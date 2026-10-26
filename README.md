# FreeRangePDF (FreeRangeIce/free-range-pdf)

This is a static, desktop-only (1440px) PDF line editor that runs in the browser. There is no server and no cloud OCR, and the file never leaves the browser. **The editor is live at [freerangeice.github.io/free-range-pdf/app/](https://freerangeice.github.io/free-range-pdf/app/).** This repo also holds the proof that the editing method works.

The live editor changes only PDFs made of real text. The scan and photo path below is proof code and is not in the editor yet.

- `src/lib/text-edit.js`: path A, for PDFs with a text layer (pdf.js reads the line, pdf-lib removes the line's text-show operators and redraws it, using the embedded font or an OFL fallback).
- `src/lib/scan-edit.js`: path B, for scans and photos (OpenCV.js paper detection, deskew, 300 dpi and CLAHE; Tesseract.js eng OCR; then paint, redraw and a lossless patch over the untouched original image).
- `src/lib/content-stream.js`, `src/lib/img-util.js`: helpers.
- `vendor/`: every browser library, the traineddata and the fonts, vendored with their licence and notice files (`scripts/vendor.sh` rebuilds it; `vendor/SHA256SUMS`).
- `proof/`: the harness page, the Playwright runner (`node proof/run-proof.mjs`), the report builder (`node proof/make-report.mjs`), the stand-in inputs and the outputs. Read `proof/REPORT.md`.

Run it: `npm install && ./scripts/vendor.sh && node proof/run-proof.mjs && node proof/make-report.mjs` (it needs `/usr/bin/google-chrome`).
