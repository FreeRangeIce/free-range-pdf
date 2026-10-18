import { editTextLine, readLines } from '/src/lib/text-edit.js';
  window.FRP = { editTextLine, readLines };
  try { const m = await import('/src/lib/scan-edit.js'); Object.assign(window.FRP, m); } catch (e) { window.FRP.scanImportError = String(e.stack || e); }
  window.FRP_READY = true;
import { classifyPages } from '/src/lib/classify.js';
window.FRP.classify = async url => classifyPages(await window.PDFLib.PDFDocument.load(new Uint8Array(await (await fetch(url)).arrayBuffer())));
