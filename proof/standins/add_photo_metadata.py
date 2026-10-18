"""Give the photo stand-in the metadata a real phone photo carries, so the 'metadata is gone' check is meaningful:
EXIF (Make/Model/DateTime), a GPS IFD with a fake location, an EXIF thumbnail (IFD1 JPEG), and an sRGB ICC profile (APP2).
The segments are inserted after SOI/APP0; the JPEG's entropy-coded image data is untouched (no re-encode)."""
import struct, io, sys
from PIL import Image, ImageCms
src = 'photo-standin.jpg'
jpg = open(src, 'rb').read()
assert jpg[:2] == b'\xff\xd8'
# strip any previous APP1/APP2 we added (idempotent)
def segments(b):
    i = 2; out = []
    while i < len(b) and b[i] == 0xFF and b[i+1] not in (0xDA,):
        m = b[i+1]; L = struct.unpack('>H', b[i+2:i+4])[0]; out.append((m, b[i:i+2+L])); i += 2 + L
    return out, b[i:]
segs, rest = segments(jpg)
segs = [s for s in segs if s[0] not in (0xE1, 0xE2)]
im = Image.open(io.BytesIO(jpg)); th = im.copy(); th.thumbnail((160, 120)); tb = io.BytesIO(); th.save(tb, 'JPEG', quality=80); thumb = tb.getvalue()
def rat(n, d=1): return struct.pack('>II', n, d)
def ifd(entries, data_off, next_ifd=0):
    """entries: list of (tag, type, count, valuebytes). returns (ifd bytes, data bytes) with offsets from TIFF start."""
    n = len(entries); head = struct.pack('>H', n); body = b''; data = b''
    base = data_off + 2 + 12 * n + 4
    for tag, typ, cnt, val in entries:
        if len(val) <= 4: body += struct.pack('>HHI', tag, typ, cnt) + val.ljust(4, b'\0')
        else: body += struct.pack('>HHII', tag, typ, cnt, base + len(data)); data += val + (b'\0' if len(val) % 2 else b'')
    return head + body + struct.pack('>I', next_ifd), data
ASCII, SHORT, LONG, RATIONAL = 2, 3, 4, 5
s = lambda t: t.encode() + b'\0'
# layout: header(8) | IFD0 | IFD0 data | GPS IFD | GPS data | IFD1 | IFD1 data | thumbnail
def build():
    ifd0_off = 8
    ifd0_entries = lambda gps_off, ifd1_off: [(0x010F, ASCII, len(s('FakePhone')), s('FakePhone')), (0x0110, ASCII, len(s('FP-12 (stand-in)')), s('FP-12 (stand-in)')),
        (0x0132, ASCII, 20, s('2026:10:11 14:02:33')), (0x8825, LONG, 1, struct.pack('>I', gps_off))]
    a, ad = ifd(ifd0_entries(0, 0), ifd0_off); gps_off = ifd0_off + len(a) + len(ad)
    gps_entries = [(0x0000, 1, 4, bytes([2, 3, 0, 0])), (0x0001, ASCII, 2, b'N\0'), (0x0002, RATIONAL, 3, rat(45) + rat(31) + rat(1234, 100)),
                   (0x0003, ASCII, 2, b'W\0'), (0x0004, RATIONAL, 3, rat(122) + rat(40) + rat(5678, 100))]
    g, gdat = ifd(gps_entries, gps_off); ifd1_off = gps_off + len(g) + len(gdat)
    thumb_off_placeholder = 0
    i1e = lambda toff: [(0x0103, SHORT, 1, struct.pack('>H', 6)), (0x0201, LONG, 1, struct.pack('>I', toff)), (0x0202, LONG, 1, struct.pack('>I', len(thumb)))]
    i1, i1d = ifd(i1e(0), ifd1_off); thumb_off = ifd1_off + len(i1) + len(i1d)
    a, ad = ifd(ifd0_entries(gps_off, ifd1_off), ifd0_off, next_ifd=ifd1_off)
    g, gdat = ifd(gps_entries, gps_off); i1, i1d = ifd(i1e(thumb_off), ifd1_off)
    tiff = b'MM' + struct.pack('>HI', 42, ifd0_off) + a + ad + g + gdat + i1 + i1d + thumb
    return tiff
tiff = build()
app1 = b'\xff\xe1' + struct.pack('>H', 2 + 6 + len(tiff)) + b'Exif\0\0' + tiff
icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
app2 = b'\xff\xe2' + struct.pack('>H', 2 + 14 + len(icc)) + b'ICC_PROFILE\0' + bytes([1, 1]) + icc
app0 = [s for s in segs if s[0] == 0xE0]; others = [s for s in segs if s[0] != 0xE0]
out = b'\xff\xd8' + b''.join(x[1] for x in app0) + app1 + app2 + b''.join(x[1] for x in others) + rest
open(src, 'wb').write(out)
Image.open(src).load()
print('ok', len(jpg), '->', len(out), 'exif', len(tiff), 'thumb', len(thumb), 'icc', len(icc), 'exif readback GPS:', Image.open(src).getexif().get_ifd(0x8825))
