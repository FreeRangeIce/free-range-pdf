// Path A: edit one line of a PDF that has a real text layer. No OCR.
// pdf.js reads the line; pdf-lib writes a NEW file in which the line's text-show operators are
// removed from the content stream and the new text is drawn at the same baseline/x/size/font.
import { openPdf, renderPage, diff, crop, png, sha256, u8ToB64, fetchBytes } from './img-util.js';
import { collectGarbage } from './pdf-gc.js';
import { tokenize, textShows, bytesToBinary, binaryToBytes, mul, apply } from './content-stream.js';
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, decodePDFRawStream } = window.PDFLib;

export const FALLBACK_FONTS = {
  serif: { file: '/vendor/fonts/liberation/LiberationSerif-Regular.ttf', name: 'Liberation Serif Regular 2.1.5', license: 'vendor/fonts/liberation/LICENSE (SIL OFL 1.1)' },
  sans: { file: '/vendor/fonts/liberation/LiberationSans-Regular.ttf', name: 'Liberation Sans Regular 2.1.5', license: 'vendor/fonts/liberation/LICENSE (SIL OFL 1.1)' },
  mono: { file: '/vendor/fonts/liberation/LiberationMono-Regular.ttf', name: 'Liberation Mono Regular 2.1.5', license: 'vendor/fonts/liberation/LICENSE (SIL OFL 1.1)' },
};

export async function readLines(u8, pageNo = 1) {
  const doc = await openPdf(u8); const page = await doc.getPage(pageNo);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const items = tc.items.filter(it => 'str' in it && it.str.length);
  const fonts = {};
  for (const it of items) if (!fonts[it.fontName]) {
    try { const f = page.commonObjs.get(it.fontName); fonts[it.fontName] = { name: f.name, fallbackName: f.fallbackName, missingFile: !!f.missingFile }; }
    catch { fonts[it.fontName] = { name: tc.styles[it.fontName]?.fontFamily }; }
  }
  const lines = [];
  for (const it of items) {
    const y = it.transform[5]; const size = Math.hypot(it.transform[2], it.transform[3]);
    let L = lines.find(l => Math.abs(l.y - y) < 0.2 * Math.max(size, l.size));
    if (!L) { L = { y, size, items: [] }; lines.push(L); } L.items.push(it);
  }
  lines.sort((a, b) => b.y - a.y);
  for (const L of lines) {
    L.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '', prevEnd = null;
    for (const it of L.items) {
      const x = it.transform[4];
      if (prevEnd !== null && x - prevEnd > 0.15 * L.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      text += it.str; prevEnd = x + it.width;
    }
    L.text = text.replace(/\s+/g, ' ').trim(); L.x0 = L.items[0].transform[4]; L.x1 = prevEnd;
    L.items = L.items.map(i => ({ str: i.str, pdfjsFontId: i.fontName, fontName: fonts[i.fontName]?.name, embeddedFileMissing: fonts[i.fontName]?.missingFile,
      size: +Math.hypot(i.transform[2], i.transform[3]).toFixed(4), transform: i.transform.map(v => +v.toFixed(4)), width: +i.width.toFixed(4) }));
  }
  const vp = page.getViewport({ scale: 1 });
  const pageText = lines.map(l => l.text).join('\n');
  await doc.destroy();
  return { lines, pageText, viewBox: vp.viewBox };
}

function utf16hex(h) { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return s; }
export function parseToUnicode(txt) {
  const map = new Map(); let codeBytes = 1;
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { codeBytes = m[1].length / 2; map.set(parseInt(m[1], 16), utf16hex(m[2])); }
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      codeBytes = m[1].length / 2; const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3].startsWith('[')) { const arr = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => x[1]); for (let c = lo; c <= hi; c++) map.set(c, utf16hex(arr[c - lo] || '')); }
      else { const base = m[3].slice(1, -1); const last = parseInt(base.slice(-4), 16); for (let c = lo; c <= hi; c++) map.set(c, utf16hex(base.slice(0, -4) + (last + c - lo).toString(16).padStart(4, '0'))); }
    }
  return { map, codeBytes };
}

