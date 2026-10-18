// Wraps the simulated JPEGs as image-only PDFs. embedJpg copies the JPEG bytes verbatim (no re-encode).
// The photo also gets what phone/scanner apps leave behind: an XMP packet with GPS on the catalog and on the image,
// and a /Thumb page thumbnail (a small JPEG of the page), so the "metadata is gone" check has something to find.
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'; import fs from 'fs'; import zlib from 'zlib';
import { fileURLToPath } from 'url'; import path from 'path'; import { execFileSync } from 'child_process';
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
for (const [name, dpi] of [['scan',300],['photo',144]]) {
  const jpg = fs.readFileSync(`${name}-standin.jpg`);
  const doc = await PDFDocument.create();
  doc.setTitle(`FreeRangePDF proof stand-in (${name}, SIMULATED)`); doc.setProducer('FreeRangePDF stand-in generator');
  const img = await doc.embedJpg(jpg); const s = 72/dpi;
  const page = doc.addPage([img.width*s, img.height*s]);
  page.drawImage(img, {x:0,y:0,width:img.width*s,height:img.height*s});
  if (name === 'photo') {
    const xmp = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" exif:GPSLatitude="45,31.2057N" exif:GPSLongitude="122,40.9463W" tiff:Make="FakePhone" tiff:Model="FP-12 (stand-in)"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const mk = () => doc.context.register(doc.context.stream(Buffer.from(xmp, 'utf8'), { Type: 'Metadata', Subtype: 'XML' }));
    doc.catalog.set(PDFName.of('Metadata'), mk());
    await img.embed(); doc.context.lookup(img.ref).dict.set(PDFName.of('Metadata'), mk());
    execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${name}-standin.jpg'); im.thumbnail((106,140)); im.convert('RGB').save('/tmp/${name}-thumb.jpg', quality=75)`]);
    const t = new Uint8Array(fs.readFileSync(`/tmp/${name}-thumb.jpg`)); const ti = await doc.embedJpg(t); await ti.embed();
    page.node.set(PDFName.of('Thumb'), ti.ref);
  }
  fs.writeFileSync(`${name}-standin.pdf`, await doc.save({useObjectStreams:false}));
  console.log(name, img.width, img.height, page.getSize());
}
