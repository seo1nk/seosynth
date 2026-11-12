// Builds the site into dist/:
//
//   dist/wasm/seosynth.wasm   the Rust engine (cargo, then wasm-opt if installed)
//   dist/js/                  the app, compiled from src/ by tsc
//   dist/index.html, css/     copied from web/
//
// `node scripts/build.ts` builds everything; `wasm` or `web` builds one part.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const has = (cmd: string) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function buildWasm(): void {
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'seosynth-engine']);
  mkdirSync(`${dist}/wasm`, { recursive: true });
  const out = `${dist}/wasm/seosynth.wasm`;
  cpSync(`${root}target/wasm32-unknown-unknown/release/seosynth_engine.wasm`, out);
  // Optional size optimisation when binaryen is installed.
  if (has('wasm-opt')) run('wasm-opt', ['-O3', '--enable-simd', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', out, '-o', out]);
  console.log(`built dist/wasm/seosynth.wasm (${statSync(out).size} bytes)`);
}

function buildWeb(): void {
  rmSync(`${dist}/js`, { recursive: true, force: true });
  // tsc comes from node_modules/.bin, which pnpm puts on the PATH.
  run('tsc', ['-p', 'tsconfig.json']);
  cpSync(`${root}web`, dist, { recursive: true });
  console.log('built dist/js, copied web/ to dist/');
}

const part = process.argv[2];
if (!part) rmSync(dist, { recursive: true, force: true });
if (!part || part === 'wasm') buildWasm();
if (!part || part === 'web') buildWeb();
if (part && part !== 'wasm' && part !== 'web') throw new Error(`unknown part "${part}" (use wasm or web)`);
if (!existsSync(`${dist}/wasm/seosynth.wasm`)) console.warn('dist/wasm/seosynth.wasm is missing: run "pnpm build:wasm"');
