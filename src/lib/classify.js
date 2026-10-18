// Route each page to path A (text layer) or path B (scan/photo). A page whose only VISIBLE content is one image
// covering most of the page is a scan, even when an invisible OCR text layer (Tr 3) sits on top of it.
import { tokenize, mul } from './content-stream.js';
import { bytesToBinary } from './content-stream.js';
export function classifyPages(pdoc) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = window.PDFLib;
  return pdoc.getPages().map((page, pi) => {
    const { width: PW, height: PH } = page.getMediaBox(); const rot = page.getRotation().angle % 360;
    const res = page.node.Resources(); const xo = res && res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const cv = page.node.get(PDFName.of('Contents')); const refs = cv instanceof PDFArray ? cv.asArray() : cv ? [cv] : [];
    const s = refs.map(r => bytesToBinary(decodePDFRawStream(pdoc.context.lookup(r)).decode())).join('\n');
    let ctm = [1, 0, 0, 1, 0, 0], Tr = 0; const st = []; const images = []; let vis = 0, invis = 0, forms = 0;
    for (const o of tokenize(s)) {
      if (o.op === 'q') st.push([ctm, Tr]); else if (o.op === 'Q') [ctm, Tr] = st.pop() || [[1, 0, 0, 1, 0, 0], 0];
      else if (o.op === 'cm') ctm = mul(o.args.map(a => a.v), ctm);
      else if (o.op === 'Tr') Tr = o.args[0].v;
      else if (['Tj', 'TJ', "'", '"'].includes(o.op)) (Tr === 3 ? invis++ : vis++);
      else if (o.op === 'Do' && xo) {
        const obj = pdoc.context.lookup(xo.get(PDFName.of(o.args[0].v)));
        const sub = obj?.dict?.lookup(PDFName.of('Subtype'))?.toString();
        if (sub === '/Image') { const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]); images.push({ name: o.args[0].v, coverage: +(area / (PW * PH)).toFixed(4), filter: obj.dict.lookup(PDFName.of('Filter'))?.toString(), w: obj.dict.lookup(PDFName.of('Width'))?.asNumber(), h: obj.dict.lookup(PDFName.of('Height'))?.asNumber() }); }
        else if (sub === '/Form') forms++;
      }
    }
    const big = images.filter(i => i.coverage >= 0.85);
    let route, reason;
    if (big.length && vis === 0) { route = 'scan'; reason = `one image covers ${(big[0].coverage * 100).toFixed(1)}% of the page and there is no visible text${invis ? `; ${invis} invisible (Tr 3) text runs = an existing OCR layer, which path B keeps and edits` : ''}`; }
    else if (vis > 0 && big.length) { route = 'mixed'; reason = 'visible text over a full-page image'; }
    else if (vis > 0) { route = 'text'; reason = `${vis} visible text runs`; }
    else { route = 'unknown'; reason = 'no text and no full-page image'; }
    return { page: pi + 1, rotate: rot, images, visibleTextRuns: vis, invisibleTextRuns: invis, formXObjectsDrawn: forms, route, reason };
  });
}
