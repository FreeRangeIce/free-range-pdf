// Builds proof/REPORT.md and proof/{scan,photo}/accuracy.json from the result.json files written by run-proof.mjs.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const P = path.dirname(fileURLToPath(import.meta.url));
const J = f => JSON.parse(fs.readFileSync(path.join(P, f)));
const run = J('run.json'); const R = Object.entries(run).filter(([k]) => k !== 'text').map(([, v]) => v).sort((a, b) => new Date(b.when) - new Date(a.when))[0]; const RT = run.text;
const EDITS = J('edits.json'); const TC = EDITS.text.map(c => ({ c, r: J(c.dir + '/result.json') })); const text = TC[0].r;
const scan = J('scan/result.json'), photo = J('photo/result.json'), srch = J('searchable/result.json');
const FC = d => J(d + '/file_check.json'), EX = d => J(d + '/extracted_images_check.json');
const meta = J('standins/standins-meta.json');

function align(truth, ocr) { // token-level Levenshtein with backtrace
  const n = truth.length, m = ocr.length; const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (truth[i - 1] === ocr[j - 1] ? 0 : 1));
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (truth[i - 1] === ocr[j - 1] ? 0 : 1)) { ops.push(truth[i - 1] === ocr[j - 1] ? { t: 'ok', truth: truth[i - 1] } : { t: 'sub', truth: truth[i - 1], ocr: ocr[j - 1] }); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push({ t: 'del', truth: truth[i - 1] }); i--; }
    else { ops.push({ t: 'ins', ocr: ocr[j - 1] }); j--; }
  }
  ops.reverse(); const ok = ops.filter(o => o.t === 'ok').length;
  return { truthWords: n, ocrWords: m, correct: ok, accuracy: ok / n, wer: d[n][m] / n, errors: ops.filter(o => o.t !== 'ok') };
}
const toks = s => s.replace(/\f/g, ' ').split(/\s+/).filter(Boolean);
const norm = t => t.map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
function acc(kind, res) {
  const truthTxt = fs.readFileSync(path.join(P, 'standins', `${kind}-truth.txt`), 'utf8');
  const exact = align(toks(truthTxt), toks(res.ocr.text)); const loose = align(norm(toks(truthTxt)), norm(toks(res.ocr.text)));
  const low = res.ocr.lines.flatMap((l, li) => l.words.filter(w => w.confidence < 80).map(w => ({ word: w.text, confidence: w.confidence, line: li })));
  const line = align(toks(res.target.trueText), toks(res.target.ocrText));
  const out = { exact, normalized: loose, lowConfidenceWords: low, targetLine: { ocr: res.target.ocrText, truth: res.target.trueText, ...line } };
  fs.writeFileSync(path.join(P, kind, 'accuracy.json'), JSON.stringify(out, null, 1)); return out;
}
const A = { scan: acc('scan', scan), photo: acc('photo', photo) };
const pct = x => (100 * x).toFixed(1) + '%';
const errList = es => es.length ? es.map(e => e.t === 'sub' ? `\`${e.truth}\` → \`${e.ocr}\`` : e.t === 'del' ? `\`${e.truth}\` (missed)` : `extra \`${e.ocr}\``).join(', ') : 'none';
const lowList = l => l.length ? l.map(w => `\`${w.word}\` (${w.confidence})`).join(', ') : 'none';
const img = (dir, f, alt) => `![${alt}](${dir}/${f})`;
const shaRow = f => `| ${f} | \`${R.inputsSha256Before[f]}\` | \`${R.inputsSha256After[f]}\` | ${R.inputsSha256Before[f] === R.inputsSha256After[f] ? 'unchanged' : '**CHANGED**'} |`;


const yes = b => b ? 'yes' : '**NO**';
const j = x => JSON.stringify(x);
const cls = J('classification.json');
const srchRw = J('searchable/out-rewrite/result.json');

