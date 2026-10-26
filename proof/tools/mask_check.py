# Compares /SMask and /Mask of the page image in input vs output: same indirect object (by number) and identical raw bytes.
import sys, json, pikepdf
def info(f):
    p = pikepdf.open(f); pg = p.pages[0]; x = pg.Resources.XObject[list(pg.Resources.XObject.keys())[0]]; r = {}
    for k in ('/SMask', '/Mask'):
        if k in x:
            v = x.get(k)
            if isinstance(v, pikepdf.Stream): r[k] = {'objgen': list(v.objgen), 'raw': v.read_raw_bytes().hex(), 'dict': {kk: str(vv) for kk, vv in v.items()}}
            else: r[k] = {'value': str(v)}
    return r
a, b = info(sys.argv[1]), info(sys.argv[2])
print(json.dumps({'input': sorted(a), 'output': sorted(b), 'same': a == b, 'sameObject': {k: a[k].get('objgen') == b.get(k, {}).get('objgen') for k in a}, 'sameBytes': {k: a[k].get('raw') == b.get(k, {}).get('raw') for k in a}}))
