"""Orientation + colour check for one edited PDF: renders the original and the edited page with poppler (pdftoppm) and pdf.js
(render_pdfjs.mjs) at the image's own resolution and reports, per renderer: page size, which way up the original shows
(best match of the upright reference among 0/90/180/270), whether the edit kept that orientation, and the pixel difference
outside the edit rectangle (patch_mask.png mapped to the page). usage: orient_color_check.py <in.pdf> <out.pdf> <dir> <upright_ref.jpg> <dpi>"""
import sys, json, subprocess, os, tempfile, warnings, numpy as np
warnings.filterwarnings('ignore', category=DeprecationWarning)
from PIL import Image
inp, outp, d, ref, dpi = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
HERE = os.path.dirname(os.path.abspath(__file__)); T = tempfile.mkdtemp(prefix='frpdf-render-')
for tag, f in [('in', inp), ('out', outp)]: subprocess.check_call(['pdftoppm', '-r', dpi, '-png', '-singlefile', f, os.path.join(T, 'poppler-' + tag)])
subprocess.check_call(['node', os.path.join(HERE, 'render_pdfjs.mjs'), dpi, inp, os.path.join(T, 'pdfjs-in.png'), outp, os.path.join(T, 'pdfjs-out.png')])
R = np.asarray(Image.open(ref).convert('L').resize((189, 252))).astype(float)  # upright reference, small
mask_img = np.asarray(Image.open(os.path.join(d, 'patch_mask.png')).convert('L')) > 0
res = json.load(open(os.path.join(d, 'result.json'))); pr = res['paintBox']['patchRect']
rect = np.zeros(mask_img.shape, bool); rect[pr['y0']:pr['y1'], pr['x0']:pr['x1']] = True
def way_up(a):
    g = np.asarray(Image.fromarray(a).convert('L')); best = None
    for k in range(4):
        r = np.rot90(g, k); sm = np.asarray(Image.fromarray(r).resize((189, 252))).astype(float); e = float(np.abs(sm - R).mean())
        if best is None or e < best[1]: best = (k, e)
    return {'rotationToUpright': best[0] * 90, 'upright': best[0] == 0, 'meanAbsVsUprightRef': round(best[1], 2)}
out = {}
for rnd in ['poppler', 'pdfjs']:
    a = np.asarray(Image.open(os.path.join(T, rnd + '-in.png')).convert('RGB')); b = np.asarray(Image.open(os.path.join(T, rnd + '-out.png')).convert('RGB'))
    o = {'sizeIn': a.shape[1::-1], 'sizeOut': b.shape[1::-1], 'original': way_up(a), 'edited': way_up(b)}
    o['orientationKept'] = o['sizeIn'] == o['sizeOut'] and o['original']['rotationToUpright'] == o['edited']['rotationToUpright']
    if a.shape == b.shape:
        # image rectangle -> page: find the rotation k for which the rotated image-space rect has the page's shape and contains the changed pixels
        D = np.abs(a.astype(int) - b.astype(int)).max(2); best = None
        for k in range(4):
            m = np.rot90(rect, -k)
            if m.shape != D.shape: continue
            m = np.pad(m, 3)[3:-3, 3:-3] if False else m
            yy, xx = np.nonzero(m); mm = np.zeros_like(m); mm[max(0, yy.min() - 3):yy.max() + 4, max(0, xx.min() - 3):xx.max() + 4] = True
            n_out = int((D[~mm] > 0).sum())
            if best is None or n_out < best[0]: best = (n_out, k, mm)
        n_out, k, mm = best
        o.update({'editRectRotationDeg': k * 90, 'changedOutsideEditRect': n_out, 'maxAbsOutsideEditRect': int(D[~mm].max()), 'meanAbsOutsideEditRect': round(float(D[~mm].mean()), 4), 'changedInsideEditRect': int((D[mm] > 0).sum())})
    out[rnd] = o
import pikepdf, hashlib
def cs_of(f):
    with pikepdf.open(f) as pdf:
        for _, im in pdf.pages[0].images.items():
            cs = im.get('/ColorSpace')
            if isinstance(cs, pikepdf.Array) and str(cs[0]) == '/ICCBased': return {'kind': 'ICCBased', 'N': int(cs[1].get('/N')), 'profileSha256': hashlib.sha256(cs[1].read_bytes()).hexdigest()}
            return {'kind': str(cs)}
out['colorSpace'] = {'input': cs_of(inp), 'output': cs_of(outp)}; out['colorSpace']['same'] = out['colorSpace']['input'] == out['colorSpace']['output']
json.dump(out, open(os.path.join(d, 'orient_color_check.json'), 'w'), indent=1); print(json.dumps(out))
