// Tiny static file server for local development: `pnpm dev`.
// Serves dist/ (the build output) at the same sub-path as production, so
// relative paths behave exactly as they will on the site.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_PATH } from './site.ts';

// dist/ holds the build; web/ is checked too so index.html and css/ edits
// show without rebuilding.
const roots = ['../dist', '../web'].map((dir) => resolve(fileURLToPath(new URL(dir, import.meta.url))));
const port = Number(process.env.PORT || process.argv[2] || 8080);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.status = status;
  }
}

/** The file for a URL path: web/ first (sources of the static files), then dist/. */
async function find(path: string): Promise<string> {
  for (const root of [...roots].reverse()) {
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      await stat(file);
      return file;
    } catch {
      /* try the next folder */
    }
  }
  throw new HttpError(404);
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path === '/' || path === BASE_PATH) {
      res.writeHead(302, { location: `${BASE_PATH}/` });
      res.end();
      return;
    }
    if (!path.startsWith(`${BASE_PATH}/`)) throw new HttpError(404);
    const file = await find(path.slice(BASE_PATH.length));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    const status = err instanceof HttpError && err.status === 403 ? 403 : 404;
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(status === 403 ? 'Forbidden' : 'Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`seosynth dev server: http://localhost:${port}${BASE_PATH}/`));
