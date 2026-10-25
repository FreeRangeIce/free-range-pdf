// Checks the review fixes: strings, page scale, legend, undo-during-apply queueing, unsaved line, failed-open message. usage: node proof/new-fixes-test.mjs [url]
import { chromium } from 'playwright-core'; import fs from 'fs';
const URL_ = process.argv[2] || 'http://127.0.0.1:8090/app/index.html', out = 'proof/app-shots/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const pg = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage(); const bad = [], ext = [];
await pg.route('**/*', r => { const u = r.request().url(); if (/^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(u)) r.continue(); else { ext.push(u); r.abort(); } });
pg.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); }); pg.on('requestfailed', r => bad.push('FAILED ' + r.url())); pg.on('pageerror', e => bad.push('PAGEERROR ' + e.message));
const R = {}; const txt = id => pg.$eval('#' + id, e => e.textContent);
await pg.goto(URL_); await pg.click('#sample'); await pg.waitForSelector('#editor:not([hidden])'); await pg.waitForTimeout(1200);
R.bodyTextPx = await pg.evaluate(() => { const S = window.FRP_APP.S, sz = S.lines.map(l => l.size).sort((a, b) => a - b); return +(sz[sz.length >> 1] * S.scale).toFixed(2); });
R.pageSize = await pg.$eval('#page', c => [c.getBoundingClientRect().width, c.getBoundingClientRect().height]); R.leftColW = await pg.$eval('#left', e => e.getBoundingClientRect().width);
R.legend = await pg.$eval('.legend', e => { const cs = getComputedStyle(e); const rgb = s => s.match(/\d+/g).map(Number); const L = c => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); }; const bg = rgb(getComputedStyle(document.body).backgroundColor), fg = rgb(cs.color); const a = L(fg), z = L(bg); return { fontSize: cs.fontSize, contrast: +((Math.max(a, z) + .05) / (Math.min(a, z) + .05)).toFixed(2) }; });
const pickLine = async t => pg.evaluate(t => { const S = window.FRP_APP.S; const i = S.lines.findIndex(l => l.text.includes(t)); document.querySelectorAll('.ln')[i].click(); }, t);
const typeEdit = async (f, t) => { await pg.fill('#newtext', (await pg.inputValue('#newtext')).replace(f, t)); await pg.waitForFunction(() => !document.getElementById('apply').disabled, null, { timeout: 60000 }); };
const idle = n => pg.waitForFunction(n => { const S = window.FRP_APP.S; return S.edits.length === n && !S.busy && !S.pending && !S.queuedUndo; }, n, { timeout: 90000 });
// edit 1
await pickLine('through the wet weather'); await typeEdit('wet weather', 'winter freeze'); await pg.keyboard.press('Enter'); await idle(1); await pg.waitForTimeout(800);
R.unsaved = { visible: await pg.$eval('#unsaved', e => !e.hidden), text: await txt('unsaved') }; await pg.screenshot({ path: out + '16-unsaved-line.png' });
// edit 2, then Undo immediately after Enter (before busy would have shown): must be queued, not dropped
await pickLine('Thursday morning'); await typeEdit('Thursday', 'Friday'); await pg.keyboard.press('Enter'); await pg.keyboard.press('Control+z');
R.immediateUndo = { noteVisible: await pg.$eval('#busynote', e => !e.hidden), noteText: await txt('busynote'), undoDisabled: await pg.$eval('#undo', e => e.disabled), queued: await pg.evaluate(() => window.FRP_APP.S.queuedUndo) };
await pg.waitForTimeout(300); await pg.screenshot({ path: out + '17-undo-queued.png' });
await idle(1); R.afterImmediateUndo = { edits: await pg.evaluate(() => window.FRP_APP.S.edits.length) };
// undo while busy (button disabled; Ctrl+Z queues)
await pickLine('Thursday morning'); await typeEdit('Thursday', 'Friday'); await pg.keyboard.press('Enter'); await pg.waitForFunction(() => window.FRP_APP.S.busy, null, { timeout: 5000 }).catch(() => {});
R.undoWhileBusy = { undoDisabled: await pg.$eval('#undo', e => e.disabled), noteText: await txt('busynote') }; await pg.keyboard.press('Control+z'); await idle(1);
R.afterBusyUndo = { edits: await pg.evaluate(() => window.FRP_APP.S.edits.length) };
// failed open of a new file after an earlier one was open
await pg.setInputFiles('#file', '/workspace/frpdf-stress/in/corrupt.pdf'); await pg.waitForFunction(() => document.getElementById('nosel').className === 'refuse', null, { timeout: 30000 }); await pg.waitForTimeout(300);
R.failedOpen = await txt('nosel'); await pg.screenshot({ path: out + '15-failed-open.png' });
console.log(JSON.stringify({ R, badRequests: bad, externalRequests: ext }, null, 1)); await b.close();
