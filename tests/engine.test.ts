// Tests the compiled wasm through the same wrapper the browser uses.
// Run `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EngineCore } from '../src/engine/core.ts';

const bytes = await readFile(new URL('../dist/wasm/seosynth.wasm', import.meta.url));
const make = () => EngineCore.fromBytes(bytes, 48000);

const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function renderSeconds(e: EngineCore, seconds: number): Float32Array {
  const out: Float32Array[] = [];
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
  assert.equal(e.info.fxKinds.length, 10);
  assert.equal(e.info.fx.length, 30, 'three copies of each kind');
  assert.deepEqual(e.info.fx.slice(9, 12), ['fxfilter', 'hyper2', 'dist2']);
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

test('the arpeggiator plays a held chord one note at a time', async () => {
  const e = await make();
  e.setPlain(e.idx('arp.on'), 1);
  e.setPlain(e.idx('arp.mode'), e.params[e.idx('arp.mode')].options.indexOf('Down'));
  const T = e.info.tele;
  e.noteOn(60, 0.8);
  e.noteOn(64, 0.8);
  e.noteOn(67, 0.8);
  // 1/16 at 120 bpm is 6000 samples at 48 kHz: look in the middle of each step.
  const notes: number[] = [];
  for (let step = 0; step < 4; step++) {
    renderSeconds(e, 1500 / 48000);
    notes.push(e.telemetry()[T.note]);
    renderSeconds(e, 4500 / 48000);
  }
  assert.deepEqual(notes, [67, 64, 60, 67]);
  e.noteOff(60);
  e.noteOff(64);
  e.noteOff(67);
  renderSeconds(e, 0.5);
  assert.equal(e.telemetry()[T.voices], 0);
});

test('parameter conversion and patch roundtrip', async () => {
  const e = await make();
  const cutoff = e.idx('filter.cutoff');
  e.setPlain(cutoff, 440);
  assert.ok(Math.abs(e.getPlain(cutoff) - 440) < 0.5);
  e.setPlain(e.idx('oscA.unison'), 5);
  e.setSlot(0, { src: e.info.sources.indexOf('lfo1'), dst: cutoff, amount: 0.25, bipolar: true, curve: -0.5, aux: e.info.sources.indexOf('modWheel') });
  e.setLfoShape(1, [{ x: 0, y: 1, curve: 0.5 }, { x: 1, y: 0, curve: 0 }]);
  // Reverb first, and the second distortion on lane B of the fork.
  const units = e.info.fx.map((_, u) => u);
  const order = [7, ...units.filter((u) => u !== 7)];
  const lanes = units.map((u) => (u === 11 ? 2 : 0));
  assert.ok(e.setFxChain(order, lanes));
  assert.equal(e.setFxChain([0, 0, ...units.slice(2)], lanes), false, 'a unit listed twice is rejected');
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
  assert.ok(Math.abs(slot.curve + 0.5) < 0.01);
  assert.equal(slot.aux, f.info.sources.indexOf('modWheel'));
  assert.equal(f.getLfoShape(1).length, 2);
  assert.deepEqual(f.getFxChain(), { order, lanes });
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
  assert.ok(resp);
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

test('user wavetables: set, play, preview, save', async () => {
  const e = await make();
  const { userTables, userPoints, userMaxFrames, tables } = e.info;
  assert.deepEqual([userTables, userPoints, userMaxFrames], [2, 128, 16]);
  // Untouched, a user table is one frame holding a sine.
  const sine = e.getUserTable(0);
  assert.equal(sine.length, userPoints);
  assert.deepEqual([sine[0], sine[32], sine[96]], [0, 127, -127]);

  // Two frames: a square, then a ramp.
  const drawn = new Int8Array(2 * userPoints);
  for (let i = 0; i < userPoints; i++) {
    drawn[i] = i < userPoints / 2 ? 127 : -127;
    drawn[userPoints + i] = i * 2 - 127;
  }
  assert.ok(e.setUserTable(1, drawn));
  assert.equal(e.setUserTable(1, new Int8Array(100)), false, 'not whole frames');
  assert.equal(e.setUserTable(1, new Int8Array(userPoints * (userMaxFrames + 1))), false, 'too many frames');
  assert.equal(e.setUserTable(5, drawn), false, 'no such table');
  assert.deepEqual(Array.from(e.getUserTable(1)), Array.from(drawn));
  const index = tables.length + 1;
  assert.equal(e.tableFrames(index), 2);
  const first = e.previewTable(index, 0, 64);
  assert.ok(first[8] > 0.8 && first[56] < -0.8, 'the square');
  const last = e.previewTable(index, 1, 64);
  assert.ok(last[8] < -0.5 && last[56] > 0.5, 'the ramp');

  // An oscillator that plays it sounds different from the factory table.
  const hear = async (user: number) => {
    const f = await make();
    f.setUserTable(1, drawn);
    f.setPlain(f.idx('oscA.rand'), 0);
    f.setPlain(f.idx('oscA.userTable'), user);
    f.noteOn(48, 0.9);
    return renderSeconds(f, 0.1);
  };
  const [factory, own] = [await hear(0), await hear(2)];
  assert.ok(rms(own) > 0.02);
  assert.ok(factory.some((v, i) => Math.abs(v - own[i]) > 0.05));

  // It travels with the patch.
  e.setPlain(e.idx('oscA.userTable'), 2);
  const saved = e.save();
  assert.ok(saved.length > 2 * userPoints && saved.length < 2 * userPoints + 40, `patch is ${saved.length} bytes`);
  const g = await make();
  assert.ok(g.load(saved));
  assert.deepEqual(Array.from(g.getUserTable(1)), Array.from(drawn));
  assert.equal(g.getUserTable(0).length, userPoints);
  assert.equal(g.getPlain(g.idx('oscA.userTable')), 2);
  g.init();
  assert.deepEqual(Array.from(g.getUserTable(1)), Array.from(sine));
});

test('the audio thread gets factory tables from the main thread and builds them gradually', async () => {
  const main = await make();
  const audio = await make();
  audio.x.set_realtime(1);
  const x = audio.x;
  assert.equal(x.table_wanted(), -1, 'the default table is ready');
  audio.setPlain(audio.idx('oscA.rand'), 0);
  audio.setPlain(audio.idx('oscA.wt'), 2); // Acid Sweep: 48 frames
  audio.render(128);
  assert.equal(x.table_wanted(), 2, 'asks for the new table');

  // What the worklet does with the answer. Allocating can grow the memory,
  // so the buffer is taken afterwards.
  const raw = main.tableRaw(2);
  assert.equal(raw.length, 48 * 2048);
  const ptr = x.table_offer(2, raw.length / 2048);
  new Float32Array(x.memory.buffer, ptr, raw.length).set(raw);
  x.table_offer_ready();
  assert.equal(x.table_wanted(), -1, 'no longer wanted: on its way');

  // Built within 24 callbacks (two frames each); then a note sounds exactly
  // like one played on the same table built in one go.
  for (let k = 0; k < 24; k++) audio.render(128);
  const direct = await make();
  direct.setPlain(direct.idx('oscA.rand'), 0);
  direct.setPlain(direct.idx('oscA.wt'), 2);
  for (let k = 0; k < 25; k++) direct.render(128);
  audio.noteOn(48, 0.9);
  direct.noteOn(48, 0.9);
  const [a] = audio.render(1024);
  const [b] = direct.render(1024);
  const diff = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  assert.ok(rms(a) > 0.01 && diff < 1e-4, `differs by ${diff}`);
});