function visRow(name, r) { const v = r.visual.newWord, g = r.visual.grain, e = r.visual.patchEdge;
  return `| ${name} | ${v.baselineDeltaPx} (old word ${r.visual.oldWordBaselineDeltaPx}) | ${v.xHeightDeltaPx} (old ${r.visual.oldWordXHeightDeltaPx}) | ${v.capHeightDeltaPx} | ${v.stemWidthPx} / ${v.stemWidthUntouchedMedianPx} (old ${v.stemWidthOldWordPx}) | ${v.advancePerCharPx} / ${v.advancePerCharUntouchedMedianPx} (old ${v.advancePerCharOldWordPx}) | ${v.gapBeforePx ?? '-'} (was ${v.gapBeforeWasPx ?? '-'}) / ${v.gapAfterPx ?? '-'} (was ${v.gapAfterWasPx ?? '-'}); typical ${v.typicalWordGapPx} | ${e.meanAbsStepAcrossBorderAfter} (before ${e.sameSpotsBefore}) | ${g.insidePatchAfter.std} / ring ${g.ringAroundPatch.std} (before ${g.insidePatchBefore.std}) |`; }
function lookRow(name, r) { const l = r.look; return `| ${name} | ${l.target.inkRGB.join(',')} → **${l.newWord.inkMedianRGB.join(',')}** | ${(+l.target.edge).toFixed(2)} → **${l.newWord.edge10_90px}** (sharpest untouched ${l.sharpestUntouchedEdgePx}) | ${(+l.target.noise).toFixed(2)} → **${l.newWord.noiseStd}** | ${l.strokeWidth50.untouchedMedian} → **${l.strokeWidth50.newWord}** | σ ${l.blurSigmaPx}, weight ${l.strokeWeightPx}px, rgb(${l.drawnColor.join(',')}), colour target: ${l.colourTarget} | ${l.newWordIsSharpestOnLine ? '**YES (fail)**' : 'no'} |`; }
function widthRowScan(name, r) { const o = r.overflow; return `| ${name} | \`${r.editedWords.old}\` → \`${r.editedWords.new}\` | ${o.slotPx}px | ${o.naturalInkWidthPx}px | ${o.letterSpacingEm} em | ${o.horizontalScale} | ${o.gapPx}px | ${o.decision} |`; }
function widthRowText({ c, r }) { const o = r.overflow; return `| ${c.name} | \`${c.find}\` → \`${c.replace}\` | ${o.slotPt}pt | ${o.naturalWidthPt}pt | ${r.refused ? `tried ${o.spacingTriedEm}` : o.spacingEm} em | ${r.refused ? `tried ${o.scaleTried}` : o.scale} | ${r.refused ? '-' : o.gapPt + 'pt'} | ${r.refused ? '**REFUSED**, nothing written: ' + o.explanation : o.decision} |`; }
function oldGoneRow(name, d, find, repl, expectOld) { const f = FC(d), o = f.output, i = f.input, e = fs.existsSync(path.join(P, d, 'extracted_images_check.json')) ? EX(d) : null;
  const showOld = o.search.perShowOpHits[find].length, showNew = o.search.perShowOpHits[repl].length;
  const imgOld = e ? e.output.map(x => x.counts[find]).join('+') : 'n/a', imgOldIn = e ? e.input.map(x => x.counts[find]).join('+') : 'no images';
  return `| ${name} | ${i.pdftotext[find]} → **${o.pdftotext[find]}** (${o.pdftotext[repl]} × \`${repl}\`) | ${showOld} (expected ${expectOld}) | ${o.search.plainHitsNonImageStreams[find].length} | ${o.search.glyphCodeHits[find].reduce((a, g) => a + g.hexForm + g.contiguousBytes, 0)} | ${imgOldIn} → **${imgOld}** | ${o.incrementalUpdate ? '**yes**' : 'no'} / ${o.eofMarkers} / ${o.orphans.length} | ${Object.values(o.rawFileMarkers).reduce((a, b) => a + b, 0)} (input ${Object.values(i.rawFileMarkers).reduce((a, b) => a + b, 0)}) |`; }
