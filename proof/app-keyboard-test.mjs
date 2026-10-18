// Keyboard-only flow + Nathan holes 1,2,4,5,7 + Berean character message, at 1440. Screenshots in proof/app-shots.
import { chromium } from 'playwright-core'; import fs from 'fs';
const URL_ = 'http://127.0.0.1:8090/app/index.html', out = 'proof/app-shots/', R = {};
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); const pg = await ctx.newPage();
const dialogs = []; pg.on('dialog', async d => { dialogs.push(d.type()); await d.accept(); });
await pg.goto(URL_); const act = () => pg.evaluate(() => { const e = document.activeElement; return e.tagName + '#' + e.id + (e.className ? '.' + e.className.split(' ')[0] : ''); });
const S = () => pg.evaluate(() => { const g = id => document.getElementById(id), A = window.FRP_APP.S; return { edits: A.edits.length, dlDisabled: g('download').disabled, undoDisabled: g('undo').disabled, verified: A.verified, applyAria: g('apply').getAttribute('aria-disabled'), status: g('status').textContent, charmsg: g('charmark').hidden ? '' : g('charmsg').textContent, sel: A.lines[A.sel]?.text?.slice(0, 30) }; });
const idle = () => pg.waitForFunction(() => !window.FRP_APP.S.busy, null, { timeout: 90000 });
// ---- keyboard only
let seq = []; for (let i = 0; i < 6; i++) { await pg.keyboard.press('Tab'); const a = await act(); seq.push(a); if (a.includes('#sample')) break; }
await pg.keyboard.press('Enter'); await pg.waitForSelector('#editor:not([hidden])', { timeout: 30000 }); await pg.waitForTimeout(1500);
for (let i = 0; i < 6; i++) { await pg.keyboard.press('Tab'); const a = await act(); seq.push(a); if (a.includes('.ln')) break; }
let n = 0; while (n++ < 14 && !(await S()).sel?.startsWith('Thursday')) { await pg.keyboard.press('ArrowDown'); await pg.waitForTimeout(80); }
await pg.screenshot({ path: out + '09-keyboard-line-focus-ring.png' });
await pg.keyboard.press('Enter'); await pg.waitForTimeout(200); seq.push(await act());
const v = await pg.inputValue('#newtext'); await pg.keyboard.press('Control+a'); await pg.keyboard.type(v.replace('Thursday', 'Friday')); await pg.waitForFunction(() => document.getElementById('apply').getAttribute('aria-disabled') === 'false', null, { timeout: 60000 });
await pg.keyboard.press('Enter'); await pg.waitForFunction(() => window.FRP_APP.S.edits.length === 1 && !window.FRP_APP.S.busy, null, { timeout: 90000 }); await pg.waitForTimeout(1200);
let reach = []; for (let i = 0; i < 12; i++) { await pg.keyboard.press('Tab'); const a = await act(); reach.push(a); if (a.includes('#download')) break; }
await pg.screenshot({ path: out + '10-keyboard-download-focus.png' });
const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 15000 }), pg.keyboard.press('Enter')]); await dl.saveAs(out + 'kbd-' + dl.suggestedFilename());
R.keyboardOnly = { toOpen: seq, toDownload: reach, downloaded: dl.suggestedFilename(), state: await S() };
// Details + Credits reachable
R.detailsReachable = await (async () => { for (let i = 0; i < 14; i++) { await pg.keyboard.press('Shift+Tab'); const a = await act(); if (a.includes('#checkdetails')) return true; } return false; })();
// ---- hole 4: beforeunload (edit is applied, saved by download -> no prompt; make a new unsaved edit)
await pg.click('#undo'); await idle(); await pg.click('.ln[data-i="4"]'); const v2 = await pg.inputValue('#newtext'); await pg.fill('#newtext', v2.replace('eleven', 'twelve')); await pg.waitForFunction(() => document.getElementById('apply').getAttribute('aria-disabled') === 'false', null, { timeout: 60000 }); await pg.click('#apply'); await pg.waitForFunction(() => window.FRP_APP.S.edits.length === 1 && !window.FRP_APP.S.busy, null, { timeout: 90000 });
// hole 7: undo disabled while busy
await pg.evaluate(() => { window.__u = []; const u = document.getElementById('undo'); new MutationObserver(() => window.__u.push(u.disabled)).observe(u, { attributes: true }); });
R.beforeunloadFlag = await pg.evaluate(() => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; });
await pg.reload({ waitUntil: 'load' }).catch(e => R.reloadErr = e.message.slice(0, 80)); R.dialogs = dialogs;
// ---- hole 1: failed open after a good doc with an edit
await pg.goto(URL_); await pg.click('#sample'); await pg.waitForSelector('#editor:not([hidden])', { timeout: 30000 }); await pg.waitForTimeout(1500);
await pg.click('.ln[data-i="8"]'); const v3 = await pg.inputValue('#newtext'); await pg.fill('#newtext', v3.replace('Thursday', 'Friday')); await pg.waitForFunction(() => document.getElementById('apply').getAttribute('aria-disabled') === 'false', null, { timeout: 60000 });
await pg.click('#apply'); const busyDuring = await pg.evaluate(() => ({ busy: window.FRP_APP.S.busy, undoDisabled: document.getElementById('undo').disabled, flag: !document.getElementById('busyflag').hidden })); await pg.waitForFunction(() => window.FRP_APP.S.edits.length === 1 && !window.FRP_APP.S.busy, null, { timeout: 90000 }); await pg.waitForTimeout(1000);
R.busyDuringApply = busyDuring; R.beforeFail = await S();
await pg.setInputFiles('#file', '/workspace/frpdf-stress/in/fake.pdf'); await pg.waitForTimeout(1500); R.afterFailedOpen = await S(); R.afterFailedOpenMsg = await pg.textContent('#nosel'); await pg.screenshot({ path: out + '11-failed-open-cleared.png' });
await pg.setInputFiles('#file', '/workspace/frpdf-stress/in/enc.pdf'); await pg.waitForTimeout(1500); R.passwordMsg = await pg.textContent('#nosel');
// ---- holes 2 and 5 on a fresh open
await pg.click('#sample'); await pg.waitForSelector('#editor:not([hidden])'); await pg.waitForTimeout(1500); await pg.click('.ln[data-i="8"]');
await pg.fill('#newtext', ''); await pg.waitForTimeout(600); R.empty = await S(); await pg.keyboard.press('Enter'); await pg.waitForTimeout(400); R.emptyAfterEnter = await S(); await pg.screenshot({ path: out + '12-empty-blocked.png' });
for (const [k, t] of [['emoji', 'Fri\u{1F600}day morning'], ['zerowidth', 'Fr\u200bi'], ['tab', 'Fri\tday'], ['rtl', 'Fri\u202eday'], ['arabic', '\u0627\u0644\u062e\u0645\u064a\u0633'], ['cjk', '\u6728\u66dc']]) {
  const base = await pg.evaluate(() => window.FRP_APP.S.lines[window.FRP_APP.S.sel].text); await pg.fill('#newtext', base.replace('Thursday', t)); await pg.waitForTimeout(700); const s1 = await S();
  if (k === 'emoji') await pg.screenshot({ path: out + '13-char-short-message.png' });
  await pg.click('#apply', { force: true }); await pg.waitForTimeout(300); const s2 = await S(); if (k === 'emoji') await pg.screenshot({ path: out + '14-char-long-message-after-apply.png' });
  R['char.' + k] = { short: s1.charmsg, afterApply: s2.charmsg, applyAria: s2.applyAria, edits: s2.edits };
}
R.undoStates = await pg.evaluate(() => window.__u); R.sha = await pg.evaluate(() => window.FRP_APP.S.origSha);
console.log(JSON.stringify(R, null, 1)); await b.close();
