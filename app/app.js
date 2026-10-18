// FreeRangePDF text-PDF editor (browser only; no network). The ORIGINAL bytes are never modified: every state of the
// document is produced by replaying the edit list (Path A, src/lib/text-edit.js) onto a fresh copy of those bytes.
import { editTextLine, readLines } from '../src/lib/text-edit.js';
import { classifyPages } from '../src/lib/classify.js';
import { renderPage, sha256, diff, pdfjsLib, openPdf } from '../src/lib/img-util.js';

const SUBST_SENTENCE = "This PDF's font doesn't include every letter you typed, so the outlined text uses a close substitute font and may look slightly different.";
const MSG = {
  notText: 'This page is a picture, like a scan or photo, so it has no text to edit. This editor only changes PDFs made of real text. Nothing was changed.',
  tooLong: "That's too long to fit where the old words were, and the words after it can't move. Try something shorter. Nothing was changed.",
  notFound: "I couldn't find those words in this file. Nothing was changed.",
  cantEdit: "This line can't be edited here. The file stores it in a way this editor can't change safely. Nothing was changed.",
  generic: "This edit couldn't be applied. Nothing was changed.",
  password: "This PDF is password-protected, so it can't be opened here. Remove the password first, then try again.",
  restricted: "This PDF is password-protected, so it can't be opened here. Remove the password first, then try again.", // owner-restricted PDFs: same approved wording
  empty: 'Type the new text first. To remove words, delete them and keep the rest of the line.',
  charShort: "This character can't be used here",
  charLong: (c) => `This editor can't write that character: ${c}. Use letters, numbers and common punctuation.`,
  unreadable: "This file couldn't be opened as a PDF. Nothing was changed.",
  verifyFailed: "The edited file didn't pass our check, so Download isn't offered. Your original is untouched.",
  busy: 'Applying your edit, one moment.',
  unsaved: "Edits aren't saved until you download.",
  openFailedAfter: "That file couldn't be opened. The earlier file is closed.",
  fits: 'Fits the old space.',
  gap: (n) => `Shorter than the old word, so a gap of about ${n} ${n === 1 ? 'letter' : 'letters'} is left. Nothing to the right moves.`,
};
const $ = id => document.getElementById(id);
const S = { pending: false, queuedUndo: false, name: '', orig: null, origSha: null, edits: [], cur: null, curRes: [], lines: [], vb: null, scale: 1, sel: -1, verified: false, busy: false, previewSeq: 0, lastPreview: null };
const norm = t => (t || '').replace(/\s+/g, ' ').trim();
const blobUrl = u8 => URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }));
const b64ToU8 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
function refreshUndo() { $('undo').disabled = S.busy || S.pending || !S.edits.length; }
function refreshNotes() { $('busynote').hidden = !(S.busy && S.rebuilding || S.pending); $('unsaved').hidden = !(S.edits.length && JSON.stringify(S.edits) !== S.savedKey); }
function setBusy(b, rebuilding = false) { S.busy = b; S.rebuilding = b && rebuilding; $('busyflag').hidden = !b; $('rbody').setAttribute('aria-busy', b ? 'true' : 'false'); if (b) $('download').disabled = true; refreshUndo(); refreshNotes(); if (!b) runQueuedUndo(); }
function runQueuedUndo() { if (S.queuedUndo && !S.busy && !S.pending) { S.queuedUndo = false; setTimeout(undo, 0); } }
// Apply states: 'ok' (enabled), 'off' (nothing to apply), 'blocked' (looks disabled, still reachable: pressing it explains why; never applies)
function setApply(state) { const a = $('apply'); S.applyState = state; a.disabled = state === 'off'; a.setAttribute('aria-disabled', state === 'ok' ? 'false' : 'true'); a.classList.toggle('blocked', state === 'blocked'); }
const EMOJI_OK = new Set(['\u00a9', '\u00ae', '\u2122']);
function badChar(ch) { // emoji, zero-width/bidi controls, tabs and other control chars, RTL scripts, CJK
  if (EMOJI_OK.has(ch)) return false;
  return /[\p{Extended_Pictographic}\p{Cc}\p{Cf}\u2028\u2029\ufe0f\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch);
}
function findBad(t) { const out = []; for (const ch of t) if (badChar(ch)) out.push(ch); return out; }
const showCp = ch => /\p{Cc}|\p{Cf}|\s/u.test(ch) ? 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : ch;

