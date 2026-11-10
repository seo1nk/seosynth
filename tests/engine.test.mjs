// Tests the compiled wasm through the same wrapper the browser uses.
// Run `./scripts/build.sh` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EngineCore } from '../web/js/engine/core.js';

const bytes = await readFile(new URL('../web/wasm/seosynth.wasm', import.meta.url));
const make = () => EngineCore.fromBytes(bytes, 48000);

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function renderSeconds(e, seconds) {
  const out = [];
  for (let n = 0; n < seconds * 48000; n += 128) out.push(e.render(128)[0]);
  return Float32Array.from(out.flatMap((c) => Array.from(c)));
}

test('module needs no imports', async () => {
  const mod = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
});

test('describes itself', async () => {
  const e = await make();
  assert.ok(e.params.length > 200);
  assert.equal(e.params[e.idx('filter.cutoff')].unit, 'Hz');
  assert.equal(e.info.fx.length, 10);
  assert.ok(e.info.tables.includes('Basic Shapes'));
});

test('plays a note', async () => {
  const e = await make();
  assert.equal(rms(renderSeconds(e, 0.05)), 0);
  e.noteOn(60, 0.9);
  const on = renderSeconds(e, 0.2);
  assert.ok(rms(on) > 0.02);
  assert.ok(on.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));
  e.noteOff(60);
  renderSeconds(e, 0.3);
  assert.equal(e.telemetry()[e.info.tele.voices], 0);
});

test('parameter conversion and patch roundtrip', async () => {
  const e = await make();
  const cutoff = e.idx('filter.cutoff');
  e.setPlain(cutoff, 440);
  assert.ok(Math.abs(e.getPlain(cutoff) - 440) < 0.5);
  e.setPlain(e.idx('oscA.unison'), 5);
  e.setSlot(0, { src: e.info.sources.indexOf('lfo1'), dst: cutoff, amount: 0.25, bipolar: true });
  e.setLfoShape(1, [{ x: 0, y: 1, curve: 0.5 }, { x: 1, y: 0, curve: 0 }]);
  e.setFxOrder([7, 0, 1, 2, 3, 4, 5, 6, 8, 9]);
  e.setName('ねいろ 1');
  const saved = e.save();
  assert.ok(saved.length < 80, `patch is ${saved.length} bytes`);

  const f = await make();
  assert.ok(f.load(saved));
  assert.ok(Math.abs(f.getPlain(cutoff) - 440) < 0.5);
  assert.equal(f.getPlain(f.idx('oscA.unison')), 5);
  const slot = f.getSlot(0);
  assert.equal(slot.dst, cutoff);
  assert.ok(slot.bipolar);
  assert.ok(Math.abs(slot.amount - 0.25) < 1e-3);
  assert.equal(f.getLfoShape(1).length, 2);
  assert.deepEqual(f.getFxOrder(), [7, 0, 1, 2, 3, 4, 5, 6, 8, 9]);
  assert.equal(f.getName(), 'ねいろ 1');
  assert.deepEqual(Array.from(f.save()), Array.from(saved));

  assert.equal(f.load(new Uint8Array([1, 2, 3])), false);
  assert.equal(f.getName(), 'ねいろ 1', 'a rejected load changes nothing');
});

test('previews', async () => {
  const e = await make();
  assert.ok(rms(e.previewOsc(0, 0.5, 0, 256)) > 0.3);
  assert.ok(rms(e.previewTable(6, 0.3, 128)) > 0.1);
  const lfo = e.previewLfo(0, 101);
  assert.ok(Math.abs(lfo[50] - 1) < 0.02);
  const resp = e.filterResponse(e.params[e.idx('filter.type')].options.indexOf('LP24'), 1000, 0, 0, 128);
  assert.ok(Math.abs(resp[10]) < 1, 'flat passband');
  assert.ok(resp[127] < -60, 'steep stopband');
  assert.equal(e.filterResponse(e.params[e.idx('filter.type')].options.indexOf('Ring'), 1000, 0, 0, 64), null);
});

test('renders faster than real time with headroom', async () => {
  const e = await make();
  // A heavy but realistic patch: both oscillators with 7-voice unison,
  // filter, and a few effects, playing 8 notes.
  for (const o of ['oscA', 'oscB']) {
    e.setPlain(e.idx(`${o}.on`), 1);
    e.setPlain(e.idx(`${o}.unison`), 7);
  }
  for (const fx of ['chorus', 'delay', 'reverb']) e.setPlain(e.idx(`${fx}.on`), 1);
  for (let n = 0; n < 8; n++) e.noteOn(48 + n * 4, 0.8);
  renderSeconds(e, 0.2); // warm up
  const t0 = performance.now();
  renderSeconds(e, 2);
  const load = (performance.now() - t0) / 2000;
  console.log(`  heavy patch: ${(load * 100).toFixed(1)}% of real time`);
  assert.ok(load < 0.5, `engine uses ${(load * 100).toFixed(0)}% of real time`);
});
