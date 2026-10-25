// Asserts the orientation / colour-profile / metadata stand-in results written by `node proof/run-proof.mjs scans`
// (cases orient-* and icc-* in proof/edits.json; inputs from proof/standins/make_orient_icc.py + wrap_orient_icc.mjs).
// usage: node proof/run-proof.mjs orient && node proof/orient-icc-test.mjs   (exit 1 on any failure)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const P = path.dirname(fileURLToPath(import.meta.url)); let bad = 0; const rows = [];
const ok = (cond, msg) => { if (!cond) { bad++; console.log('FAIL', msg); } };
// must be refused at save with the colour-space message, nothing written
for (const c of ['color-cmyk']) { const r = JSON.parse(fs.readFileSync(path.join(P, 'orient', c, 'result.json')));
  ok(r.refused && r.kind === 'saveBlocked' && /^SAVE BLOCKED: the page image uses colour space .*DeviceCMYK/.test(r.reason) && !r.pdfFilesInOutputDir.length, `${c}: expected SAVE BLOCKED (colour space), got ${JSON.stringify(r.reason || r.kind)}`);
  rows.push([c, '-', 'SAVE BLOCKED', '-', '-', '-']); }
const GRAY = { 'color-gray': 1, 'color-gray-iccbased': 1 };
for (const c of ['orient-exif3', 'orient-exif6', 'orient-exif8', 'orient-rot90', 'orient-rot180', 'orient-rot270', 'orient-cm90', 'orient-vflip', 'orient-hflip', 'icc-wide-app2', 'icc-wide-iccbased', 'color-gray', 'color-gray-iccbased']) {
  const d = path.join(P, 'orient', c); const oc = JSON.parse(fs.readFileSync(path.join(d, 'orient_color_check.json')));
  const r = JSON.parse(fs.readFileSync(path.join(d, 'result.json'))); const fc = JSON.parse(fs.readFileSync(path.join(d, 'file_check.json')));
  for (const rnd of ['poppler', 'pdfjs']) { const o = oc[rnd]; if (!o) continue;
    ok(o.original.upright && o.edited.upright && o.orientationKept, `${c} ${rnd}: orientation (orig ${o.original.rotationToUpright}, edited ${o.edited.rotationToUpright})`);
    rows.push([c, rnd, o.edited.rotationToUpright, o.changedOutsideEditRect, o.maxAbsOutsideEditRect, o.meanAbsOutsideEditRect]); }
  ok(oc.poppler.changedOutsideEditRect === 0, `${c}: poppler render outside the edit changed (${oc.poppler.changedOutsideEditRect} px)`);
  ok(oc.pdfjs.maxAbsOutsideEditRect <= 12 && oc.pdfjs.meanAbsOutsideEditRect < 0.5, `${c}: pdf.js render outside the edit differs beyond its own JPEG-decoder rounding`);
  ok(r.image.changedOutsidePatchMask === 0, `${c}: image pixels outside the patch changed`);
  ok(r.image.channelsWritten === (GRAY[c] || 3), `${c}: wrote ${r.image.channelsWritten} channel(s), expected ${GRAY[c] || 3}`);
  if (/flip/.test(c)) ok(oc.poppler.editRectMirrored && oc.pdfjs.editRectMirrored, `${c}: the edit should land in the mirrored image rect (flipped placement)`);
  ok(oc.colorSpace.same, `${c}: colour space ${JSON.stringify(oc.colorSpace.input)} -> ${JSON.stringify(oc.colorSpace.output)}`);
  ok(fc.output.images[0].w === fc.input.images[0].w && fc.output.images[0].h === fc.input.images[0].h, `${c}: image size changed`);
}
// metadata: documents (does not decide) what the photo path keeps/strips today; a change in behaviour fails here on purpose
{ const { execFileSync } = await import('child_process'); const PROOF = P;
  const m = JSON.parse(execFileSync('/workspace/.venv-pdf/bin/python', [path.join(PROOF, 'tools/metadata_report.py'), path.join(PROOF, 'inputs/photo-standin.pdf'), path.join(PROOF, 'photo/photo-standin.edited.pdf')]).toString());
  fs.writeFileSync(path.join(PROOF, 'orient/metadata_report.json'), JSON.stringify(m, null, 1));
  const want = { catalogXMP: false, pageThumb: false, imageXMP: false, jpegExif: false, jpegICC: false, exifMakeModel: false, exifDateTime: false, anyGpsMarkerInFile: false };
  for (const [k, v] of Object.entries(want)) ok(m.output[k] === v, `metadata ${k}: expected ${v}, got ${m.output[k]}`);
  ok(m.input.jpegExif && m.input.anyGpsMarkerInFile && m.input.catalogXMP && m.input.pageThumb, 'metadata: the stand-in input should carry EXIF, GPS, XMP and /Thumb');
  ok(m.pdfInfoUnchanged, 'metadata: PDF /Info dictionary should be carried over unchanged'); console.log('metadata', JSON.stringify(Object.fromEntries(Object.keys(want).map(k => [k, `${m.input[k]} -> ${m.output[k]}`]))), 'pdfInfoUnchanged', m.pdfInfoUnchanged); }
console.table(rows.map(([c, rnd, up, n, mx, mean]) => ({ case: c, renderer: rnd, editedRotationToUpright: up, changedOutsideEdit: n, maxAbs: mx, meanAbs: mean })));
console.log(bad ? `${bad} check(s) FAILED` : 'all orientation/colour checks passed'); process.exit(bad ? 1 : 0);
