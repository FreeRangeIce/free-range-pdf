// Path B: edit one line of a scan / phone photo (image-only PDF), entirely in the browser.
// OpenCV.js: paper edges -> perspective/deskew -> crop -> ~300 dpi; CLAHE / adaptive threshold for OCR only.
// Tesseract.js (eng, tessdata_fast, vendored) gives lines/words/confidences.
// Output: the page image is decoded, the patch is written INTO it, and the whole image is re-saved losslessly
// (Flate + PNG predictor). The old JPEG stream, image/catalog XMP, EXIF/GPS/ICC segments and /Thumb are gone.
import { openPdf, renderPage, diff, crop, scaled, png, sha256, u8ToB64, fetchBytes, getData } from './img-util.js';
import { tokenize, mul, apply } from './content-stream.js';
import { collectGarbage } from './pdf-gc.js';
import { classifyPages } from './classify.js';
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFNumber, decodePDFRawStream } = window.PDFLib;
import { bytesToBinary, binaryToBytes } from './content-stream.js';

let cvReady = null;
export function getCv() {
  if (!cvReady) cvReady = (async () => {
    let c = window.cv;
    if (c instanceof Promise || (c && typeof c.then === 'function' && !c.Mat)) c = await c;
    if (!c.Mat) await new Promise(r => { c.onRuntimeInitialized = r; });
    try { delete c.then; } catch {} if (typeof c.then === 'function') c.then = undefined; // Emscripten Module is a thenable; neutralise so promises can carry it
    window.cv = c; return { cv: c };
  })();
  return cvReady.then(w => w.cv);
}
const FONTS = {
  serif: { family: 'FRP Liberation Serif', file: '/vendor/fonts/liberation/LiberationSerif-Regular.ttf', name: 'Liberation Serif Regular 2.1.5' },
  sans: { family: 'FRP Liberation Sans', file: '/vendor/fonts/liberation/LiberationSans-Regular.ttf', name: 'Liberation Sans Regular 2.1.5' },
  mono: { family: 'FRP Liberation Mono', file: '/vendor/fonts/liberation/LiberationMono-Regular.ttf', name: 'Liberation Mono Regular 2.1.5' },
};
let fontsLoaded = null;
function loadFonts() {
  if (!fontsLoaded) fontsLoaded = Promise.all(Object.values(FONTS).map(async f => { const ff = new FontFace(f.family, `url(${f.file})`); await ff.load(); document.fonts.add(ff); }));
  return fontsLoaded;
}
let workerP = null;
function getWorker() {
  if (!workerP) workerP = window.Tesseract.createWorker('eng', 1, {
    workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core/', langPath: '/vendor/tessdata/',
    gzip: false, cacheMethod: 'none', workerBlobURL: false, logger: m => { if (m.status && (m.progress === 0 || m.progress === 1)) console.log('[tess]', m.status, m.progress); },
  });
  return workerP;
}

// ---------- find the page image in the PDF (no decoding of the PDF by us beyond locating the XObject) ----------
function findPageImage(pdoc, pageIndex = 0) {
  const page = pdoc.getPage(pageIndex);
  const xo = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const cv = page.node.get(PDFName.of('Contents'));
  const refs = cv instanceof PDFArray ? cv.asArray() : [cv];
  const s = refs.map(r => bytesToBinary(decodePDFRawStream(pdoc.context.lookup(r)).decode())).join('\n');
  const ops = tokenize(s); let ctm = [1, 0, 0, 1, 0, 0]; const st = [];
  for (const o of ops) {
    if (o.op === 'q') st.push(ctm); else if (o.op === 'Q') ctm = st.pop() || [1, 0, 0, 1, 0, 0];
    else if (o.op === 'cm') ctm = mul(o.args.map(a => a.v), ctm);
    else if (o.op === 'Do') {
      const name = o.args[0].v; const ref = xo.get(PDFName.of(name)); const obj = pdoc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream)) continue;
      const d = obj.dict; if (d.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      const filter = d.lookup(PDFName.of('Filter'))?.toString();
      return { name, ref, obj, ctm, filter, xo, width: d.lookup(PDFName.of('Width')).asNumber(), height: d.lookup(PDFName.of('Height')).asNumber(), raw: obj.contents };
    }
  }
  throw new Error('no page image found');
}

async function decodeImageToCanvas(img) {
  if (img.filter !== '/DCTDecode') throw new Error('proof handles DCTDecode (JPEG) page images; got ' + img.filter);
  // colorSpaceConversion 'default': an embedded ICC profile is applied, so the lossless re-save (DeviceRGB = sRGB) keeps colour
  const bmp = await createImageBitmap(new Blob([img.raw], { type: 'image/jpeg' }), { colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0); return c;
}

// ---------- OpenCV geometry ----------
function orderQuad(pts) {
  const s = pts.map(p => p[0] + p[1]), d = pts.map(p => p[1] - p[0]);
  return [pts[s.indexOf(Math.min(...s))], pts[d.indexOf(Math.min(...d))], pts[s.indexOf(Math.max(...s))], pts[d.indexOf(Math.max(...d))]];
}
// WHITE-PAGE EDGE FIT (perspective, 4 corners). Page = low-saturation, not-dark pixels (a red border or coloured cloth
// is saturated, so it is outside the page). Each side is a robust (RANSAC) line through the page/background transition
// found along rows (left, right) and columns (top, bottom); corners are the line intersections, so tilt and
// keystone are measured, not assumed. Returns null when the fit is not trustworthy (caller falls back).
function findWhitePage(cv, srcRGBA) {
  const W = srcRGBA.cols, H = srcRGBA.rows, st = Math.max(1, Math.round(W / 756)), w = Math.floor(W / st), h = Math.floor(H / st), d = srcRGBA.data;
  const m = new Uint8Array(w * h); let cnt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((y * st + (st >> 1)) * W + x * st + (st >> 1)) * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if ((mx - mn) / (mx + 1e-6) < 0.25 && mx > 60) { m[y * w + x] = 1; cnt++; } }
  const run = (get, n, gap = 12) => { let best = [0, 0, 0], s = -1, last = -1; for (let i = 0; i < n; i++) { if (get(i)) { if (s < 0) s = i; last = i; } else if (s >= 0 && i - last > gap) { if (last - s > best[0]) best = [last - s, s, last]; s = -1; } } if (s >= 0 && last - s > best[0]) best = [last - s, s, last]; return best; };
  const L = [], R = [], T = [], B = [];
  for (let y = Math.round(h * .08); y < h * .92; y += 4) { const r = run(x => m[y * w + x], w); if (r[0] > w * .5) { L.push([y, r[1]]); R.push([y, r[2]]); } }
  for (let x = Math.round(w * .15); x < w * .85; x += 4) { const r = run(y => m[y * w + x], h); if (r[0] > h * .5) { T.push([x, r[1]]); B.push([x, r[2]]); } }
  if (L.length < 30 || T.length < 30) return null;
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const ransac = P => { let best = null, bc = -1; for (let it = 0; it < 400; it++) { const a = P[Math.floor(rnd() * P.length)], b = P[Math.floor(rnd() * P.length)]; if (Math.abs(a[0] - b[0]) < 20) continue; const s = (b[1] - a[1]) / (b[0] - a[0]), c = a[1] - s * a[0]; const inl = P.filter(p => Math.abs(p[1] - (s * p[0] + c)) < 3); if (inl.length > bc) { bc = inl.length; best = inl; } }
    if (!best) return null; const n = best.length, mu = best.reduce((a, p) => a + p[0], 0) / n, mv = best.reduce((a, p) => a + p[1], 0) / n; let sxx = 0, sxy = 0; best.forEach(p => { sxx += (p[0] - mu) ** 2; sxy += (p[0] - mu) * (p[1] - mv); }); const s = sxy / sxx, c = mv - s * mu;
    return { s, c, inliers: n, of: P.length, resid: Math.sqrt(best.reduce((a, p) => a + (p[1] - (s * p[0] + c)) ** 2, 0) / n) }; };
  const fl = ransac(L), fr = ransac(R), ft = ransac(T), fb = ransac(B); if (!fl || !fr || !ft || !fb) return null;
  if ([fl, fr, ft, fb].some(f => f.inliers < 0.5 * f.of || f.resid > 2)) return null;
  const hit = (v, hz) => { /* x = v.s*y + v.c ; y = hz.s*x + hz.c */ const y = (hz.s * v.c + hz.c) / (1 - hz.s * v.s), x = v.s * y + v.c; return [x * st, y * st]; };
  const tl = hit(fl, ft), tr = hit(fr, ft), br = hit(fr, fb), bl = hit(fl, fb);
  const ang = s => Math.atan(s) * 180 / Math.PI, dd = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const area = Math.abs((tl[0] * tr[1] - tr[0] * tl[1]) + (tr[0] * br[1] - br[0] * tr[1]) + (br[0] * bl[1] - bl[0] * br[1]) + (bl[0] * tl[1] - tl[0] * bl[1])) / 2 / (W * H);
  if (area < 0.4 || area > 0.97 || cnt / (w * h) > 0.97) return null;
  const metrics = { topEdgeTiltDeg: +ang(ft.s).toFixed(2), bottomEdgeTiltDeg: +ang(fb.s).toFixed(2), leftEdgeOffVerticalDeg: +ang(fl.s).toFixed(2), rightEdgeOffVerticalDeg: +ang(fr.s).toFixed(2),
    widthTopPx: Math.round(dd(tl, tr)), widthBottomPx: Math.round(dd(bl, br)), heightLeftPx: Math.round(dd(tl, bl)), heightRightPx: Math.round(dd(tr, br)),
    keystoneWidthRatioTopOverBottom: +(dd(tl, tr) / dd(bl, br)).toFixed(4), keystoneHeightRatioLeftOverRight: +(dd(tl, bl) / dd(tr, br)).toFixed(4),
    lineFits: { left: [fl.inliers, fl.of, +fl.resid.toFixed(2)], right: [fr.inliers, fr.of, +fr.resid.toFixed(2)], top: [ft.inliers, ft.of, +ft.resid.toFixed(2)], bottom: [fb.inliers, fb.of, +fb.resid.toFixed(2)] }, areaFrac: +area.toFixed(3) };
  return { quad: [tl, tr, br, bl], method: 'white-page edge fit (low-saturation mask, RANSAC side lines, 4 corners)', metrics, areaFrac: area, borderBrightFrac: 0 };
}
function findPaper(cv, srcRGBA) {
  { const wp = findWhitePage(cv, srcRGBA); if (wp) return wp; }
  const maxDim = 1000, k = Math.min(1, maxDim / Math.max(srcRGBA.cols, srcRGBA.rows));
  const gray = new cv.Mat(), small = new cv.Mat(), bin = new cv.Mat(), hier = new cv.Mat(); const contours = new cv.MatVector();
  cv.cvtColor(srcRGBA, gray, cv.COLOR_RGBA2GRAY);
  cv.resize(gray, small, new cv.Size(Math.round(gray.cols * k), Math.round(gray.rows * k)), 0, 0, cv.INTER_AREA);
  cv.GaussianBlur(small, small, new cv.Size(5, 5), 0);
  const otsu = cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  // how much of the outer 2% frame is paper-bright: ~1 when the paper fills the frame (flatbed scan, no background)
  let bright = 0, tot = 0; { const bw0 = Math.max(2, Math.round(0.02 * Math.min(bin.cols, bin.rows))); for (let y = 0; y < bin.rows; y++) for (let x = 0; x < bin.cols; x++) { if (x >= bw0 && x < bin.cols - bw0 && y >= bw0 && y < bin.rows - bw0) continue; tot++; if (bin.data[y * bin.cols + x]) bright++; } }
  const ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, ker); cv.morphologyEx(bin, bin, cv.MORPH_OPEN, ker);
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null, bestA = 0;
  for (let i = 0; i < contours.size(); i++) { const c = contours.get(i); const a = cv.contourArea(c); if (a > bestA) { bestA = a; best = c; } }
  let pts, method;
  const approx = new cv.Mat(); cv.approxPolyDP(best, approx, 0.02 * cv.arcLength(best, true), true);
  if (approx.rows === 4) { pts = []; for (let i = 0; i < 4; i++) pts.push([approx.data32S[i * 2] / k, approx.data32S[i * 2 + 1] / k]); method = 'largest contour -> approxPolyDP quad'; }
  else { const rr = cv.minAreaRect(best); pts = cv.RotatedRect.points(rr).map(p => [p.x / k, p.y / k]); method = `minAreaRect (approx had ${approx.rows} pts)`; }
  const areaFrac = bestA / (small.cols * small.rows);
  [gray, small, bin, hier, contours, ker, approx].forEach(m => m.delete());
  return { quad: orderQuad(pts), method, otsu, areaFrac, borderBrightFrac: bright / tot };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// True aspect ratio of a rectangle seen in perspective (Zhang & He, "Whiteboard scanning", 2006),
// principal point assumed at the image centre. Falls back to the raw edge ratio when the view is ~affine.
function trueAspect(q, W, H) {
  const c = [W / 2, H / 2];
  const m = [q[0], q[1], q[3], q[2]].map(([x, y]) => [x - c[0], y - c[1], 1]); // m1=tl m2=tr m3=bl m4=br
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [m1, m2, m3, m4] = m;
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3), k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  if (!(f2 > 0) || Math.abs(n2[2]) < 1e-6 || Math.abs(n3[2]) < 1e-6) return { ratio: null, focalPx: null };
  const nn = n => (n[0] * n[0] + n[1] * n[1]) / f2 + n[2] * n[2];
  const wh = Math.sqrt(nn(n2) / nn(n3));
  return { ratio: 1 / wh, focalPx: Math.sqrt(f2) };
}
function paperSize(q, W, H) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2; const raw = h / w;
  const ta = trueAspect(q, W, H);
  // near-affine views (flatbed scans) make the focal estimate meaningless; use the raw ratio there
  const affine = Math.abs(raw - (ta.ratio ?? raw)) < 0.01 || !ta.ratio || ta.focalPx > 20 * Math.max(W, H);
  const r = affine ? raw : ta.ratio;
  const sizes = [{ name: 'US Letter', w: 8.5, h: 11 }, { name: 'A4', w: 8.27, h: 11.69 }, { name: 'US Legal', w: 8.5, h: 14 }];
  const s = sizes.reduce((a, b) => Math.abs(b.h / b.w - r) < Math.abs(a.h / a.w - r) ? b : a);
  return { ...s, rawEdgeRatio: raw, perspectiveRatio: ta.ratio, focalPx: ta.focalPx, measuredRatio: r, ratioMethod: affine ? 'edge lengths (near-affine)' : 'perspective-corrected (Zhang-He)', pxW: w, pxH: h, srcDpi: w / s.w };
}
function matToCanvas(cv, m) { const c = document.createElement('canvas'); cv.imshow(c, m); return c; }

// ---------- measuring a line ----------
function inkProfile(mask, W, x0, y0, x1, y1) {
  const rows = [], cols = new Array(x1 - x0).fill(0);
  for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) if (mask[y * W + x]) { n++; cols[x - x0]++; } rows.push(n); }
  const mx = Math.max(...rows);
  const core = rows.map((v, i) => v >= 0.45 * mx ? i : -1).filter(i => i >= 0);
  const any = rows.map((v, i) => v >= 0.06 * mx ? i : -1).filter(i => i >= 0);
  const colIdx = cols.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  // baseline = bottom of the dense core band; x-height = core band height; top = first row with any real ink
  const xTop = core[0], base = core[core.length - 1] + 1, top = any[0];
  return { xHeight: base - xTop, capHeight: base - top, baselineRel: base, topRel: top, xTopRel: xTop, inkLeftRel: colIdx[0], inkRightRel: colIdx[colIdx.length - 1] + 1, rows };
}
function renderSample(fontFamily, text, sizePx, blur = 0, weight = 0) {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = `${sizePx}px "${fontFamily}"`; const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w; c.height = Math.ceil(sizePx * 2);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#000'; ctx.font = `${sizePx}px "${fontFamily}"`; ctx.textBaseline = 'alphabetic';
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  ctx.fillText(text, 20, Math.round(sizePx * 1.4));
  if (weight > 0) { ctx.lineWidth = weight; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round'; ctx.strokeText(text, 20, Math.round(sizePx * 1.4)); }
  const d = ctx.getImageData(0, 0, c.width, c.height).data; const mask = new Uint8Array(c.width * c.height);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] < 128 ? 1 : 0;
  const p = inkProfile(mask, c.width, 0, 0, c.width, c.height);
  return { ...p, inkWidth: p.inkRightRel - p.inkLeftRel, baselineAbs: Math.round(sizePx * 1.4), mask, w: c.width, h: c.height };
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- OCR ----------
async function ocr(canvas, rectangle, psm = '3') {
  const w = await getWorker();
  await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_pageseg_mode: psm });
  const r = await w.recognize(canvas, rectangle ? { rectangle } : {}, { blocks: true, text: true });
  const lines = [];
  for (const b of r.data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines)
    lines.push({ text: l.text.trim(), confidence: +l.confidence.toFixed(1), bbox: l.bbox, baseline: l.baseline,
      words: l.words.map(w => ({ text: w.text, confidence: +w.confidence.toFixed(1), bbox: w.bbox })) });
  return { text: r.data.text, lines, meanConf: lines.length ? lines.flatMap(l => l.words).reduce((s, w) => s + w.confidence, 0) / lines.flatMap(l => l.words).length : 0 };
}
function tokSim(a, b) { // fraction of matching tokens (LCS) - used only to locate the target line
  const A = a.split(/\s+/), B = b.split(/\s+/); const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[A.length][B.length] / B.length; // recall of the corrected tokens (junk OCR tokens from nearby handwriting don't count against a line)
}

