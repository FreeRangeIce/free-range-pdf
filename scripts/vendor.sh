#!/usr/bin/env bash
# Copies browser libraries into vendor/ so nothing is fetched from a CDN at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
NM=node_modules; V=vendor
rm -rf "$V"; mkdir -p $V/pdfjs $V/pdf-lib $V/fontkit $V/tesseract/core $V/tessdata $V/opencv $V/fonts/liberation
# pdf.js
cp $NM/pdfjs-dist/build/pdf.min.mjs $NM/pdfjs-dist/build/pdf.worker.min.mjs $V/pdfjs/
cp -r $NM/pdfjs-dist/standard_fonts $NM/pdfjs-dist/cmaps $NM/pdfjs-dist/wasm $NM/pdfjs-dist/iccs $V/pdfjs/
cp $NM/pdfjs-dist/LICENSE $V/pdfjs/LICENSE
# pdf-lib + fontkit
cp $NM/pdf-lib/dist/pdf-lib.min.js $V/pdf-lib/; cp $NM/pdf-lib/LICENSE.md $V/pdf-lib/LICENSE.md
cp $NM/@pdf-lib/fontkit/dist/fontkit.umd.min.js $V/fontkit/
# tesseract.js + core
cp $NM/tesseract.js/dist/tesseract.min.js $NM/tesseract.js/dist/worker.min.js $V/tesseract/
cp $NM/tesseract.js/LICENSE.md $V/tesseract/LICENSE.md
cp $NM/tesseract.js/dist/*.LICENSE.txt $V/tesseract/
cp $NM/tesseract.js-core/tesseract-core*.js $NM/tesseract.js-core/tesseract-core*.wasm $V/tesseract/core/
cp $NM/tesseract.js-core/LICENSE $V/tesseract/core/LICENSE
# tessdata_fast English (Apache-2.0)
curl -sSL -o $V/tessdata/eng.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
curl -sSL -o $V/tessdata/LICENSE https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/LICENSE
# OpenCV.js official build 4.9.0 (Apache-2.0)
curl -sSL -o $V/opencv/opencv.js https://docs.opencv.org/4.9.0/opencv.js
curl -sSL -o $V/opencv/LICENSE https://raw.githubusercontent.com/opencv/opencv/4.9.0/LICENSE
curl -sSL -o $V/opencv/COPYRIGHT https://raw.githubusercontent.com/opencv/opencv/4.9.0/COPYRIGHT
# Fonts: Liberation 2.1.5 (SIL OFL 1.1)
for f in Serif Sans Mono; do cp /usr/share/fonts/truetype/liberation/Liberation$f-Regular.ttf $V/fonts/liberation/; done
curl -sSL -o $V/fonts/liberation/LICENSE https://raw.githubusercontent.com/liberationfonts/liberation-fonts/2.1.5/LICENSE
cp /usr/share/doc/fonts-liberation/copyright $V/fonts/liberation/debian-copyright.txt
(cd $V && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo vendored
