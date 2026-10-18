// Tiny static server for local preview: node scripts/serve.mjs [port]  (127.0.0.1 only, no network use)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const port = +process.argv[2] || 8090;
const T = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.md': 'text/plain', '.txt': 'text/plain' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/app/index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || /frm-pdf-private|micah-real/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('serving', ROOT, 'on http://127.0.0.1:' + port));
