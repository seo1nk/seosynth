// Tiny static file server for local development: `npm run dev`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error('forbidden'), { code: 403 });
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    const code = err.code === 403 ? 403 : 404;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(code === 403 ? 'Forbidden' : 'Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`seosynth dev server: http://localhost:${port}`));