// ---- replay: ALWAYS from a fresh copy of the original bytes ----
async function applyOne(bytes, e, light = true) {
  const url = blobUrl(bytes);
  try { return await editTextLine({ url, find: e.find, replace: e.replace, lineContains: e.lineContains, occurrence: e.occurrence, renderScale: 1, cropScale: light ? 3 : 4 }); }
  finally { URL.revokeObjectURL(url); }
}
async function replay(edits) {
  let bytes = S.orig.slice(), results = [];
  for (const e of edits) { const r = await applyOne(bytes, e); if (r.refused) throw Object.assign(new Error('refused'), { refused: r }); bytes = b64ToU8(r.outputPdfB64); results.push(r); }
  return { bytes, results };
}

// ---- diff old/new line text -> find/replace that occurs exactly once in the old line ----
function deriveEdit(oldT, newT) {
  let p = 0; while (p < oldT.length && p < newT.length && oldT[p] === newT[p]) p++;
  let s = 0; while (s < oldT.length - p && s < newT.length - p && oldT[oldT.length - 1 - s] === newT[newT.length - 1 - s]) s++;
  let a = p, bo = oldT.length - s, bn = newT.length - s; // old[a..bo] -> new[a..bn]
  const count = (t, q) => { let n = 0, i = -1; while ((i = t.indexOf(q, i + 1)) >= 0) n++; return n; };
  while (a > 0 && oldT[a - 1] !== ' ') a--; while (bo < oldT.length && oldT[bo] !== ' ') { bo++; bn++; } // whole words
  let left = true;
  while (!(bo > a && count(oldT, oldT.slice(a, bo)) === 1)) { if ((left && a > 0) || bo >= oldT.length) { if (a > 0) a--; else break; } else { bo++; bn++; } left = !left; }
  return { find: oldT.slice(a, bo), replace: newT.slice(a, bn) };
}

// ---- page + overlay ----
async function showCurrent() {
  const rl = await readLines(S.cur); S.lines = rl.lines; S.vb = rl.viewBox;
  const doc = await openPdf(S.cur); const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 }); const sizes = S.lines.map(l => l.size).sort((a, b) => a - b); const medSize = sizes[sizes.length >> 1] || 11; S.scale = Math.min(824 / base.width, 15 / medSize); /* fit the left column (824 px), but keep body text at most 15 px */ const vp = page.getViewport({ scale: S.scale });
  const c = $('page'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise; await doc.destroy();
  const ov = $('overlay'); ov.innerHTML = '';
  S.lines.forEach((l, i) => { const d = document.createElement('div'); d.className = 'ln'; d.dataset.i = i;
    const x = (l.x0 - S.vb[0]) * S.scale, top = (S.vb[3] - (l.y + l.size * 0.95)) * S.scale; Object.assign(d.style, { left: x - 2 + 'px', top: top + 'px', width: (l.x1 - l.x0) * S.scale + 4 + 'px', height: l.size * 1.25 * S.scale + 'px' });
    d.title = l.text; d.tabIndex = -1; d.setAttribute('role', 'button'); d.setAttribute('aria-label', 'Line ' + (i + 1) + ': ' + l.text);
    d.addEventListener('click', () => select(i)); d.addEventListener('keydown', ev => lineKey(ev, i)); ov.appendChild(d); });
  const first = ov.querySelector('.ln'); if (first) first.tabIndex = 0;
  markEdited(); if (S.sel >= 0) select(S.sel, true, false);
}
function markEdited() { // green underline on lines changed by the edit list; orange outline on substitute-font spans
  const ov = $('overlay'); ov.querySelectorAll('.spanbox').forEach(n => n.remove());
  S.edits.forEach((e, k) => { const r = S.curRes[k]; if (!r) return; const li = S.lines.findIndex(l => Math.abs(l.y - r.line.baseline) < 0.2 * l.size); if (li >= 0) ov.children[li]?.classList.add('edited');
    if (r.font.used === 'fallback') { const b = r.span.bboxPdf, d = document.createElement('div'); d.className = 'ln substspan spanbox'; d.style.pointerEvents = 'none';
      Object.assign(d.style, { left: (b.x0 - S.vb[0]) * S.scale + 'px', top: (S.vb[3] - b.y1) * S.scale + 'px', width: (b.x1 - b.x0) * S.scale + 'px', height: (b.y1 - b.y0) * S.scale + 'px' }); ov.appendChild(d); } });
}
function select(i, keep, focusInput = true, focusLine = false) {
  if (i < 0 || i >= S.lines.length) return; S.sel = i;
  document.querySelectorAll('.ln').forEach(n => { n.classList.remove('sel'); if (!n.classList.contains('spanbox')) n.tabIndex = -1; }); { const n = $('overlay').children[i]; n?.classList.add('sel'); if (n) { n.tabIndex = 0; n.setAttribute('aria-current', 'true'); if (focusLine) n.focus(); } }
  $('nosel').hidden = true; $('editor').hidden = false; const t = S.lines[i].text; $('orig').textContent = t;
  if (!keep) { $('newtext').value = t; resetPreview(); } if (focusInput) $('newtext').focus();
}
function lineKey(ev, i) { // roving tabindex: arrows move between lines, Enter/Space edits the focused line
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); select(Math.min(S.lines.length - 1, i + 1), false, false, true); }
  else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); select(Math.max(0, i - 1), false, false, true); }
  else if (ev.key === 'Home') { ev.preventDefault(); select(0, false, false, true); } else if (ev.key === 'End') { ev.preventDefault(); select(S.lines.length - 1, false, false, true); }
  else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(i); }
}
function resetPreview() { for (const id of ['gapbar', 'subst', 'refuse', 'crop', 'charmark']) $(id).hidden = true; $('status').textContent = '\u00a0'; $('charmark').hidden = true; setApply('off'); S.lastPreview = null; }

