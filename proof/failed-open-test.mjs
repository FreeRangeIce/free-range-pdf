// A failed open with a document loaded must change nothing: edits, undo, selection, page, Download stay as they were. usage: node proof/failed-open-test.mjs [url]
import { chromium } from 'playwright-core'; import crypto from 'crypto';
const URL_ = process.argv[2] || 'http://127.0.0.1:8090/app/index.html', IN = new URL('./fixtures/', import.meta.url).pathname;
const MSG = { unreadable: "This file couldn't be opened as a PDF. Nothing was changed.",
  password: "This PDF is password-protected, so it can't be opened here. Remove the password first, then try again.",
  restricted: "This PDF is locked against editing by whoever made it, so it can't be edited here. Ask for an unlocked copy, then try again. Nothing was changed." };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const pg = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const errs = [];
await pg.route('**/*', r => /^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(r.request().url()) ? r.continue() : r.abort());
pg.on('pageerror', e => errs.push(e.message));
const snap = async () => { const s = await pg.evaluate(() => { const S = window.FRP_APP.S, $ = id => document.getElementById(id);
  return { edits: JSON.stringify(S.edits), nEdits: document.querySelectorAll('#edits li .mono').length, sel: S.sel, name: S.name, origSha: S.origSha, undoLen: S.edits.length, undoDisabled: $('undo').disabled,
    download: $('download').disabled, dlname: $('dlname').textContent, docinfo: $('docinfo').textContent, editorHidden: $('editor').hidden, emptyHidden: $('emptystate').hidden, newtext: $('newtext').value, page: $('page').toDataURL() }; });
  s.page = crypto.createHash('sha256').update(s.page).digest('hex').slice(0, 16); return s; };
const idle = () => pg.waitForFunction(() => { const S = window.FRP_APP.S; return !S.busy && !S.pending && !S.queuedUndo && document.getElementById('busyflag').hidden; }, null, { timeout: 90000 });
await pg.goto(URL_); await pg.click('#sample'); await pg.waitForSelector('#editor:not([hidden])'); await idle(); await pg.waitForTimeout(800);
await pg.evaluate(() => { const i = window.FRP_APP.S.lines.findIndex(l => l.text.includes('Thursday morning')); document.querySelectorAll('.ln')[i].click(); });
await pg.fill('#newtext', (await pg.inputValue('#newtext')).replace('Thursday', 'Friday'));
await pg.waitForFunction(() => !document.getElementById('apply').disabled, null, { timeout: 60000 }); await pg.keyboard.press('Enter');
await pg.waitForFunction(() => window.FRP_APP.S.edits.length === 1, null, { timeout: 90000 }); await idle(); await pg.waitForFunction(() => window.FRP_APP.S.verified, null, { timeout: 60000 }); await pg.waitForTimeout(500);
const before = await snap(); let fails = 0; const res = {};
if (before.nEdits !== 1 || before.download) { console.log('setup failed', before); fails++; }
const cases = [['corrupt', 'corrupt.pdf', MSG.unreadable], ['fake', 'fake.pdf', MSG.unreadable], ['empty', 'empty.pdf', MSG.unreadable], ['trunc', 'trunc.pdf', null], ['password', 'enc.pdf', MSG.password], ['restricted', 'enc-owner-only.pdf', MSG.restricted], ['notText', '../inputs/scan-standin.pdf', null]];
for (const [k, f, want] of cases) {
  await pg.evaluate(() => { const n = document.getElementById('nosel'); n.className = 'muted'; });
  await pg.setInputFiles('#file', IN + f);
  await pg.waitForFunction(() => document.getElementById('nosel').className === 'refuse' || window.FRP_APP.S.name !== 'text-standin.pdf', null, { timeout: 60000 }); await idle(); await pg.waitForTimeout(300);
  const after = await snap(), msg = await pg.textContent('#nosel'), diffs = Object.keys(before).filter(x => before[x] !== after[x]);
  const ok = !diffs.length && (!want || msg === want); if (!ok) fails++;
  res[k] = { ok, msg, changed: diffs.map(x => `${x}: ${before[x]} -> ${after[x]}`) };
}
// a valid second PDF still replaces the first
await pg.setInputFiles('#file', IN + 'runs.pdf'); await pg.waitForFunction(() => window.FRP_APP.S.name === 'runs.pdf', null, { timeout: 60000 }); await idle(); await pg.waitForTimeout(500);
const v = await snap(); res.validReplaces = { ok: v.nEdits === 0 && v.undoLen === 0 && v.name === 'runs.pdf' && v.origSha !== before.origSha && !v.editorHidden && !(await pg.$eval('#nosel', e => !e.hidden && e.className === 'refuse')), name: v.name, edits: v.nEdits };
if (!res.validReplaces.ok) fails++;
// races: with base.pdf loaded and edited, pick two files back to back (the second before the first open finishes)
// kept: base.pdf, its edit and an enabled Download survive; swapped: the new file is open like any fresh open (no edits, Download off until an edit)
const loadEdited = async () => { const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  await p.route('**/*', r => /^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(r.request().url()) ? r.continue() : r.abort());
  await p.goto(URL_); await p.setInputFiles('#file', IN + 'base.pdf'); await p.waitForSelector('#editor:not([hidden])');
  await p.waitForFunction(() => window.FRP_APP.S.lines.length && !window.FRP_APP.S.busy, null, { timeout: 60000 });
  await p.evaluate(() => { const i = window.FRP_APP.S.lines.findIndex(l => l.text.includes('Thursday morning')); document.querySelectorAll('.ln')[i].click(); });
  await p.fill('#newtext', (await p.inputValue('#newtext')).replace('Thursday', 'Friday')); await p.waitForFunction(() => !document.getElementById('apply').disabled, null, { timeout: 60000 }); await p.keyboard.press('Enter');
  await p.waitForFunction(() => { const S = window.FRP_APP.S; return S.edits.length === 1 && S.verified && !S.busy && !S.pending; }, null, { timeout: 90000 }); return p; };
