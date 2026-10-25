"""Reports which personal metadata survives a photo edit: JPEG EXIF (make/model, timestamps, GPS, IFD1 thumbnail), APP2 ICC,
image XMP, catalog XMP, page /Thumb and the PDF /Info dictionary. usage: metadata_report.py <in.pdf> <out.pdf>  (prints JSON)
Report only: whether personal data is kept or removed is the owner's decision; this documents what the code does today."""
import sys, json, pikepdf
def info(f):
    p = pikepdf.open(f); pg = p.pages[0]; r = {}
    r['pdfInfo'] = {str(k): str(v) for k, v in p.docinfo.items()} if p.trailer.get('/Info') is not None else None
    r['catalogXMP'] = '/Metadata' in p.Root; r['pageThumb'] = '/Thumb' in pg
    ims = [o for o in pg.Resources.XObject.values() if o.get('/Subtype') == '/Image']; im = ims[0]; raw = im.read_raw_bytes(); head = raw[:200000]
    r['imageFilter'] = str(im.get('/Filter')); r['imageColorSpace'] = str(im.get('/ColorSpace'))[:60]; r['imageXMP'] = '/Metadata' in im
    r['jpegExif'] = b'Exif\x00\x00' in head; r['jpegICC'] = b'ICC_PROFILE' in head; r['jpegXMP'] = b'http://ns.adobe.com/xap/1.0/' in head
    r['exifMakeModel'] = b'FakePhone' in head or b'FP-12' in head; r['exifDateTime'] = b'2026:10:11 14:02:33' in head
    r['anyGpsMarkerInFile'] = any(s in open(f, 'rb').read() for s in [b'GPSLatitude', b'exif:GPS'])
    return r
a, b = info(sys.argv[1]), info(sys.argv[2])
print(json.dumps({'input': a, 'output': b, 'pdfInfoUnchanged': a['pdfInfo'] == b['pdfInfo']}, indent=1))
