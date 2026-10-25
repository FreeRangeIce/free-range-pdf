// Wraps make_orient_icc.py's JPEGs as image-only PDFs into proof/inputs (JPEG bytes copied verbatim, like wrap_images.mjs).
import { PDFDocument, PDFName, PDFArray, PDFNumber, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib'; import fs from 'fs';
import { fileURLToPath } from 'url'; import path from 'path';
const HERE = path.dirname(fileURLToPath(import.meta.url)), IN = path.join(HERE, '../inputs'), T = '/tmp/frpdf-orient', s = 72 / 144;
async function make(name, jpgFile, mode, icc, iccN = 3) {
  const doc = await PDFDocument.create(); doc.setTitle(`FreeRangePDF stand-in (${name}, SIMULATED)`); doc.setProducer('FreeRangePDF stand-in generator');
  const img = await doc.embedJpg(fs.readFileSync(path.join(T, jpgFile))); const w = img.width * s, h = img.height * s;
  if (mode === 'upright') { const p = doc.addPage([w, h]); p.drawImage(img, { x: 0, y: 0, width: w, height: h }); }
  else if (mode === 'rot90') { // stored sideways (CCW); page is landscape in user space and /Rotate 90 turns it upright
    const p = doc.addPage([w, h]); p.drawImage(img, { x: 0, y: 0, width: w, height: h }); p.setRotation({ type: 'degrees', angle: 90 }); }
  else if (mode === 'cm90') { // stored sideways (CCW); portrait page, image drawn with a -90 deg placement matrix
    const p = doc.addPage([h, w]); p.drawImage(img, { x: 0, y: w, width: w, height: h, rotate: { type: 'degrees', angle: -90 } }); }
  else if (mode === 'rot180' || mode === 'rot270') { const p = mode === 'rot180' ? doc.addPage([w, h]) : doc.addPage([w, h]); p.drawImage(img, { x: 0, y: 0, width: w, height: h }); p.setRotation({ type: 'degrees', angle: mode === 'rot180' ? 180 : 270 }); }
  else if (mode === 'vflip' || mode === 'hflip') { // stored mirrored; a negative-scale placement matrix flips it back upright
    const p = doc.addPage([w, h]); await img.embed(); const n = p.node.newXObject('Image', img.ref);
    const m = mode === 'vflip' ? [w, 0, 0, -h, 0, h] : [-w, 0, 0, h, w, 0];
    p.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(n), popGraphicsState()); }
  if (icc) { await img.embed(); const cs = doc.context.register(doc.context.flateStream(fs.readFileSync(icc), { N: iccN })); doc.context.lookup(img.ref).dict.set(PDFName.of('ColorSpace'), doc.context.obj([PDFName.of('ICCBased'), cs])); }
  fs.writeFileSync(path.join(IN, name + '.pdf'), await doc.save({ useObjectStreams: false })); console.log(name);
}
await make('orient-exif6', 'exif6.jpg', 'upright'); await make('orient-exif8', 'exif8.jpg', 'upright');
await make('orient-rot90', 'side.jpg', 'rot90'); await make('orient-cm90', 'side.jpg', 'cm90');
await make('icc-wide-app2', 'wide.jpg', 'upright'); await make('icc-wide-iccbased', 'wide.jpg', 'upright', path.join(T, 'test-wide.icc'));
await make('orient-exif3', 'exif3.jpg', 'upright'); await make('orient-rot180', 'r180.jpg', 'rot180'); await make('orient-rot270', 'r270.jpg', 'rot270');
await make('orient-vflip', 'vflip.jpg', 'vflip'); await make('orient-hflip', 'hflip.jpg', 'hflip');
await make('color-gray', 'gray.jpg', 'upright'); await make('color-gray-iccbased', 'gray.jpg', 'upright', path.join(T, 'test-gray.icc'), 1);
await make('color-cmyk', 'cmyk.jpg', 'upright');
