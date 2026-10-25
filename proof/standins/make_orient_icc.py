"""Synthetic orientation / colour-profile stand-ins (all derived from photo-standin.jpg; nothing private).
  exif6 / exif8 : upright pixels, EXIF Orientation 6 / 8 (a PDF viewer ignores EXIF inside an image stream)
  rot90         : pixels stored sideways (90 CCW), page /Rotate 90 shows them upright
  cm90          : pixels stored sideways, placed with a rotated placement matrix (upright on the page)
  wide          : upright pixels + a synthetic wide-gamut (Adobe RGB-like) ICC profile (make_icc.py) in APP2; a second
                  file also declares it as /ICCBased in the PDF (wrap_orient_icc.mjs)"""
import io, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
src = Image.open('photo-standin.jpg').convert('RGB')
def exif_with(orient):
    e = Image.Exif(); e[274] = orient; e[271] = 'FakePhone'; e[272] = 'FP-12 (stand-in)'; e[306] = '2026:10:11 14:02:33'; return e.tobytes()
out = '/tmp/frpdf-orient'; import os; os.makedirs(out, exist_ok=True)
src.save(f'{out}/exif6.jpg', quality=92, exif=exif_with(6))
src.save(f'{out}/exif8.jpg', quality=92, exif=exif_with(8))
side = src.transpose(Image.Transpose.ROTATE_90)   # stored sideways (90 CCW); shown upright by /Rotate 90 or a cm rotation
side.save(f'{out}/side.jpg', quality=92, exif=exif_with(1))
import subprocess; subprocess.check_call([sys.executable, 'make_icc.py', f'{out}/test-wide.icc'])
icc = open(f'{out}/test-wide.icc', 'rb').read()
src.save(f'{out}/wide.jpg', quality=92, icc_profile=icc)
print('ok', src.size)
