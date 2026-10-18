// Drives the proof in headless Chrome (Playwright). Serves the project as static files on 127.0.0.1;
// every request to any other host is aborted and logged (proves no CDN / no upload at runtime).
import http from 'http'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url'; import { chromium } from 'playwright-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROOF = path.join(ROOT, 'proof');
// Private inputs (real customer documents) live OUTSIDE the repo. Set FRM_PDF_PRIVATE to that folder; it must hold
// edits-real.json. Without it, private cases are skipped. Nothing private is ever written under the repo.
const PRIV = process.env.FRM_PDF_PRIVATE ? path.resolve(process.env.FRM_PDF_PRIVATE) : null;
if (PRIV && PRIV.startsWith(ROOT)) throw new Error('FRM_PDF_PRIVATE must be outside the repo');
const PRIV_EDITS = PRIV && fs.existsSync(path.join(PRIV, 'edits-real.json')) ? JSON.parse(fs.readFileSync(path.join(PRIV, 'edits-real.json'))).scans : [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.traineddata': 'application/octet-stream', '.icc': 'application/octet-stream' };
const served = [];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = PRIV && p.startsWith('/private/') ? PRIV : ROOT; const f = base === PRIV ? path.join(PRIV, p.slice('/private/'.length)) : path.join(ROOT, p);
  if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  served.push(p); res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const INPUTS = ['inputs/text-standin.pdf', 'inputs/text-runs-standin.pdf', 'inputs/scan-standin.pdf', 'inputs/photo-standin.pdf', 'inputs/searchable-standin.pdf'].filter(f => fs.existsSync(path.join(PROOF, f))).map(f => path.join(PROOF, f)).concat([...new Set(PRIV_EDITS.map(c => path.join(PRIV, c.file)))]);
const shaBefore = Object.fromEntries(INPUTS.map(f => [path.basename(f), sha(f)]));
const mtimeBefore = Object.fromEntries(INPUTS.map(f => [path.basename(f), fs.statSync(f).mtimeMs]));

const only = process.argv[2]; // optional: text|scan|photo
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const blocked = [];
await ctx.route('**/*', route => { const u = route.request().url(); if (u.startsWith(ORIGIN + '/') || u.startsWith('blob:') || u.startsWith('data:')) return route.continue(); blocked.push(u); return route.abort(); });
const page = await ctx.newPage();
const consoleLog = []; page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text()}`)); page.on('pageerror', e => consoleLog.push('[pageerror] ' + e.message));
page.setDefaultTimeout(+(process.env.FRP_TIMEOUT || 15 * 60 * 1000));
if (process.env.FRP_DEBUG) page.on('console', m => console.log('[browser]', m.type(), m.text()));
await page.goto(ORIGIN + '/proof/harness.html');
await page.waitForFunction(() => window.FRP_READY === true);
const scanImportError = await page.evaluate(() => window.FRP.scanImportError || null);
if (scanImportError) console.log('scan module import error:', scanImportError);

function saveDataUrl(file, dataUrl) { fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64')); }
import { execFileSync } from 'child_process';
const PY = '/workspace/.venv-pdf/bin/python';
function fileCheck(dir, inPdf, outPdf, olds, news) {
  const args = w => w.flatMap(x => ['--old', x]);
  const run = f => JSON.parse(execFileSync(PY, [path.join(PROOF, 'tools/verify_file.py'), f, ...olds.flatMap(x => ['--old', x]), ...news.flatMap(x => ['--new', x])], { maxBuffer: 1 << 28 }).toString());
  const r = { input: run(inPdf), output: outPdf && fs.existsSync(outPdf) ? run(outPdf) : null };
  fs.writeFileSync(path.join(dir, 'file_check.json'), JSON.stringify(r, null, 1)); return r;
}
function writeOut(dir, res, outName) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(res.images || {})) saveDataUrl(path.join(dir, k + '.png'), v);
  if (res.outputPdfB64) fs.writeFileSync(path.join(dir, outName), Buffer.from(res.outputPdfB64, 'base64'));
  const j = { ...res }; delete j.images; delete j.outputPdfB64;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(j, null, 1));
  return j;
}
const results = {};
const t0 = Date.now();
if (!only || only === 'text') {
  results.text = {};
  for (const c of JSON.parse(fs.readFileSync(path.join(PROOF, 'edits.json'))).text) {
    const t1 = Date.now();
    const r = await page.evaluate(c => window.FRP.editTextLine(c), { url: `/proof/inputs/${c.file}`, find: c.find, replace: c.replace, lineContains: c.lineContains, occurrence: c.occurrence || 0 });
    r.case = c; results.text[c.name] = writeOut(path.join(PROOF, c.dir), r, c.file.replace('.pdf', '.edited.pdf'));
    const olds = [...new Set([c.find, ...c.find.split(' ')])], news = [...new Set([c.replace, ...c.replace.split(' ')])];
    fileCheck(path.join(PROOF, c.dir), path.join(PROOF, 'inputs', c.file), path.join(PROOF, c.dir, c.file.replace('.pdf', '.edited.pdf')), olds, news);
    console.log('text', c.name, r.refused ? 'REFUSED' : 'ok', ((Date.now() - t1) / 1000).toFixed(1) + 's');
  }
}
const EDITS = JSON.parse(fs.readFileSync(path.join(PROOF, 'edits.json')));
if (!only || only === 'classify') {
  const cls = {};
  const clsP = {};
  for (const f of INPUTS) { const isP = PRIV && f.startsWith(PRIV); const r = await page.evaluate(u => window.FRP.classify(u), isP ? '/private/' + path.relative(PRIV, f) : '/' + path.relative(ROOT, f)); if (isP) clsP[path.relative(PRIV, f)] = r; else cls[path.relative(PROOF, f)] = r; }
  fs.writeFileSync(path.join(PROOF, 'classification.json'), JSON.stringify(cls, null, 1)); if (PRIV) fs.writeFileSync(path.join(PRIV, 'classification-real.json'), JSON.stringify(clsP, null, 1)); console.log('classified', Object.keys(cls).length, Object.keys(clsP).length);
}
if (only === 'ocrvariants' && PRIV) { // real page 1: our OCR in several page-segmentation modes, scored separately
  for (const [psm, variant] of [['3', 'clahe'], ['3', 'adaptive'], ['11', 'clahe'], ['4', 'clahe'], ['6', 'clahe'], ['11', 'adaptive']]) {
    const r = await page.evaluate(a => window.FRP.ocrImage(a), { url: '/private/real/out/extracted_input/img-000.png', rotate: 180, psm, variant, words: ['Two', 'Six'] });
    fs.writeFileSync(path.join(PRIV, `real/ocr/page1-ocr-psm${psm}-${variant}.txt`), r.text); fs.writeFileSync(path.join(PRIV, `real/ocr/page1-ocr-psm${psm}-${variant}.json`), JSON.stringify(r, null, 1)); console.log('ocr', psm, variant, r.meanConf);
  }
}
if (only === 'makesearchable') {
  const r = await page.evaluate(a => window.FRP.makeSearchable(a), { url: '/proof/inputs/scan-standin.pdf', dropLineContaining: 'Saturday' });
  fs.writeFileSync(path.join(PROOF, 'inputs/searchable-standin.pdf'), Buffer.from(r.b64, 'base64'));
  fs.writeFileSync(path.join(PROOF, 'standins/searchable-standin-meta.json'), JSON.stringify({ ...r, b64: undefined }, null, 1)); console.log('searchable', r.words, r.droppedLine);
}
for (const c of [...EDITS.scans, ...PRIV_EDITS]) {
  if (only && only !== c.name && only !== 'scans' && !(only === 'real' && c.private && !c.name.startsWith('pr')) && !(only === 'photoreal' && c.name.startsWith('pr'))) continue;
  const BASE = c.private ? PRIV : PROOF, URLB = c.private ? '/private/' : '/proof/';
  const t1 = Date.now(); const dir = path.join(BASE, c.dir); const inPdf = path.join(BASE, c.file); const outName = path.basename(c.file).replace('.pdf', '.edited.pdf');
  let r;
  try { r = await page.evaluate(c => window.FRP.editScanLine(c), { url: URLB + c.file, confirm: c.confirm || null, confirmBelow: c.confirmBelow || 80, kind: c.name, trueLine: c.trueLine, find: c.find, replace: c.replace, pageIndex: c.pageIndex || 0, occurrence: c.occurrence || 0, hidden: c.hidden || 'add' }); }
  catch (e) {
    if (!c.expectNotEditable && !c.expectSaveBlocked) throw e;
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const reason = String(e.message).replace(/^page.evaluate: Error: /, ''); const kind = /^SAVE BLOCKED/.test(reason) ? 'saveBlocked' : /^NOT EDITABLE/.test(reason) ? 'notEditable' : /^width rule refused/.test(reason) ? 'widthRefused' : 'error';
    if ((c.expectSaveBlocked && kind !== 'saveBlocked') || (c.expectNotEditable && !['notEditable', 'widthRefused'].includes(kind))) throw e;
    const res = { case: c, refused: true, kind, reason, pdfFilesInOutputDir: fs.readdirSync(dir).filter(f => f.endsWith('.pdf')), outputFilesWritten: false, inputSha256: sha(inPdf) };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 1)); results[c.name] = res; console.log(c.name, 'refused as expected:', res.reason); continue;
  }
  if (c.expectNotEditable || c.expectSaveBlocked) throw new Error(c.name + ' was expected to be refused/blocked but was edited');
  results[c.name] = writeOut(dir, r, outName); const outPdf = path.join(dir, outName);
  console.log(c.name, 'edited', ((Date.now() - t1) / 1000).toFixed(1) + 's');
  fileCheck(dir, inPdf, outPdf, [c.find], [c.replace]);
  // every image in both files: extract (poppler pdfimages, decoded to PNG) and OCR it
  const ex = {};
  for (const [side, f] of [['input', inPdf], ['output', outPdf]]) {
    const d = path.join(dir, 'extracted_' + side); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d);
    execFileSync('pdfimages', ['-png', f, path.join(d, 'img')]);
    const list = execFileSync('pdfimages', ['-list', f]).toString().trim().split('\n').slice(2).map(l => l.trim().split(/\s+/));
    ex[side] = [];
    for (const [i, fn] of fs.readdirSync(d).sort().entries()) {
      const pageNo = +list[i][0]; const rotate = (c.rotate || 0);
      const o = await page.evaluate(a => window.FRP.ocrImage(a), { url: URLB + path.relative(BASE, path.join(d, fn)), rotate, words: [c.find, c.replace] });
      ex[side].push({ file: path.relative(BASE, path.join(d, fn)), page: pageNo, type: list[i][2], enc: list[i][8], ...o, text: undefined, textHead: o.text.slice(0, 200) });
      fs.writeFileSync(path.join(d, fn.replace('.png', '.ocr.txt')), o.text);
    }
  }
  // independent pixel check (Python/PIL): poppler's decode of the input image vs the output image, outside the patch mask
  const pyc = execFileSync(PY, ['-c', `