const st = p => p.evaluate(() => { const S = window.FRP_APP.S, $ = id => document.getElementById(id); return { name: S.name, edits: S.edits.length, busy: S.busy, busyflag: !$('busyflag').hidden, download: !$('download').disabled, verified: S.verified, editor: !$('editor').hidden, empty: !$('emptystate').hidden, msg: $('nosel').hidden ? '' : $('nosel').textContent }; });
const races = [['valid>corrupt', 'multi.pdf', 'corrupt.pdf', 'base.pdf'], ['corrupt>valid', 'corrupt.pdf', 'multi.pdf', 'multi.pdf'], ['valid>valid', 'runs.pdf', 'multi.pdf', 'multi.pdf'], ['corrupt>bad', 'corrupt.pdf', 'fake.pdf', 'base.pdf']];
for (const [k, f1, f2, want] of races) {
  const p = await loadEdited(); const inp = await p.$('#file'); await inp.setInputFiles(IN + f1); await inp.setInputFiles(IN + f2);
  await p.waitForFunction(() => !window.FRP_APP.S.busy, null, { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(2500); const s = await st(p);
  const kept = want === 'base.pdf', ok = s.name === want && !s.busy && !s.busyflag && s.download === kept && s.verified === kept && s.editor && !s.empty && s.edits === (kept ? 1 : 0) && (!kept || s.msg === MSG.unreadable) && !p.errs.length;
  if (!ok) fails++; res['race ' + k] = { ok, ...s, pageErrors: p.errs }; await p.context().close();
}
console.log(JSON.stringify({ res, pageErrors: errs }, null, 1)); console.log(fails ? `FAIL ${fails}` : 'PASS'); await b.close(); process.exit(fails ? 1 : 0);