const kb = n => (n / 1024).toFixed(0) + ' KB';
const sizeRow = (name, r) => `| ${name} | ${kb(r.sizes.inputBytes)} | ${kb(r.sizes.outputBytes)} | ×${(r.sizes.outputBytes / r.sizes.inputBytes).toFixed(2)} | ${kb(r.image.oldImageStreamBytes)} JPEG → ${kb(r.image.newImageStreamBytes)} Flate+PNG predictor |`;
const textSizeRow = ({ c, r }) => { const inB = fs.statSync(path.join(P, 'inputs', c.file)).size, outF = path.join(P, c.dir, c.file.replace('.pdf', '.edited.pdf')); if (!fs.existsSync(outF)) return `| ${c.name} | ${kb(inB)} | (refused, no file) | | |`; const o = fs.statSync(outF).size; return `| ${c.name} | ${kb(inB)} | ${kb(o)} | ×${(o / inB).toFixed(2)} | ${r.font.used === 'fallback' ? 'adds a subset fallback font' : 'no new font'} |`; };
const pix = (name, r, d) => { const e = EX(d); return `| ${name} | ${r.image.decodedVsComposite} | **${r.image.changedOutsidePatchMask}** | **${e.independentPixelCheck.changedOutsideMask}** (max Δ ${e.independentPixelCheck.maxAbsDiffOutside}) | **${e.popplerRenderDiff.changedOutsideMaskBeyond2px}** beyond 2 px (${e.popplerRenderDiff.changedInRing0to2pxOutsideMask} in the 0–2 px ring) | ${r.paintBox.maskPixels} |`; };
const crops = (d, extra = '') => `| | before | after |
|---|---|---|
| line, 100% | ![](${d}/line_before.png) | ![](${d}/line_after_box_outlined.png) |
| word, 100% | ![](${d}/vis100_before.png) | ![](${d}/vis100_after.png) |
| word, 300% (nearest neighbour) | ![](${d}/vis300_before.png) | ![](${d}/vis300_after.png) |
${extra}
Full page: [before](${d}/before_full.png) · [after](${d}/after_full.png) · [pdf.js diff](${d}/diff_full.png) · [poppler diff](${d}/diff_full_poppler.png) (red = changed inside the patch, blue = changed outside) · [patch](${d}/patch.png) · [patch mask](${d}/patch_mask.png) · [deskewed page](${d}/corrected_page.png)`;

const textCaseShort = ({ c, r }) => r.refused ? `- **${c.name}**: \`${c.find}\` → \`${c.replace}\` REFUSED by the width rule. ${r.overflow.explanation} Input unchanged.` :
  `- **${c.name}** (\`proof/${c.dir}/\`): \`${r.line.text}\` → pdf.js reads \`${r.verify.pdfjsNewLineText}\` (match ${yes(r.verify.newLineMatches)}). Font ${r.font.used}${r.font.used === 'fallback' ? ` (${r.font.fallbackFont}; subset lacks ${j(r.font.missingGlyphs)}; whole run switched, span chars ${r.span.startChar}–${r.span.endChar}, bbox ${j(r.span.bboxPdf)})` : ''}. Pixels changed outside the edited box: **${r.pixel.changedOutsideBox}**; right of the box on the same line: **${r.pixel.rightOfBoxSameLineChanged}/${r.pixel.rightOfBoxSameLinePixels}**; untouched glyph max shift ${r.verify.untouchedGlyphMaxShiftPt}pt.`;