import sys, json, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int); b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(int); m = np.asarray(Image.open(sys.argv[3]).convert('L')) > 0
d = (a != b).any(axis=2); print(json.dumps({'changedOutsideMask': int((d & ~m).sum()), 'changedInsideMask': int((d & m).sum()), 'maskPixels': int(m.sum()), 'maxAbsDiffOutside': int(np.abs(a - b)[~m].max()) if (~m).any() else 0}))
`, path.join(dir, 'extracted_input', fs.readdirSync(path.join(dir, 'extracted_input')).filter(f => f.endsWith('.png')).sort()[c.pageIndex || 0]), path.join(dir, 'extracted_output', fs.readdirSync(path.join(dir, 'extracted_output')).filter(f => f.endsWith('.png')).sort()[c.pageIndex || 0]), path.join(dir, 'patch_mask.png')]).toString();
  ex.independentPixelCheck = JSON.parse(pyc);
  ex.popplerRenderDiff = JSON.parse(execFileSync(PY, [path.join(PROOF, 'tools/render_diff.py'), inPdf, outPdf, String((c.pageIndex || 0) + 1), String(r.image.width), String(r.image.height), String(r.pageRotate), path.join(dir, 'patch_mask.png'), path.join(dir, 'diff_full_poppler.png')]).toString());
  fs.writeFileSync(path.join(dir, 'extracted_images_check.json'), JSON.stringify(ex, null, 1));
  console.log(c.name, 'done', ((Date.now() - t1) / 1000).toFixed(1) + 's', JSON.stringify(ex.independentPixelCheck), JSON.stringify(ex.popplerRenderDiff));
}
await browser.close(); server.close();
const shaAfter = Object.fromEntries(INPUTS.map(f => [path.basename(f), sha(f)]));
const run = { when: new Date().toString(), origin: ORIGIN, blockedExternalRequests: blocked, servedCount: served.length,
  servedOutsideProjectVendorSrcProof: served.filter(p => !/^\/(vendor|src|proof)\//.test(p)),
  inputsSha256Before: shaBefore, inputsSha256After: shaAfter, inputsUnchanged: JSON.stringify(shaBefore) === JSON.stringify(shaAfter),
  inputsMtimeUnchanged: INPUTS.every(f => fs.statSync(f).mtimeMs === mtimeBefore[path.basename(f)]), consoleLog: consoleLog.slice(-200) };
const isPriv = k => PRIV && INPUTS.some(f => f.startsWith(PRIV) && path.basename(f) === k);
const pub = { ...run, inputsSha256Before: Object.fromEntries(Object.entries(shaBefore).filter(([k]) => !isPriv(k))), inputsSha256After: Object.fromEntries(Object.entries(shaAfter).filter(([k]) => !isPriv(k))), consoleLog: undefined, realInputs: INPUTS.filter(f => PRIV && f.startsWith(PRIV)).length };
if (only !== 'real') { const prev = fs.existsSync(path.join(PROOF, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(PROOF, 'run.json'))) : {}; fs.writeFileSync(path.join(PROOF, 'run.json'), JSON.stringify({ ...prev, [only || 'all']: pub }, null, 1)); }
if (PRIV) { const pf = path.join(PRIV, 'run-real.json'); const prev = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf)) : {}; fs.writeFileSync(pf, JSON.stringify({ ...prev, [only || 'all']: run }, null, 1)); }
console.log(JSON.stringify({ blocked, inputsUnchanged: run.inputsUnchanged }, null, 1));
