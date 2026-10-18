// Drop every indirect object not reachable from the trailer (Root/Info/Encrypt), so a saved file carries no
// orphaned old content streams, old images or unused fonts. pdf-lib always writes a complete new file (no incremental update).
export function collectGarbage(pdoc) {
  const { PDFRef, PDFDict, PDFArray, PDFRawStream, PDFStream } = window.PDFLib; const ctx = pdoc.context;
  // pdf-lib rewrites every stream's /Length as a direct number on save, which would orphan indirect Length objects
  // (LibreOffice writes /Length 12 0 R). Make them direct first so the GC below sees the final graph.
  const { PDFName, PDFNumber } = window.PDFLib;
  for (const [, o] of ctx.enumerateIndirectObjects()) if (o && o.dict instanceof PDFDict && o.dict.get(PDFName.of('Length')) instanceof PDFRef && o.contents) o.dict.set(PDFName.of('Length'), PDFNumber.of(o.contents.length));
  const seen = new Set(); const stack = [];
  const visit = o => {
    if (!o) return;
    if (o instanceof PDFRef) { const k = o.toString(); if (seen.has(k)) return; seen.add(k); stack.push(ctx.lookup(o)); return; }
    stack.push(o);
  };
  const ti = ctx.trailerInfo; [ti.Root, ti.Info, ti.Encrypt].forEach(visit);
  while (stack.length) {
    const o = stack.pop(); if (!o) continue;
    if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
    else if (o instanceof PDFArray) o.asArray().forEach(visit);
    else if (o.dict instanceof PDFDict) for (const [, v] of o.dict.entries()) visit(v);
  }
  const removed = [];
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) { removed.push(ref.toString()); ctx.delete(ref); }
  return { kept: seen.size, removed };
}