let _ctx = null; const pdfCtx = () => _ctx;
function fontResource(page, resName) {
  _ctx = page.doc.context;
  const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
  const fd = fonts.lookup(PDFName.of(resName), PDFDict);
  const nm = k => { const v = fd.lookup(PDFName.of(k)); return v ? v.decodeText ? v.decodeText() : v.toString().replace(/^\//, '') : null; };
  const info = { resName, subtype: nm('Subtype'), baseFont: nm('BaseFont') };
  info.subset = /^[A-Z]{6}\+/.test(info.baseFont || '');
  const tu = fd.lookup(PDFName.of('ToUnicode'));
  if (tu) { const t = bytesToBinary(decodePDFRawStream(tu).decode()); const p = parseToUnicode(t); info.toUnicode = p.map; info.codeBytes = p.codeBytes; }
  if (info.subtype === 'Type0') { info.codeBytes = 2; }
  const W = fd.lookupMaybe(PDFName.of('Widths'), PDFArray); const FC = fd.lookup(PDFName.of('FirstChar'));
  if (W && FC) { info.firstChar = FC.asNumber(); info.widths = W.asArray().map(n => n.asNumber()); }
  let desc = fd.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  if (info.subtype === 'Type0') {
    const df = fd.lookup(PDFName.of('DescendantFonts'), PDFArray); const cid = df && df.lookup(0, PDFDict);
    if (cid) {
      desc = cid.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
      const dw = cid.lookup(PDFName.of('DW')); info.dw = dw ? dw.asNumber() : 1000; info.cidW = new Map();
      const Wa = cid.lookupMaybe(PDFName.of('W'), PDFArray);
      if (Wa) { const a = Wa.asArray().map(x => { const v = Wa.context ? x : x; return v; }); let i = 0;
        const val = x => pdfCtx(fd).lookup(x);
        while (i < a.length) { const c0 = val(a[i]).asNumber(); const nx = val(a[i + 1]);
          if (nx instanceof PDFArray) { nx.asArray().forEach((w, k) => info.cidW.set(c0 + k, val(w).asNumber())); i += 2; }
          else { const c1 = nx.asNumber(), w = val(a[i + 2]).asNumber(); for (let c = c0; c <= c1; c++) info.cidW.set(c, w); i += 3; } } }
    }
  }
  if (desc) {
    const num = k => { const v = desc.lookup(PDFName.of(k)); return v && v.asNumber ? v.asNumber() : null; };
    info.flags = num('Flags'); info.xHeight = num('XHeight'); info.capHeight = num('CapHeight');
    info.fontFile = ['FontFile2', 'FontFile3', 'FontFile'].find(k => desc.lookup(PDFName.of(k))) || null;
  }
  return info;
}

export function glyphWidth(fi, code) { // glyph-space width (1/1000 em)
  if (fi.subtype === 'Type0') return fi.cidW && fi.cidW.has(code) ? fi.cidW.get(code) : (fi.dw ?? 1000);
  if (fi.widths) { const w = fi.widths[code - fi.firstChar]; return w ?? 0; }
  return 0;
}
function chooseFallback(baseFont, flags) {
  const n = (baseFont || '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (/mono|courier|consol|menlo|cousine/.test(n) || (flags & 1)) return 'mono';
  if (/sans|arial|helvet|arimo|verdana|calibri|segoe/.test(n)) return 'sans';
  if (/serif|times|roman|tinos|georgia|garamond|cambria|book/.test(n) || (flags & 2)) return 'serif';
  return 'sans';
}

const fmt = v => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };
const hexOf = codes => '<' + codes.map(c => c.toString(16).padStart(2, '0')).join('') + '>';

// ---------------------------------------------------------------------------------------------
// Word-level edit. Only the glyphs of the edited span are removed from their text-show operator;
// the remaining glyphs keep their exact bytes, and a TJ positioning number of the span's exact
// advance is put where the span was, so every glyph to the right stays at the identical position.
// The replacement is drawn as ONE run in ONE font (embedded if it has every glyph, else fallback).
// Width rule: letter spacing (Tc) up to +/-0.04 em per letter, then horizontal scale (Tz) 0.97-1.03 on top;
// still shorter -> natural width + reported gap; still longer -> REFUSED, nothing written.
// ---------------------------------------------------------------------------------------------
export const SPACING_MAX_EM = 0.04, SCALE_MIN = 0.97, SCALE_MAX = 1.03;
const bytesOf = str => [...str].map(c => c.charCodeAt(0));
const hexBytes = b => '<' + b.map(c => c.toString(16).padStart(2, '0')).join('') + '>';

function makeLayout(page, fontCache) {
  return rec => {
    const fi = fontCache[rec.font] || (fontCache[rec.font] = fontResource(page, rec.font));
    const cb = fi.codeBytes || 1; const k = rec.Th / 100; const glyphs = []; let x = 0;
    const elems = rec.op === 'TJ' ? rec.args[0].v : [rec.strArg];
    elems.forEach((el, ei) => {
      if (el.t === 'num') { x += -el.v / 1000 * rec.size * k; return; }
      if (el.t !== 'str') return;
      const b = bytesOf(el.v);
      for (let i = 0; i + cb <= b.length; i += cb) {
        const code = cb === 2 ? (b[i] << 8) | b[i + 1] : b[i];
        const w0 = glyphWidth(fi, code);
        const tx = (w0 / 1000 * rec.size + rec.Tc + (cb === 1 && code === 32 ? rec.Tw : 0)) * k;
        glyphs.push({ code, bytes: b.slice(i, i + cb), char: fi.toUnicode?.get(code) ?? '\uFFFD', x, tx, ei });
        x += tx;
      }
    });
    return { glyphs, adv: x };
  };
}

function lineGlyphs(shows) { // flatten glyphs with user-space coordinates
  const out = [];
  shows.forEach((sh, si) => { if (!sh.glyphs) return; const M = mul(sh.Tm, sh.ctm);
    sh.glyphs.forEach((g, gi) => { const [ux, uy] = apply(M, g.x, sh.rise); const [ex] = apply(M, g.x + g.tx, sh.rise);
      out.push({ ...g, si, gi, ux, uy, uxEnd: ex, size: sh.size * Math.hypot(M[2], M[3]) }); }); });
  return out;
}
function groupLines(glyphs) {
  const lines = [];
  for (const g of glyphs) { let L = lines.find(l => Math.abs(l.y - g.uy) < 0.2 * Math.max(l.size, g.size)); if (!L) { L = { y: g.uy, size: g.size, glyphs: [] }; lines.push(L); } L.glyphs.push(g); }
  lines.sort((a, b) => b.y - a.y);
  for (const L of lines) { // text with a char->glyph map; virtual spaces for positioned gaps
    L.glyphs.sort((a, b) => a.ux - b.ux); let text = '', map = [], prev = null;
    for (const g of L.glyphs) {
      if (prev && g.ux - prev.uxEnd > 0.15 * L.size && !/\s$/.test(text) && !/^\s/.test(g.char)) { text += ' '; map.push(null); }
      for (const ch of g.char) { text += ch; map.push(g); } prev = g;
    }
    L.text = text; L.map = map;
  }
  return lines;
}

export async function editTextLine({ url, find, replace, lineContains, occurrence = 0, renderScale = 2, cropScale = 4 }) {
  const original = await fetchBytes(url);
  const shaBefore = await sha256(original);
  const before = await readLines(original);
  const pdoc = await PDFDocument.load(original.slice(), { updateMetadata: false });
  pdoc.registerFontkit(window.fontkit);
  const page = pdoc.getPage(0);
  const cvRef = page.node.get(PDFName.of('Contents'));
  const refs = cvRef instanceof PDFArray ? cvRef.asArray() : [cvRef];
  const s = refs.map(r => bytesToBinary(decodePDFRawStream(pdoc.context.lookup(r)).decode())).join('\n');
  const ops = tokenize(s); const fontCache = {};
  const shows = textShows(ops, makeLayout(page, fontCache));
  const allGlyphs = lineGlyphs(shows); const lines = groupLines(allGlyphs);
  const cands = lines.filter(l => l.text.includes(lineContains || find));
  const line = cands[occurrence]; if (!line) throw new Error(`line #${occurrence} containing "${lineContains || find}" not found`);
  const pos = line.text.indexOf(find); if (pos < 0 || line.text.indexOf(find, pos + 1) >= 0) throw new Error('find must occur exactly once in the chosen line');
  const spanGlyphs = [...new Set(line.map.slice(pos, pos + find.length).filter(Boolean))];
  const spanSet = new Set(spanGlyphs);
  const first = spanGlyphs[0], last = spanGlyphs[spanGlyphs.length - 1];
  const sh0 = shows[first.si];
  const newLineText = line.text.slice(0, pos) + replace + line.text.slice(pos + find.length);
  // slot: from the first span glyph's origin to the end of the last span glyph's advance (text space of sh0)
  const M0 = mul(sh0.Tm, sh0.ctm); const scaleX = Math.hypot(M0[0], M0[1]);
  const slotUser = last.uxEnd - first.ux; const slotTx = slotUser / scaleX;

  // ---- font for the new run: all-or-nothing ----
  const fi = fontCache[sh0.font];
  const needed = [...new Set([...replace])];
  let rev = null, missing;
  if (fi.toUnicode && fi.fontFile) {
    rev = new Map(); for (const [code, u] of fi.toUnicode) if (!rev.has(u)) rev.set(u, code);
    missing = needed.filter(ch => { const c = rev.get(ch); return c === undefined || !(glyphWidth(fi, c) > 0); });
  } else missing = needed;
  const record = { originalFont: fi.baseFont, resName: fi.resName, subtype: fi.subtype, subset: fi.subset, embeddedFontFile: fi.fontFile, glyphsNeeded: needed.join(''), missingGlyphs: missing };
  let fontOp, textHex, size = sh0.size, newTx;
  const k = sh0.Th / 100;
  if (!missing.length) {
    const codes = [...replace].map(ch => rev.get(ch));
    textHex = hexBytes(codes.flatMap(c => fi.codeBytes === 2 ? [c >> 8, c & 255] : [c]));
    newTx = codes.reduce((t, c) => t + (glyphWidth(fi, c) / 1000 * size + sh0.Tc + (fi.codeBytes !== 2 && c === 32 ? sh0.Tw : 0)) * k, 0);
    fontOp = `/${sh0.font}`;
    Object.assign(record, { used: 'embedded', reason: `embedded font ${fi.baseFont} has a glyph (ToUnicode + width) for every character of the replacement run` });
  } else {
    const kind = chooseFallback(fi.baseFont, fi.flags); const FB = FALLBACK_FONTS[kind];
    const ttf = await fetchBytes(FB.file); const fk = window.fontkit.create(ttf);
    const pfont = await pdoc.embedFont(ttf, { subset: true });
    const ratios = [];
    if (fi.toUnicode) for (const [code, u] of fi.toUnicode) { const w = glyphWidth(fi, code); if (!(w > 0) || u.length !== 1 || u === ' ') continue; const g = fk.glyphForCodePoint(u.codePointAt(0)); if (g && g.id) ratios.push(w / (g.advanceWidth * 1000 / fk.unitsPerEm)); }
    ratios.sort((a, b) => a - b); const med = ratios.length ? ratios[ratios.length >> 1] : 1;
    let sc = 1, method;
    if (fi.xHeight && fk.xHeight) { sc = (fi.xHeight / 1000) / (fk.xHeight / fk.unitsPerEm); method = 'x-height from FontDescriptor'; }
    else if (Math.abs(med - 1) > 0.02) { sc = med; method = 'median advance-width ratio over shared glyphs'; }
    else method = 'metric-compatible (median width ratio within 2%), size kept';
    size = sh0.size * sc;
    newTx = (pfont.widthOfTextAtSize(replace, size) + sh0.Tc * [...replace].length) * k;
    fontOp = page.node.newFontDictionary('FRPFallback', pfont.ref).toString(); textHex = pfont.encodeText(replace).toString();
    Object.assign(record, { used: 'fallback', fallbackKind: kind, fallbackFont: FB.name, fallbackFile: 'vendor' + FB.file.replace('/vendor', ''), fallbackLicense: FB.license,
      reason: `embedded ${fi.subset ? 'SUBSET ' : ''}font ${fi.baseFont} has no glyph for ${missing.map(c => JSON.stringify(c)).join(', ')}; the WHOLE replacement run uses the fallback (no per-glyph mixing)`,
      sizeScale: +sc.toFixed(4), sizeMethod: method, widthRatio: { sharedGlyphs: ratios.length, min: +(ratios[0] || 1).toFixed(4), median: +med.toFixed(4), max: +(ratios[ratios.length - 1] || 1).toFixed(4) } });
  }
  // ---- overflow rule ----
  // width rule (team decision): 1) letter spacing up to +/-0.04 em per letter gap, 2) then horizontal scale 0.97-1.03
  // on top, 3) still shorter -> natural width from the original start, report the gap, 4) still longer -> refuse.
  const nGl = [...replace].length, gaps = Math.max(0, nGl - 1);
  const A = newTx / k, slotA = slotTx / k, dMax = SPACING_MAX_EM * size;
  const dReq = gaps ? (slotA - A) / gaps : 0; const dlt = Math.max(-dMax, Math.min(dMax, dReq));
  const W1 = A + gaps * dlt; const sc = Math.max(SCALE_MIN, Math.min(SCALE_MAX, slotA / W1)); const W2 = W1 * sc;
  const left = (slotA - W2) * k * scaleX; // pt
  const overflow = { rule: `letter spacing up to +/-${SPACING_MAX_EM} em per letter, then horizontal scale ${SCALE_MIN}-${SCALE_MAX}; still shorter -> natural width + gap; still longer -> refused`,
    slotPt: +slotUser.toFixed(3), naturalWidthPt: +(newTx * scaleX).toFixed(3), letters: nGl,
    spacingNeededEm: +(dReq / size).toFixed(4), spacingTriedEm: +(dlt / size).toFixed(4), scaleTried: +sc.toFixed(4), leftoverAfterSpacingAndScalePt: +left.toFixed(3) };
  let Th = sh0.Th, Tc = sh0.Tc;
  const TOL = 0.005; // pt
  if (left < -TOL) {
    overflow.decision = 'REFUSED'; overflow.explanation = `replacement is ${(newTx * scaleX).toFixed(2)}pt; the slot is ${slotUser.toFixed(2)}pt. Even at ${(dlt / size).toFixed(3)} em spacing and ${(sc * 100).toFixed(1)}% scale it is ${(-left).toFixed(2)}pt too long, and the words to its right may not move. Nothing written.`;
    return { input: url, refused: true, edit: { find, replace, newText: newLineText }, line: { text: line.text, baseline: +line.y.toFixed(4) }, font: record, overflow, shaBefore, shaAfterRefetch: await sha256(await fetchBytes(url)) };
  }
  if (left > TOL) { overflow.decision = 'still shorter after max spacing and scale -> drawn at natural width from the original start; gap reported'; overflow.spacingEm = 0; overflow.scale = 1; overflow.gapPt = +((slotTx - newTx) * scaleX).toFixed(3); }
  else { Tc = sh0.Tc + dlt; Th = sh0.Th * sc; overflow.spacingEm = +(dlt / size).toFixed(4); overflow.scale = +sc.toFixed(4); overflow.gapPt = 0;
    overflow.decision = `fits: spacing ${(dlt / size).toFixed(4)} em per letter${Math.abs(sc - 1) > 1e-6 ? `, scale ${(sc * 100).toFixed(2)}%` : ', no scaling'}; following words do not move`; }
  const drawnTx = overflow.gapPt ? newTx : W2 * k;

  // ---- rewrite the operators that carry span glyphs ----
  const touched = [...new Set(spanGlyphs.map(g => g.si))].sort((a, b) => a - b);
  let out = '', cur = 0;
  for (const si of touched) {
    const sh = shows[si]; const o = ops[sh.idx];
    const elems = sh.op === 'TJ' ? sh.args[0].v : [sh.strArg];
    const kk = sh.Th / 100; const parts = []; let pending = 0;
    const flush = () => { if (Math.abs(pending) > 1e-9) { parts.push(fmt(-pending * 1000 / (sh.size * kk))); pending = 0; } };
    let gi = 0;
    elems.forEach((el, ei) => {
      if (el.t === 'num') { // kerning: keep unless it sits inside the span
        const prevG = sh.glyphs[gi - 1], nextG = sh.glyphs[gi];
        const inside = prevG && nextG && spanSet.has(allGlyphs.find(g => g.si === si && g.gi === gi - 1)) && spanSet.has(allGlyphs.find(g => g.si === si && g.gi === gi));
        if (inside) pending += -el.v / 1000 * sh.size * kk; else { flush(); parts.push(el.raw); }
        return;
      }
      if (el.t !== 'str') return;
      let run = [];
      const n = sh.glyphs.filter(g => g.ei === ei).length;
      for (let j = 0; j < n; j++, gi++) {
        const g = sh.glyphs[gi]; const G = allGlyphs.find(x => x.si === si && x.gi === gi);
        if (spanSet.has(G)) { if (run.length) { parts.push(hexBytes(run)); run = []; } pending += g.tx; }
        else { if (Math.abs(pending) > 1e-9) { if (run.length) { parts.push(hexBytes(run)); run = []; } flush(); } run.push(...g.bytes); }
      }
      if (run.length) parts.push(hexBytes(run));
    });
    flush();
    const a = o.args; let pre = '';
    if (sh.op === "'") pre = 'T* '; else if (sh.op === '"') pre = `${fmt(a[0].v)} Tw ${fmt(a[1].v)} Tc T* `;
    out += s.slice(cur, o.start) + pre + `[${parts.join(' ')}] TJ`; cur = o.end;
  }
  out += s.slice(cur);
  // ---- the replacement run ----
  const TmSpan = mul([1, 0, 0, 1, first.x, 0], sh0.Tm);
  const fill = sh0.fill.map(o => s.slice(o.start, o.end)).join('\n');
  const block = ['q', `${sh0.ctm.map(fmt).join(' ')} cm`, fill, 'BT', `${fontOp} ${fmt(size)} Tf`,
    `${fmt(Tc)} Tc ${fmt(sh0.Tw)} Tw ${fmt(Th)} Tz ${fmt(sh0.rise)} Ts ${fmt(sh0.Tr)} Tr`, `${TmSpan.map(fmt).join(' ')} Tm`, `${textHex} Tj`, 'ET', 'Q'].filter(Boolean).join('\n');
  const newContent = 'q\n' + out + '\nQ\n' + block + '\n'; // no comment: it must not carry the old word
  page.node.set(PDFName.of('Contents'), pdoc.context.register(pdoc.context.flateStream(binaryToBytes(newContent))));
  for (const r of refs) if (r instanceof PDFRef) pdoc.context.delete(r);
  await pdoc.flush(); const gc = collectGarbage(pdoc);
  const edited = await pdoc.save({ useObjectStreams: false });

  // ---- verification 1: every untouched glyph on the page sits at the identical position ----
  const chk = await PDFDocument.load(edited); const cpage = chk.getPage(0);
  const cs = (() => { const c = cpage.node.get(PDFName.of('Contents')); const rr = c instanceof PDFArray ? c.asArray() : [c]; return rr.map(r => bytesToBinary(decodePDFRawStream(chk.context.lookup(r)).decode())).join('\n'); })();
  const cops = tokenize(cs); const cshows = textShows(cops, makeLayout(cpage, {}));
  const newRun = cshows[cshows.length - 1];
  const keptBefore = allGlyphs.filter(g => !spanSet.has(g)).map(g => [g.code, g.ux, g.uy]);
  const keptAfter = lineGlyphs(cshows.slice(0, -1)).map(g => [g.code, g.ux, g.uy]);
  const key = a => a.slice().sort((p, q) => q[2] - p[2] || p[1] - q[1]);
  const kb = key(keptBefore), ka = key(keptAfter); let maxShift = 0, codeMismatch = 0;
  if (kb.length === ka.length) kb.forEach((g, i) => { maxShift = Math.max(maxShift, Math.hypot(g[1] - ka[i][1], g[2] - ka[i][2])); if (g[0] !== ka[i][0]) codeMismatch++; });
  const right = allGlyphs.filter(g => Math.abs(g.uy - line.y) < 0.2 * line.size && !spanSet.has(g) && g.ux >= last.uxEnd - 1e-6);
  // ---- verification 2: pdf.js text layer ----
  const after = await readLines(edited);
  const norm = t => t.replace(/\s+/g, ' ').trim();
  const newLine = after.lines.find(l => Math.abs(l.y - line.y) < 0.2 * line.size && norm(l.text).includes(norm(replace)));
  const countIn = (txt, q) => txt.split(q).length - 1;
  const verify = {
    pdfjsNewLineText: newLine?.text, expected: newLineText, newLineMatches: norm(newLine?.text || '') === norm(newLineText),
    findCountBefore: countIn(before.pageText, find), findCountAfter: countIn(after.pageText, find), replaceCountBefore: countIn(before.pageText, replace), replaceCountAfter: countIn(after.pageText, replace),
    findGoneFromEditedLine: !norm(newLine?.text || '').includes(norm(find)),
    otherLinesIdentical: JSON.stringify(before.lines.filter(l => Math.abs(l.y - line.y) >= 0.2 * line.size).map(l => [l.y, l.text])) === JSON.stringify(after.lines.filter(l => Math.abs(l.y - line.y) >= 0.2 * line.size).map(l => [l.y, l.text])),
    untouchedGlyphs: kb.length, untouchedGlyphsAfter: ka.length, untouchedGlyphMaxShiftPt: +maxShift.toExponential(3), untouchedGlyphCodeMismatches: codeMismatch,
    glyphsRightOfSpanOnLine: right.length, textRightOfSpan: line.text.slice(pos + find.length),
    newRunFont: newRun.font, newRunTz: newRun.Th,
  };
  // ---- verification 3: pixels ----
  const vb = before.viewBox; const toPx = (x, y, kx) => [(x - vb[0]) * kx, (vb[3] - y) * kx];
  const spanEndUser = first.ux + Math.max(slotUser, drawnTx * scaleX);
  const fs = Math.max(size, line.size);
  const boxPdf = { x0: first.ux, x1: spanEndUser, yTop: line.y + 1.0 * fs, yBot: line.y - 0.32 * fs };
  const boxAt = (kx, pad = 2) => { const [x0, y0] = toPx(boxPdf.x0, boxPdf.yTop, kx), [x1, y1] = toPx(boxPdf.x1, boxPdf.yBot, kx); return { x0: Math.floor(x0) - pad, y0: Math.floor(y0) - pad, x1: Math.ceil(x1) + pad, y1: Math.ceil(y1) + pad }; };
  const cA = await renderPage(original, renderScale), cB = await renderPage(edited, renderScale);
  const b = boxAt(renderScale);
  const d = diff(cA, cB, (x, y) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1, [b]);
  // explicit right-of-span check on the same line band
  let rightChanged = 0, rightPixels = 0; { const A = cA.getContext('2d').getImageData(0, 0, cA.width, cA.height).data, B = cB.getContext('2d').getImageData(0, 0, cB.width, cB.height).data;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x1; x < cA.width; x++) { rightPixels++; const i = (y * cA.width + x) * 4; if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) rightChanged++; } }
  const hA = await renderPage(original, cropScale), hB = await renderPage(edited, cropScale);
  const hb = boxAt(cropScale, 2); const m = line.size * cropScale * 0.9;
  const [lx0] = toPx(Math.min(...line.glyphs.map(g => g.ux)), 0, cropScale), [lx1] = toPx(Math.max(...line.glyphs.map(g => g.uxEnd)), 0, cropScale);
  const cropBefore = crop(hA, Math.min(lx0, hb.x0) - 20, hb.y0 - m, Math.max(lx1, hb.x1) + 20, hb.y1 + m), cropAfter = crop(hB, Math.min(lx0, hb.x0) - 20, hb.y0 - m, Math.max(lx1, hb.x1) + 20, hb.y1 + m);
  const boxed = crop(hB, Math.min(lx0, hb.x0) - 20, hb.y0 - m, Math.max(lx1, hb.x1) + 20, hb.y1 + m);
  { const g = boxed.getContext('2d'); g.strokeStyle = 'rgb(0,90,255)'; g.lineWidth = 2; g.strokeRect(hb.x0 - (Math.min(lx0, hb.x0) - 20), m, hb.x1 - hb.x0, hb.y1 - hb.y0); }
  const shaRefetch = await sha256(await fetchBytes(url));
  return {
    input: url, shaBefore, shaAfterRefetch: shaRefetch,
    line: { text: line.text, baseline: +line.y.toFixed(4), size: line.size, occurrence, candidatesOnPage: cands.length },
    edit: { find, replace, newText: newLineText },
    span: { startChar: pos, endChar: pos + replace.length, text: replace, oldStartChar: pos, oldEndChar: pos + find.length,
      bboxPdf: { x0: +boxPdf.x0.toFixed(3), y0: +boxPdf.yBot.toFixed(3), x1: +boxPdf.x1.toFixed(3), y1: +boxPdf.yTop.toFixed(3) }, bboxPx: b, font: record.used },
    contentStream: { opsTotal: ops.length, showOpsTotal: shows.length, showOpsRewritten: touched.length, spanGlyphs: spanGlyphs.length, structure: touched.map(si => ({ op: shows[si].op, glyphsInOp: shows[si].glyphs.length, spanGlyphsInOp: spanGlyphs.filter(g => g.si === si).length })), oldStreamRefs: refs.map(String) },
    font: record, overflow, verify, fileHygiene: { gcRemovedObjects: gc.removed, objectsKept: gc.kept },
    pixel: { renderScale, boxPx: b, changedOutsideBox: d.outside, changedInsideBox: d.inside, rightOfBoxSameLineChanged: rightChanged, rightOfBoxSameLinePixels: rightPixels, outsideSamples: d.outsideSamples, width: cA.width, height: cA.height },
    images: { before_full: png(cA), after_full: png(cB), diff_full: png(d.canvas), line_before: png(cropBefore), line_after: png(cropAfter), line_after_span_outlined: png(boxed) },
    outputPdfB64: u8ToB64(edited),
  };
}
