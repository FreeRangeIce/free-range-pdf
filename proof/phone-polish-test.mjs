// Checks the desktop-only polish: phone note, 44px header controls, and badge contrast. usage: node proof/phone-polish-test.mjs [url]
import { chromium } from 'playwright-core';
const URL_ = process.argv[2] || 'http://127.0.0.1:8090/app/index.html';
const NOTE = 'This editor works best on a computer.';
const PHONES = [344, 390, 411, 600];
let bad = 0, n = 0;
const ok = (cond, msg) => { n++; if (cond) console.log('ok', n, msg); else { bad++; console.log('FAIL', n, msg); } };

const contrastOf = (fg, bg) => {
  const rgb = s => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
  const L = c => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const a = L(rgb(fg)), z = L(rgb(bg));
  return (Math.max(a, z) + .05) / (Math.min(a, z) + .05);
};

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const pg = await (await b.newContext()).newPage();
const errs = [];
pg.on('pageerror', e => errs.push(e.message));
await pg.goto(URL_, { waitUntil: 'domcontentloaded' });

for (const w of PHONES) {
  await pg.setViewportSize({ width: w, height: 800 });
  const st = await pg.evaluate(() => {
    const note = document.getElementById('phonenote');
    const main = document.querySelector('main');
    const cs = getComputedStyle(note);
    const body = getComputedStyle(document.body);
    return {
      noteText: (note.textContent || '').replace(/\s+/g, ' ').trim(),
      noteDisplay: cs.display,
      mainDisplay: getComputedStyle(main).display,
      bodyWidth: body.width,
      bodyPx: document.body.getBoundingClientRect().width,
    };
  });
  ok(st.noteText === NOTE, `phone ${w}: note text is the approved line (got ${JSON.stringify(st.noteText)})`);
  ok(st.noteDisplay !== 'none', `phone ${w}: note is shown (display ${st.noteDisplay})`);
  ok(st.mainDisplay === 'none', `phone ${w}: squeezed desktop main is hidden (display ${st.mainDisplay})`);
  ok(st.bodyPx <= w + 1, `phone ${w}: layout is not a squeezed 1440px body (body ${st.bodyPx}px, css width ${st.bodyWidth})`);
}

await pg.setViewportSize({ width: 1440, height: 1000 });
const desk = await pg.evaluate(() => {
  const note = document.getElementById('phonenote');
  const main = document.querySelector('main');
  const tag = document.querySelector('.tag');
  const tcs = getComputedStyle(tag);
  const headerBtns = [...document.querySelectorAll('header .btn')].map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id, h: r.height, w: r.width, text: el.textContent.trim(), display: getComputedStyle(el).display };
  });
  return {
    noteDisplay: getComputedStyle(note).display,
    mainDisplay: getComputedStyle(main).display,
    bodyPx: document.body.getBoundingClientRect().width,
    emptyVisible: !document.getElementById('emptystate').hidden,
    headerBtns,
    tag: { color: tcs.color, bg: tcs.backgroundColor, text: tag.textContent.trim() },
  };
});
ok(desk.noteDisplay === 'none', `1440: phone note is hidden (display ${desk.noteDisplay})`);
ok(desk.mainDisplay !== 'none', `1440: desktop main is shown (display ${desk.mainDisplay})`);
ok(Math.abs(desk.bodyPx - 1440) < 1, `1440: body stays 1440px (got ${desk.bodyPx})`);
ok(desk.emptyVisible, '1440: empty-state editor is present');
const visibleBtns = desk.headerBtns.filter(b => b.display !== 'none');
ok(visibleBtns.length >= 3, `1440: header controls are present (${visibleBtns.map(b => b.id || b.text).join(', ')})`);
for (const btn of visibleBtns) {
  ok(btn.h >= 44, `1440: header #${btn.id || btn.text} tap height is at least 44px (got ${btn.h})`);
}
ok(desk.tag.text === 'text PDFs only', `badge text is "text PDFs only" (got ${JSON.stringify(desk.tag.text)})`);
const ratio = contrastOf(desk.tag.color, desk.tag.bg);
ok(ratio >= 4.5, `badge text contrast is at least 4.5:1 (got ${ratio.toFixed(2)}:1, ${desk.tag.color} on ${desk.tag.bg})`);
ok(errs.length === 0, `no page errors (${errs.join('; ') || 'none'})`);

console.log(bad ? `${bad} of ${n} check(s) FAILED` : `all ${n} phone-polish checks passed`);
await b.close();
process.exit(bad ? 1 : 0);
