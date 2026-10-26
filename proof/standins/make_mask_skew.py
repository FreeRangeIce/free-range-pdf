# Mask / skew stand-ins for the 'orient' group (run from the repo root with the pdf venv):
#   mask-gray-smask   DeviceGray DCT + /SMask (alpha 100 in rows 40-200)            -> must keep the SMask by reference
#   mask-rgb-smask    DeviceRGB DCT (orient-vflip) + /SMask (same band, own size)   -> must keep the SMask by reference
#   mask-stencil      DeviceGray DCT + /Mask stencil stream (1-bit, half size)      -> must keep the Mask by reference
#   mask-colorkey     DeviceGray DCT + /Mask [0 40] colour-key array                -> SAVE BLOCKED
#   x-skew            orient-vflip with a sheared placement cm [756 0 60 -1008 0 1008] -> NOT EDITABLE
import pikepdf, zlib
I = 'proof/inputs/'
def img(p): pg = p.pages[0]; return pg, pg.Resources.XObject[list(pg.Resources.XObject.keys())[0]]
def smask(p, W, H, val=100):
    a = bytearray([255]) * (W * H)
    for y in range(40, 200): a[y * W:(y + 1) * W] = bytes([val]) * W
    s = p.make_stream(zlib.compress(bytes(a))); s.Type = pikepdf.Name.XObject; s.Subtype = pikepdf.Name.Image
    s.Width, s.Height, s.ColorSpace, s.BitsPerComponent, s.Filter = W, H, pikepdf.Name.DeviceGray, 8, pikepdf.Name.FlateDecode; return s
p = pikepdf.open(I + 'color-gray.pdf'); pg, x = img(p); x.SMask = smask(p, int(x.Width), int(x.Height)); p.save(I + 'mask-gray-smask.pdf')
p = pikepdf.open(I + 'orient-vflip.pdf'); pg, x = img(p); x.SMask = smask(p, int(x.Width), int(x.Height)); p.save(I + 'mask-rgb-smask.pdf')
p = pikepdf.open(I + 'color-gray.pdf'); pg, x = img(p); W, H = int(x.Width) // 2, int(x.Height) // 2; rb = (W + 7) // 8
rows = b''.join((bytes([0xFF]) * rb if 20 <= y < 100 else bytes(rb)) for y in range(H))  # 1 = masked out (default Decode [0 1])
m = p.make_stream(zlib.compress(rows)); m.Type = pikepdf.Name.XObject; m.Subtype = pikepdf.Name.Image
m.Width, m.Height, m.ImageMask, m.BitsPerComponent, m.Filter = W, H, True, 1, pikepdf.Name.FlateDecode
x.Mask = m; p.save(I + 'mask-stencil.pdf')
p = pikepdf.open(I + 'color-gray.pdf'); pg, x = img(p); x.Mask = pikepdf.Array([0, 40]); p.save(I + 'mask-colorkey.pdf')
p = pikepdf.open(I + 'orient-vflip.pdf'); pg, x = img(p); name = list(pg.Resources.XObject.keys())[0]
pg.obj.Contents = p.make_stream(b'q\n756 0 60 -1008 0 1008 cm\n' + name.encode() + b' Do\nQ\n'); p.save(I + 'x-skew.pdf')
print('ok')
