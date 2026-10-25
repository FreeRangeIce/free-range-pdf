// Renders page 1 of each PDF with the vendored pdf.js (headless Chrome) to PNG. usage: node proof/tools/render_pdfjs.mjs <dpi> <in.pdf> <out.png> [<in.pdf> <out.png> ...]
// PDFs are passed as bytes; the page is served from the repo on 127.0.0.1 only.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'; import { chromium } from 'playwright-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.icc': 'application/octet-stream' };
const srv = http.createServer((q, r) => { const f = path.join(ROOT, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const O = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] }); const pg = await b.newPage();
await pg.goto(O + '/proof/harness.html'); await pg.waitForFunction(() => window.FRP_READY === true, null, { timeout: 120000 });
const [dpi, ...pairs] = process.argv.slice(2);
for (let i = 0; i < pairs.length; i += 2) {
  const b64 = fs.readFileSync(pairs[i]).toString('base64');
  const png = await pg.evaluate(async ([b64, dpi]) => { const m = await import('/src/lib/img-util.js'); const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const c = await m.renderPage(u8, dpi / 72, 1); return c.toDataURL('image/png'); }, [b64, +dpi]);
  fs.writeFileSync(pairs[i + 1], Buffer.from(png.split(',')[1], 'base64'));
}
await b.close(); srv.close();
