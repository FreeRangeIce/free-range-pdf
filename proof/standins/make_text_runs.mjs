// Stand-in 4: a text PDF written with pdf-lib (embedded SUBSET Liberation Sans, Type0/Identity-H) that has
//  (a) lines drawn word-by-word as SEPARATE POSITIONED RUNS (one BT/Tm/Tj per word), and
//  (b) a repeated block (the same field line twice, "Tenant copy" / "Office copy") drawn as single TJ runs with kerning.
import { PDFDocument, PDFOperator, PDFNumber, rgb, beginText, endText, setFontAndSize, setTextMatrix, setFillingRgbColor, pushGraphicsState, popGraphicsState } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
doc.setTitle('FreeRangePDF proof stand-in: separate runs + repeated block'); doc.setProducer('FreeRangePDF stand-in generator (pdf-lib)');
const font = await doc.embedFont(fs.readFileSync('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'), { subset: true });
const page = doc.addPage([612, 792]);
const S = 11, LEAD = 16; let y = 700;
page.drawText('Tenant Move-In Checklist', { x: 72, y: 730, size: 16, font });
const runs = ['Please read each item below and keep this sheet with your lease.',
  'Keys will be handed over at the front office on Monday after ten.',
  'Report any damage within seven days so it is not charged to you.',
  'Bring photo ID and the signed lease when you collect the keys.'];
for (const line of runs) { let x = 72; for (const w of line.split(' ')) { page.drawText(w, { x, y, size: S, font }); x += font.widthOfTextAtSize(w + ' ', S); } y -= LEAD; }
const fname = page.node.newFontDictionary('FTJ', font.ref);
function tjLine(text, x, yy) { // one TJ run: words as hex strings incl. spaces, small kerning numbers between words
  const parts = []; text.split(' ').forEach((w, i, a) => { parts.push(font.encodeText(i < a.length - 1 ? w + ' ' : w)); if (i < a.length - 1) parts.push(PDFNumber.of(-12)); });
  page.pushOperators(pushGraphicsState(), setFillingRgbColor(0, 0, 0), beginText(), setFontAndSize(fname, S), setTextMatrix(1, 0, 0, 1, x, yy), PDFOperator.of('TJ', [doc.context.obj(parts)]), endText(), popGraphicsState());
}
y -= 14;
for (const copy of ['Tenant copy', 'Office copy']) {
  page.drawText(copy, { x: 72, y, size: 12, font }); y -= LEAD + 2;
  tjLine('Name: Jordan Ellis    Unit: 2B    Parking space: 17    Deposit paid: yes', 72, y); y -= LEAD;
  tjLine('Move-in date: June 1    Keys issued: 3    Signed by: J. Ellis', 72, y); y -= LEAD + 12;
}
fs.writeFileSync('text-runs-standin.pdf', await doc.save({ useObjectStreams: false }));
console.log('ok', font.widthOfTextAtSize('Monday', S), font.widthOfTextAtSize('Tuesday', S));
