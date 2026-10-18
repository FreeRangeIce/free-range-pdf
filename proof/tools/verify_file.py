"""Independent byte-level check of a saved PDF (pikepdf / libqpdf + poppler), not using any FreeRangePDF code.
usage: verify_file.py file.pdf --old WORD [--old WORD2] --new WORD [--out result.json]
Reports: incremental updates, orphaned objects, every stream decompressed and searched for the old word as plain
text and as each font's glyph codes (contiguous bytes, hex form, and per text-show operator after joining TJ pieces),
pdftotext counts, images (filters, metadata, EXIF/GPS/XMP/ICC markers), page thumbnails."""
import sys, re, json, subprocess, argparse, pikepdf
ap = argparse.ArgumentParser(); ap.add_argument('pdf'); ap.add_argument('--old', action='append', default=[]); ap.add_argument('--new', action='append', default=[]); ap.add_argument('--out')
a = ap.parse_args()
raw = open(a.pdf, 'rb').read()
R = {'file': a.pdf, 'bytes': len(raw), 'eofMarkers': raw.count(b'%%EOF'), 'startxrefs': raw.count(b'startxref')}
pdf = pikepdf.open(a.pdf)
R['trailerHasPrev'] = '/Prev' in pdf.trailer
R['incrementalUpdate'] = R['eofMarkers'] > 1 or R['trailerHasPrev']
# reachability
seen = set(); stack = [pdf.trailer]
def kids(o):
    if isinstance(o, pikepdf.Dictionary) or isinstance(o, pikepdf.Stream):
        return list(o.values()) if isinstance(o, pikepdf.Dictionary) else list(o.stream_dict.values())
    if isinstance(o, pikepdf.Array): return list(o)
    return []
while stack:
    o = stack.pop()
    for k in kids(o):
        if getattr(k, 'is_indirect', False):
            og = k.objgen
            if og in seen: continue
            seen.add(og)
        stack.append(k)
allobjs = [o for o in pdf.objects if o is not None and getattr(o, 'objgen', (0, 0)) != (0, 0)]
alln = {o.objgen for o in allobjs}
# qpdf pushes inherited page attributes (e.g. /Resources on /Pages) down when it opens a file, which makes the
# original holder look unreachable. So reachability is computed on the raw bytes when the file has no object streams.
if b'/ObjStm' not in raw:
    bodies = {}
    for m in re.finditer(rb'(\d+)\s+(\d+)\s+obj\b(.*?)endobj', raw, re.S):
        b = m.group(3); si = b.find(b'stream'); bodies[(int(m.group(1)), int(m.group(2)))] = b[:si] if si >= 0 else b
    tr = raw[raw.rfind(b'trailer'):]
    refs = lambda b: {(int(x), int(y)) for x, y in re.findall(rb'(\d+)\s+(\d+)\s+R\b', b)}
    seen = set(); st2 = [pdf.trailer[k].objgen for k in ('/Root', '/Info', '/Encrypt') if k in pdf.trailer and pdf.trailer[k].is_indirect]
    while st2:
        k = st2.pop()
        if k in seen or k not in bodies: continue
        seen.add(k); st2.extend(refs(bodies[k]))
    alln = set(bodies); R['reachabilityMethod'] = 'raw object graph (no object streams)'
else: R['reachabilityMethod'] = 'pikepdf object graph (file uses object streams)'
R['objects'] = len(alln); R['orphans'] = sorted([f'{n} {g} R' for n, g in alln - seen if not (re.search(rb'/Type\s*/(XRef|ObjStm)', bodies.get((n, g), b'')) if b'/ObjStm' not in raw else False)])
wb = lambda w: re.compile(rb'(?<![A-Za-z0-9])' + re.escape(w.encode('latin1')) + rb'(?![A-Za-z0-9])')
# fonts: unicode -> code bytes
def tounicode_map(font):
    m = {}
    tu = font.get('/ToUnicode')
    if tu is not None:
        t = tu.read_bytes().decode('latin1')
        for blk in re.findall(r'beginbfchar(.*?)endbfchar', t, re.S):
            for c, u in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk): m[bytes.fromhex(c)] = bytes.fromhex(u).decode('utf-16-be', 'replace')
        for blk in re.findall(r'beginbfrange(.*?)endbfrange', t, re.S):
            for lo, hi, rest in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)', blk):
                L, n = int(lo, 16), len(lo) // 2
                if rest.startswith('['):
                    for i, u in enumerate(re.findall(r'<([0-9A-Fa-f]+)>', rest)): m[(L + i).to_bytes(n, 'big')] = bytes.fromhex(u).decode('utf-16-be', 'replace')
                else:
                    u0 = int(rest[1:-1], 16)
                    for i in range(int(hi, 16) - L + 1): m[(L + i).to_bytes(n, 'big')] = chr(u0 + i)
        return m, 'ToUnicode'
    # simple font without ToUnicode: WinAnsi/Standard ~ latin1 for ASCII letters/digits
    for c in range(32, 127): m[bytes([c])] = chr(c)
    return m, 'Encoding (WinAnsi, ASCII range)'
