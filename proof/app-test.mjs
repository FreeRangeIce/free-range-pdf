// Drives the editor UI in headless Chrome at 1440 wide with the keyboard; screenshots into proof/app-shots. Non-local requests are aborted+logged.
import { chromium } from 'playwright-core'; import fs from 'fs';
const URL_ = process.argv[2] || 'http://127.0.0.1:8090/app/index.html'; const out = 'proof/app-shots/';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); const pg = await ctx.newPage(); const external = [];
await pg.route('**/*', r => { const u = r.request().url(); if (/^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(u)) r.continue(); else { external.push(u); r.abort(); } });
pg.on('pageerror', e => console.log('PAGEERROR', e.message)); pg.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await pg.goto(URL_); await pg.setViewportSize({ width: 1440, height: 1000 });
await pg.click('#sample'); await pg.waitForSelector('#editor:not([hidden])'); await pg.waitForTimeout(1500);
await pg.screenshot({ path: out + '01-open.png' });
async function pick(text) { const i = await pg.evaluate(t => window.FRP_APP.S.lines.findIndex(l => l.text.includes(t)), text); if (i < 0) throw new Error('no line ' + text); await pg.click(`.ln[data-i="${i}"]`); }
async function typeEdit(from, to) { const v = await pg.inputValue('#newtext'); await pg.fill('#newtext', v.replace(from, to)); await pg.waitForFunction(() => (!document.getElementById('apply').disabled && !document.getElementById('crop').hidden) || !document.getElementById('refuse').hidden, null, { timeout: 60000 }); }
// 1) fallback font span (z not in subset) -> outlined + sentence
await pick('through the wet weather'); await typeEdit('wet weather', 'winter freeze'); await pg.screenshot({ path: out + '02-preview-substitute-font.png' });
await pg.keyboard.press('Enter'); await pg.waitForFunction(() => document.querySelectorAll('#edits li .mono').length === 1, null, { timeout: 90000 }); await pg.waitForTimeout(1500); await pg.screenshot({ path: out + '03-after-edit1.png' });
// 2) shorter word -> gap preview
await pick('Thursday morning'); await typeEdit('Thursday', 'Friday'); await pg.screenshot({ path: out + '04-preview-gap.png' });
await pg.keyboard.press('Enter'); await pg.waitForFunction(() => document.querySelectorAll('#edits li .mono').length === 2, null, { timeout: 90000 }); await pg.waitForTimeout(1500);
// 3) too long -> refusal
await pick('Our egg sales rose'); await typeEdit('eleven', 'eleven thousand and nine hundred'); await pg.screenshot({ path: out + '05-refusal.png' });
// 4) undo by keyboard (focus out of the input) then redo the edit list state
await pg.fill('#newtext', await pg.evaluate(() => window.FRP_APP.S.lines[window.FRP_APP.S.sel].text)); await pg.waitForTimeout(300);
await pg.keyboard.press('Control+z'); await pg.waitForFunction(() => document.querySelectorAll('#edits li .mono').length === 1, null, { timeout: 90000 }); await pg.waitForTimeout(1500); await pg.screenshot({ path: out + '06-after-undo.png' });
const st = await pg.evaluate(async () => { const S = window.FRP_APP.S; const h = a => crypto.subtle.digest('SHA-256', a).then(d => [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('')); return { origSha: S.origSha, origNow: await h(S.orig), edits: S.edits.length, verified: S.verified, dl: document.getElementById('dlname').textContent, downloadEnabled: !document.getElementById('download').disabled, summary: document.getElementById('checksum').textContent, checks: [...document.querySelectorAll('#checks li')].map(l => l.className + ' ' + l.textContent) }; });
console.log(JSON.stringify(st, null, 1));
const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#download')]); const p = out + dl.suggestedFilename(); await dl.saveAs(p); console.log('downloaded', p, fs.statSync(p).size);
// failure case (simulated: the verifier is fed the UNEDITED bytes as if the new file were wrong) -> failed checks stay open, red, Download off
await pg.evaluate(async () => { const A = window.FRP_APP; const keep = A.S.cur; A.S.cur = A.S.orig.slice(); await A.verify(); window.__keep = keep; }); await pg.waitForTimeout(500); await pg.screenshot({ path: out + '08-failed-checks-open.png' });
await pg.evaluate(async () => { const A = window.FRP_APP; A.S.cur = window.__keep; await A.verify(); });
await pg.click('#creditsBtn'); await pg.waitForTimeout(300); await pg.screenshot({ path: out + '07-credits.png' });
console.log('external requests:', JSON.stringify(external)); await b.close();