async function cvReady0() { getCv(); return (await cvReady).cv; }
export async function editScanLine({ url, kind, trueLine, find, replace, pageIndex = 0, occurrence = 0, hidden = 'add', confirm = null, confirmBelow = 80 }) {
  const cv = (await cvReady0()); await loadFonts();
  const T = {}; const tick = (k, t0) => { T[k] = Math.round(performance.now() - t0); console.log('[FRP]', kind, k, T[k] + 'ms'); };
  let t0 = performance.now();
  const original = await fetchBytes(url); const shaBefore = await sha256(original);
  const pdoc = await PDFDocument.load(original.slice(), { updateMetadata: false });
  const classification = classifyPages(pdoc);
  if (classification[pageIndex].route !== 'scan') throw new Error('page is not routed to the scan path: ' + JSON.stringify(classification[pageIndex]));
  const rot = pdoc.getPage(pageIndex).getRotation().angle % 360;
  const img = findPageImage(pdoc, pageIndex);
  const imageShaBefore = await sha256(img.raw);
  const origCanvas = await decodeImageToCanvas(img);
  const W = origCanvas.width, H = origCanvas.height;
  tick('load', t0); t0 = performance.now();

  // 1) paper edges + perspective/deskew + crop + ~300 dpi
  const src = cv.imread(origCanvas);
  const paper = findPaper(cv, src);
  if (paper.borderBrightFrac > 0.9) { // flatbed scan with the paper filling the frame: no paper edge to find
    paper.detected = { quad: paper.quad, method: paper.method, areaFrac: paper.areaFrac };
    paper.quad = [[0, 0], [W, 0], [W, H], [0, H]]; paper.method = `full image: ${(paper.borderBrightFrac * 100).toFixed(1)}% of the outer frame is paper-bright, so the paper fills the scan (no background edge)`;
  }
  // page /Rotate: reorder the quad so its first corner is the DISPLAYED top-left (rotation is clockwise)
  { const perm = { 0: [0, 1, 2, 3], 90: [3, 0, 1, 2], 180: [2, 3, 0, 1], 270: [1, 2, 3, 0] }[rot]; paper.quadImage = paper.quad; paper.quad = perm.map(i => paper.quad[i]); paper.pageRotate = rot; }
  const ps = paperSize(paper.quad, W, H);
  // crop to the paper: pull the corners 0.4% toward the centre so no background sliver reaches OCR
  { const cx = paper.quad.reduce((a, p) => a + p[0], 0) / 4, cy = paper.quad.reduce((a, p) => a + p[1], 0) / 4; paper.quadInset = paper.quad.map(([x, y]) => [x + (cx - x) * 0.008, y + (cy - y) * 0.008]); }
  const OW = Math.round(ps.w * 300), OH = Math.round(ps.h * 300);
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, paper.quadInset.flat());
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, OW, 0, OW, OH, 0, OH]);
  let M = cv.getPerspectiveTransform(srcPts, dstPts); const Minv = new cv.Mat();
  let corr = new cv.Mat(); cv.warpPerspective(src, corr, M, new cv.Size(OW, OH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  // residual TEXT-line tilt: the white page edges are not exactly parallel to the printed lines (the book is slightly
  // bowed / the cover is cut a little off-square). Sweep a small rotation on a reduced ink mask, keep the one that makes
  // the row projection sharpest, and fold it into the same transform so every later step sees level text lines.
  if (/white-page/.test(paper.method || '')) {
    const k = 900 / OW; const sm = new cv.Mat(); cv.resize(corr, sm, new cv.Size(900, Math.round(OH * k)), 0, 0, cv.INTER_AREA);
    const g = new cv.Mat(); cv.cvtColor(sm, g, cv.COLOR_RGBA2GRAY); const bin = new cv.Mat(); cv.adaptiveThreshold(g, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 31, 12);
    const inner = bin.roi(new cv.Rect(Math.round(bin.cols * 0.1), Math.round(bin.rows * 0.06), Math.round(bin.cols * 0.8), Math.round(bin.rows * 0.5))); const sub = inner.clone(); inner.delete();
    const score = ang => { const R = cv.getRotationMatrix2D(new cv.Point(sub.cols / 2, sub.rows / 2), ang, 1); const o = new cv.Mat(); cv.warpAffine(sub, o, R, new cv.Size(sub.cols, sub.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0)); R.delete();
      const red = new cv.Mat(); cv.reduce(o, red, 1, cv.REDUCE_SUM, cv.CV_32F); const d = red.data32F; let sc = 0; for (let i = 1; i < d.length; i++) sc += (d[i] - d[i - 1]) * (d[i] - d[i - 1]); o.delete(); red.delete(); return sc; };
    let best = 0, bs = score(0); const sc0 = bs;
    for (let a = -2; a <= 2.0001; a += 0.1) { const v = score(a); if (v > bs) { bs = v; best = a; } }
    for (let a = best - 0.1; a <= best + 0.1001; a += 0.02) { const v = score(a); if (v > bs) { bs = v; best = a; } }
    sm.delete(); g.delete(); bin.delete(); sub.delete();
    paper.textRotation = { degCCW: +best.toFixed(2), sharpnessGain: +(bs / sc0).toFixed(3), applied: Math.abs(best) >= 0.15 && bs / sc0 > 1.02 };
    if (paper.textRotation.applied) {
      const R = cv.getRotationMatrix2D(new cv.Point(OW / 2, OH / 2), best, 1); const r = R.data64F; const R3 = cv.matFromArray(3, 3, cv.CV_64F, [r[0], r[1], r[2], r[3], r[4], r[5], 0, 0, 1]); R.delete();
      const M2 = new cv.Mat(); cv.gemm(R3, M, 1, new cv.Mat(), 0, M2); R3.delete(); M.delete(); M = M2; corr.delete(); corr = new cv.Mat(); cv.warpPerspective(src, corr, M, new cv.Size(OW, OH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    }
  }
  cv.invert(M, Minv, cv.DECOMP_LU);
  const angle = Math.atan2(paper.quad[1][1] - paper.quad[0][1], paper.quad[1][0] - paper.quad[0][0]) * 180 / Math.PI;
  const angleBottom = Math.atan2(paper.quad[2][1] - paper.quad[3][1], paper.quad[2][0] - paper.quad[3][0]) * 180 / Math.PI;
  const angleLeft = Math.atan2(paper.quad[3][0] - paper.quad[0][0], paper.quad[3][1] - paper.quad[0][1]) * 180 / Math.PI;
  const angleRight = Math.atan2(paper.quad[2][0] - paper.quad[1][0], paper.quad[2][1] - paper.quad[1][1]) * 180 / Math.PI;
  const corrCanvas = matToCanvas(cv, corr);
  tick('geometry', t0); t0 = performance.now();

  // 2) contrast for OCR only (never written to the output)
  const gray = new cv.Mat(); cv.cvtColor(corr, gray, cv.COLOR_RGBA2GRAY);
  const claheM = new cv.Mat(); const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8)); clahe.apply(gray, claheM); clahe.delete();
  const adapt = new cv.Mat(); const gb = new cv.Mat(); cv.GaussianBlur(claheM, gb, new cv.Size(3, 3), 0);
  cv.adaptiveThreshold(gb, adapt, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 15); gb.delete();
  const variants = { clahe: matToCanvas(cv, claheM), adaptive: matToCanvas(cv, adapt) };
  tick('enhance', t0); t0 = performance.now();

  // 3) OCR both variants; keep the one with the higher mean word confidence (no ground truth used)
  const ocrRuns = {};
  for (const [k, c] of Object.entries(variants)) ocrRuns[k] = await ocr(c);
  const chosen = Object.keys(ocrRuns).reduce((a, b) => ocrRuns[b].meanConf > ocrRuns[a].meanConf ? b : a);
  const O = ocrRuns[chosen];
  tick('ocr', t0); t0 = performance.now();

  // 4) locate the target line (in the app the user clicks it; here we match the known true text)
  const sims = O.lines.map(l => tokSim(l.text, trueLine)); const smax = Math.max(...sims);
  const cands = sims.map((v, i) => v >= smax - 0.02 ? i : -1).filter(i => i >= 0).sort((a, b) => O.lines[a].bbox.y0 - O.lines[b].bbox.y0);
  if (smax < 0.6) throw Object.assign(new Error(`NOT EDITABLE: our OCR could not read this line (best OCR line shares only ${Math.round(smax * 100)}% of its words). Re-scan at higher quality or type the line.`), { notEditable: true });
  const li = cands[Math.min(occurrence, cands.length - 1)]; const L = O.lines[li];
  const lowConfInLine = L.words.filter(w => w.confidence < 80);
  const correctedOld = trueLine; // human-corrected text of the line as it is now (proof stand-in for the user's correction)
  if (correctedOld.split(find).length !== 2) throw new Error('find must occur once in trueLine');
  const newText = correctedOld.replace(find, replace);
  // 4b) the SEGMENT of the line that holds the edit: neighbouring OCR words with normal word gaps (a table row's
  //     other cells, or junk words merged in from nearby handwriting, are left out of font/ink fitting)
  const seg = (() => {
    const tt = correctedOld.split(' '), ow = L.words.map(w => w.text); const n1 = tt.length, n2 = ow.length;
    const D = Array.from({ length: n1 + 1 }, (_, i) => Array.from({ length: n2 + 1 }, (_, j) => i + j));
    for (let i = 1; i <= n1; i++) for (let j = 1; j <= n2; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (tt[i - 1] === ow[j - 1] ? 0 : 1));
    const al = new Array(n2).fill(-1); for (let i = n1, j = n2; i > 0 && j > 0;) { if (D[i][j] === D[i - 1][j - 1] + (tt[i - 1] === ow[j - 1] ? 0 : 1)) { al[j - 1] = i - 1; i--; j--; } else if (D[i][j] === D[i - 1][j] + 1) i--; else j--; }
    const fpos = correctedOld.indexOf(find); let acc = 0, ft = -1; tt.forEach((t, i) => { if (ft < 0 && acc + t.length > fpos) ft = i; acc += t.length + 1; });
    const j0 = al.indexOf(ft); if (j0 < 0) return null;
    const lhh = L.bbox.y1 - L.bbox.y0; const ppc = (L.words[j0].bbox.x1 - L.words[j0].bbox.x0) / Math.max(1, tt[ft].length);
    const ok = j => al[j] >= 0 && (L.words[j].bbox.x1 - L.words[j].bbox.x0) / Math.max(1, tt[al[j]].length) < 1.6 * ppc;
    let a = j0, b = j0;
    while (a > 0 && ok(a - 1) && L.words[a].bbox.x0 - L.words[a - 1].bbox.x1 < 0.8 * lhh && al[a - 1] === al[a] - 1) a--;
    while (b < n2 - 1 && ok(b + 1) && L.words[b + 1].bbox.x0 - L.words[b].bbox.x1 < 0.8 * lhh && al[b + 1] === al[b] + 1) b++;
    return { j0: a, j1: b, text: tt.slice(al[a], al[b] + 1).join(' '), box: (() => { const ws = L.words.slice(a, b + 1); const y0 = Math.min(...ws.map(w => w.bbox.y0)), y1 = Math.max(...ws.map(w => w.bbox.y1)); const pad = Math.round(0.15 * (y1 - y0)); return { x0: L.words[a].bbox.x0, x1: L.words[b].bbox.x1, y0: y0 - pad, y1: y1 + pad }; })(), lineBox: L.bbox };
  })();
  const fitText = seg ? seg.text : correctedOld;

  // 5) measure the line: ink mask (Otsu inside the line box), x-height, cap height, baseline, ink colour, paper colour
  const gd = gray.data; const cw = corr.cols, ch = corr.rows;
  const bb = seg ? { ...seg.box, x0: Math.max(0, seg.box.x0 - 4), x1: seg.box.x1 + 4 } : L.bbox; const lh = bb.y1 - bb.y0;
  const roi = gray.roi(new cv.Rect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0)); const roiBin = new cv.Mat();
  const thr = cv.threshold(roi, roiBin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU); roi.delete(); roiBin.delete();
  const mask = new Uint8Array(cw * ch);
  for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0; x < bb.x1; x++) mask[y * cw + x] = gd[y * cw + x] < thr ? 1 : 0;
  const prof = inkProfile(mask, cw, bb.x0, bb.y0, bb.x1, bb.y1);
  const meas = { xHeight: prof.xHeight, capHeight: prof.capHeight, baseline: bb.y0 + prof.baselineRel, inkLeft: bb.x0 + prof.inkLeftRel, inkRight: bb.x0 + prof.inkRightRel, otsu: thr };
  meas.inkWidth = meas.inkRight - meas.inkLeft;
  const cd = corr.data; const ink = [];
  for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0; x < bb.x1; x++) if (mask[y * cw + x]) ink.push([gd[y * cw + x], cd[(y * cw + x) * 4], cd[(y * cw + x) * 4 + 1], cd[(y * cw + x) * 4 + 2]]);
  ink.sort((a, b) => a[0] - b[0]); const dark = ink.slice(0, Math.max(1, Math.floor(ink.length * 0.4)));
  const inkRGB = [1, 2, 3].map(i => Math.round(median(dark.map(p => p[i]))));

  // 6) pick the closest bundled font + blur: render the human-verified ORIGINAL line text in each candidate,
  //    size it so its measured x-height / cap height (same measuring code, same blur) match the scan's,
  //    stretch to the measured ink width, and score by normalised cross-correlation with the real line pixels.
  const lineW = bb.x1 - bb.x0, lineH = bb.y1 - bb.y0;
  const realLine = new Float32Array(lineW * lineH);
  for (let y = 0; y < lineH; y++) for (let x = 0; x < lineW; x++) realLine[y * lineW + x] = gd[(bb.y0 + y) * cw + bb.x0 + x];
  function ncc(a, b2) { let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b2[i]; } ma /= a.length; mb /= a.length; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b2[i] - mb; sab += da * db; saa += da * da; sbb += db * db; } return sab / Math.sqrt(saa * sbb); }
  function synthLine(family, size, blur, hs, weight = 0) {
    const c = document.createElement('canvas'); c.width = lineW; c.height = lineH; const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, lineW, lineH); x.fillStyle = '#000'; x.font = `${size}px "${family}"`; x.textBaseline = 'alphabetic'; if (blur > 0) x.filter = `blur(${blur}px)`;
    x.translate(meas.inkLeft - bb.x0, meas.baseline - bb.y0); x.scale(hs, 1); x.fillText(fitText, 0, 0);
    if (weight > 0) { x.lineWidth = weight; x.strokeStyle = '#000'; x.lineJoin = 'round'; x.strokeText(fitText, 0, 0); }
    const d = x.getImageData(0, 0, lineW, lineH).data; const o = new Float32Array(lineW * lineH); for (let i = 0; i < o.length; i++) o[i] = d[i * 4]; return o;
  }
  const fontTrials = {};
  for (const [k, f] of Object.entries(FONTS)) {
    let best = null; const all = [];
    for (const blur of [0, 0.75, 1.5, 2.25, 3]) for (const weight of [0, 0.75, 1.5, 2.25, 3]) {
      let size = 100, r;
      for (let it = 0; it < 4; it++) { r = renderSample(f.family, fitText, size, blur, weight * size / 50); size *= ((meas.xHeight / r.xHeight) + (meas.capHeight / r.capHeight)) / 2; }
      const wpx = weight * size / 50; // stroke weight scales with size during the fit, fixed in px afterwards
      r = renderSample(f.family, fitText, size, blur, wpx);
      const widthRatio = meas.inkWidth / r.inkWidth; const hs = Math.min(1.1, Math.max(0.9, widthRatio));
      const syn = synthLine(f.family, size, blur, hs, wpx);
      const score = ncc(realLine, syn);
      const t = { font: f.name, sizePx: +size.toFixed(2), blurPx: blur, strokeWeightPx: +wpx.toFixed(2), widthRatio: +widthRatio.toFixed(4), horizontalScale: +hs.toFixed(4), ncc: +score.toFixed(4),
        fitXHeight: r.xHeight, fitCapHeight: r.capHeight, _syn: syn };
      all.push(t);
    }
    // Occam: among fits within 0.01 NCC of the best, take the lightest stroke weight, then the least blur
    const top = Math.max(...all.map(t => t.ncc));
    best = all.filter(t => t.ncc >= top - 0.01).sort((a, b) => a.strokeWeightPx - b.strokeWeightPx || a.blurPx - b.blurPx)[0];
    best.grid = all.map(t => [t.blurPx, t.strokeWeightPx, t.ncc]);
    fontTrials[k] = best;
  }
  const fontKey = Object.keys(fontTrials).reduce((a, b) => fontTrials[b].ncc > fontTrials[a].ncc ? b : a);
  const FT = fontTrials[fontKey]; const F = FONTS[fontKey];
  // ink colour: choose it so the synthetic line has the same mean colour as the real line over the line box
  // (pixel = paper + coverage * (ink - paper)); a stroke blurred by the camera never reaches its true ink tone.
  const cov = FT._syn.map(v => 1 - v / 255); const meanCov = cov.reduce((a, b) => a + b, 0) / cov.length;
  const origMean = [0, 1, 2].map(c => { let t = 0; for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0; x < bb.x1; x++) t += cd[(y * cw + x) * 4 + c]; return t / (lineW * lineH); });
  for (const t of Object.values(fontTrials)) delete t._syn;
  const fitGrid = Object.fromEntries(Object.entries(fontTrials).map(([k, t]) => { const g = t.grid; delete t.grid; return [k, g]; }));
  const hScale = FT.horizontalScale; // keep the original line's set width (clamped to +/-10%)

  // 7) WORD-level edit: only the edited word(s) are painted over; every other word keeps its original pixels.
  const trueTok = correctedOld.split(' ');
  // align the corrected tokens to the OCR words (edit distance over tokens; OCR may split or merge words)
  const ow = L.words.map(w => w.text); const n1 = trueTok.length, n2 = ow.length;
  const D = Array.from({ length: n1 + 1 }, (_, i) => Array.from({ length: n2 + 1 }, (_, j) => i + j));
  for (let i = 1; i <= n1; i++) for (let j = 1; j <= n2; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (trueTok[i - 1] === ow[j - 1] ? 0 : 1));
  const align = new Array(n1).fill(-1); for (let i = n1, j = n2; i > 0 && j > 0;) { if (D[i][j] === D[i - 1][j - 1] + (trueTok[i - 1] === ow[j - 1] ? 0 : 1)) { align[i - 1] = j - 1; i--; j--; } else if (D[i][j] === D[i - 1][j] + 1) i--; else j--; }
  const fpos = correctedOld.indexOf(find); let acc = 0; const tokRange = [];
  trueTok.forEach((t, i) => { const a = acc, b = acc + t.length; if (b > fpos && a < fpos + find.length) tokRange.push(i); acc = b + 1; });
  const ti0 = tokRange[0], ti1 = tokRange[tokRange.length - 1];
  const oi0 = align[ti0], oi1 = align[ti1]; if (oi0 < 0 || oi1 < 0) throw Object.assign(new Error(`NOT EDITABLE: our OCR did not read the word "${find}" on this line, so there is no word box to replace.`), { notEditable: true, detail: { trueTok, ow, align } });
  const oldSeg = trueTok.slice(ti0, ti1 + 1).join(' '), newSeg = oldSeg.replace(find, replace);
  const eWords = L.words.slice(oi0, oi1 + 1), uWords = L.words.filter((w, i) => (i < oi0 || i > oi1) && w.text.trim() && (!seg || (i >= seg.j0 && i <= seg.j1)));
  const wb = { x0: Math.min(...eWords.map(w => w.bbox.x0)), x1: Math.max(...eWords.map(w => w.bbox.x1)) };
  const prevW = L.words[oi0 - 1], nextW = L.words[oi1 + 1]; const tokenAlignment = trueTok.map((t, i) => [t, align[i] >= 0 ? ow[align[i]] : null]);

  // --- measurement helpers (same code for the untouched words and for the new word) ---
  const grayAt = (D, i) => 0.299 * D[i * 4] + 0.587 * D[i * 4 + 1] + 0.114 * D[i * 4 + 2];
  const paperPix = []; for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0; x < bb.x1; x++) if (gd[y * cw + x] >= thr + 15) paperPix.push(gd[y * cw + x]);
  const paperLvl = median(paperPix);
  const uInk = []; for (const w of uWords) for (let y = w.bbox.y0; y < w.bbox.y1; y++) for (let x = w.bbox.x0; x < w.bbox.x1; x++) if (gd[y * cw + x] < thr) uInk.push(gd[y * cw + x]);
  uInk.sort((a, b) => a - b); const inkLvl = uInk[Math.floor(uInk.length * 0.1)];
  const l10 = paperLvl - 0.1 * (paperLvl - inkLvl), l90 = paperLvl - 0.9 * (paperLvl - inkLvl);
  const minContrast = 0.4 * (paperLvl - median(uInk));
  function stats(D, W0, rect, ox, oy) { // D = RGBA of a region whose top-left is (ox,oy) in deskewed space, width W0
    const g = (x, y) => grayAt(D, (y - oy) * W0 + (x - ox));
    const ink = [[], [], [], []]; const edges = []; const hp = [];
    for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) { const v = g(x, y); if (v < thr) { const i = ((y - oy) * W0 + (x - ox)) * 4; ink[0].push(D[i]); ink[1].push(D[i + 1]); ink[2].push(D[i + 2]); ink[3].push(v); } }
    // stroke edge profiles: horizontal scanlines through the x-height band, 10%-90% transition width
    const yA = Math.round(meas.baseline - 0.8 * meas.xHeight), yB = Math.round(meas.baseline - 0.2 * meas.xHeight);
    for (let y = Math.max(rect.y0, yA); y < Math.min(rect.y1, yB); y++) {
      // monotonic runs along the scanline; a run whose total swing >= minContrast is one stroke edge.
      // width = distance between the 10% and 90% points of that run's own swing (independent of ink colour).
      let x = rect.x0;
      while (x < rect.x1 - 1) {
        const d0 = g(x + 1, y) - g(x, y); if (Math.abs(d0) < 2) { x++; continue; }
        const sgn = Math.sign(d0); let e = x + 1;
        while (e < rect.x1 - 1) { const d = g(e + 1, y) - g(e, y); if (d * sgn > -2 && !(Math.abs(d) < 2 && Math.abs(g(Math.min(rect.x1 - 1, e + 2), y) - g(e + 1, y)) < 2)) e++; else break; }
        const vS = g(x, y), vE = g(e, y), sw = vE - vS;
        if (Math.abs(sw) >= minContrast) {
          const at = f => { const lv = vS + f * sw; for (let j = x; j < e; j++) { const a = g(j, y), b = g(j + 1, y); if ((a - lv) * (b - lv) <= 0 && a !== b) return j + (lv - a) / (b - a); } return null; };
          const p10 = at(0.1), p90 = at(0.9); if (p10 != null && p90 != null) edges.push(Math.abs(p90 - p10));
        }
        x = e;
      }
    }
    // noise: high-pass (value - 5x5 mean) on paper pixels whose 5x5 neighbourhood is all paper
    for (let y = rect.y0 + 2; y < rect.y1 - 2; y += 1) for (let x = rect.x0 + 2; x < rect.x1 - 2; x++) {
      let s = 0, allPaper = true; for (let dy = -2; dy <= 2 && allPaper; dy++) for (let dx = -2; dx <= 2; dx++) { const v = g(x + dx, y + dy); if (v < thr + 15) { allPaper = false; break; } s += v; }
      if (allPaper) hp.push(g(x, y) - s / 25);
    }
    const hm = hp.reduce((a, b) => a + b, 0) / Math.max(1, hp.length);
    const p10 = arr => { const t = [...arr].sort((a, b) => a - b); return t.length ? t[Math.floor(t.length * 0.1)] : NaN; };
    return { inkMedianRGB: ink.slice(0, 3).map(c => Math.round(median(c))), inkMedianGray: +median(ink[3]).toFixed(1), inkP10RGB: ink.slice(0, 3).map(c => Math.round(p10(c))), inkPixels: ink[3].length,
      edge10_90px: edges.length >= 4 ? +median(edges).toFixed(3) : null, edgeSamples: edges.length,
      noiseStd: hp.length >= 30 ? +Math.sqrt(hp.reduce((a, b) => a + (b - hm) ** 2, 0) / hp.length).toFixed(3) : null, noiseSamples: hp.length };
  }
  const uStats = uWords.map(w => ({ word: w.text, ...stats(cd, cw, w.bbox, 0, 0) }));
  const target = {
    inkRGB: [0, 1, 2].map(c => Math.round(median(uStats.map(s => s.inkMedianRGB[c])))),
    edge: median(uStats.map(s => s.edge10_90px).filter(v => v != null)),
    noise: median(uStats.map(s => s.noiseStd).filter(v => v != null)),
    inkDensity: median(uWords.map((w, i) => uStats[i].inkPixels / (w.bbox.x1 - w.bbox.x0))),
    inkMass: median(uWords.map(w => { let t = 0; for (let y = w.bbox.y0; y < w.bbox.y1; y++) for (let x = w.bbox.x0; x < w.bbox.x1; x++) t += paperLvl - gd[y * cw + x]; return t / (w.bbox.x1 - w.bbox.x0); })),
    inkP10RGB: [0, 1, 2].map(c => Math.round(median(uStats.map(s => s.inkP10RGB[c])))), inkMedianGray: median(uStats.map(s => s.inkMedianGray)),
  };

  // --- width rule (same as the text path): letter spacing first (|sp| <= 0.04 em per letter gap), then horizontal
  //     scale within 0.97..1.03 on top; still shorter -> natural width from the original start + reported gap;
  //     still longer -> refused, nothing written. Nothing to the right ever moves (only the edited word is repainted).
  const r0 = renderSample(F.family, newSeg, FT.sizePx, 0, 0);
  const slot = wb.x1 - wb.x0; const base = r0.inkWidth * hScale; const gaps = Math.max(0, [...newSeg].length - 1); const em = FT.sizePx;
  const spMax = 0.04 * em; const sp = gaps ? Math.max(-spMax, Math.min(spMax, (slot - base) / gaps)) : 0; const w1 = base + gaps * sp;
  let sc = Math.max(0.97, Math.min(1.03, slot / w1)); let w2 = w1 * sc; let spUse = sp;
  const tried = { spacingTriedEm: +(sp / em).toFixed(4), scaleTried: +sc.toFixed(4), widthAfterMaxPx: +w2.toFixed(1) };
  if (w2 < slot - 0.5) { spUse = 0; sc = 1; w2 = base; } // rule 3: still shorter -> natural width from the original start
  const overflow = { slotPx: slot, naturalInkWidthPx: +base.toFixed(1), ...tried, letterSpacingPx: +spUse.toFixed(3), letterSpacingEm: +(spUse / em).toFixed(4), horizontalScale: +sc.toFixed(4), finalInkWidthPx: +w2.toFixed(1), rule: 'spacing <= +-0.04 em/letter, then scale 0.97..1.03; shorter -> gap; longer -> refuse' };
  if (w2 > slot + 0.5) { overflow.decision = 'refused: longer than the slot even at -0.04 em spacing and 0.97 scale'; throw Object.assign(new Error('width rule refused: ' + JSON.stringify(overflow)), { overflow }); }
  overflow.gapPx = +Math.max(0, slot - w2).toFixed(1); overflow.decision = overflow.gapPx > 0.5 ? `still shorter after +0.04 em spacing and 1.03 scale (${tried.widthAfterMaxPx} px) -> drawn at natural width from the original start; ${overflow.gapPx} px gap left (shown in preview)` : `fits: spacing ${(spUse / em).toFixed(4)} em, scale ${sc.toFixed(3)}`;
  const hsWord = hScale * sc, letterSp = spUse / hScale; // canvas letterSpacing is applied before the x-scale
  const drawnInkW = w2;

  // --- paint box: the edited word(s) only, padded but never touching the neighbouring words or lines ---
  const prevL = O.lines[li - 1], nextL = O.lines[li + 1];
  const gapUp = prevL && prevL.bbox.y1 <= bb.y0 ? bb.y0 - prevL.bbox.y1 : lh, gapDn = nextL && nextL.bbox.y0 >= bb.y1 ? nextL.bbox.y0 - bb.y1 : lh;
  const padV = Math.max(1, Math.floor(Math.min(0.25 * lh, gapUp / 2 - 1, gapDn / 2 - 1)));
  const padL = Math.max(1, Math.floor(Math.min(0.3 * lh, prevW ? (wb.x0 - prevW.bbox.x1) / 2 - 1 : 0.3 * lh)));
  const padR = Math.max(1, Math.floor(Math.min(0.3 * lh, nextW ? (nextW.bbox.x0 - wb.x1) / 2 - 1 : 0.3 * lh)));
  const box = { x0: wb.x0 - padL, y0: bb.y0 - padV, x1: wb.x1 + padR, y1: bb.y1 + padV };
  // paper colour: per 24-px segment, median of bright pixels in thin strips just above and below the box
  const segW = 24, strip = Math.max(3, Math.min(8, padV + 2)); const segs = [];
  for (let sx = box.x0; sx < box.x1; sx += segW) {
    const take = (ya, yb) => { const px = []; for (let y = Math.max(0, ya); y < Math.min(ch, yb); y++) for (let x = sx; x < Math.min(box.x1, sx + segW); x++) { const g = gd[y * cw + x]; if (g >= thr + 10) px.push([cd[(y * cw + x) * 4], cd[(y * cw + x) * 4 + 1], cd[(y * cw + x) * 4 + 2]]); } return px; };
    const up = take(box.y0 - strip, box.y0), dn = take(box.y1, box.y1 + strip);
    const m = px => [0, 1, 2].map(i => median(px.map(p => p[i])));
    segs.push({ cx: Math.min(box.x1, sx + segW / 2), up: up.length ? m(up) : null, dn: dn.length ? m(dn) : null });
  }
  for (const s of segs) { s.up = s.up || s.dn; s.dn = s.dn || s.up; }
  const paperRGB = [0, 1, 2].map(i => Math.round(median(segs.flatMap(s => [s.up[i], s.dn[i]]))));
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const colAt = (x, which) => { let a = segs[0], b = segs[segs.length - 1]; for (let i = 0; i < segs.length - 1; i++) if (x >= segs[i].cx && x <= segs[i + 1].cx) { a = segs[i]; b = segs[i + 1]; break; } const t = b.cx === a.cx ? 0 : Math.min(1, Math.max(0, (x - a.cx) / (b.cx - a.cx))); return [0, 1, 2].map(i => a[which][i] * (1 - t) + b[which][i] * t); };
  const inkLeftReal = (() => { for (let x = wb.x0; x < wb.x1; x++) for (let y = bb.y0; y < bb.y1; y++) if (gd[y * cw + x] < thr) return x; return wb.x0; })();
  const drawX = inkLeftReal - (r0.inkLeftRel - 20) * hsWord;
  // LOCAL height/baseline (white-page photos only): the line-level baseline/size are averages over a line that can still
  // be slightly bowed, so anchor the new word to the OLD word it replaces: same baseline, same ink height (same profile code).
  let wordBaseline = meas.baseline, wordSizeK = 1, localFit = null;
  if (paper.textRotation) {
    const ww = wb.x1 - wb.x0, hh = bb.y1 - bb.y0, om = new Uint8Array(cw * ch);
    for (let y = bb.y0; y < bb.y1; y++) for (let x = wb.x0; x < wb.x1; x++) om[y * cw + x] = gd[y * cw + x] < thr ? 1 : 0;
    const po = inkProfile(om, cw, wb.x0, bb.y0, wb.x1, bb.y1);
    const tcv = document.createElement('canvas'); tcv.width = Math.ceil(ww * 1.6) + 40; tcv.height = Math.ceil(hh * 2); const tg = tcv.getContext('2d', { willReadFrequently: true });
    tg.fillStyle = '#fff'; tg.fillRect(0, 0, tcv.width, tcv.height); tg.fillStyle = '#000'; tg.font = `${FT.sizePx}px "${F.family}"`; tg.letterSpacing = `${letterSp}px`; tg.translate(20, hh * 1.3); tg.scale(hsWord, 1); tg.fillText(newSeg, 0, 0);
    const td = tg.getImageData(0, 0, tcv.width, tcv.height).data; const nm = new Uint8Array(tcv.width * tcv.height); for (let i = 0; i < nm.length; i++) nm[i] = td[i * 4] < 128 ? 1 : 0;
    const pn = inkProfile(nm, tcv.width, 0, 0, tcv.width, tcv.height);
    wordSizeK = Math.min(1.12, Math.max(0.88, po.capHeight / pn.capHeight)); wordBaseline = bb.y0 + po.baselineRel;
    localFit = { oldCap: po.capHeight, newCapAtLineSize: pn.capHeight, sizeK: +wordSizeK.toFixed(4), baselineLine: meas.baseline, baselineOldWord: wordBaseline };
  }
  let wpx = FT.strokeWeightPx, gain = 1;
  // sharp glyph coverage at 8x supersampling; weight w>0 dilates, w<0 erodes, by |w|/2 px per side (1/16 px steps),
  // then box-downsampled to 1x. Returned as a float coverage Mat (1 = full ink).
  const SS = 8; const MIN_STROKE_PX = 1.6; const covCache = new Map();
  // continuous weight: linear blend of the two neighbouring 1/16-px morphology steps
  function coverage(w) { const kf = w * SS / 2, k0 = Math.floor(kf), t = kf - k0; const a = coverageK(k0); if (t < 1e-3) return a;
    const b = coverageK(k0 + 1); cv.addWeighted(a, 1 - t, b, t, 0, a); b.delete(); return a; }
  function coverageK(key) {
    if (covCache.has(key)) return covCache.get(key).clone();
    const tc = document.createElement('canvas'); tc.width = bw * SS; tc.height = bh * SS; const tx = tc.getContext('2d', { willReadFrequently: true });
    tx.fillStyle = '#000'; tx.fillRect(0, 0, tc.width, tc.height); tx.fillStyle = '#fff'; tx.font = `${FT.sizePx * wordSizeK * SS}px "${F.family}"`; tx.textBaseline = 'alphabetic';
    tx.letterSpacing = `${letterSp * SS}px`; tx.translate((drawX - box.x0) * SS, (wordBaseline - box.y0) * SS); tx.scale(hsWord / wordSizeK, 1); tx.fillText(newSeg, 0, 0);
    const m = cv.imread(tc), g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY); m.delete();
    const g0 = key < 0 ? g.clone() : null;
    const r = Math.abs(key); if (r > 0) { const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1)); (key > 0 ? cv.dilate : cv.erode)(g, g, k); k.delete(); }
    if (g0) { // hairline guard: strokes thinner than MIN_STROKE_PX (x diagonals, serifs) must not be eroded away or thinned
      // below it. hair = original minus its opening at the minimum width; the guard keeps hair at >= MIN_STROKE_PX.
      const rm = Math.round(MIN_STROKE_PX * SS / 2); const km = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * rm + 1, 2 * rm + 1));
      const op = new cv.Mat(); cv.erode(g0, op, km); cv.dilate(op, op, km); const hair = new cv.Mat(); cv.subtract(g0, op, hair);
      const kg = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * Math.round(MIN_STROKE_PX * SS / 4) + 1, 2 * Math.round(MIN_STROKE_PX * SS / 4) + 1)); cv.dilate(hair, hair, kg);
      cv.min(hair, g0, hair); cv.max(g, hair, g); [km, kg, op, hair, g0].forEach(x => x.delete()); }
    const sm = new cv.Mat(); cv.resize(g, sm, new cv.Size(bw, bh), 0, 0, cv.INTER_AREA); g.delete();
    const f = new cv.Mat(); sm.convertTo(f, cv.CV_32F, 1 / 255, 0); sm.delete(); covCache.set(key, f); return f.clone();
  }
  // background under the old word: inpaint (Telea) the old ink out of the ORIGINAL pixels, so the paper keeps its real
  // tone, gradients and tints (e.g. a highlighter edge); plus a spatially correlated noise field like the scan's
  const bgGrayAt = i => 0.299 * bgInfo.bg[i * 3] + 0.587 * bgInfo.bg[i * 3 + 1] + 0.114 * bgInfo.bg[i * 3 + 2];
  const bgInfo = (() => {
    // Work on the box plus a 14-px ring so the paper statistics come from real surrounding paper.
    const R = 14, ex0 = Math.max(0, box.x0 - R), ey0 = Math.max(0, box.y0 - R), ex1 = Math.min(cw, box.x1 + R), ey1 = Math.min(ch, box.y1 + R), ew = ex1 - ex0, eh = ey1 - ey0;
    const ox = box.x0 - ex0, oy = box.y0 - ey0;
    const r = corr.roi(new cv.Rect(ex0, ey0, ew, eh)); const rgb = new cv.Mat(); cv.cvtColor(r, rgb, cv.COLOR_RGBA2RGB); r.delete();
    const g = new cv.Mat(); cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY);
    // local paper level per pixel: grey closing (max then min filter) wider than any stroke, then smoothed. Ink =
    // clearly darker than its own local paper, so a lighting gradient never turns paper into "ink".
    const kc = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(9, Math.round(0.6 * lh)) | 1, Math.max(9, Math.round(0.6 * lh)) | 1));
    const lp = new cv.Mat(); cv.morphologyEx(g, lp, cv.MORPH_CLOSE, kc); kc.delete(); cv.GaussianBlur(lp, lp, new cv.Size(0, 0), 2);
    // paper noise of this neighbourhood (pixels within 3 of local paper level) sets the ink threshold
    const pv = []; for (let i = 0; i < ew * eh; i++) { const d = g.data[i] - lp.data[i]; if (d > -3 * 2.5) pv.push(d); }
    const pm = pv.reduce((a, b) => a + b, 0) / pv.length, psd = Math.sqrt(pv.reduce((a, b) => a + (b - pm) ** 2, 0) / pv.length);
    const delta = Math.max(4, 3 * psd, 0.04 * (paperLvl - target.inkMedianGray));
    // coloured marks (handwriting, highlighter strokes, stamps) are never part of a printed word: chroma > 40
    const hand = new cv.Mat(eh, ew, cv.CV_8U); let handN = 0; for (let i = 0; i < ew * eh; i++) { const r_ = rgb.data[i * 3], g_ = rgb.data[i * 3 + 1], b_ = rgb.data[i * 3 + 2]; const c_ = Math.max(r_, g_, b_) - Math.min(r_, g_, b_); hand.data[i] = c_ > 40 && g.data[i] < lp.data[i] - delta ? 255 : 0; handN += hand.data[i] ? 1 : 0; }
    const kh = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); const handD = new cv.Mat(); cv.dilate(hand, handD, kh); kh.delete();
    const inkM = new cv.Mat(eh, ew, cv.CV_8U); for (let i = 0; i < ew * eh; i++) inkM.data[i] = g.data[i] < lp.data[i] - delta && !hand.data[i] ? 255 : 0;
    // only ink blobs that belong to the old word are removed: connected components touching the old word's box.
    // Letters of neighbouring lines or words that poke into the patch box stay exactly as they are.
    // PHOTOS: the weak ink mask (3 sigma of paper noise) also catches smudges, shadow and JPEG blotches of the paper, and a
    // component that touches the word then drags them into the repaint (ragged, tinted patches). Own components are therefore
    // taken from STRONG ink only (>= 30% of the ink contrast); the soft stroke edge is covered by a dilation sized to the edge.
    const isPhoto = !/full image/.test(paper.method || ''); let ownSrc = inkM; let strongM = null;
    if (isPhoto) { const sthr = Math.max(delta, 0.3 * (paperLvl - target.inkMedianGray)); strongM = new cv.Mat(eh, ew, cv.CV_8U); for (let i = 0; i < ew * eh; i++) strongM.data[i] = g.data[i] < lp.data[i] - sthr && !hand.data[i] ? 255 : 0; ownSrc = strongM; }
    const lab = new cv.Mat(); const nLab = cv.connectedComponents(ownSrc, lab, 8, cv.CV_32S); const own = new Uint8Array(nLab);
    const wy0 = Math.min(...eWords.map(w => w.bbox.y0)), wy1 = Math.max(...eWords.map(w => w.bbox.y1));
    for (let y = Math.max(0, wy0 - ey0); y < Math.min(eh, wy1 - ey0); y++) for (let x = Math.max(0, wb.x0 - ex0); x < Math.min(ew, wb.x1 - ex0); x++) own[lab.data32S[y * ew + x]] = 1; own[0] = 0;
    const oldInk = new cv.Mat(eh, ew, cv.CV_8U); for (let i = 0; i < ew * eh; i++) oldInk.data[i] = own[lab.data32S[i]] ? 255 : 0; lab.delete();
    const kd0sz = isPhoto ? Math.max(7, 2 * Math.ceil(1.6 * (target.edge || 3)) + 1) : 7; const kd0 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kd0sz, kd0sz)); const oldD = new cv.Mat(); cv.dilate(oldInk, oldD, kd0); kd0.delete(); oldInk.delete();
    if (isPhoto) { // chroma halo: JPEG 4:2:0 spreads the ink's colour cast several px beyond the strokes (pinkish/greenish fringes). Pixels
      // near the old word whose chroma (R-G, B-G) differs from the paper's median chroma are repainted with the word.
      const k21 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21)), k25 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(25, 25));
      const near = new cv.Mat(), far = new cv.Mat(); cv.dilate(oldD, near, k21); cv.dilate(strongM, far, k25); k21.delete(); k25.delete();
      const A = [], B = []; for (let i = 0; i < ew * eh; i += 2) if (!far.data[i]) { A.push(rgb.data[i * 3] - rgb.data[i * 3 + 1]); B.push(rgb.data[i * 3 + 2] - rgb.data[i * 3 + 1]); }
      if (A.length > 200) { const mA = median(A), mB = median(B); const dev = A.map((v, i) => Math.abs(v - mA) + Math.abs(B[i] - mB)); const mad = median(dev); const thr = 6 + 3 * mad; let added = 0;
        for (let i = 0; i < ew * eh; i++) if (near.data[i] && !oldD.data[i] && !hand.data[i]) { const d = Math.abs(rgb.data[i * 3] - rgb.data[i * 3 + 1] - mA) + Math.abs(rgb.data[i * 3 + 2] - rgb.data[i * 3 + 1] - mB); if (d > thr) { oldD.data[i] = 255; added++; } }
        const kc = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)); cv.morphologyEx(oldD, oldD, cv.MORPH_CLOSE, kc); kc.delete(); }
      near.delete(); far.delete(); }
    // dilate: letter pixels + their soft edge + JPEG ringing never feed the inpaint or the paper sample
    const kdsz = isPhoto ? kd0sz : 7; const kd = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kdsz, kdsz)); const inkD = new cv.Mat(); cv.dilate(isPhoto ? strongM : inkM, inkD, kd); kd.delete(); // photos: only STRONG ink is withheld from the paper model, so natural paper mottling stays in it (no lighter halo)
    // inpaint mask = dilated ink INSIDE the box only (outside the box nothing is touched)
    const m = new cv.Mat(eh, ew, cv.CV_8U); m.data.fill(0); for (let y = oy; y < oy + bh; y++) for (let x = ox; x < ox + bw; x++) m.data[y * ew + x] = oldD.data[y * ew + x] && !handD.data[y * ew + x] ? 255 : 0;
    if (isPhoto) { const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)); cv.dilate(m, m, k5); k5.delete(); for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) { const e = y * ew + x; if (!(y >= oy && y < oy + bh && x >= ox && x < ox + bw) || handD.data[e]) m.data[e] = 0; } } // +2 px so the feather below sits outside the old ink
    for (let i = 0; i < ew * eh; i++) if (handD.data[i]) inkD.data[i] = 255; // coloured marks never feed the inpaint
    const handInBox = new Uint8Array(bw * bh); let handInBoxN = 0; for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (handD.data[(y + oy) * ew + x + ox]) { handInBox[y * bw + x] = 1; handInBoxN++; }
    // source for the inpaint = plain paper only: every dilated-ink pixel (inside or outside the box) is masked, so the
    // smooth base is built from paper alone; Telea gives the low-frequency paper (tone, tint, lighting gradient)
    const out = new cv.Mat(); cv.inpaint(rgb, inkD, out, 6, cv.INPAINT_TELEA);
    const sm = new cv.Mat(); cv.GaussianBlur(out, sm, new cv.Size(0, 0), 2.5);
    // grain: residuals (pixel - smooth paper) of plain-paper pixels in the neighbourhood, resampled into the masked
    // pixels in small 2x2 tiles (keeps the scan's pixel-to-pixel correlation and its clipping at white)
    // grain donors: paper at least 7 px from any ink (letters' JPEG ringing reaches ~5 px), and not inside the box
    const kf = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15)); const inkF = new cv.Mat(); cv.dilate(inkD, inkF, kf); kf.delete();
    const pool = []; for (let y = 1; y < eh - 2; y++) for (let x = 1; x < ew - 2; x++) { const i = y * ew + x; if (inkF.data[i] || inkF.data[i + 1] || inkF.data[i + ew] || inkF.data[i + ew + 1]) continue; if (x >= ox && x < ox + bw && y >= oy && y < oy + bh && m.data[i]) continue; pool.push(i); }
    if (pool.length < 50) for (let y = 1; y < eh - 1; y++) for (let x = 1; x < ew - 1; x++) { const i = y * ew + x; if (!inkD.data[i]) pool.push(i); }
    const rnd = mulberry32(4242); const bg = new Float32Array(bw * bh * 3); const im = new Float32Array(bw * bh); let n = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const j = y * bw + x, e = (y + oy) * ew + x + ox; for (let q = 0; q < 3; q++) bg[j * 3 + q] = rgb.data[e * 3 + q]; }
    for (let ty = 0; ty < bh; ty += 2) for (let tx = 0; tx < bw; tx += 2) {
      let any = false; for (let y = ty; y < Math.min(bh, ty + 2); y++) for (let x = tx; x < Math.min(bw, tx + 2); x++) if (m.data[(y + oy) * ew + x + ox]) any = true; if (!any) continue;
      const s = pool[Math.floor(rnd() * pool.length)]; const sy = Math.floor(s / ew), sx = s % ew;
      for (let y = ty; y < Math.min(bh, ty + 2); y++) for (let x = tx; x < Math.min(bw, tx + 2); x++) { const e = (y + oy) * ew + x + ox; if (!m.data[e]) continue;
        const ss = Math.min(eh - 1, sy + y - ty) * ew + Math.min(ew - 1, sx + x - tx); const src = inkF.data[ss] ? s : ss;
        for (let q = 0; q < 3; q++) bg[(y * bw + x) * 3 + q] = Math.max(0, Math.min(255, sm.data[e * 3 + q] + (rgb.data[src * 3 + q] - sm.data[src * 3 + q]))); im[y * bw + x] = 1; n++; } }
    if (isPhoto) { // 2-4 px feather: blend repainted paper into the untouched pixels with a soft mask (gradient and grain carry across)
      const mf = new cv.Mat(); m.convertTo(mf, cv.CV_32F, 1 / 255); cv.GaussianBlur(mf, mf, new cv.Size(0, 0), 1.0);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const e = (y + oy) * ew + x + ox; if (!m.data[e]) continue; const a = Math.min(1, mf.data32F[e]); const j = y * bw + x; for (let q = 0; q < 3; q++) bg[j * 3 + q] = rgb.data[e * 3 + q] * (1 - a) + bg[j * 3 + q] * a; }
      mf.delete(); }
    const dbgM = m.roi(new cv.Rect(ox, oy, bw, bh)); const dbgO = new cv.Mat(); { const t = rgb.roi(new cv.Rect(ox, oy, bw, bh)); dbgO.create(bh, bw, cv.CV_8UC3); t.copyTo(dbgO); t.delete(); }
    const bgC = document.createElement('canvas'); bgC.width = bw; bgC.height = bh; { const D = bgC.getContext('2d').createImageData(bw, bh); for (let i = 0; i < bw * bh; i++) { for (let q = 0; q < 3; q++) D.data[i * 4 + q] = bg[i * 3 + q]; D.data[i * 4 + 3] = 255; } bgC.getContext('2d').putImageData(D, 0, 0); }
    const dbg = { thr: `local paper (grey closing) - ${delta.toFixed(1)}`, localPaper: +(lp.data[(oy + (bh >> 1)) * ew + ox + (bw >> 1)]).toFixed(1), maskCanvas: matToCanvas(cv, dbgM), bgCanvas: bgC, srcCanvas: matToCanvas(cv, dbgO) };
    // ink noise field (new ink only)
    const nz = new cv.Mat(bh, bw, cv.CV_32F); const rn2 = mulberry32(99); for (let i = 0; i < bw * bh; i++) nz.data32F[i] = Math.sqrt(-2 * Math.log(rn2() + 1e-12)) * Math.cos(2 * Math.PI * rn2());
    cv.GaussianBlur(nz, nz, new cv.Size(0, 0), 0.7); let s2 = 0; for (let i = 0; i < bw * bh; i++) s2 += nz.data32F[i] ** 2; const ns = Math.sqrt(s2 / (bw * bh)); const field = Float32Array.from(nz.data32F, v => v / ns);
    [rgb, g, lp, hand, handD, inkM, inkD, inkF, oldD, m, out, sm, nz, dbgM, dbgO].forEach(x => x.delete()); if (strongM) strongM.delete();
    return { bg, handInBox, handInBoxN, inpaintMask: im, inpaintPixels: n, localPaperNoiseStd: +psd.toFixed(3), inkDelta: +delta.toFixed(2), grainPoolPixels: pool.length, field, dbg };
  })();
  function compose(color, sigma, noiseSd, seed = 1234) {
    const c = document.createElement('canvas'); c.width = bw; c.height = bh; const x = c.getContext('2d', { willReadFrequently: true });
    const fill = x.createImageData(bw, bh); for (let i = 0; i < bw * bh; i++) { for (let q = 0; q < 3; q++) fill.data[i * 4 + q] = bgInfo.bg[i * 3 + q]; fill.data[i * 4 + 3] = 255; }
    x.putImageData(fill, 0, 0);
    // text coverage rendered sharp, then blurred with a continuous-sigma Gaussian (OpenCV), then composited:
    // pixel = paper * (1 - a) + ink * a   (canvas filter blur() only steps in whole pixels, too coarse here)
    const tf = coverage(wpx); // stroke weight (erode/dilate) applied to the SHARP glyphs, before any blur
    if (sigma > 0) cv.GaussianBlur(tf, tf, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
    if (gain !== 1) { const d = tf.data32F; for (let i = 0; i < d.length; i++) d[i] = Math.min(1, d[i] * gain); }
    const D0 = x.getImageData(0, 0, bw, bh); const al = tf.data32F;
    for (let i = 0; i < bw * bh; i++) { const a = Math.max(0, Math.min(1, al[i])); for (let q = 0; q < 3; q++) D0.data[i * 4 + q] = D0.data[i * 4 + q] * (1 - a) + Math.max(0, Math.min(255, color[q])) * a; }
    // noise only where pixels are new (inpainted paper or new ink); untouched paper keeps its own grain
    if (noiseSd > 0) for (let i = 0; i < bw * bh; i++) { const aa = Math.min(1, Math.max(0, al[i])); const nsd = aa * noiseSd; if (!nsd) continue; const n = bgInfo.field[i] * nsd; for (let q = 0; q < 3; q++) D0.data[i * 4 + q] = Math.max(0, Math.min(255, D0.data[i * 4 + q] + n)); }
    x.putImageData(D0, 0, 0); tf.delete();
    return c;
  }
  const innerRect = { x0: box.x0 + 1, y0: box.y0 + 1, x1: box.x1 - 1, y1: box.y1 - 1 };
  const measure = c => stats(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data, bw, innerRect, box.x0, box.y0);
  // a)+b) alternate: blur sigma to match the untouched words' 10-90% edge width, then ink colour and noise so the new
  //       word's MEASURED ink median and noise std match the untouched words; repeat (each changes the others).
  let color = target.inkRGB.slice(), noiseSd = target.noise || 0, sigma = 0; const iters = []; let sigmaTrials = [];
  let colourTarget = '';
  function strokeW(g, w, h, thr, rect) { const r = rect || { x0: 0, y0: 0, x1: w, y1: h }; let A = 0, P = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { if (g(y * w + x) >= thr) continue; A++;
      if (x === r.x0 || y === r.y0 || x === r.x1 - 1 || y === r.y1 - 1 || g(y * w + x - 1) >= thr || g(y * w + x + 1) >= thr || g((y - 1) * w + x) >= thr || g((y + 1) * w + x) >= thr) P++; }
    return P ? 2 * A / P : 0; }
  const swThr = (paperLvl + Math.min(...target.inkP10RGB)) / 2;
  target.strokeWidth = median(uWords.map(w => strokeW(i => gd[i], cw, ch, swThr, w.bbox)));
  for (let it = 0; it < 6; it++) {
    // 1) stroke weight FIRST, on a blur-invariant measure: ink mass = sum(paper - pixel) per px of word width
    //    (a Gaussian blur moves ink around but keeps its total). Bisection on w with the current colour, no blur.
    { // stroke width at the 50% level between paper and ink core: 2 * area / boundary pixels. A Gaussian blur keeps
      // the 50% contour of a stroke in place, so this measure is (nearly) blur-invariant and can be fitted first.
      const swOf = c => { const D = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data; return strokeW(i => grayAt(D, i), bw, bh, swThr); };
      let lo = -3, hi = 4;
      for (let k = 0; k < 10; k++) { wpx = (lo + hi) / 2; const v = swOf(compose(color, sigma, 0)); if (v < target.strokeWidth) lo = wpx; else hi = wpx; }
      wpx = (lo + hi) / 2; }
    sigmaTrials = [];
    for (let sg = 0; sg <= 4.001; sg += 0.1) { const st = measure(compose(color, sg, noiseSd)); sigmaTrials.push([+sg.toFixed(2), st.edge10_90px]); }
    sigma = sigmaTrials.filter(t => t[1] != null).reduce((a, b) => Math.abs(b[1] - target.edge) < Math.abs(a[1] - target.edge) ? b : a)[0];
    const st = measure(compose(color, sigma, noiseSd)); iters.push({ sigma, color: color.map(Math.round), noiseSd: +noiseSd.toFixed(2), measured: st });
    // colour drives the stroke-core tone (10th percentile of ink), stroke weight drives the ink MEDIAN
    // when the scan clips stroke cores to black (p10 ~ 0) the p10 carries no information; match the ink MEDIAN then
    const p10Clipped = Math.max(...target.inkP10RGB) <= 8; colourTarget = p10Clipped ? 'ink median (p10 clipped to black)' : 'ink p10';
    color = p10Clipped ? color.map((v, c) => v + (target.inkRGB[c] - st.inkMedianRGB[c])) : color.map((v, c) => v + (target.inkP10RGB[c] - st.inkP10RGB[c]));
    // noise is not iterated: new ink gets the untouched words' measured noise, inpainted paper the local paper noise
    iters[iters.length - 1].strokeWeightPx = +wpx.toFixed(3);
  }
  const sharpestU0 = Math.min(...uStats.map(s => s.edge10_90px).filter(v => v != null));
  // ---- joint fit of stroke weight, blur, ink saturation (gain) and colour ----
  // Targets from the untouched printed words on this segment:
  //   stem width at the 50% level (2*area/boundary), the median of the STROKE CORES (ink mask eroded by 1 px, so only
  //   the middle of each stroke counts), and the 10-90% edge width. The new word may not be sharper than the sharpest
  //   untouched word. Model per pixel: a = min(1, gain * G_sigma * cov_w), pixel = paper*(1-a) + ink*a. gain > 1
  //   models the scanner's tone curve saturating stroke cores (dark cores with soft edges).
  const coreVals = (gAt, w, rect) => { const out = []; for (let y = rect.y0 + 1; y < rect.y1 - 1; y++) for (let x = rect.x0 + 1; x < rect.x1 - 1; x++) { let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (gAt((y + dy) * w + x + dx) >= swThr) { ok = false; break; } if (ok) out.push(gAt(y * w + x)); } return out; };
  const deepThr = 0.22 * paperLvl; const deepFrac = (gAt, w, rect) => { let a = 0, d = 0; for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) { const v = gAt(y * w + x); if (v < swThr) { a++; if (v < deepThr) d++; } } return a ? d / a : 0; };
  // thick-stroke cores of each NEIGHBOURING word separately (not a line average): we match the median of the neighbours' deep-core fractions
  target.deepFracPerWord = uWords.map(w => ({ text: w.text, deepFrac: +deepFrac(i => gd[i], cw, w.bbox).toFixed(3) })); target.deepFrac = median(target.deepFracPerWord.map(x => x.deepFrac));
  target.coreMedianGray = median(uWords.flatMap(w => coreVals(i => gd[i], cw, w.bbox)));
  const grayOfC = c => { const D = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data; return i => grayAt(D, i); };
  const evalC = c => { const gA = grayOfC(c); const cv_ = coreVals(gA, bw, { x0: 0, y0: 0, x1: bw, y1: bh }); const st = measure(c);
    return { deep: deepFrac(gA, bw, { x0: 0, y0: 0, x1: bw, y1: bh }), stem: strokeW(gA, bw, bh, swThr), core: cv_.length ? median(cv_) : null, coreN: cv_.length, edge: st.edge10_90px, med: 0.299 * st.inkMedianRGB[0] + 0.587 * st.inkMedianRGB[1] + 0.114 * st.inkMedianRGB[2], st }; };
  const targetMed = 0.299 * target.inkRGB[0] + 0.587 * target.inkRGB[1] + 0.114 * target.inkRGB[2];
  const hue = target.inkRGB.map(v => v - (0.299 * target.inkRGB[0] + 0.587 * target.inkRGB[1] + 0.114 * target.inkRGB[2]));
  const colOf = gv => hue.map(h => gv + h);
  let inkGray = target.coreMedianGray; gain = 1; const fitLog = [];
  const sgC = sigma; const sgs = []; for (let s_ = Math.max(0, sgC - 1.2); s_ <= sgC + 1.5001; s_ += 0.05) sgs.push(+s_.toFixed(2));
  let best = null; const fitCands = [];
  for (const sg of sgs) for (const gn of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.1, 2.5, 3, 3.5, 4, 5]) {
    let ig = target.coreMedianGray, w_ = wpx, r = null;
    // weight first (stem), then the ink TONE through the colour; repeat, and finish with a weight fit so the stem is
    // what the colour step left exact
    const fitW = () => { let lo = -3, hi = 8; for (let k = 0; k < 11; k++) { w_ = (lo + hi) / 2; wpx = w_; gain = gn; const e = evalC(compose(colOf(ig), sg, noiseSd)); if (e.stem < target.strokeWidth) lo = w_; else hi = w_; } w_ = (lo + hi) / 2; };
    for (let pass = 0; pass < 3; pass++) {
      fitW(); wpx = w_; gain = gn; r = evalC(compose(colOf(ig), sg, noiseSd)); if (r.core == null) break;
      const toneErr = Math.max(...target.inkP10RGB) <= 8 ? (targetMed - r.med) : (target.coreMedianGray - r.core);
      ig = Math.max(0, Math.min(255, ig + toneErr));
    }
    fitW(); wpx = w_; gain = gn; r = evalC(compose(colOf(ig), sg, noiseSd)); if (r.core == null || r.edge == null) continue;
    const okSharp = r.edge >= sharpestU0 + 0.01;
    const cost = Math.abs(r.deep - target.deepFrac) / 0.03 + Math.abs(r.core - target.coreMedianGray) / 4 + Math.abs(r.med - targetMed) / 3 + Math.abs(r.stem - target.strokeWidth) / 0.1 + Math.abs(r.edge - target.edge) / 0.15 + (okSharp ? 0 : 100) + 0.05 * (gn - 1) + (gn > 2.1 ? 3 * (gn - 2.1) : 0) + (w_ < -1.25 ? 4 * (-1.25 - w_) : 0); // keep letters whole: no heavy erosion + saturation combos
    fitCands.push({ sg, gn, med: +r.med.toFixed(1), stem: +r.stem.toFixed(3), edge: r.edge, core: r.core, ok: okSharp });
    if (!best || cost < best.cost) best = { cost, sg, gn, w: w_, ig, core: r.core, inkMedian: r.med, stem: r.stem, edge: r.edge };
  }
  sigma = best.sg; gain = best.gn; wpx = best.w; inkGray = best.ig; color = colOf(inkGray);
  fitLog.push({ ...best, candidatesTried: fitCands.length, nearMisses: fitCands.filter(c => c.ok && Math.abs(c.med - targetMed) <= 3).sort((a, b) => Math.abs(a.edge - target.edge) - Math.abs(b.edge - target.edge)).slice(0, 6) });
  // ---- patch boundary: gradient-domain (membrane) correction + 3-px feather ----
  // The composed box keeps its own gradients; the low-frequency difference to the original along the 1-px border
  // (smoothed along the border so grain is not smeared inward) is spread over the box by solving Laplace's equation
  // (Jacobi), i.e. a Poisson blend with the composed image as guidance field. Then the outer 3 px fade from original
  // to patch. The box is axis-aligned in the deskewed page, so in the stored image the blend follows the page tilt.
  function blendEdge(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true }); const C = ctx.getImageData(0, 0, bw, bh);
    const O = corrCanvas.getContext('2d', { willReadFrequently: true }).getImageData(box.x0, box.y0, bw, bh).data;
    const border = []; for (let x = 0; x < bw; x++) border.push([x, 0]); for (let y = 1; y < bh; y++) border.push([bw - 1, y]); for (let x = bw - 2; x >= 0; x--) border.push([x, bh - 1]); for (let y = bh - 2; y > 0; y--) border.push([0, y]);
    // Dirichlet boundary = the original pixels on the 1-px border (textbook Poisson clone: the composed box keeps its own
    // gradients, its border is pinned to the original). The difference is median-smoothed over 5 border pixels so the
    // grain of single border pixels is not smeared inward; the 3-px feather then carries the original grain across.
    const dRaw = border.map(([x, y]) => { const i = (y * bw + x) * 4; return [0, 1, 2].map(q => O[i + q] - C.data[i + q]); });
    const K = 2, nb = border.length; const dS = dRaw.map((_, k) => [0, 1, 2].map(q => { const v = []; for (let t = -K; t <= K; t++) v.push(dRaw[(k + t + nb) % nb][q]); return median(v); }));
    let maxAbsBorderDiff = 0; dS.forEach(d => d.forEach(v => { maxAbsBorderDiff = Math.max(maxAbsBorderDiff, Math.abs(v)); }));
    const M = [0, 1, 2].map(() => new Float32Array(bw * bh)); const fixed = new Uint8Array(bw * bh);
    border.forEach(([x, y], k) => { fixed[y * bw + x] = 1; for (let q = 0; q < 3; q++) M[q][y * bw + x] = dS[k][q]; });
    if (maxAbsBorderDiff > 0.25) for (let q = 0; q < 3; q++) { const m = M[q]; const tmp = new Float32Array(bw * bh);
      for (let it = 0; it < 1500; it++) { for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) { const i = y * bw + x; tmp[i] = (m[i - 1] + m[i + 1] + m[i - bw] + m[i + bw]) / 4; } for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) { const i = y * bw + x; m[i] = tmp[i]; } } }
    const FE = 3; for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = y * bw + x, d = Math.min(x, y, bw - 1 - x, bh - 1 - y); const w = d >= FE ? 1 : (d + 1) / (FE + 1);
      for (let q = 0; q < 3; q++) { const v = C.data[i * 4 + q] + M[q][i]; C.data[i * 4 + q] = Math.max(0, Math.min(255, O[i * 4 + q] * (1 - w) + v * w)); } }
    ctx.putImageData(C, 0, 0); const dbgTop = border.map(([x, y], k) => ({ x, y, d: dS[k].map(Math.round), raw: dRaw[k] && dRaw[k].map(Math.round) })).sort((a, b) => Math.abs(b.d[1]) - Math.abs(a.d[1])).slice(0, 8);
    return { dbgTop, bw, bh, membraneMaxAbsBorderDiff: +maxAbsBorderDiff.toFixed(2), featherPx: FE, method: 'Poisson clone: Laplace membrane (Jacobi, 1500 it) pinned to the original along the border (5-px median), then 3-px linear feather' };
  }
  // finalise = compose + patch-edge blend + coloured-mark restore; then the stem is calibrated on exactly this output
  // (the same box metric the report uses): the weight is nudged until the final stem matches the untouched words
  const buildFinal = () => {
    const finalCanvas = compose(color, sigma, noiseSd); const edgeBlend = blendEdge(finalCanvas); const handKeep = (() => { // coloured marks inside the box are restored from the original, pixel for pixel
    const ctx = finalCanvas.getContext('2d', { willReadFrequently: true }); const C = ctx.getImageData(0, 0, bw, bh); const O = corrCanvas.getContext('2d', { willReadFrequently: true }).getImageData(box.x0, box.y0, bw, bh).data;
    let changedBefore = 0; for (let i = 0; i < bw * bh; i++) if (bgInfo.handInBox[i]) { if (Math.abs(C.data[i * 4] - O[i * 4]) + Math.abs(C.data[i * 4 + 1] - O[i * 4 + 1]) + Math.abs(C.data[i * 4 + 2] - O[i * 4 + 2]) > 0) changedBefore++; for (let q = 0; q < 4; q++) C.data[i * 4 + q] = O[i * 4 + q]; }
    ctx.putImageData(C, 0, 0); return { colouredMarkPixelsInBox: bgInfo.handInBoxN, restoredFromOriginal: changedBefore }; })();
    return { finalCanvas, edgeBlend, handKeep }; };
  let _f = buildFinal(); const finStem = () => strokeW(i => grayAt(_f.finalCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data, i), bw, bh, swThr);
  const stemCal = [];
  // word-only stem (same region as the visual table) AND edge width: both pulled to the untouched words' values
  const wordRect = { x0: Math.max(0, wb.x0 - 3 - box.x0), y0: 0, x1: Math.min(bw, wb.x1 + 3 - box.x0), y1: bh };
  const sharpestNb = Math.min(...uStats.map(s => s.edge10_90px).filter(v => v != null));
  for (let it = 0; it < 14; it++) { const D = _f.finalCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data;
    const sNow = strokeW(i => grayAt(D, i), bw, bh, swThr, wordRect); const eNow = measure(_f.finalCanvas).edge10_90px;
    stemCal.push({ weightPx: +wpx.toFixed(3), sigma: +sigma.toFixed(3), wordStem: +sNow.toFixed(3), edge: eNow == null ? null : +eNow.toFixed(3) });
    const stemOk = Math.abs(sNow - target.strokeWidth) <= 0.01 * target.strokeWidth;
    const edgeOk = eNow == null || (eNow >= Math.max(sharpestNb, target.edge) - 0.05 && eNow <= target.edge + 0.25);
    if (stemOk && edgeOk) break;
    if (!stemOk) wpx += (target.strokeWidth - sNow) * 0.45;
    if (!edgeOk && eNow != null) sigma = Math.max(0, sigma + (Math.max(sharpestNb, target.edge) - eNow) * 0.3);
    _f = buildFinal(); }
  const { finalCanvas, edgeBlend, handKeep } = _f; const newStats = measure(finalCanvas); const finalCanvasData = finalCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bw, bh).data;
  const sharpestUntouched = Math.min(...uStats.map(s => s.edge10_90px).filter(v => v != null));
  const look = { target, untouchedWords: uStats, newWord: { text: newSeg, ...newStats }, drawnColor: color.map(v => Math.round(Math.max(0, Math.min(255, v)))), drawnColorUnclamped: color.map(Math.round), blurSigmaPx: sigma, strokeWeightPx: +wpx.toFixed(2), inkGain: gain, jointFit: fitLog[0], stemCalibration: stemCal, deepCores: { thresholdGray: +deepThr.toFixed(1), neighbours: target.deepFracPerWord, neighbourMedian: target.deepFrac, newWord: +deepFrac(grayOfC(finalCanvas), bw, { x0: 0, y0: 0, x1: bw, y1: bh }).toFixed(3) }, edgeBlend, handKeep, coreMedian: { untouched: +target.coreMedianGray.toFixed(1), newWord: (() => { const v = coreVals(grayOfC(finalCanvas), bw, { x0: 0, y0: 0, x1: bw, y1: bh }); return v.length ? median(v) : null; })() }, paperRebuild: { inkDelta: bgInfo.inkDelta, grainPoolPixels: bgInfo.grainPoolPixels, inpaintPixels: bgInfo.inpaintPixels }, sigmaTrials, addedNoiseSd: +noiseSd.toFixed(3), iterations: iters,
    newWordIsSharpestOnLine: newStats.edge10_90px != null && newStats.edge10_90px < sharpestUntouched - 0.005, sharpestUntouchedEdgePx: sharpestUntouched,
    levels: { paper: paperLvl, ink10pct: inkLvl, l10: +l10.toFixed(1), l90: +l90.toFixed(1) } };
  const inkFitRGB = color.map(v => Math.round(Math.max(0, Math.min(255, v))));

  // 8) put the composed box into the deskewed page copy
  const edited = document.createElement('canvas'); edited.width = cw; edited.height = ch;
  const ectx = edited.getContext('2d', { willReadFrequently: true }); ectx.drawImage(corrCanvas, 0, 0); ectx.drawImage(finalCanvas, box.x0, box.y0);
  const blurPx = sigma;
  tick('edit', t0); t0 = performance.now();

  // 9) map the painted box back onto the ORIGINAL image: patch = warp(edited) inside warp(box mask); alpha 0 elsewhere
  const boxCorners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
  const mi = Array.from(Minv.data64F); const back = ([x, y]) => { const w = mi[6] * x + mi[7] * y + mi[8]; return [(mi[0] * x + mi[1] * y + mi[2]) / w, (mi[3] * x + mi[4] * y + mi[5]) / w]; };
  const poly = boxCorners.map(back);
  const px0 = Math.max(0, Math.floor(Math.min(...poly.map(p => p[0]))) - 1), py0 = Math.max(0, Math.floor(Math.min(...poly.map(p => p[1]))) - 1);
  const px1 = Math.min(W, Math.ceil(Math.max(...poly.map(p => p[0]))) + 1), py1 = Math.min(H, Math.ceil(Math.max(...poly.map(p => p[1]))) + 1);
  const PW = px1 - px0, PH = py1 - py0;
  const Tm = cv.matFromArray(3, 3, cv.CV_64F, [1, 0, -px0, 0, 1, -py0, 0, 0, 1]); const Hp = new cv.Mat(); cv.gemm(Tm, Minv, 1, new cv.Mat(), 0, Hp);
  const editedMat = cv.imread(edited); const patchMat = new cv.Mat();
  cv.warpPerspective(editedMat, patchMat, Hp, new cv.Size(PW, PH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const boxMask = cv.Mat.zeros(ch, cw, cv.CV_8UC1); cv.rectangle(boxMask, new cv.Point(box.x0, box.y0), new cv.Point(box.x1 - 1, box.y1 - 1), new cv.Scalar(255), -1);
  const pMask = new cv.Mat(); cv.warpPerspective(boxMask, pMask, Hp, new cv.Size(PW, PH), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  // the patch only covers pixels the edit actually changed (warp(edited) != warp(unedited), +1 px), never a coloured mark
  // of the ORIGINAL image (handwriting, stamps): those stay bit-identical even inside the box
  { const corrMat = cv.imread(corrCanvas); const po = new cv.Mat(); cv.warpPerspective(corrMat, po, Hp, new cv.Size(PW, PH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0)); corrMat.delete();
    const ch_ = new cv.Mat(PH, PW, cv.CV_8U); for (let i = 0; i < PW * PH; i++) { let d = 0; for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(patchMat.data[i * 4 + c] - po.data[i * 4 + c])); ch_.data[i] = d > 0 ? 255 : 0; }
    const k1 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(ch_, ch_, k1);
    const O = origCanvas.getContext('2d', { willReadFrequently: true }).getImageData(px0, py0, PW, PH).data; const colr = new cv.Mat(PH, PW, cv.CV_8U);
    for (let i = 0; i < PW * PH; i++) { const c_ = Math.max(O[i * 4], O[i * 4 + 1], O[i * 4 + 2]) - Math.min(O[i * 4], O[i * 4 + 1], O[i * 4 + 2]); colr.data[i] = c_ > 40 ? 255 : 0; }
    const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(colr, colr, k2);
    var colouredExcluded = 0; for (let i = 0; i < PW * PH; i++) { if (pMask.data[i] && colr.data[i]) colouredExcluded++; pMask.data[i] = pMask.data[i] && ch_.data[i] && !colr.data[i] ? 255 : 0; }
    [po, ch_, k1, colr, k2].forEach(m => m.delete()); }
  const patch = new ImageData(PW, PH); let maskCount = 0;
  for (let i = 0; i < PW * PH; i++) { if (pMask.data[i]) { maskCount++; for (let c = 0; c < 3; c++) patch.data[i * 4 + c] = patchMat.data[i * 4 + c]; patch.data[i * 4 + 3] = 255; } }
  const patchCanvas = document.createElement('canvas'); patchCanvas.width = PW; patchCanvas.height = PH; patchCanvas.getContext('2d').putImageData(patch, 0, 0);
  const patchPng = new Uint8Array(await (await new Promise(r => patchCanvas.toBlob(r, 'image/png'))).arrayBuffer());
  // in-memory composite (pixel space) for an exact check of "outside the painted box is untouched"
  const comp = document.createElement('canvas'); comp.width = W; comp.height = H; const cctx = comp.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(origCanvas, 0, 0); cctx.drawImage(patchCanvas, px0, py0);
  const inMaskOrig = (x, y) => x >= px0 && x < px1 && y >= py0 && y < py1 && pMask.data[(y - py0) * PW + (x - px0)] > 0;
  const dPix = diff(origCanvas, comp, inMaskOrig, [{ poly }]);
  tick('patch', t0); t0 = performance.now();

  // 10) new PDF: write the patch INTO the page image and re-save the whole image losslessly (Flate + PNG predictor).
  //     The original JPEG stream is dropped (GC), so its pixels (and the old word) are gone from the file.
  const compData = cctx.getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(W * H * 3); for (let i = 0, j = 0; i < W * H; i++, j += 3) { rgb[j] = compData[i * 4]; rgb[j + 1] = compData[i * 4 + 1]; rgb[j + 2] = compData[i * 4 + 2]; }
  const filtered = pngPredict(rgb, W, H, 3);
  const page = pdoc.getPage(pageIndex);
  const newImg = pdoc.context.flateStream(filtered, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: W } });
  const newImgRef = pdoc.context.register(newImg);
  img.xo.set(PDFName.of(img.name), newImgRef);
  // metadata: catalog XMP, every page /Thumb (none rebuilt), old image's XMP goes with the old image
  const stripped = [];
  if (pdoc.catalog.get(PDFName.of('Metadata'))) { pdoc.catalog.delete(PDFName.of('Metadata')); stripped.push('catalog /Metadata (XMP)'); }
  pdoc.getPages().forEach((pg, i) => { if (pg.node.get(PDFName.of('Thumb'))) { pg.node.delete(PDFName.of('Thumb')); stripped.push(`page ${i + 1} /Thumb`); } });
  if (img.obj.dict.get(PDFName.of('Metadata'))) stripped.push('page image /Metadata (XMP) - dropped with the old image');
  const jpegSegs = jpegSegments(img.raw); if (jpegSegs.some(x => x.name === 'APP1-Exif')) stripped.push('JPEG APP1 EXIF (incl. GPS IFD and IFD1 thumbnail) - dropped with the old JPEG stream');
  if (jpegSegs.some(x => x.name === 'APP2-ICC')) stripped.push('JPEG APP2 ICC profile - applied while decoding, then dropped (pixels are sRGB, written as DeviceRGB)');
  // hidden text layer
  const hiddenInfo = hidden === 'edit' ? await editHiddenLayer(pdoc, page, pageIndex, { find, replace, poly, W, H, ctm: img.ctm, L, oi0, oi1, back, confirm, confirmBelow })
    : await addHiddenLayer(pdoc, page, { lines: O.lines, li, newTokens: newText.split(' '), back, W, H, ctm: img.ctm });
  await pdoc.flush(); const gc = collectGarbage(pdoc);
  const out = await pdoc.save({ useObjectStreams: false });
  // verify: the saved image decodes (our own inflate + un-predict) to exactly the composite, i.e. identical to the
  // original decode everywhere outside the patch mask
  const chk = await PDFDocument.load(out); const img2 = findPageImage(chk, pageIndex);
  const inflated = decodePDFRawStream(img2.obj).decode(); const back2 = pngUnpredict(inflated, W, H, 3);
  const O0 = getData(origCanvas).data; let imgOutside = 0, imgInside = 0, imgVsComposite = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, j = i * 3, k = i * 4;
    const same = back2[j] === O0[k] && back2[j + 1] === O0[k + 1] && back2[j + 2] === O0[k + 2];
    if (back2[j] !== compData[k] || back2[j + 1] !== compData[k + 1] || back2[j + 2] !== compData[k + 2]) imgVsComposite++;
    if (!same) { if (inMaskOrig(x, y)) imgInside++; else imgOutside++; } }
  const imageCheck = { newFilter: img2.filter, newImageStreamBytes: img2.raw.length, oldImageStreamBytes: img.raw.length, decodedVsComposite: imgVsComposite, changedOutsidePatchMask: imgOutside, changedInsidePatchMask: imgInside, imagesInOutput: countImages(chk) };
  const maskCanvas = document.createElement('canvas'); maskCanvas.width = W; maskCanvas.height = H; { const mc = maskCanvas.getContext('2d'); const md = mc.createImageData(W, H); for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) if (inMaskOrig(x, y)) { const k = (y * W + x) * 4; md.data[k] = md.data[k + 1] = md.data[k + 2] = 255; } for (let i = 3; i < md.data.length; i += 4) md.data[i] = 255; mc.putImageData(md, 0, 0); }

  // 11) render both PDFs with pdf.js at 1 image pixel = 1 device pixel and diff (every page)
  const scale = W / Math.abs(img.ctm[0]);
  const rA = await renderPage(original, scale, pageIndex + 1), rB = await renderPage(out, scale, pageIndex + 1);
  const toRender = renderMapper(img.ctm, W, H, rot, rA.width, rA.height, scale, chk.getPage(pageIndex));
  const polyR = poly.map(toRender); const rx0 = Math.floor(Math.min(...polyR.map(p => p[0]))) - 2, ry0 = Math.floor(Math.min(...polyR.map(p => p[1]))) - 2, rx1 = Math.ceil(Math.max(...polyR.map(p => p[0]))) + 2, ry1 = Math.ceil(Math.max(...polyR.map(p => p[1]))) + 2;
  const inRect = (x, y) => x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
  const dRender = diff(rA, rB, inRect, [{ poly: polyR }, { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }]);
  // decoder check: pdf.js render of the OUTPUT vs our decoded composite (pixel-exact mapping for /Rotate 0 and 180),
  // and pdf.js render of the ORIGINAL vs the browser's decode of the original JPEG (decoder difference only)
  const decoderCheck = {}; if (rA.width === W && rA.height === H && (rot === 0 || rot === 180)) {
    const A = getData(rA).data, B = getData(rB).data, O1 = getData(origCanvas).data; let outMis = 0, origMis = 0, origMax = 0;
    for (let ry = 0; ry < H; ry++) for (let rx = 0; rx < W; rx++) { const ix = rot ? W - 1 - rx : rx, iy = rot ? H - 1 - ry : ry; const k = (ry * W + rx) * 4, j = (iy * W + ix) * 4;
      if (B[k] !== compData[j] || B[k + 1] !== compData[j + 1] || B[k + 2] !== compData[j + 2]) outMis++;
      const d = Math.max(Math.abs(A[k] - O1[j]), Math.abs(A[k + 1] - O1[j + 1]), Math.abs(A[k + 2] - O1[j + 2])); if (d) { origMis++; if (d > origMax) origMax = d; } }
    Object.assign(decoderCheck, { pdfjsRenderOfOutputVsWrittenPixels: outMis, pdfjsRenderOfOriginalVsBrowserJpegDecode: origMis, pdfjsVsBrowserJpegMaxAbs: origMax, pixels: W * H }); }
  const otherPages = [];
  for (let p = 0; p < pdoc.getPageCount(); p++) if (p !== pageIndex) { const a = await renderPage(original, 150 / 72, p + 1), b2 = await renderPage(out, 150 / 72, p + 1); const dd = diff(a, b2, () => false, []); otherPages.push({ page: p + 1, changedPixels: dd.outside, size: [a.width, a.height], imageStreamIdentical: await sameImageStream(pdoc0bytes(original), out, p) }); }
  const renderOutsideMask = 0;
  // pdf.js decodes JPEG with its own decoder, so the ORIGINAL renders slightly differently from the browser decode we
  // wrote out. Measure that decoder difference directly: max |pdf.js(original) - pdf.js(output)| outside the patch rect.
  let renderMaxAbsOutside = 0, renderHist = {}; { const A = getData(rA).data, B = getData(rB).data; for (let y = 0; y < rA.height; y++) for (let x = 0; x < rA.width; x++) { if (inRect(x, y)) continue; const k = (y * rA.width + x) * 4; const d = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2])); if (d) { renderHist[d] = (renderHist[d] || 0) + 1; if (d > renderMaxAbsOutside) renderMaxAbsOutside = d; } } }
  // text layer as pdf.js reads it
  const textCheck = await hiddenTextCheck(out, pageIndex, find, replace, original);
  const classificationOut = classifyPages(chk);
  tick('render+diff', t0); t0 = performance.now();

  // 12) re-OCR the edited line (corrected space) as a sanity check of legibility
  const lineRect = { left: Math.max(0, bb.x0 - 10), top: box.y0, width: bb.x1 - bb.x0 + 20, height: bh };
  const ocrEdited = await ocr(edited, lineRect, '6');
  const ocrOrigLine = await ocr(corrCanvas, lineRect, '6');
  tick('reocr', t0);

  // ---- Oholiab's visual set: metrics on the deskewed page, before vs after, same code for every word ----
  const visual = (() => {
    const grayOf = c => { const D = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data; const g = new Float32Array(cw * ch); for (let i = 0; i < cw * ch; i++) g[i] = 0.299 * D[i * 4] + 0.587 * D[i * 4 + 1] + 0.114 * D[i * 4 + 2]; return g; };
    const GB = grayOf(corrCanvas), GA = grayOf(edited);
    const yA = Math.min(...[...uWords, ...eWords].map(w => w.bbox.y0)) - 4, yB = Math.max(...[...uWords, ...eWords].map(w => w.bbox.y1)) + 4;
    const wordM = (G, x0, x1, chars) => { const m = new Uint8Array(cw * ch); for (let y = yA; y < yB; y++) for (let x = x0; x < x1; x++) m[y * cw + x] = G[y * cw + x] < swThr ? 1 : 0;
      const p = inkProfile(m, cw, x0, yA, x1, yB); const inkL = x0 + p.inkLeftRel, inkR = x0 + p.inkRightRel;
      return { baselineY: yA + p.baselineRel, xHeightPx: p.xHeight, capHeightPx: p.capHeight, inkLeft: inkL, inkRight: inkR, inkWidthPx: inkR - inkL, advancePerCharPx: +((inkR - inkL) / Math.max(1, chars)).toFixed(2), stemWidthPx: +strokeW(i => G[i], cw, ch, swThr, { x0, y0: yA, x1, y1: yB }).toFixed(3) }; };
    const segWords = L.words.map((w, i) => ({ w, i })).filter(({ w, i }) => w.text.trim() && (!seg || (i >= seg.j0 && i <= seg.j1)));
    const rows = segWords.map(({ w, i }) => { const edited_ = i >= oi0 && i <= oi1; const x0 = edited_ ? Math.max(box.x0, wb.x0 - 3) : w.bbox.x0 - 1, x1 = edited_ ? Math.min(box.x1, wb.x1 + 3) : w.bbox.x1 + 1;
      return { word: w.text, edited: edited_, before: wordM(GB, x0, x1, w.text.length), after: wordM(GA, x0, x1, edited_ ? newSeg.length : w.text.length) }; });
    const un = rows.filter(r => !r.edited), ed = rows.filter(r => r.edited);
    const med = f => median(un.map(r => f(r.after)));
    const n = ed[0].after, o = ed[0].before;
    const gapsU = []; for (let k = 1; k < rows.length; k++) if (!rows[k].edited && !rows[k - 1].edited) gapsU.push(rows[k].after.inkLeft - rows[k - 1].after.inkRight);
    const ie = rows.indexOf(ed[0]); const prevR = rows[ie - 1], nextR = rows[ie + 1];
    // patch edge seam: |inside - outside| across the box border on paper pixels, after vs before at the same spots
    let sA = 0, sB = 0, sn = 0; const edgeP = (xi, yi, xo, yo) => { const a = yi * cw + xi, b = yo * cw + xo; if (GB[a] < swThr + 20 || GB[b] < swThr + 20) return; sA += Math.abs(GA[a] - GA[b]); sB += Math.abs(GB[a] - GB[b]); sn++; };
    for (let x = box.x0; x < box.x1; x++) { edgeP(x, box.y0, x, box.y0 - 1); edgeP(x, box.y1 - 1, x, box.y1); }
    for (let y = box.y0; y < box.y1; y++) { edgeP(box.x0, y, box.x0 - 1, y); edgeP(box.x1 - 1, y, box.x1, y); }
    // grain: std of (pixel - 5x5 mean) on paper pixels (>= 3 px from any ink) inside the box vs a 12 px ring around it
    const grain = (G, inside) => { const v = []; const R = 12;
      for (let y = box.y0 - R; y < box.y1 + R; y++) for (let x = box.x0 - R; x < box.x1 + R; x++) { if (x < 3 || y < 3 || x >= cw - 3 || y >= ch - 3) continue; const ins = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1; if (ins !== inside) continue;
        let ok = true, s = 0; for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) if (G[(y + dy) * cw + x + dx] < swThr + 20) { ok = false; break; } if (!ok) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += G[(y + dy) * cw + x + dx]; v.push(G[y * cw + x] - s / 25); }
      const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); return { std: +Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length)).toFixed(3), samples: v.length }; };
    // gap check: the part of the old word's area that the new word does not cover must read as clean paper.
    // Region: right of the new ink (+2 px) to the box edge, rows from x-height top-2 to baseline+2. Reference: the
    // untouched inter-word gaps on the same rows (2 px clear of ink). Blob = 5x5 mean deviating from the reference
    // mean by more than 3x the reference's own 5x5-mean std (its noise floor).
    const gapCheck = (() => { const r0y = Math.round(meas.baseline - meas.capHeight - 2), r1y = Math.round(meas.baseline + 2);
      const gx0 = n.inkRight + 3, gx1 = box.x1 - 1; if (gx1 - gx0 < 4) return { region: null, note: 'new word fills the slot; no gap' };
      const refCols = []; for (let k = 1; k < rows.length; k++) if (!rows[k].edited && !rows[k - 1].edited) for (let x = rows[k - 1].after.inkRight + 3; x <= rows[k].after.inkLeft - 3; x++) refCols.push(x);
      const m5 = (G, x, y) => { let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += G[(y + dy) * cw + x + dx]; return s / 25; };
      const st = a => { const m = a.reduce((p, q) => p + q, 0) / a.length; return { mean: m, std: Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length) }; };
      const gp = [], gm = [], rp = [], rm = [];
      for (let y = r0y; y < r1y; y++) { for (let x = gx0; x < gx1; x++) { gp.push(GA[y * cw + x]); if (x >= gx0 + 2 && x < gx1 - 2 && y >= r0y + 2 && y < r1y - 2) gm.push(m5(GA, x, y)); }
        for (const x of refCols) { rp.push(GA[y * cw + x]); if (y >= r0y + 2 && y < r1y - 2) rm.push(m5(GA, x, y)); } }
      if (!rp.length) return { region: null, note: 'no untouched gap for reference' };
      const G = st(gp), R = st(rp), RM = st(rm); const floor = 3 * RM.std; const dev = gm.length ? Math.max(...gm.map(v => Math.abs(v - R.mean))) : 0;
      return { region: { x0: gx0, x1: gx1, y0: r0y, y1: r1y, pixels: gp.length }, gapMean: +G.mean.toFixed(2), gapStd: +G.std.toFixed(2), paperMean: +R.mean.toFixed(2), paperStd: +R.std.toFixed(2), meanDelta: +(G.mean - R.mean).toFixed(2),
        noiseFloor5x5: +floor.toFixed(2), maxBlobDeviation5x5: +dev.toFixed(2), blobAboveFloor: dev > floor, oldWordAreaBefore: +st((() => { const a = []; for (let y = r0y; y < r1y; y++) for (let x = gx0; x < gx1; x++) a.push(GB[y * cw + x]); return a; })()).mean.toFixed(2) }; })();
    return {
      gapCheck, words: rows,
      newWord: { baselineDeltaPx: +(n.baselineY - med(r => r.baselineY)).toFixed(2), xHeightDeltaPx: +(n.xHeightPx - med(r => r.xHeightPx)).toFixed(2), capHeightDeltaPx: +(n.capHeightPx - med(r => r.capHeightPx)).toFixed(2),
        stemWidthPx: n.stemWidthPx, stemWidthUntouchedMedianPx: +med(r => r.stemWidthPx).toFixed(3), stemWidthOldWordPx: o.stemWidthPx,
        advancePerCharPx: n.advancePerCharPx, advancePerCharUntouchedMedianPx: +med(r => r.advancePerCharPx).toFixed(2), advancePerCharOldWordPx: o.advancePerCharPx,
        gapBeforePx: prevR ? n.inkLeft - prevR.after.inkRight : null, gapBeforeWasPx: prevR ? o.inkLeft - prevR.before.inkRight : null,
        gapAfterPx: nextR ? nextR.after.inkLeft - n.inkRight : null, gapAfterWasPx: nextR ? nextR.before.inkLeft - o.inkRight : null, typicalWordGapPx: gapsU.length ? median(gapsU) : null },
      oldWordBaselineDeltaPx: +(o.baselineY - median(un.map(r => r.before.baselineY))).toFixed(2), oldWordXHeightDeltaPx: +(o.xHeightPx - median(un.map(r => r.before.xHeightPx))).toFixed(2),
      patchEdge: { meanAbsStepAcrossBorderAfter: +(sA / Math.max(1, sn)).toFixed(3), sameSpotsBefore: +(sB / Math.max(1, sn)).toFixed(3), paperBorderPixels: sn },
      grain: { insidePatchAfter: grain(GA, true), insidePatchBefore: grain(GB, true), ringAroundPatch: grain(GA, false) } };
  })();
  const nearest = (c, k) => { const o = document.createElement('canvas'); o.width = c.width * k; o.height = c.height * k; const x = o.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(c, 0, 0, o.width, o.height); return o; };
  // images
  const m = 40, mv = Math.round(lh * 1.2);
  const linePoly = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]].map(back).map(toRender);
  const lx0 = Math.min(...linePoly.map(p => p[0])), lx1 = Math.max(...linePoly.map(p => p[0])), ly0 = Math.min(...linePoly.map(p => p[1])), ly1 = Math.max(...linePoly.map(p => p[1]));
  const lmv = Math.round((ly1 - ly0) * 0.8); const lineCropDbg = { bb, linePoly, lx0, lx1, ly0, ly1, rA: [rA.width, rA.height] };
  const outlined = crop(rB, lx0 - m, ly0 - lmv, lx1 + m, ly1 + lmv); { const g = outlined.getContext('2d'); g.strokeStyle = 'rgb(0,90,255)'; g.lineWidth = 2; g.beginPath(); polyR.forEach(([x, y], i) => { const X = x - Math.max(0, Math.floor(lx0 - m)), Y = y - Math.max(0, Math.floor(ly0 - lmv)); i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.closePath(); g.stroke(); }
  const images = {
    line_before: png(crop(rA, lx0 - m, ly0 - lmv, lx1 + m, ly1 + lmv)), line_after: png(crop(rB, lx0 - m, ly0 - lmv, lx1 + m, ly1 + lmv)), line_after_box_outlined: png(outlined),
    line_before_deskewed: png(crop(corrCanvas, bb.x0 - m, bb.y0 - mv, bb.x1 + m, bb.y1 + mv)), line_after_deskewed: png(crop(edited, bb.x0 - m, bb.y0 - mv, bb.x1 + m, bb.y1 + mv)),
    word_zoom_before: png(crop(corrCanvas, box.x0 - 3 * lh, box.y0 - 10, box.x1 + 3 * lh, box.y1 + 10)), word_zoom_after: png(crop(edited, box.x0 - 3 * lh, box.y0 - 10, box.x1 + 3 * lh, box.y1 + 10)),
    before_full: png(rA), after_full: png(rB), diff_full: png(dRender.canvas), diff_line_zoom: png(crop(dRender.canvas, lx0 - m, ly0 - lmv, lx1 + m, ly1 + lmv)),
    corrected_page: png(scaled(corrCanvas, 1275)), ocr_input_clahe: png(scaled(variants.clahe, 1275)), ocr_input_adaptive: png(scaled(variants.adaptive, 1275)),
    patch: png(patchCanvas), patch_mask: png(maskCanvas),
    vis100_before: png(crop(rA, Math.min(...polyR.map(p => p[0])) - 3 * lh, Math.min(...polyR.map(p => p[1])) - lh, Math.max(...polyR.map(p => p[0])) + 3 * lh, Math.max(...polyR.map(p => p[1])) + lh)),
    vis100_after: png(crop(rB, Math.min(...polyR.map(p => p[0])) - 3 * lh, Math.min(...polyR.map(p => p[1])) - lh, Math.max(...polyR.map(p => p[0])) + 3 * lh, Math.max(...polyR.map(p => p[1])) + lh)),
    vis300_before: png(nearest(crop(rA, Math.min(...polyR.map(p => p[0])) - 0.6 * lh, Math.min(...polyR.map(p => p[1])) - 0.3 * lh, Math.max(...polyR.map(p => p[0])) + 0.6 * lh, Math.max(...polyR.map(p => p[1])) + 0.3 * lh), 3)),
    vis300_after: png(nearest(crop(rB, Math.min(...polyR.map(p => p[0])) - 0.6 * lh, Math.min(...polyR.map(p => p[1])) - 0.3 * lh, Math.max(...polyR.map(p => p[0])) + 0.6 * lh, Math.max(...polyR.map(p => p[1])) + 0.3 * lh), 3)), inpaint_mask: png(bgInfo.dbg.maskCanvas), inpaint_bg: png(bgInfo.dbg.bgCanvas), inpaint_src: png(bgInfo.dbg.srcCanvas),
  };
  { // paper detection overlay
    const ov = scaled(origCanvas, 1000); const k = ov.width / W; const o = ov.getContext('2d'); o.strokeStyle = 'rgb(0,200,0)'; o.lineWidth = 3; o.beginPath(); paper.quad.forEach(([x, y], i) => i ? o.lineTo(x * k, y * k) : o.moveTo(x * k, y * k)); o.closePath(); o.stroke();
    o.strokeStyle = 'rgb(255,0,0)'; o.beginPath(); poly.forEach(([x, y], i) => i ? o.lineTo(x * k, y * k) : o.moveTo(x * k, y * k)); o.closePath(); o.stroke(); images.paper_detect = png(ov);
  }
  [src, srcPts, dstPts, M, Minv, corr, gray, claheM, adapt, Tm, Hp, editedMat, patchMat, boxMask, pMask].forEach(mm => mm.delete());
  const shaRefetch = await sha256(await fetchBytes(url));
  return {
    kind, input: url, shaBefore, shaAfterRefetch: shaRefetch, inputUnchanged: shaBefore === shaRefetch,
    classification, classificationOutput: classificationOut, pageIndex, pageRotate: rot,
    image: { width: W, height: H, filter: img.filter, placement: img.ctm, sha256Before: imageShaBefore, jpegSegments: jpegSegs, ...imageCheck },
    stripped, decoderCheck, hiddenLayer: hiddenInfo, textLayer: textCheck, otherPages, fileHygiene: { gcRemovedObjects: gc.removed, objectsKept: gc.kept }, sizes: { inputBytes: original.length, outputBytes: out.length },
    paper: { ...paper, quad: paper.quad.map(p => p.map(v => +v.toFixed(1))), edgeAnglesDeg: { top: +angle.toFixed(2), bottom: +angleBottom.toFixed(2), left: +angleLeft.toFixed(2), right: +angleRight.toFixed(2) },
      size: ps.name, measuredRatio: +ps.measuredRatio.toFixed(4), rawEdgeRatio: +ps.rawEdgeRatio.toFixed(4), perspectiveRatio: ps.perspectiveRatio && +ps.perspectiveRatio.toFixed(4), focalPx: ps.focalPx && Math.round(ps.focalPx), ratioMethod: ps.ratioMethod, quadInset: paper.quadInset.map(p => p.map(v => +v.toFixed(1))), sourceDpiEquivalent: +ps.srcDpi.toFixed(1), corrected: [OW, OH], upscale: +(300 / ps.srcDpi).toFixed(3) },
    ocr: { variantChosen: chosen, meanConf: Object.fromEntries(Object.entries(ocrRuns).map(([k, v]) => [k, +v.meanConf.toFixed(2)])), lines: O.lines, text: O.text,
      otherVariant: Object.fromEntries(Object.entries(ocrRuns).filter(([k]) => k !== chosen).map(([k, v]) => [k, { text: v.text, lines: v.lines }])) },
    target: { segment: seg, fitText, ocrLineIndex: li, ocrText: L.text, trueText: trueLine, similarity: +sims[li].toFixed(3), bbox: L.bbox, lowConfidenceWords: lowConfInLine,
      wouldBlockInApp: lowConfInLine.length > 0, correctedOld, newText, find, replace },
    measure: { ...meas, inkRGB_untouchedMedian: target.inkRGB, inkRGB_darkest40pct: inkRGB, inkRGB_drawn: inkFitRGB, paperRGB, lineHeight: lh },
    preview: (() => { // what the UI shows BEFORE Save: the natural-width gap the width rule leaves (nothing to the right moves)
      const g = overflow.gapPx > 0 ? { x0: Math.round(inkLeftReal + overflow.naturalInkWidthPx), x1: wb.x1, y0: box.y0, y1: box.y1 } : null;
      const tu = ([ix, iy]) => [img.ctm[4] + ix / W * img.ctm[0], img.ctm[5] + (1 - iy / H) * img.ctm[3]];
      return { showGapBeforeSave: !!g, gapPx: overflow.gapPx, gapMm: +(overflow.gapPx / 300 * 25.4).toFixed(2), slotPx: overflow.slotPx, drawnInkWidthPx: overflow.naturalInkWidthPx, decision: overflow.decision,
        gapRectDeskewedPx: g, gapPolygonPdfUser: g ? [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]].map(back).map(tu).map(p => p.map(v => +v.toFixed(2))) : null }; })(),
    visual, look: { ...look, inpaintThreshold: bgInfo.dbg.thr, inpaintLocalPaper: bgInfo.dbg.localPaper, strokeWidth50: { untouchedMedian: +target.strokeWidth.toFixed(3), newWord: +strokeW(i => { const D = finalCanvasData; return grayAt(D, i); }, bw, bh, swThr).toFixed(3) }, colourTarget, inpaintPixels: bgInfo.inpaintPixels, localPaperNoiseStd: bgInfo.localPaperNoiseStd, noiseModel: 'Gaussian field (0.7 px correlation): fitted line noise on new ink, local paper noise on inpainted paper, none on untouched paper' }, overflow, editedWords: { tokens: [ti0, ti1], ocrWords: [oi0, oi1], old: oldSeg, new: newSeg, ocr: eWords, tokenAlignment },
    font: { localFit, chosen: fontKey, file: F.file.replace(/^\//, ''), name: F.name, license: 'vendor/fonts/liberation/LICENSE (SIL OFL 1.1)', sizePx: FT.sizePx, horizontalScale: +hsWord.toFixed(4), lineHorizontalScale: +hScale.toFixed(4), blurPx, trials: fontTrials, fitGrid_blur_weight_ncc: fitGrid },
    paintBox: { corrected: box, originalPolygon: poly.map(p => p.map(v => +v.toFixed(2))), patchRect: { x0: px0, y0: py0, x1: px1, y1: py1 }, maskPixels: maskCount, colouredMarkPixelsExcludedFromPatch: colouredExcluded },
    pixel: { compositeChangedOutsideMask: dPix.outside, compositeChangedInsideMask: dPix.inside,
      renderScale: scale, renderSize: [rA.width, rA.height], renderChangedOutsidePatchRect: dRender.outside, renderChangedInsidePatchRect: dRender.inside, renderChangedOutsideMask: dRender.outside + renderOutsideMask, renderMaxAbsDiffOutside: renderMaxAbsOutside, renderDiffHistogram: renderHist, outsideSamples: dRender.outsideSamples },
    verifyOcr: { editedLine: ocrEdited.text.trim(), originalLineSameBox: ocrOrigLine.text.trim(), editedWords: ocrEdited.lines.flatMap(l => l.words) },
    timingsMs: T, images, outputPdfB64: u8ToB64(out),
  };
}

// ---------- lossless image writing / checking ----------
function pngPredict(px, W, H, C) { // PNG row filters (per row: the one with the least sum of |values|), as /Predictor 15
  const stride = W * C, out = new Uint8Array(H * (stride + 1)); const prev = new Uint8Array(stride); const tmp = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < H; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride); const up = y ? px.subarray((y - 1) * stride, y * stride) : prev;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) { const t = tmp[f]; let sum = 0;
      for (let i = 0; i < stride; i++) { const a = i >= C ? row[i - C] : 0, b = up[i], c = i >= C ? up[i - C] : 0; let pr;
        if (f === 0) pr = 0; else if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[i] - pr) & 255; t[i] = v; sum += v < 128 ? v : 256 - v; if (sum >= bestSum) break; }
      if (sum < bestSum) { bestSum = sum; best = f; } }
    // recompute the chosen filter fully (the loop above may have stopped early)
    const t = tmp[best]; for (let i = 0; i < stride; i++) { const a = i >= C ? row[i - C] : 0, b = up[i], c = i >= C ? up[i - C] : 0; let pr;
      if (best === 0) pr = 0; else if (best === 1) pr = a; else if (best === 2) pr = b; else if (best === 3) pr = (a + b) >> 1; else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      t[i] = (row[i] - pr) & 255; }
    out[y * (stride + 1)] = best; out.set(t, y * (stride + 1) + 1);
  }
  return out;
}
function pngUnpredict(data, W, H, C) {
  const stride = W * C, out = new Uint8Array(W * H * C);
  for (let y = 0; y < H; y++) { const f = data[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) { const a = i >= C ? out[dst + i - C] : 0, b = y ? out[dst - stride + i] : 0, c = y && i >= C ? out[dst - stride + i - C] : 0; let pr;
      if (f === 0) pr = 0; else if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + i] = (data[src + i] + pr) & 255; } }
  return out;
}
function jpegSegments(b) {
  const out = []; let i = 2;
  while (i + 4 <= b.length && b[i] === 0xFF && b[i + 1] !== 0xDA) { const m = b[i + 1], L = (b[i + 2] << 8) | b[i + 3]; const head = String.fromCharCode(...b.subarray(i + 4, i + 4 + 14));
    let name = 'FF' + m.toString(16).toUpperCase();
    if (m === 0xE0) name = 'APP0-' + (head.startsWith('JFIF') ? `JFIF(thumb ${b[i + 4 + 12]}x${b[i + 4 + 13]})` : head.slice(0, 4)); else if (m === 0xE1) name = head.startsWith('Exif') ? 'APP1-Exif' : head.startsWith('http://ns.adobe') ? 'APP1-XMP' : 'APP1'; else if (m === 0xE2) name = head.startsWith('ICC_PROFILE') ? 'APP2-ICC' : 'APP2'; else if (m === 0xFE) name = 'COM'; else if (m === 0xEE) name = 'APP14-Adobe';
    out.push({ name, bytes: L }); i += 2 + L; }
  return out;
}
function countImages(pdoc) { let n = 0; for (const [, o] of pdoc.context.enumerateIndirectObjects()) if (o instanceof PDFRawStream && o.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') n++; return n; }
function renderMapper(ctm, W, H, rot, RW, RH, s, page) {
  const { width: PW, height: PH } = page.getMediaBox();
  return ([ix, iy]) => { const x = ctm[4] + ix / W * ctm[0], y = ctm[5] + (1 - iy / H) * ctm[3];
    if (rot === 0) return [x * s, (PH - y) * s]; if (rot === 180) return [(PW - x) * s, y * s]; if (rot === 90) return [y * s, x * s]; return [(PH - y) * s, (PW - x) * s]; };
}
async function sameImageStream(a, b, p) { const A = await PDFDocument.load(a.slice()), B = await PDFDocument.load(b.slice()); return (await sha256(findPageImage(A, p).raw)) === (await sha256(findPageImage(B, p).raw)); }
function pdoc0bytes(x) { return x; }
const wordRx = w => new RegExp('(?<![A-Za-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'g');
async function hiddenTextCheck(out, pageIndex, find, replace, original) {
  const read = async bytes => { const d = await openPdf(bytes); const pages = [];
    for (let p = 1; p <= d.numPages; p++) { const pg = await d.getPage(p); const vp = pg.getViewport({ scale: 1 }); const tc = await pg.getTextContent();
      pages.push(tc.items.map(it => { const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]); return { str: it.str, x: +x.toFixed(1), y: +y.toFixed(1) }; })); }
    await d.destroy(); return pages; };
  const A = await read(original), B = await read(out);
  const count = (pages, w) => pages.map(items => items.reduce((n, it) => n + (it.str.match(wordRx(w)) || []).length, 0));
  const hits = (pages, w) => pages.flatMap((items, p) => items.filter(it => wordRx(w).test(it.str)).map(it => ({ page: p + 1, ...it })));
  return { pdfjs: { [find]: { before: count(A, find), after: count(B, find) }, [replace]: { before: count(A, replace), after: count(B, replace) } },
    hitsBefore: { [find]: hits(A, find) }, hitsAfter: { [find]: hits(B, find), [replace]: hits(B, replace) },
    garbageCharsAfter: B.flat().reduce((n, it) => n + (it.str.match(/\uFFFD/g) || []).length, 0),
    pageTextAfter: B.map(items => items.map(i => i.str).join(' ')) };
}
// invisible OCR layer for an image-only page (Tr 3), Liberation Sans subset with ToUnicode, one run per word
async function addHiddenLayer(pdoc, page, { lines, li, newTokens, back, W, H, ctm, standard = false, dropLine = -1 }) {
  pdoc.registerFontkit(window.fontkit);
  const font = standard ? await pdoc.embedFont(window.PDFLib.StandardFonts.Helvetica) : await pdoc.embedFont(await fetchBytes('/vendor/fonts/liberation/LiberationSans-Regular.ttf'), { subset: true });
  const fname = page.node.newFontDictionary(standard ? 'F3' : 'FRPOCR', font.ref);
  const toUser = ([ix, iy]) => [ctm[4] + ix / W * ctm[0], ctm[5] + (1 - iy / H) * ctm[3]];
  const f = n => (+n.toFixed(4)).toString(); let cs = 'q\nBT\n3 Tr\n'; let words = 0;
  lines.forEach((l, i) => l.words.forEach((w, wi) => {
    if (i === dropLine && wi > 0) return; // simulate a scanner OCR layer that lost the rest of this line
    const text = i === li && newTokens.length === l.words.length ? newTokens[wi] : w.text; if (!text.trim()) return;
    const yb = w.bbox.y1 - 0.22 * (w.bbox.y1 - w.bbox.y0);
    const L = toUser(back([w.bbox.x0, yb])), R = toUser(back([w.bbox.x1, yb])), T = toUser(back([w.bbox.x0, w.bbox.y0]));
    const len = Math.hypot(R[0] - L[0], R[1] - L[1]); const ux = (R[0] - L[0]) / len, uy = (R[1] - L[1]) / len;
    const size = Math.max(1, Math.hypot(T[0] - L[0], T[1] - L[1]) / 0.75); if (!isFinite(size) || !isFinite(len) || len === 0) { (window.__hiddenNaN ||= []).push({ line: i, word: wi, text, bbox: w.bbox, L, T }); return; } const nat = font.widthOfTextAtSize(text, size);
    cs += `/${fname.toString().replace(/^\//, '')} ${f(size)} Tf ${f(100 * len / nat)} Tz ${f(ux)} ${f(uy)} ${f(-uy)} ${f(ux)} ${f(L[0])} ${f(L[1])} Tm ${font.encodeText(text).toString()} Tj\n`; words++;
  }));
  cs += 'ET\nQ\n';
  const ref = pdoc.context.register(pdoc.context.flateStream(binaryToBytes(cs)));
  page.node.addContentStream(ref);
  return { mode: 'added (the input had no text layer)', words, font: 'Liberation Sans Regular 2.1.5 (subset, Identity-H, ToUnicode)', editedLineUsesCorrectedText: li >= 0 && lines[li].words.length === newTokens.length };
}
// edit the EXISTING invisible OCR layer: only the run(s) on the edited word's spot that contain the old word
async function editHiddenLayer(pdoc, page, pageIndex, { find, replace, poly, W, H, ctm, L, oi0, oi1, back, confirm, confirmBelow = 80 }) {
  const isRule = t => /^[|_\-—–=]+$/.test(t); // table rules read as characters are not text
  const cvr = page.node.get(PDFName.of('Contents')); const refs = cvr instanceof PDFArray ? cvr.asArray() : [cvr];
  const s = refs.map(r => bytesToBinary(decodePDFRawStream(pdoc.context.lookup(r)).decode())).join('\n');
  const ops = tokenize(s);
  const toUser = ([ix, iy]) => [ctm[4] + ix / W * ctm[0], ctm[5] + (1 - iy / H) * ctm[3]];
  const up = poly.map(toUser); const bx0 = Math.min(...up.map(p => p[0])), bx1 = Math.max(...up.map(p => p[0])), by0 = Math.min(...up.map(p => p[1])), by1 = Math.max(...up.map(p => p[1]));
  let C = [1, 0, 0, 1, 0, 0], Tm = [1, 0, 0, 1, 0, 0], Tlm = Tm, Tr = 0, size = 12, TL = 0; const st = []; const runs = [];
  for (let i = 0; i < ops.length; i++) { const o = ops[i]; const a = o.args;
    if (o.op === 'q') st.push([C, Tr]); else if (o.op === 'Q') [C, Tr] = st.pop() || [[1, 0, 0, 1, 0, 0], 0];
    else if (o.op === 'cm') C = mul(a.map(x => x.v), C); else if (o.op === 'BT') { Tm = Tlm = [1, 0, 0, 1, 0, 0]; }
    else if (o.op === 'Tm') Tm = Tlm = a.map(x => x.v); else if (o.op === 'Td' || o.op === 'TD') { Tm = Tlm = mul([1, 0, 0, 1, a[0].v, a[1].v], Tlm); if (o.op === 'TD') TL = -a[1].v; }
    else if (o.op === 'T*') Tm = Tlm = mul([1, 0, 0, 1, 0, -TL], Tlm); else if (o.op === 'Tr') Tr = a[0].v; else if (o.op === 'Tf') size = a[1].v; else if (o.op === 'TL') TL = a[0].v;
    else if (o.op === 'Tj' || o.op === 'TJ') { const [ux, uy] = apply(mul(Tm, C), 0, 0); const str = o.op === 'Tj' ? a[0].v : a[0].v.filter(x => x.t === 'str').map(x => x.v).join('');
      // centre of the run's glyph box (approx. width 0.5 em per char, centre at 0.35 em above the baseline)
      const [cx, cy] = apply(mul(Tm, C), 0.25 * size * str.trimEnd().length, 0.35 * size);
      runs.push({ i, op: o.op, text: str, ux, uy, cx, cy, Tr, size, inBox: cx >= bx0 - 0.25 * size && cx <= bx1 + 0.25 * size && cy >= by0 - 0.25 * size && cy <= by1 + 0.25 * size }); }
  }
  const target = runs.filter(r => r.Tr === 3 && r.inBox && wordRx(find).test(r.text));
  let out = '', cur = 0; const changed = [];
  for (const r of target) { const o = ops[r.i]; if (o.op !== 'Tj') throw new Error('hidden-layer TJ edit not implemented in proof');
    const nt = r.text.replace(wordRx(find), replace); const hex = '<' + [...nt].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') + '>';
    out += s.slice(cur, o.start) + hex + ' Tj'; cur = o.end; changed.push({ before: r.text, after: nt, userX: +r.ux.toFixed(2), userY: +r.uy.toFixed(2) }); }
  out += s.slice(cur);
  let added = null, rewrite = null;
  const lowOnLine = L.words.map((w, i) => ({ index: i, text: w.text, confidence: Math.round(w.confidence), edited: i >= oi0 && i <= oi1 })).filter(w => w.confidence < confirmBelow && !isRule(w.text));
  if (!target.length) {
    // The scanner's runs do not cover the edited word (e.g. its OCR lost the line). Editability comes from OUR OCR:
    // remove the scanner's runs inside this line's box and write a fresh invisible line from our corrected OCR text.
    // Nathan's rule: that rewritten line may only be written once every word under 80 on it is confirmed/corrected
    // (the edited word itself is the user's correction).
    const unconfirmed = lowOnLine.filter(w => !w.edited && !(confirm && Object.prototype.hasOwnProperty.call(confirm, String(w.index))));
    if (unconfirmed.length) throw Object.assign(new Error('SAVE BLOCKED: this line\'s hidden text must be rewritten from our OCR, and ' + unconfirmed.length + ' word(s) on it are under ' + confirmBelow + ' confidence and not yet confirmed: ' + unconfirmed.map(w => `"${w.text}" (${w.confidence})`).join(', ') + '. Confirm or correct them first; nothing written.'), { saveBlocked: true, unconfirmed, lowOnLine });
    const words = L.words.map((w, i) => ({ ...w, text: i === oi0 ? (oi0 === oi1 && wordRx(find).test(w.text) ? w.text.replace(wordRx(find), replace) : replace) : (i > oi0 && i <= oi1) ? '' : (confirm && Object.prototype.hasOwnProperty.call(confirm, String(i)) ? confirm[String(i)] : w.text) })).filter(w => w.text.trim() && !isRule(w.text));
    const lc = [[L.bbox.x0, L.bbox.y0], [L.bbox.x1, L.bbox.y0], [L.bbox.x1, L.bbox.y1], [L.bbox.x0, L.bbox.y1]].map(back).map(toUser);
    const lx0 = Math.min(...lc.map(p => p[0])), lx1 = Math.max(...lc.map(p => p[0])), ly0 = Math.min(...lc.map(p => p[1])), ly1 = Math.max(...lc.map(p => p[1]));
    const removed = runs.filter(r => r.Tr === 3 && r.cx >= lx0 && r.cx <= lx1 && r.cy >= ly0 && r.cy <= ly1);
    const rm = new Set(removed.map(r => r.i)); out = ''; cur = 0;
    for (const r of removed) { const o = ops[r.i]; out += s.slice(cur, o.start) + ' '; cur = o.end; } // drop the show op (string + operator)
    out += s.slice(cur);
    // verify: every scanner run outside the line is still there with the same text and position
    const keep = runs.filter(r => r.Tr === 3 && !rm.has(r.i)).map(r => [r.text, r.ux.toFixed(2), r.uy.toFixed(2)].join('|'));
    rewrite = { lineBoxUser: [lx0, ly0, lx1, ly1].map(v => +v.toFixed(2)), removedScannerRuns: removed.map(r => r.text), newLineText: words.map(w => w.text).join(' '), keepSig: keep, confirmations: confirm || {}, confirmBelow, lowConfidenceWordsOnLine: lowOnLine, allWordsOnLine: L.words.map((w, i) => ({ index: i, text: w.text, confidence: Math.round(w.confidence) })) };
    rewrite._words = words;
  }
  page.node.set(PDFName.of('Contents'), pdoc.context.register(pdoc.context.flateStream(binaryToBytes(out))));
  if (rewrite) {
    added = await addHiddenLayer(pdoc, page, { lines: [{ words: rewrite._words }], li: -1, newTokens: [], back, W, H, ctm }); delete rewrite._words;
    const ops2 = tokenize(out); let C2 = [1, 0, 0, 1, 0, 0], T2 = [1, 0, 0, 1, 0, 0], Tl2 = T2, Tr2 = 0, TL2 = 0; const st2 = []; const after = [];
    for (const o of ops2) { const a = o.args;
      if (o.op === 'q') st2.push([C2, Tr2]); else if (o.op === 'Q') [C2, Tr2] = st2.pop() || [[1, 0, 0, 1, 0, 0], 0]; else if (o.op === 'cm') C2 = mul(a.map(x => x.v), C2); else if (o.op === 'BT') T2 = Tl2 = [1, 0, 0, 1, 0, 0];
      else if (o.op === 'Tm') T2 = Tl2 = a.map(x => x.v); else if (o.op === 'Td' || o.op === 'TD') { T2 = Tl2 = mul([1, 0, 0, 1, a[0].v, a[1].v], Tl2); if (o.op === 'TD') TL2 = -a[1].v; } else if (o.op === 'T*') T2 = Tl2 = mul([1, 0, 0, 1, 0, -TL2], Tl2); else if (o.op === 'Tr') Tr2 = a[0].v; else if (o.op === 'TL') TL2 = a[0].v;
      else if ((o.op === 'Tj' || o.op === 'TJ') && Tr2 === 3) { const [ux, uy] = apply(mul(T2, C2), 0, 0); const str = o.op === 'Tj' ? a[0].v : a[0].v.filter(x => x.t === 'str').map(x => x.v).join(''); after.push([str, ux.toFixed(2), uy.toFixed(2)].join('|')); } }
    rewrite.otherLinesScannerRunsUnchanged = JSON.stringify(after) === JSON.stringify(rewrite.keepSig); rewrite.scannerRunsKept = after.length; delete rewrite.keepSig;
  }
  const hiddenRuns = runs.filter(r => r.Tr === 3);
  return { mode: rewrite ? 'rewrote this line from our OCR (scanner runs did not cover the word)' : 'replaced the scanner run in place', rewrite, lowConfidenceWordsOnLine: lowOnLine, invisibleRuns: hiddenRuns.length, runsWithOldWordOnPage: hiddenRuns.filter(r => wordRx(find).test(r.text)).map(r => ({ text: r.text, userX: +r.ux.toFixed(2), userY: +r.uy.toFixed(2), centre: [+r.cx.toFixed(2), +r.cy.toFixed(2)], atEditedSpot: r.inBox })), changed, added, editBoxUser: [bx0, by0, bx1, by1].map(v => +v.toFixed(2)) };
}

// OCR any image file the way path B sees a page (paper quad or full frame, page rotation, ~300 dpi, CLAHE)
export async function ocrImage({ url, rotate = 0, words = [], psm = '3', variant = 'clahe' }) {
  const cv = await cvReady0();
  const im = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'default' });
  const c0 = document.createElement('canvas'); c0.width = im.width; c0.height = im.height; c0.getContext('2d').drawImage(im, 0, 0);
  const W = im.width, H = im.height; const src = cv.imread(c0); const paper = findPaper(cv, src);
  let q = paper.borderBrightFrac > 0.9 ? [[0, 0], [W, 0], [W, H], [0, H]] : paper.quad;
  q = { 0: [0, 1, 2, 3], 90: [3, 0, 1, 2], 180: [2, 3, 0, 1], 270: [1, 2, 3, 0] }[rotate].map(i => q[i]);
  const ps = paperSize(q, W, H); const OW = Math.round(ps.w * 300), OH = Math.round(ps.h * 300);
  const M = cv.getPerspectiveTransform(cv.matFromArray(4, 1, cv.CV_32FC2, q.flat()), cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, OW, 0, OW, OH, 0, OH]));
  const corr = new cv.Mat(); cv.warpPerspective(src, corr, M, new cv.Size(OW, OH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  const g = new cv.Mat(); cv.cvtColor(corr, g, cv.COLOR_RGBA2GRAY); const cl = new cv.Mat(); const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8)); clahe.apply(g, cl); clahe.delete();
  let inp = cl; if (variant === 'adaptive') { const gb = new cv.Mat(); cv.GaussianBlur(cl, gb, new cv.Size(3, 3), 0); inp = new cv.Mat(); cv.adaptiveThreshold(gb, inp, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 15); gb.delete(); }
  const r = await ocr(matToCanvas(cv, inp), null, psm); if (inp !== cl) inp.delete(); [src, M, corr, g, cl].forEach(m => m.delete());
  const counts = Object.fromEntries(words.map(w => [w, (r.text.match(wordRx(w)) || []).length]));
  const lines = r.lines.filter(l => words.some(w => wordRx(w).test(l.text))).map(l => l.text);
  return { width: W, height: H, counts, linesWithWords: lines, meanConf: +r.meanConf.toFixed(1), text: r.text, lowConf: r.lines.flatMap(l => l.words).filter(w => w.confidence < 80).map(w => [w.text, w.confidence]) };
}

