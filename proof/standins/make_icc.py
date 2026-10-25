"""Writes a minimal (argv[2] == "gray": a gray kTRC profile instead)
 ICC v2 RGB matrix/TRC display profile with Adobe RGB (1998)-like primaries (D50-adapted colorants,
gamma 2.2), built from published numbers. Synthetic test profile only: 'FreeRangePDF test wide-gamut RGB'."""
import struct, sys
def s15(v): return struct.pack('>i', round(v * 65536))
def tag_xyz(x, y, z): return b'XYZ ' + b'\0' * 4 + s15(x) + s15(y) + s15(z)
def tag_curv(g): return b'curv' + b'\0' * 4 + struct.pack('>I', 1) + struct.pack('>H', round(g * 256)) + b'\0\0'
def tag_desc(t):
    a = t.encode() + b'\0'; return b'desc' + b'\0' * 4 + struct.pack('>I', len(a)) + a + b'\0' * 4 + b'\0' * 4 + b'\0' * 2 + b'\0' + b'\0' * 67
def tag_text(t): return b'text' + b'\0' * 4 + t.encode() + b'\0'
# Adobe RGB (1998) colorants, Bradford-adapted to D50 (as in common matrix profiles)
tags = [(b'desc', tag_desc('FreeRangePDF test wide-gamut RGB')), (b'cprt', tag_text('Public domain test profile')),
        (b'wtpt', tag_xyz(0.96420, 1.0, 0.82491)),
        (b'rXYZ', tag_xyz(0.60974, 0.31111, 0.01947)), (b'gXYZ', tag_xyz(0.20528, 0.62567, 0.06087)), (b'bXYZ', tag_xyz(0.14919, 0.06322, 0.74457)),
        (b'rTRC', tag_curv(2.19922)), (b'gTRC', tag_curv(2.19922)), (b'bTRC', tag_curv(2.19922))]
GRAY = len(sys.argv) > 2 and sys.argv[2] == 'gray'
if GRAY: tags = [(b'desc', tag_desc('FreeRangePDF test gray gamma 2.2')), (b'cprt', tag_text('Public domain test profile')), (b'wtpt', tag_xyz(0.96420, 1.0, 0.82491)), (b'kTRC', tag_curv(2.19922))]
off = 128 + 4 + 12 * len(tags); table = struct.pack('>I', len(tags)); data = b''
for sig, body in tags:
    while (off + len(data)) % 4: data += b'\0'
    table += sig + struct.pack('>II', off + len(data), len(body)); data += body
body = table + data
while len(body) % 4: body += b'\0'
size = 128 + len(body)
hdr = struct.pack('>I', size) + b'none' + struct.pack('>I', 0x02100000) + (b'mntrGRAYXYZ ' if GRAY else b'mntrRGB XYZ ') + struct.pack('>6H', 2026, 1, 1, 0, 0, 0) + b'acsp' + b'APPL' + struct.pack('>I', 0) + b'none' + b'\0' * 4 + b'\0' * 8 + struct.pack('>I', 0) + s15(0.9642) + s15(1.0) + s15(0.82491) + b'none' + b'\0' * 16 + b'\0' * 28
assert len(hdr) == 128, len(hdr)
open(sys.argv[1], 'wb').write(hdr + body)
