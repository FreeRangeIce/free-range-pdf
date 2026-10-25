# Independent render check with poppler (pdftoppm): render the edited page of input and output at exactly the page
# image's pixel grid, diff, and count changed pixels outside the patch mask (mask rotated with the page /Rotate).
import sys, json, subprocess, tempfile, os
import numpy as np
from PIL import Image
inp, out, page, W, H, rot, mask_png, diff_png = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), sys.argv[7], sys.argv[8]
def render(f, swap=False):
    d = tempfile.mkdtemp(); w, h = (H, W) if rot in (90, 270) else (W, H)
    if swap: w, h = h, w  # some poppler versions apply -scale-to-x/-y before the page /Rotate
    subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-scale-to-x', str(w), '-scale-to-y', str(h), '-png', f, os.path.join(d, 'r')], check=True)
    fn = [x for x in os.listdir(d) if x.endswith('.png')][0]; return np.asarray(Image.open(os.path.join(d, fn)).convert('RGB')).astype(int)
a, b = render(inp), render(out)
m = np.asarray(Image.open(mask_png).convert('L')) > 0
m = np.rot90(m, k=-(rot // 90))  # page rotation is clockwise
if a.shape[:2] != m.shape: a, b = render(inp, True), render(out, True)
d = (a != b).any(axis=2)
vis = (a * 0.35 + 165).astype(np.uint8); vis[d & m] = [255, 0, 0]; vis[d & ~m] = [0, 0, 255]
Image.fromarray(vis).save(diff_png)
from PIL import ImageFilter
m2 = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0  # mask grown by 2 px
ring = d & ~m & m2
print(json.dumps({'changedOutsideMaskBeyond2px': int((d & ~m2).sum()), 'changedInRing0to2pxOutsideMask': int(ring.sum()),'renderer': 'poppler pdftoppm ' + subprocess.run(['pdftoppm', '-v'], capture_output=True, text=True).stderr.split('\n')[0], 'size': [int(a.shape[1]), int(a.shape[0])], 'changedOutsideMask': int((d & ~m).sum()), 'changedInsideMask': int((d & m).sum()), 'maxAbsOutside': int(np.abs(a - b)[~m].max())}))