fonts = {}
def collect_fonts(res, where):
    if res is None: return
    f = res.get('/Font')
    if f is not None:
        for name, fd in f.items():
            key = (where, name); m, src = tounicode_map(fd); fonts[key] = {'map': m, 'src': src, 'base': str(fd.get('/BaseFont')), 'cb': max((len(k) for k in m), default=1), 'obj': fd.objgen}
    x = res.get('/XObject')
    if x is not None:
        for name, xo in x.items():
            if xo.get('/Subtype') == '/Form': collect_fonts(xo.get('/Resources'), f'{where}/{name}')
for i, p in enumerate(pdf.pages): collect_fonts(p.get('/Resources'), f'p{i+1}')
def codes_for(word, m):
    rev = {}
    for c, u in m.items(): rev.setdefault(u, c)
    if not all(ch in rev for ch in word): return None
    return b''.join(rev[ch] for ch in word)
# per text-show operator decode
def shows(page_i, page):
    out = []; font = None; where = f'p{page_i+1}'
    try: ops = pikepdf.parse_content_stream(page)
    except Exception as e: return [('ERR', str(e))]
    y = None
    for operands, op in ops:
        o = str(op)
        if o == 'Tf': font = fonts.get((where, str(operands[0])))
        if o in ('Td', 'TD'): y = float(operands[1]) if y is None else y + float(operands[1])
        if o == 'Tm': y = float(operands[5])
        if o in ('Tj', "'", '"', 'TJ'):
            parts = operands[0] if o == 'TJ' else [operands[-1]]
            b = b''.join(bytes(x) for x in parts if isinstance(x, pikepdf.String))
            if font is None: continue
            cb = font['cb']; txt = ''.join(font['map'].get(b[i:i + cb], '\ufffd') for i in range(0, len(b), cb))
            out.append({'font': font['base'], 'codes': b, 'text': txt, 'y': y})
    return out
R['fonts'] = {f'{k[0]}{k[1]}': {'base': v['base'], 'unicodeSource': v['src']} for k, v in fonts.items()}
S = {'plainHitsNonImageStreams': {}, 'glyphCodeHits': {}, 'perShowOpHits': {}, 'newWordShowOpHits': {}}
streams = [o for o in allobjs if isinstance(o, pikepdf.Stream)]
kind = {}
for i, pg in enumerate(pdf.pages):
    c = pg.obj.get('/Contents')
    for cc in (c if isinstance(c, pikepdf.Array) else [c] if c is not None else []): kind[cc.objgen] = f'page {i+1} content stream'
for st in streams:
    d = st.stream_dict
    if st.objgen in kind: continue
    if d.get('/Subtype') == '/Image': kind[st.objgen] = 'image'
    elif d.get('/Type') == '/Metadata': kind[st.objgen] = 'XMP metadata'
    elif '/Length1' in d or d.get('/Subtype') in ('/Type1C', '/CIDFontType0C', '/OpenType'): kind[st.objgen] = 'embedded font program (binary)'
for k, f in list(fonts.items()):
    pass
for o in allobjs:
    if isinstance(o, pikepdf.Dictionary) and o.get('/Type') == '/Font' and '/ToUnicode' in o: kind[o.ToUnicode.objgen] = 'ToUnicode CMap'
    if isinstance(o, pikepdf.Dictionary) and o.get('/Type') == '/FontDescriptor':
        for ff in ('/FontFile', '/FontFile2', '/FontFile3'):
            if ff in o: kind[o[ff].objgen] = 'embedded font program (binary)'
    if isinstance(o, pikepdf.Dictionary) and o.get('/Subtype') == '/CIDFontType2' and isinstance(o.get('/CIDToGIDMap'), pikepdf.Stream): kind[o.CIDToGIDMap.objgen] = 'CIDToGIDMap'
