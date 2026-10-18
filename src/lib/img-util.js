// Canvas / pdf.js helpers shared by the proof pipelines (browser ES module).
import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
const REPO = p => new URL('../../' + p, import.meta.url).href; // repo-root-relative -> absolute URL, works under any base path
pdfjsLib.GlobalWorkerOptions.workerSrc = REPO('vendor/pdfjs/pdf.worker.min.mjs');
export { pdfjsLib };

export const PDFJS_OPTS = { cMapUrl: REPO('vendor/pdfjs/cmaps/'), cMapPacked: true,
  standardFontDataUrl: REPO('vendor/pdfjs/standard_fonts/'), wasmUrl: REPO('vendor/pdfjs/wasm/'), iccUrl: REPO('vendor/pdfjs/iccs/'),
  isEvalSupported: false, useSystemFonts: false };

export async function sha256(u8) {
  const h = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function openPdf(u8) { return pdfjsLib.getDocument({ ...PDFJS_OPTS, data: u8.slice() }).promise; }

export async function renderPage(u8, scale, pageNo = 1) {
  const doc = await openPdf(u8); const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  await doc.destroy();
  return c;
}

export function getData(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); }

// Count changed pixels. insideFn(x,y) says whether a pixel lies in the edited region.
export function diff(cA, cB, insideFn, boxes = []) {
  const A = getData(cA), B = getData(cB); const W = A.width, H = A.height;
  if (W !== B.width || H !== B.height) throw new Error(`size mismatch ${W}x${H} vs ${B.width}x${B.height}`);
  const out = new ImageData(W, H); let inside = 0, outside = 0; const outsideSamples = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4;
    const ch = A.data[k] !== B.data[k] || A.data[k + 1] !== B.data[k + 1] || A.data[k + 2] !== B.data[k + 2] || A.data[k + 3] !== B.data[k + 3];
    const g = 255 - (255 - (A.data[k] * 0.3 + A.data[k + 1] * 0.59 + A.data[k + 2] * 0.11)) * 0.25; // faint ghost of the page
    let r = g, gg = g, b = g;
    if (ch) { if (insideFn(x, y)) { inside++; r = 255; gg = 140; b = 0; } else { outside++; r = 255; gg = 0; b = 0; if (outsideSamples.length < 20) outsideSamples.push([x, y]); } }
    out.data[k] = r; out.data[k + 1] = gg; out.data[k + 2] = b; out.data[k + 3] = 255;
  }
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); ctx.putImageData(out, 0, 0);
  ctx.strokeStyle = 'rgb(0,90,255)'; ctx.lineWidth = Math.max(2, W / 600);
  for (const bx of boxes) { if (bx.poly) { ctx.beginPath(); bx.poly.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke(); } else ctx.strokeRect(bx.x0, bx.y0, bx.x1 - bx.x0, bx.y1 - bx.y0); }
  return { inside, outside, total: inside + outside, outsideSamples, canvas: c };
}

export function crop(c, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(c.width, Math.ceil(x1)); y1 = Math.min(c.height, Math.ceil(y1));
  const o = document.createElement('canvas'); o.width = x1 - x0; o.height = y1 - y0;
  o.getContext('2d').drawImage(c, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); return o;
}
export function scaled(c, maxW) {
  if (c.width <= maxW) return c; const k = maxW / c.width;
  const o = document.createElement('canvas'); o.width = maxW; o.height = Math.round(c.height * k);
  const ctx = o.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c, 0, 0, o.width, o.height); return o;
}
export const png = c => c.toDataURL('image/png');
export function u8ToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export async function fetchBytes(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(url + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); }
