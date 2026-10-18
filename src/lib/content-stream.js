// Minimal PDF content-stream tokenizer + text-state tracker (browser ES module).
// Works on a "binary string" (one char per byte) so byte offsets are preserved.

export function bytesToBinary(u8) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}
export function binaryToBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

const WS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);
const DELIM = new Set('()<>[]{}/%'.split('').map(c => c.charCodeAt(0)));

export function tokenize(s) {
  const n = s.length; let i = 0;
  const ops = []; let operands = []; let opStart = -1;
  const isWs = c => WS.has(c), isDelim = c => DELIM.has(c);
  function skipWs() {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isWs(c)) { i++; continue; }
      if (c === 0x25) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      break;
    }
  }
  function readLiteral() { // at '('
    let depth = 0, out = ''; const start = i;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\') {
        const nx = s[i + 1];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (nx in map) { out += map[nx]; i += 2; continue; }
        if (nx === '\r' || nx === '\n') { i += 2; if (nx === '\r' && s[i] === '\n') i++; continue; }
        if (/[0-7]/.test(nx)) { let o = ''; i++; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; out += String.fromCharCode(parseInt(o, 8) & 0xff); continue; }
        i++; continue;
      }
      if (ch === '(') { depth++; if (depth > 1) out += ch; i++; continue; }
      if (ch === ')') { depth--; i++; if (depth === 0) break; out += ch; continue; }
      out += ch; i++;
    }
    return { t: 'str', v: out, raw: s.slice(start, i) };
  }
  function readValue() {
    skipWs(); const c = s[i]; const start = i;
    if (c === '(') return readLiteral();
    if (c === '<' && s[i + 1] === '<') {
      i += 2; const entries = [];
      while (true) { skipWs(); if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; } if (i >= n) break; entries.push(readValue()); }
      return { t: 'dict', v: entries, raw: s.slice(start, i) };
    }
    if (c === '<') {
      const e = s.indexOf('>', i); let hex = s.slice(i + 1, e).replace(/\s+/g, ''); if (hex.length % 2) hex += '0';
      let out = ''; for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
      i = e + 1; return { t: 'str', v: out, hex: true, raw: s.slice(start, i) };
    }
    if (c === '[') {
      i++; const items = [];
      while (true) { skipWs(); if (s[i] === ']') { i++; break; } if (i >= n) break; items.push(readValue()); }
      return { t: 'arr', v: items, raw: s.slice(start, i) };
    }
    if (c === '/') {
      i++; let name = '';
      while (i < n && !isWs(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) name += s[i++];
      name = name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return { t: 'name', v: name, raw: s.slice(start, i) };
    }
    let word = '';
    while (i < n && !isWs(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) word += s[i++];
    if (word === '' ) { i++; return { t: 'junk', v: c, raw: c }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word), raw: word };
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true', raw: word };
    if (word === 'null') return { t: 'null', v: null, raw: word };
    return { t: 'op', v: word, raw: word };
  }
  while (true) {
    skipWs(); if (i >= n) break;
    const start = i; const val = readValue();
    if (opStart < 0) opStart = start;
    if (val.t === 'op') {
      if (val.v === 'BI') { // inline image: skip to EI
        let j = s.indexOf('ID', i); j += 2; let k = j;
        while (true) { k = s.indexOf('EI', k); if (k < 0) { k = n; break; } const b = s.charCodeAt(k - 1), a = s.charCodeAt(k + 2); if (isWs(b) && (k + 2 >= n || isWs(a))) break; k += 2; }
        i = Math.min(n, k + 2);
      }
      ops.push({ op: val.v, args: operands, start: opStart, end: i });
      operands = []; opStart = -1;
    } else operands.push(val);
  }
  return ops;
}

export const I = [1, 0, 0, 1, 0, 0];
export function mul(m1, m2) {
  return [m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5]];
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const FILL_OPS = new Set(['g', 'rg', 'k', 'sc', 'scn', 'cs']);
const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

// Walk ops, tracking graphics + text state. Returns one record per text-show operator.
export function textShows(ops, layout = null) {
  let gs = { ctm: I.slice(), fill: [], Tc: 0, Tw: 0, Th: 100, TL: 0, font: null, size: 0, rise: 0, Tr: 0 };
  const stack = []; let Tm = I.slice(), Tlm = I.slice(); const shows = [];
  const num = a => a.v;
  ops.forEach((o, idx) => {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push(JSON.parse(JSON.stringify(gs))); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': gs.ctm = mul(a.map(num), gs.ctm); break;
      case 'BT': Tm = I.slice(); Tlm = I.slice(); break;
      case 'Tf': gs.font = a[0].v; gs.size = a[1].v; break;
      case 'Tc': gs.Tc = a[0].v; break; case 'Tw': gs.Tw = a[0].v; break;
      case 'Tz': gs.Th = a[0].v; break; case 'TL': gs.TL = a[0].v; break;
      case 'Ts': gs.rise = a[0].v; break; case 'Tr': gs.Tr = a[0].v; break;
      case 'Td': Tlm = mul([1, 0, 0, 1, a[0].v, a[1].v], Tlm); Tm = Tlm.slice(); break;
      case 'TD': gs.TL = -a[1].v; Tlm = mul([1, 0, 0, 1, a[0].v, a[1].v], Tlm); Tm = Tlm.slice(); break;
      case 'Tm': Tlm = a.map(num); Tm = Tlm.slice(); break;
      case 'T*': Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm.slice(); break;
      default:
        if (FILL_OPS.has(o.op)) { if (o.op === 'sc' || o.op === 'scn') gs.fill = gs.fill.filter(f => f.op === 'cs').concat([o]); else gs.fill = [o]; }
    }
    if (SHOW_OPS.has(o.op)) {
      if (o.op === "'" || o.op === '"') { if (o.op === '"') { gs.Tw = a[0].v; gs.Tc = a[1].v; } Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm.slice(); }
      const trm = mul(Tm, gs.ctm);
      const [ux, uy] = apply(trm, 0, gs.rise);
      const strArg = o.op === 'TJ' ? a[0] : a[a.length - 1];
      const rec = { idx, op: o.op, args: a, x: ux, y: uy, Tm: Tm.slice(), ctm: gs.ctm.slice(), font: gs.font, size: gs.size,
        Tc: gs.Tc, Tw: gs.Tw, Th: gs.Th, rise: gs.rise, Tr: gs.Tr, fill: gs.fill.map(f => f), strArg, start: o.start, end: o.end };
      if (layout) { const L = layout(rec); rec.glyphs = L.glyphs; rec.adv = L.adv; Tm = mul([1, 0, 0, 1, L.adv, 0], Tm); }
      shows.push(rec);
    }
  });
  return shows;
}