// ---- live preview of the edit (trial replay on the current version; nothing is committed) ----
let timer = null;
$('newtext').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 350); });
async function preview() {
  const i = S.sel; if (i < 0) return; if (S.busy) { clearTimeout(timer); timer = setTimeout(preview, 300); return; }
  const oldT = S.lines[i].text, newT = $('newtext').value;
  if (norm(newT) === norm(oldT)) return resetPreview();
  for (const id of ['gapbar', 'subst', 'refuse', 'crop', 'charmark']) $(id).hidden = true; S.lastPreview = null;
  if (!newT.trim()) { setApply('blocked'); $('status').textContent = MSG.empty; return; }
  const bad = findBad(newT); if (bad.length) { showCharMark(newT); setApply('blocked'); $('status').textContent = ''; return; }
  const seq = ++S.previewSeq; setApply('off'); $('status').textContent = 'Checking the width rule\u2026';
  const d = deriveEdit(oldT, newT); const occ = S.lines.slice(0, i).filter(l => l.text === oldT).length;
  const e = { find: d.find, replace: d.replace, lineContains: oldT, occurrence: occ, line: i };
  try {
    const r = await applyOne(S.cur, e); if (seq !== S.previewSeq) return;
    showPreview(r, e);
  } catch (err) { if (seq !== S.previewSeq) return; resetPreview(); console.warn('preview failed:', err && err.message); showRefusal(...errMsg(err)); }
}
function showCharMark(t) { // orange underline under each unsupported character + the short inline message
  const m = $('charmirror'); m.textContent = ''; for (const ch of t) { if (badChar(ch)) { const sp = document.createElement('span'); sp.className = 'badch'; sp.textContent = /\p{Cc}|\p{Cf}/u.test(ch) ? '\u00b7' : ch; m.appendChild(sp); } else m.appendChild(document.createTextNode(ch)); }
  $('charmsg').textContent = MSG.charShort; $('charmark').hidden = false;
}
function showRefusal(text, reason) { const r = $('refuse'); r.hidden = false; r.textContent = text; if (reason) { const d = document.createElement('div'); d.className = 'reason'; d.textContent = reason; r.appendChild(d); } $('status').textContent = ''; setApply('off'); }
function errMsg(err) { const m = (err && err.message) || ''; if (err && err.refused) return [MSG.tooLong]; if (/not found/.test(m)) return [MSG.notFound]; if (/exactly once|cannot|unsupported/i.test(m)) return [MSG.cantEdit]; return [MSG.generic, m || String(err)]; }
function widthNote(o, e) {
  if (o.gapPt > 0) { const len = Math.max(1, (e.replace || '').length), n = Math.max(1, Math.round(o.gapPt / ((o.naturalWidthPt || 1) / len))); return MSG.gap(n); }
  const parts = []; const sp = o.spacingEm || 0, sc = o.scale || 1;
  if (Math.abs(sp) >= 0.0005) parts.push(`Letters ${sp < 0 ? 'tightened' : 'loosened'} by ${(Math.abs(sp) * 100).toFixed(0)}%.`);
  if (Math.abs(sc - 1) >= 0.0005) parts.push(`Text ${sc < 1 ? 'narrowed' : 'widened'} by ${(Math.abs(sc - 1) * 100).toFixed(0)}%.`);
  return parts.length ? `Fits. ${parts.join(' ')}` : MSG.fits;
}
// preview strip: ONLY the edited line (+4 px), 8 px padding, rendered from the trial result; orange box when the font is substituted
async function drawStrip(r, line) {
  const K = 3, cv_ = $('crop'); const bytes = b64ToU8(r.outputPdfB64); const full = await renderPage(bytes, K); const vb = S.vb;
  const x0 = (line.x0 - vb[0]) * K - 4, x1 = (line.x1 - vb[0]) * K + 4, y0 = (vb[3] - (line.y + line.size * 0.78)) * K - 4, y1 = (vb[3] - (line.y - line.size * 0.22)) * K + 4, P = 8;
  const w = Math.round(x1 - x0), h = Math.round(y1 - y0); cv_.width = w + 2 * P; cv_.height = h + 2 * P; const g = cv_.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv_.width, cv_.height);
  g.drawImage(full, Math.round(x0), Math.round(y0), w, h, P, P, w, h);
  if (r.font.used === 'fallback') { const b = r.span.bboxPdf; g.strokeStyle = '#d9600b'; g.lineWidth = 2; g.strokeRect(P + (b.x0 - vb[0]) * K - Math.round(x0), P + (vb[3] - b.y1) * K - Math.round(y0) + 2, (b.x1 - b.x0) * K, Math.min(h - 4, (b.y1 - b.y0) * K)); }
  cv_.style.width = (cv_.width * S.scale / K) + 'px'; /* same px-per-point as the page, so strip text = page text size */ cv_.hidden = false;
}
function showPreview(r, e) {
  for (const id of ['gapbar', 'subst', 'refuse', 'crop']) $(id).hidden = true; const o = r.overflow;
  if (r.refused) { showRefusal(MSG.tooLong); S.lastPreview = null; return; }
  const slot = o.slotPt, nat = o.naturalWidthPt; $('gapbar').hidden = false;
  const drawn = o.gapPt > 0 ? nat : slot; $('gapnat').style.width = (drawn / slot * 100) + '%'; $('gapgap').style.width = (o.gapPt > 0 ? o.gapPt / slot * 100 : 0) + '%';
  $('gaptext').textContent = widthNote(o, e);
  if (r.font.used === 'fallback') { $('subst').hidden = false; $('subst').textContent = SUBST_SENTENCE; }
  drawStrip(r, S.lines[S.sel]).catch(err => console.error("strip", err.message));
  $('status').textContent = `Ready: "${e.find}" \u2192 "${e.replace}"`; setApply('ok'); S.lastPreview = e;
}

