"""Synthetic orientation / colour-profile stand-ins (all derived from photo-standin.jpg; nothing private).
  exif6 / exif8 : upright pixels, EXIF Orientation 6 / 8 (a PDF viewer ignores EXIF inside an image stream)
  rot90         : pixels stored sideways (90 CCW), page /Rotate 90 shows them upright
  cm90          : pixels stored sideways, placed with a rotated placement matrix (upright on the page)
  wide          : upright pixels + a synthetic wide-gamut (Adobe RGB-like) ICC profile (make_icc.py) in APP2; a second
                  file also declares it as /ICCBased in the PDF (wrap_orient_icc.mjs)
  exif3         : upright pixels, EXIF Orientation 3
  rot180/rot270 : pixels stored turned 180 / 90 CW, page /Rotate 180 / 270 shows them upright
  vflip / hflip : pixels stored mirrored top-bottom / left-right, placed with a negative-scale (flipping) cm, upright on the page
  gray          : 1-channel (grayscale) JPEG -> /DeviceGray; also as /ICCBased N=1 with a synthetic gray profile
  cmyk          : 4-channel CMYK JPEG -> /DeviceCMYK (must be SAVE BLOCKED)"""
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
src.save(f'{out}/exif3.jpg', quality=92, exif=exif_with(3))
src.transpose(Image.Transpose.ROTATE_180).save(f'{out}/r180.jpg', quality=92, exif=exif_with(1))
src.transpose(Image.Transpose.ROTATE_270).save(f'{out}/r270.jpg', quality=92, exif=exif_with(1))
src.transpose(Image.Transpose.FLIP_TOP_BOTTOM).save(f'{out}/vflip.jpg', quality=92, exif=exif_with(1))
src.transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(f'{out}/hflip.jpg', quality=92, exif=exif_with(1))
src.convert('L').save(f'{out}/gray.jpg', quality=92, exif=exif_with(1))
src.convert('CMYK').save(f'{out}/cmyk.jpg', quality=92)
subprocess.check_call([sys.executable, 'make_icc.py', f'{out}/test-gray.icc', 'gray'])
print('ok', src.size)