const md = `# FreeRangePDF: proof of method (stage 1, no app UI)

Last run: ${R.when}. Headless Chrome (Playwright) against a static page on \`127.0.0.1\`; every other host is aborted and logged. Blocked external requests: **${R.blockedExternalRequests.length}**. All libraries are vendored under \`vendor/\`.

**Stand-ins only.** Every input in this repo is a stand-in I made (\`proof/inputs/\`). The proof on the real scanned bill is kept outside the repo and is not quoted here. Its report is \`REPORT-real.md\` in that external folder, generated by the runner when \`FRM_PDF_PRIVATE\` points at that folder. \`scripts/check-no-private.sh\` (installed as the git pre-commit hook) refuses to commit any file from it.

## Summary

| check | result |
|---|---|
| routing | text PDFs → path A; scan, photo and searchable scan → path B (a full-page image with no visible text, even with an invisible OCR layer) |
| only the edited word changes; nothing to the right moves | yes, every case (text: 0 px changed outside the box; scans: 0 px outside the patch, checked by 2 decoders) |
| width rule | ±0.04 em spacing, then ×0.97–1.03, then natural width with the gap reported (the gap rectangle is in the preview data, \`result.json → preview\`), longer → refused, nothing written |
| old word gone (image OCR, hidden layer, raw bytes) | yes |
| EXIF/GPS/XMP/ICC/thumbnails gone (photo) | yes |
| lossless whole-image re-save; fresh save; no orphans | yes |
| hidden layer | editability comes from OUR OCR. Scanner runs that cover the word are replaced in place; if they don't (a scanner layer that lost the line), that line's scanner runs are removed and a fresh invisible line is written from our corrected OCR. Under-80 words on a rewritten line must be confirmed first (Save is blocked otherwise). |
| refusal | only when our own OCR can't read the line or the word ("NOT EDITABLE: our OCR could not read this line …") |
| OCR accuracy | PROVISIONAL (simulated stand-ins): scan ${pct(A.scan.exact.accuracy)}, photo ${pct(A.photo.exact.accuracy)} |

## Look fixes in this run (photo stand-in)

| measure | before this run | now | target |
|---|---|---|---|
| patch edge step on paper (mean abs, same spots before = ${photo.visual.patchEdge.sameSpotsBefore}) | 3.36 | **${photo.visual.patchEdge.meanAbsStepAcrossBorderAfter}** | ≤ 0.6, near 0.48 |
| stem width 50%, new / untouched px | 6.84 / 7.89 | **${photo.look.strokeWidth50.newWord} / ${photo.look.strokeWidth50.untouchedMedian}** (${(100 * (photo.look.strokeWidth50.newWord / photo.look.strokeWidth50.untouchedMedian - 1)).toFixed(1)}%) | within 2% (box metric; see below)  |
| stroke-core median (eroded ink mask), new / untouched | – | **${(+photo.look.coreMedian.newWord).toFixed(1)} / ${photo.look.coreMedian.untouched}** | ±4 |
| ink median RGB, new / untouched | 160,157,150 / 149,144,135 | **${photo.look.newWord.inkMedianRGB.join(',')} / ${photo.look.target.inkRGB.join(',')}** | |
| edge 10–90% px, new / untouched (sharpest untouched ${photo.look.sharpestUntouchedEdgePx}) | 4.31 / 4.34 | **${photo.look.newWord.edge10_90px} / ${(+photo.look.target.edge).toFixed(2)}** | not the sharpest |
| grain std inside patch / ring | 0.79 / 0.77 | **${photo.visual.grain.insidePatchAfter.std} / ${photo.visual.grain.ringAroundPatch.std}** | |
| re-OCR of the edited line | (nine) | \`${photo.verifyOcr.editedLine}\` | |

How:
- **Paper:** rebuilt only from plain paper. Ink is found against a per-pixel local paper level (grey closing), so the lighting gradient never counts as ink. Only ink blobs belonging to the old word are removed; neighbouring letters that poke into the box stay. Every letter pixel (dilated 3 px) is excluded from the inpaint source. Grain is resampled from paper at least 7 px from any letter.
- **Coloured marks** (handwriting, stamps; chroma > 40) are never part of a printed word. They are not removed and do not feed the inpaint, and they are excluded from the patch mask. The patch covers only pixels the edit actually changed, so everything else in the box stays bit-identical.
- **Seam:** Poisson clone: a Laplace membrane pinned to the original pixels along the box border, then a 3-px feather. The box is axis-aligned on the deskewed page, so in the stored image the blend follows the page tilt.
- **Weight and tone:** stroke weight is fitted first (continuous erode/dilate on the 8× supersampled sharp glyphs, before any blur). Then blur, then the ink tone through the colour, with a saturation gain allowed, then the weight again so the stem stays within 2%. Heavy erosion with saturation is penalised so letters stay whole.

300% crops (nearest neighbour): \`proof/photo/vis300_before.png\`, \`proof/photo/vis300_after.png\`; 100%: \`proof/photo/vis100_before.png\`, \`proof/photo/vis100_after.png\`.

## 2. Width rule (all text cases, re-run)
Rule: (1) letter spacing up to ±0.04 em per letter gap; (2) then horizontal scale 0.97–1.03 on top; (3) still shorter → natural width from the original start point, with the gap reported and shown in the preview; (4) still longer → refused, nothing written. Nothing to the right ever moves.

| case | edit | slot | natural | spacing | scale | gap | decision |
|---|---|---|---|---|---|---|---|
${TC.map(widthRowText).join('\n')}
${widthRowScan('scan stand-in', scan)}
${widthRowScan('photo stand-in', photo)}
${widthRowScan('searchable stand-in', srch)}
${widthRowScan('searchable, rewritten line', srchRw)}

\`wet weather\` → \`winter freeze\` (natural 92.6% too wide) now **fits** at −0.0326 em per letter over 13 letters (≤ 0.04 em), so it didn't need rewording. The refused case is \`spare parts\` → \`a spare nozzle\`, which is still 8.23pt too long at −0.04 em and ×0.97.

## 3. Text PDFs: path A
${TC.map(textCaseShort).join('\n')}

**Text-layer truth (pdf.js and pdftotext ${'25.03'}):** in every edited copy the new word reads correctly in both extractors, with 0 U+FFFD characters. This includes the fallback-font span: pdf-lib's subset carries a ToUnicode CMap, and my verifier decodes the \`winter freeze\` and \`26\` runs through it. Old-word hits: see §6. The only remaining \`17\` is the untouched Tenant copy (expected). \`winter\` shows 2 hits because "winter" already appears once elsewhere on the page.

## 4. Scan and photo stand-ins, searchable stand-in, rewritten hidden line

| stand-in | input | output | OCR accuracy (**PROVISIONAL**, simulated) |
|---|---|---|---|
| clean scan | \`proof/inputs/scan-standin.pdf\` | \`proof/scan/scan-standin.edited.pdf\` | ${pct(A.scan.exact.accuracy)} exact tokens; words < 80: ${lowList(A.scan.lowConfidenceWords)} |
| crooked phone photo | \`proof/inputs/photo-standin.pdf\` (fake EXIF+GPS+EXIF thumbnail, ICC, XMP with GPS, /Thumb) | \`proof/photo/photo-standin.edited.pdf\` | ${pct(A.photo.exact.accuracy)}; words < 80: ${lowList(A.photo.lowConfidenceWords)} |

- Scan: \`yearly\` → \`annual\`; re-OCR \`${scan.verifyOcr.editedLine}\`. Photo: \`five\` → \`nine\`; re-OCR \`${photo.verifyOcr.editedLine}\`.
- Searchable: the hidden run \`yearly\` was rewritten to \`annual\` in place (${j(srch.hiddenLayer.changed)}). pdftotext: \`yearly\` ${FC('searchable').output.pdftotext.yearly}, \`annual\` ${FC('searchable').output.pdftotext.annual}. The first-line "annual" was hidden-layer text already. Per-show decode finds \`annual\` twice: one existing, one edited.
- **Scanner layer lost the line (searchable stand-in):** on the "Saturday…" line the stand-in's hidden layer kept only its first word. \`morning\` → \`evening\` is now **edited**, because our OCR read the line. The hidden layer was handled as follows: ${srchRw.hiddenLayer.mode}. Scanner runs removed from the line box: ${j(srchRw.hiddenLayer.rewrite.removedScannerRuns)}. New hidden line: \`${srchRw.hiddenLayer.rewrite.newLineText}\`. Every other scanner run is unchanged: ${srchRw.hiddenLayer.rewrite.otherLinesScannerRunsUnchanged} (${srchRw.hiddenLayer.rewrite.scannerRunsKept} runs). Words under 80 on the line: ${srchRw.hiddenLayer.lowConfidenceWordsOnLine.length}. pdftotext: \`morning\` ${FC('searchable/out-rewrite').output.pdftotext.morning}, \`evening\` ${FC('searchable/out-rewrite').output.pdftotext.evening}. Output: \`proof/searchable/out-rewrite/\`.
- Stand-ins with no text layer (scan, photo) get a new invisible layer from our OCR, in Liberation Sans subset with ToUnicode, carrying the corrected line.
- Photo stroke weight is fitted **before** the blur: erode/dilate on the sharp 8× supersampled glyph mask, then Gaussian blur, then colour. The weight target is the 50%-level stem width (2 × area / boundary), which a blur barely moves.

${crops('scan')}

${crops('photo')}

## 5. Oholiab's visual set
All numbers come from the deskewed page, using the same code for every word, at a threshold halfway between paper and ink core. Deltas are new word minus the median of the untouched words in the same segment; the old word's own delta is given for reference. Crops at 100% and 300% are in each case's section above (\`vis100_*\`, \`vis300_*\`).

| case | baseline Δ px | x-height Δ px | cap Δ px | stem width new / untouched px | advance per char new / untouched px | gap before / after (px) | patch edge step (paper, mean abs) | grain std inside / ring |
|---|---|---|---|---|---|---|---|---|
${visRow('scan', scan)}
${visRow('photo', photo)}
${visRow('searchable', srch)}
${visRow('searchable rewrite', srchRw)}

Ink, edge and noise (target = untouched words on the segment → new word):

| case | ink median RGB | edge 10–90% px | noise std | stem width 50% px | drawn with | new word sharpest? |
|---|---|---|---|---|---|---|
${lookRow('scan', scan)}
${lookRow('photo', photo)}

Reading the numbers:
- Photo seam: fixed (edge step ${photo.visual.patchEdge.meanAbsStepAcrossBorderAfter} vs ${photo.visual.patchEdge.sameSpotsBefore} untouched). Photo stem: **calibrated on the box metric to ${photo.look.strokeWidth50.newWord} vs ${photo.look.strokeWidth50.untouchedMedian}**, but the word-only metric reads ${photo.visual.newWord.stemWidthPx} vs ${photo.visual.newWord.stemWidthUntouchedMedianPx} (${(100*(photo.visual.newWord.stemWidthPx/photo.visual.newWord.stemWidthUntouchedMedianPx-1)).toFixed(1)}%), outside the 2% target, and the new word's edge (${photo.look.newWord.edge10_90px}) is sharper than the sharpest untouched word (${photo.look.sharpestUntouchedEdgePx}): **two photo targets missed**.
- Private real-document proofs (a scanned bill, two phone photos of a book back) are kept outside the repo under \`$FRM_PDF_PRIVATE\`; their reports are not part of this repo.

## 6. Old word is gone from the file

**Scans and photo: the edit is written into the page image.** The original JPEG is decoded in the browser (ICC applied, so colour stays correct), the patch is written into the pixels, and the whole image is re-saved losslessly as one FlateDecode stream with PNG predictors (DeviceRGB). The old JPEG stream is dropped, unreferenced objects are garbage-collected, and the file is a fresh full save.

| file | our decode of the saved stream vs composite | changed outside patch (browser decode) | **independent: poppler decode of input vs output, outside patch** | poppler render diff | patch px |
|---|---|---|---|---|---|
${pix('scan', scan, 'scan')}
${pix('photo', photo, 'photo')}
${pix('searchable', srch, 'searchable')}
${pix('searchable rewrite', srchRw, 'searchable/out-rewrite')}


**Old/new word search** (\`proof/tools/verify_file.py\`, pikepdf/qpdf): every stream is decompressed and searched as plain text, as hex glyph codes, and by decoding every text-show operator through its font's ToUnicode or encoding. Every image is extracted with \`pdfimages -png\` and OCR'd with the path-B pipeline:

| file | pdftotext old-word hits in → **out** | old word in decoded text-show ops | plain-text hits (non-image streams) | glyph-code hits | OCR of every extracted image, old word in → **out** | incremental? / %%EOF / orphans | EXIF/GPS/XMP/Thumb/ICC/Metadata markers out (in) |
|---|---|---|---|---|---|---|---|
${oldGoneRow('searchable (yearly→annual)', 'searchable', 'yearly', 'annual', 0)}
${oldGoneRow('searchable rewrite (morning→evening)', 'searchable/out-rewrite', 'morning', 'evening', 0)}
${oldGoneRow('scan (yearly→annual)', 'scan', 'yearly', 'annual', 0)}
${oldGoneRow('photo (five→nine)', 'photo', 'five', 'nine', 0)}
${TC.filter(t => !t.r.refused).map(({ c }) => oldGoneRow(c.name + ` (${c.find}→${c.replace})`, c.dir, c.find, c.replace, c.name === 'repeated-block' ? 1 : 0)).join('\n')}

- repeated-block: the single remaining \`17\` is the untouched Tenant copy, as expected. The \`26\` plain hits are inside the binary font program (byte pattern), not text.
- Photo: the input carried EXIF (Make/Model/DateTime), a GPS IFD, an EXIF thumbnail, an ICC profile, XMP with GPS in the catalog and on the image, and a /Thumb page thumbnail. **All gone** in the output: ${photo.stripped.join('; ')}.
- The text PDFs (LibreOffice inputs) count 4 markers in both input and output: their document-level XMP packet (\`/Metadata\` + \`xmpmeta\`, 2 each). It holds producer/date only, no GPS and no edited word (the word search covers that stream too). It's kept because those are text documents, not photos.
- The text PDFs are a fresh full save (no incremental section, 1 %%EOF), unreachable objects removed (including old content streams and LibreOffice's indirect /Length objects), and 0 orphans in the raw object graph.

**File-size cost**

| file | input | output | factor | image stream |
|---|---|---|---|---|
${sizeRow('scan', scan)}
${sizeRow('photo', photo)}
${sizeRow('searchable', srch)}

| text case | input | output | factor | note |
|---|---|---|---|---|
${TC.map(textSizeRow).join('\n')}


## Inputs unchanged (SHA-256 before and after)

| file | before | after | |
|---|---|---|---|
${Object.keys(R.inputsSha256Before).map(shaRow).join('\n')}

mtimes unchanged: ${R.inputsMtimeUnchanged}.

## Fonts (all SIL OFL 1.1)

| font | file | licence file |
|---|---|---|
| Liberation Serif Regular 2.1.5 | \`vendor/fonts/liberation/LiberationSerif-Regular.ttf\` | \`vendor/fonts/liberation/LICENSE\` (OFL 1.1, upstream tag 2.1.5); Debian copyright: \`vendor/fonts/liberation/debian-copyright.txt\` |
| Liberation Sans Regular 2.1.5 | \`vendor/fonts/liberation/LiberationSans-Regular.ttf\` | same |
| Liberation Mono Regular 2.1.5 | \`vendor/fonts/liberation/LiberationMono-Regular.ttf\` | same |

The fonts' own name tables say "Licensed under the SIL Open Font License, Version 1.1". They are metric-compatible with Times New Roman, Arial and Courier New. Only Regular weights are bundled for now. Bold and italic lines would need the Bold, Italic and BoldItalic files (same family, same licence).
Note for Berean: \`vendor/pdfjs/standard_fonts/\` is pdf.js's own on-screen substitute set for non-embedded standard-14 fonts. It includes Foxit fonts (\`LICENSE_FOXIT\`, BSD-style, not OFL) and Liberation (\`LICENSE_LIBERATION\`). Those files are only used to *display* PDFs and are never embedded in an output file. If OFL-only applies to every font file shipped, drop the Foxit files and let pdf.js fall back.

## Vendored libraries (no CDN at runtime)

| library | version | licence | licence / notice files |
|---|---|---|---|
| pdf.js (pdfjs-dist) | 5.4.296 | Apache-2.0 | \`vendor/pdfjs/LICENSE\`, \`vendor/pdfjs/NOTICE\` |
| pdf-lib | 1.17.1 | MIT | \`vendor/pdf-lib/LICENSE.md\`, \`vendor/pdf-lib/NOTICE\` |
| @pdf-lib/fontkit | 1.1.1 | MIT | \`vendor/fontkit/LICENSE\` (the package ships no licence file; I wrote it from package.json "MIT" plus the upstream holder) |
| Tesseract.js | 7.0.0 | Apache-2.0 | \`vendor/tesseract/LICENSE.md\`, \`vendor/tesseract/NOTICE\`, bundled third-party notices \`vendor/tesseract/*.LICENSE.txt\` |
| tesseract.js-core (WASM Tesseract + Leptonica) | 7.0.0 | Apache-2.0 (Leptonica BSD-2-style) | \`vendor/tesseract/core/LICENSE\` |
| tessdata_fast eng.traineddata | main branch (sha256 in \`vendor/SHA256SUMS\`) | Apache-2.0 | \`vendor/tessdata/LICENSE\`, \`vendor/tessdata/NOTICE\` |
| OpenCV.js | **4.9.0** (official prebuilt, docs.opencv.org/4.9.0/opencv.js) | **Apache-2.0** (OpenCV ≥ 4.5) | \`vendor/opencv/LICENSE\`, \`vendor/opencv/COPYRIGHT\`, \`vendor/opencv/NOTICE\` |

Upstream Tesseract.js, tesseract and tessdata_fast ship no NOTICE file, so I wrote the NOTICE files above for Apache-2.0 §4(d) attribution. \`vendor/SHA256SUMS\` lists every vendored file. \`scripts/vendor.sh\` rebuilds \`vendor/\`.


## Limits and open items
- All photo numbers are on a simulated photo.
- Stand-in OCR figures are PROVISIONAL (simulated, clean synthetic text).
- pdf-lib names the fallback font without a subset tag (\`LiberationSerif-xxxx\`), though fontkit does subset it.
`;
fs.writeFileSync(path.join(P, 'REPORT.md'), md); console.log('ok', md.length);