R['streams'] = len(streams); undecodable = 0
for w in a.old + a.new:
    rx = wb(w); hits = []
    for st in streams:
        if st.get('/Subtype') == '/Image': continue
        try: d = st.read_bytes()
        except Exception: undecodable += 1; continue
        for mm in rx.finditer(d):
            k = kind.get(st.objgen, 'other stream'); ctxb = d[max(0, mm.start() - 24):mm.end() + 24]
            hits.append({'stream': f'{st.objgen[0]} {st.objgen[1]} R', 'kind': k, 'at': mm.start(), 'context': ctxb.decode('latin1') if k.endswith('content stream') or k in ('XMP metadata', 'ToUnicode CMap', 'other stream') else '(binary)'})
    S['plainHitsNonImageStreams'][w] = hits
    gh = []
    for k, f in fonts.items():
        c = codes_for(w, f['map'])
        if not c: continue
        for st in streams:
            if st.get('/Subtype') == '/Image': continue
            try: d = st.read_bytes()
            except Exception: continue
            n = d.count(c) if len(c) > 2 or f['src'] == 'ToUnicode' else 0  # contiguous code bytes
            hx = d.lower().count(c.hex().encode())
            if ((n and f['src'] == 'ToUnicode') or hx) and not any(g['fontObj'] == str(f['obj']) and g['stream'] == f'{st.objgen[0]} {st.objgen[1]} R' for g in gh): gh.append({'fontObj': str(f['obj']), **{'font': f['base'], 'codes': c.hex(), 'stream': f'{st.objgen[0]} {st.objgen[1]} R', 'contiguousBytes': n, 'hexForm': hx, 'kind': kind.get(st.objgen, 'other stream')}})
    S['glyphCodeHits'][w] = gh
R['undecodableStreams'] = undecodable
showops = {i: shows(i, p) for i, p in enumerate(pdf.pages)}
for w in a.old + a.new:
    rx = re.compile(r'(?<![A-Za-z0-9])' + re.escape(w) + r'(?![A-Za-z0-9])'); h = []
    for i, ss in showops.items():
        for s in ss:
            if isinstance(s, tuple): continue
            if rx.search(s['text']): h.append({'page': i + 1, 'font': s['font'], 'y': s['y'], 'text': s['text'][:120]})
    S['perShowOpHits'][w] = h
R['search'] = S
# pdftotext
txt = subprocess.run(['pdftotext', '-layout', a.pdf, '-'], capture_output=True).stdout.decode('utf8', 'replace')
R['pdftotext'] = {w: len(re.findall(r'(?<![A-Za-z0-9])' + re.escape(w) + r'(?![A-Za-z0-9])', txt)) for w in a.old + a.new}
R['pdftotextReplacementChars'] = txt.count('\ufffd')
R['pdftotextLinesWith'] = {w: [l.strip()[:140] for l in txt.splitlines() if re.search(r'(?<![A-Za-z0-9])' + re.escape(w) + r'(?![A-Za-z0-9])', l)] for w in a.old + a.new}
# images + metadata
imgs = []
for o in streams:
    if o.get('/Subtype') != '/Image': continue
    filt = o.get('/Filter'); rb_ = o.read_raw_bytes()
    imgs.append({'obj': f'{o.objgen[0]} {o.objgen[1]} R', 'w': int(o.Width), 'h': int(o.Height), 'filter': str(filt), 'colorSpace': str(o.get('/ColorSpace'))[:40], 'hasMetadata': '/Metadata' in o,
      'jpegAPP1Exif': b'Exif\x00\x00' in rb_[:65536] if 'DCT' in str(filt) else False, 'jpegICC': b'ICC_PROFILE' in rb_[:65536] if 'DCT' in str(filt) else False, 'jpegXMP': b'http://ns.adobe.com/xap' in rb_[:65536] if 'DCT' in str(filt) else False,
      'bytes': len(rb_)})
R['images'] = imgs
R['pageThumbs'] = [i + 1 for i, p in enumerate(pdf.pages) if '/Thumb' in p]
R['catalogMetadata'] = '/Metadata' in pdf.Root
R['pageRotate'] = [int(p.get('/Rotate', 0)) for p in pdf.pages]
markers = {'Exif\\0\\0': b'Exif\x00\x00', 'GPS (text)': b'GPS', 'xmpmeta': b'xmpmeta', '/Thumb': b'/Thumb', 'ICC_PROFILE': b'ICC_PROFILE', '/Metadata': b'/Metadata'}
R['rawFileMarkers'] = {k: raw.count(v) for k, v in markers.items()}
pl = subprocess.run(['pdfimages', '-list', a.pdf], capture_output=True).stdout.decode()
R['pdfimagesList'] = pl.strip().splitlines()
js = json.dumps(R, indent=1, default=str)
if a.out: open(a.out, 'w').write(js)
print(js)