// ---- apply / undo / verify ----
async function rebuild() {
  setBusy(true, true); try {
    if (!S.edits.length) { S.cur = S.orig.slice(); S.curRes = []; } else { const { bytes, results } = await replay(S.edits); S.cur = bytes; S.curRes = results; }
    await showCurrent(); renderEdits(); await verify();
  } finally { setBusy(false); }
}
$('apply').addEventListener('click', tryApply);
function tryApply() { // Apply is pressed (button or Enter)
  if (S.busy || S.pending) return; clearTimeout(timer);
  if (S.applyState === 'ok') return applyEdit();
  const t = $('newtext').value, bad = findBad(t);
  if (bad.length) { showCharMark(t); $('charmsg').textContent = MSG.charLong(showCp(bad[0])); return; } // longer sentence only when Apply is pressed; nothing is applied
  if (!t.trim()) { $('status').textContent = MSG.empty; return; }
  S.pending = true; refreshUndo(); refreshNotes();
  preview().then(() => { if (S.applyState === 'ok') return applyEdit(true); }).finally(() => endPending());
}
function endPending() { S.pending = false; refreshUndo(); refreshNotes(); runQueuedUndo(); }
async function applyEdit(inChain) {
  if (!S.lastPreview || S.busy) return; const e = { ...S.lastPreview }; delete e.line; S.edits.push(e); setApply('off'); S.pending = true; refreshUndo(); refreshNotes();
  try { await rebuild(); $('newtext').value = S.lines[S.sel]?.text || ''; resetPreview(); }
  catch (err) { S.edits.pop(); S.queuedUndo = false; await rebuild(); showRefusal(...errMsg(err)); }
  finally { if (!inChain) endPending(); }
}
function requestUndo() { // never silent: while an apply is starting/running the undo is queued and the user is told why
  if (S.busy || S.pending) { S.queuedUndo = true; $('busynote').hidden = false; return; }
  undo();
}
async function undo() { if (!S.edits.length || S.busy || S.pending) return; S.edits.pop(); await rebuild(); if (S.sel >= 0) { $('newtext').value = S.lines[S.sel]?.text || ''; resetPreview(); } }
$('undo').addEventListener('click', requestUndo);
function renderEdits() {
  $('edits').innerHTML = S.edits.map((e, k) => { const r = S.curRes[k]; return `<li><span class="mono">"${esc(e.find)}" \u2192 "${esc(e.replace)}"</span> <span class="muted">${r ? (r.font.used === 'fallback' ? 'substitute font' : 'original font') + (r.overflow.gapPt > 0 ? `, small gap left` : '') : ''}</span></li>`; }).join('') || '<li class="muted">none</li>';
  refreshUndo(); refreshNotes();
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function outName() { const b = S.name.replace(/\.pdf$/i, ''); return (/-edited(-\d+)?$/.test(b) ? b.replace(/-edited(-(\d+))?$/, (m, x, n) => `-edited-${(+n || 1) + 1}`) : b + '-edited') + '.pdf'; }

async function verify() {
  S.verified = false; $('download').disabled = true; $('dlname').textContent = '';
  const ul = $('checks'); if (!S.edits.length) { ul.hidden = true; $('checkdetails').hidden = true; $('checksum').className = 'muted'; $('checksum').textContent = 'No edits yet.'; return; }
  const items = []; const add = (ok, t) => items.push([ok, t]);
  try {
    // re-open the NEW bytes from scratch (pdf-lib + pdf.js), independent of the edit step
    const bytes = S.cur; const pd = await window.PDFLib.PDFDocument.load(bytes); const pdO = await window.PDFLib.PDFDocument.load(S.orig.slice());
    add(true, 'New file re-opens (pdf-lib and pdf.js)'); add(pd.getPageCount() === pdO.getPageCount(), `Page count unchanged (${pd.getPageCount()})`);
    add(await sha256(S.orig) === S.origSha, 'Original bytes unchanged (SHA-256 matches the one taken at open)');
    add(await sha256(bytes) !== S.origSha, 'New file differs from the original; saved under a new name');
    // text: expected page text = original lines with each edit's new text
    const o = await readLines(S.orig), n = await readLines(bytes); let exp = o.lines.map(l => l.text);
    S.curRes.forEach(r => { const k = exp.findIndex((t, i) => Math.abs(o.lines[i].y - r.line.baseline) < 0.2 * o.lines[i].size); if (k >= 0) exp[k] = r.edit.newText; });
    const got = n.lines.map(l => l.text); const nsp = t => (t || '').replace(/\s+/g, ''); // pdf.js decides word spaces from gaps, so compare letters and punctuation only
    const same = exp.length === got.length && exp.every((t, i) => nsp(t) === nsp(got[i]));
    const bad = exp.findIndex((t, i) => nsp(t) !== nsp(got[i])); add(same, 'Re-read text of every line equals the expected text (letters and punctuation; edited lines show the new text, all others unchanged)' + (same ? '' : ` [line ${bad}: expected "${exp[bad]}" got "${got[bad]}"; ${exp.length} vs ${got.length} lines]`));
    add(S.curRes.every(r => r.verify.untouchedGlyphMaxShiftPt < 1e-6 && r.verify.untouchedGlyphCodeMismatches === 0), 'Every untouched glyph keeps its exact position and code');
    add(S.curRes.every(r => r.verify.findGoneFromEditedLine), 'Old text is gone from each edited line');
    // pixels: outside the edited spans nothing may change
    const cA = await renderPage(S.orig, 1), cB = await renderPage(bytes, 1); const bands = S.curRes.map(r => r.span.bboxPdf);
    const vb = o.viewBox; const inside = (x, y) => bands.some(b => x >= (b.x0 - vb[0]) - 3 && x <= (b.x1 - vb[0]) + 3 && y >= (vb[3] - b.y1) - 3 && y <= (vb[3] - b.y0) + 3);
    const d = diff(cA, cB, inside); add(d.outside === 0, `Rendered pixels outside the edited spans: ${d.outside} changed`);
  } catch (err) { add(false, 'Re-open check failed: ' + err.message); }
  ul.innerHTML = items.map(([ok, t]) => { const m = /^(.*?) \[(line \d+:.*)\]$/s.exec(t); return `<li class="${ok ? 'ok' : 'bad'}">${esc(m ? m[1] : t)}${m ? `<span class="tech">${esc(m[2])}</span>` : ''}</li>`; }).join('');
  const nbad = items.filter(i => !i[0]).length; const sum = $('checksum'), det = $('checkdetails');
  sum.className = nbad ? 'fail' : 'muted'; sum.textContent = nbad ? `${nbad} of ${items.length} checks failed` : `All ${items.length} checks passed`;
  det.hidden = false; ul.hidden = !nbad; det.textContent = nbad ? 'Hide details' : 'Details'; // failed checks stay open
  S.verified = items.every(i => i[0]);
  if (S.verified) { $('download').disabled = false; $('dlname').textContent = outName(); } else { $('dlname').textContent = ''; sum.textContent = MSG.verifyFailed; const rs = document.createElement('div'); rs.className = 'reason'; rs.textContent = `${nbad} of ${items.length} checks failed: ` + items.filter(i => !i[0]).map(i => i[1]).join('; '); sum.appendChild(rs); }
}
$('checkdetails').addEventListener('click', ev => { ev.preventDefault(); const ul = $('checks'); ul.hidden = !ul.hidden; $('checkdetails').textContent = ul.hidden ? 'Details' : 'Hide details'; });
$('download').addEventListener('click', () => { if (!S.verified) return; const a = document.createElement('a'); a.href = blobUrl(S.cur); a.download = outName(); a.click(); S.savedKey = JSON.stringify(S.edits); refreshNotes(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });

// ---- open ----
function resetDoc() { // FIRST thing on every open: nothing of a previous document may stay live
  S.cur = null; S.orig = null; S.queuedUndo = false; S.pending = false; S.origSha = null; S.edits = []; S.curRes = []; S.lines = []; S.sel = -1; S.verified = false; S.lastPreview = null; S.savedKey = null; S.name = ''; S.previewSeq++;
  clearTimeout(timer); $('download').disabled = true; $('undo').disabled = true; refreshNotes(); $('dlname').textContent = ''; setApply('off'); $('docinfo').textContent = '';
  $('emptystate').hidden = true; $('editor').hidden = true; $('nosel').hidden = false; $('nosel').className = 'muted'; $('nosel').textContent = 'No line selected.'; $('overlay').innerHTML = ''; $('legendwrap').hidden = true;
  const c = $('page'); c.width = 1; c.height = 1; $('checks').hidden = true; $('checkdetails').hidden = true; $('checksum').className = 'muted'; $('checksum').textContent = 'No edits yet.'; $('edits').innerHTML = '';
  for (const id of ['gapbar', 'subst', 'refuse', 'crop', 'charmark']) $(id).hidden = true;
}
function failOpen(text) { resetDoc(); $('emptystate').hidden = false; $('nosel').className = 'refuse'; $('nosel').textContent = text; if (S.everOpened) { const d = document.createElement('div'); d.className = 'reason'; d.textContent = MSG.openFailedAfter; $('nosel').appendChild(d); } }
let openSeq = 0;
async function openBytes(u8, name) {
  const my = ++openSeq; resetDoc(); setBusy(true);
  try {
    let pd;
    try { pd = await window.PDFLib.PDFDocument.load(u8.slice()); }
    catch (err) { // distinguish password-protected from damaged/restricted
      if (/encrypt/i.test(err && err.message)) { let needsPw = false; try { await pdfjsLib.getDocument({ data: u8.slice(), isEvalSupported: false, useSystemFonts: false }).promise; } catch (e2) { needsPw = e2 && e2.name === 'PasswordException'; }
        return failOpen(needsPw ? MSG.password : MSG.restricted); }
      return failOpen(MSG.unreadable); }
    const cls = classifyPages(pd)[0];
    const sha = await sha256(u8); if (my !== openSeq) return;
    S.everOpened = true; S.name = name; S.orig = new Uint8Array(u8); S.origSha = sha; S.edits = []; S.curRes = []; S.sel = -1; S.cur = S.orig.slice();
    $('docinfo').textContent = `${name}  \u00b7  ${pd.getPageCount()} page(s), editing page 1  \u00b7  SHA-256 ${S.origSha.slice(0, 12)}\u2026`;
    if (cls.route !== 'text') { const msg = MSG.notText; await showCurrent().catch(() => {}); if (my !== openSeq) return; $('nosel').className = 'refuse'; $('nosel').textContent = msg; $('overlay').innerHTML = ''; S.lines = []; return; }
    await showCurrent(); if (my !== openSeq) return; $('legendwrap').hidden = false; renderEdits(); await verify(); select(0, false, false, false);
  } catch (err) { console.warn('open failed:', err && err.message); failOpen(MSG.unreadable); }
  finally { if (my === openSeq) setBusy(false); }
}
$('openbtn').addEventListener('click', () => $('file').click()); $('openbtn2').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async ev => { const f = ev.target.files[0]; ev.target.value = ''; if (!f) return; let b; try { b = new Uint8Array(await f.arrayBuffer()); } catch { return failOpen(MSG.unreadable); } openBytes(b, f.name); });
$('sample').addEventListener('click', async () => openBytes(new Uint8Array(await (await fetch('../proof/inputs/text-standin.pdf')).arrayBuffer()), 'text-standin.pdf'));

// ---- keyboard ----
document.addEventListener('keydown', ev => {
  const inInput = document.activeElement === $('newtext');
  if (ev.key === 'Enter' && inInput) { ev.preventDefault(); tryApply(); }
  else if (ev.key === 'Escape') { if ($('credits').hidden === false) { $('credits').hidden = true; $('creditsBtn').focus(); } else if (S.sel >= 0) { $('newtext').value = S.lines[S.sel].text; resetPreview(); } }
  else if (inInput && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && S.lines.length) { ev.preventDefault(); select(Math.max(0, Math.min(S.lines.length - 1, S.sel + (ev.key === 'ArrowDown' ? 1 : -1)))); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && (!inInput || S.busy || S.pending || $('newtext').value === S.lines[S.sel]?.text)) { ev.preventDefault(); requestUndo(); }
});
// unsaved edits: ask before leaving
window.addEventListener('beforeunload', ev => { if (S.edits.length && JSON.stringify(S.edits) !== S.savedKey) { ev.preventDefault(); ev.returnValue = ''; } });

// ---- credits ----
const CREDITS = [
  ['pdf.js (pdfjs-dist)', 'Apache-2.0', 'vendor/pdfjs/LICENSE', 'page display and text reading'],
  ['pdf-lib', 'MIT', 'vendor/pdf-lib/LICENSE.md', 'writing the new PDF'],
  ['@pdf-lib/fontkit', 'MIT', 'vendor/fontkit/LICENSE', 'reading font files for the substitute font'],
  ['Liberation Sans / Serif / Mono 2.1.5', 'SIL Open Font License 1.1', 'vendor/fonts/liberation/LICENSE', 'substitute fonts (also debian-copyright.txt)'],
  ['Foxit standard fonts (pdf.js standard_fonts)', 'see licence file (PDFium Authors, 2014)', 'vendor/pdfjs/standard_fonts/LICENSE_FOXIT', 'display only'],
  ['OpenCV.js 4.9.0', 'Apache-2.0', 'vendor/opencv/LICENSE', 'bundled for the scan/photo path; NOT loaded by this text editor'],
  ['Tesseract.js + core', 'Apache-2.0', 'vendor/tesseract/LICENSE.md', 'bundled for the scan/photo path; NOT loaded by this text editor'],
  ['tessdata_fast (eng)', 'Apache-2.0', 'vendor/tessdata/LICENSE', 'bundled for the scan/photo path; NOT loaded by this text editor'],
];
$('creditsBody').innerHTML = '<p>Everything runs in your browser; nothing is uploaded. Bundled tools and fonts:</p><table><tr><th>Name</th><th>Licence</th><th>Licence file</th><th>Used for</th></tr>' +
  CREDITS.map(c => `<tr><td>${c[0]}</td><td>${c[1]}</td><td><a href="../${c[2]}" target="_blank">${c[2]}</a></td><td>${c[3]}</td></tr>`).join('') + '</table>';
$('creditsBtn').addEventListener('click', () => $('credits').hidden = false); $('creditsClose').addEventListener('click', () => $('credits').hidden = true);
window.FRP_APP = { S, deriveEdit, verify };
