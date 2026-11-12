// `pnpm dev`: builds once, then recompiles src/ on every change and serves
// the app at http://localhost:8080/service/seosynth/. index.html and css/
// are served straight from web/, so edits there show on reload too.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(`${root}dist/wasm/seosynth.wasm`)) execFileSync('node', ['scripts/build.ts', 'wasm'], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['scripts/build.ts', 'web'], { cwd: root, stdio: 'inherit' });
const tsc = spawn('tsc', ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' });
process.on('exit', () => tsc.kill());
await import('./serve.ts');