// SEARCHABLE-SCAN STAND-IN: the scan stand-in plus a scanner-style invisible OCR layer (standard Helvetica, WinAnsi,
// Tr 3, one Tj per word), the JPEG kept byte-for-byte. One line keeps only its first word, like the Canon layer's
// 07/01 line, so that line is NOT mappable/editable.
export async function makeSearchable({ url, dropLineContaining }) {
  const cv = await cvReady0(); const bytes = await fetchBytes(url); const pdoc = await PDFDocument.load(bytes.slice());
  const img = findPageImage(pdoc, 0); const c0 = await decodeImageToCanvas(img); const W = c0.width, H = c0.height;
  const src = cv.imread(c0); const paper = findPaper(cv, src); const q = paper.borderBrightFrac > 0.9 ? [[0, 0], [W, 0], [W, H], [0, H]] : paper.quad;
  const ps = paperSize(q, W, H); const OW = Math.round(ps.w * 300), OH = Math.round(ps.h * 300);
  const M = cv.getPerspectiveTransform(cv.matFromArray(4, 1, cv.CV_32FC2, q.flat()), cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, OW, 0, OW, OH, 0, OH])); const Minv = new cv.Mat(); cv.invert(M, Minv, cv.DECOMP_LU);
  const corr = new cv.Mat(); cv.warpPerspective(src, corr, M, new cv.Size(OW, OH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  const g = new cv.Mat(); cv.cvtColor(corr, g, cv.COLOR_RGBA2GRAY); const cl = new cv.Mat(); const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8)); clahe.apply(g, cl); clahe.delete();
  const O = await ocr(matToCanvas(cv, cl));
  const mi = Minv.data64F; const back = ([x, y]) => { const w = mi[6] * x + mi[7] * y + mi[8]; return [(mi[0] * x + mi[1] * y + mi[2]) / w, (mi[3] * x + mi[4] * y + mi[5]) / w]; };
  const dropLine = O.lines.findIndex(l => l.text.includes(dropLineContaining));
  const info = await addHiddenLayer(pdoc, pdoc.getPage(0), { lines: O.lines, li: -1, newTokens: [], back, W, H, ctm: img.ctm, standard: true, dropLine });
  [src, M, Minv, corr, g, cl].forEach(m => m.delete());
  const out = await pdoc.save({ useObjectStreams: false });
  return { b64: u8ToB64(out), words: info.words, droppedLine: dropLine >= 0 ? O.lines[dropLine].text : null, lines: O.lines.map(l => l.text) };
}
