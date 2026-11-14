// Tests for the browser-side modules that do not need a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EngineCore } from '../src/engine/core.ts';
import { Store } from '../src/store.ts';
import { createI18n, hasParamText } from '../src/i18n.ts';
import { PRESETS, CATEGORIES } from '../src/presets.ts';
import { toBase64Url, fromBase64Url, patchToHash, encodeHash, decodeHash, shareUrl } from '../src/share.ts';
import { formatValue } from '../src/format.ts';
import type { AudioMessage } from '../src/engine/types.ts';
import type { PatchJSON } from '../src/patch-json.ts';
import type { Lang } from '../src/i18n.ts';
import { audioToFrames, findPeriod, extractCycle, toMono, POINTS } from '../src/wavetable-import.ts';

const bytes = await readFile(new URL('../dist/wasm/seosynth.wasm', import.meta.url));

/** Fails the test if `value` is missing; otherwise returns it. */
function must<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value != null, `${what} is missing`);
  return value;
}

const makeStore = async () => {
  const posted: AudioMessage[] = [];
  const store = new Store(await EngineCore.fromBytes(bytes), { post: (m) => posted.push(m) });
  return { store, posted };
};

test('every parameter has a label and help text in both languages', async () => {
  const { store } = await makeStore();
  for (const lang of ['ja', 'en'] as Lang[]) {
    const i18n = createI18n(lang);
    for (const p of store.params) {
      assert.ok(hasParamText(p.key), `no text for ${p.key}`);
      assert.ok(i18n.paramLabel(p.key).length > 0, `no ${lang} label for ${p.key}`);
      assert.ok(i18n.paramHelp(p.key).length > 0, `no ${lang} help for ${p.key}`);
      assert.ok(!i18n.paramTitle(p.key).includes('undefined'));
    }
    for (const key of store.info.sources.slice(1)) {
      assert.notEqual(i18n.sourceName(key), key, `no ${lang} name for source ${key}`);
      assert.ok(i18n.sourceHelp(key).length > 0, `no ${lang} description for source ${key}`);
    }
    for (const key of ['oscA', 'oscB', 'oscC', 'sub', 'noise', 'filter', 'filter2', 'amp', 'split', 'out', ...store.info.fx]) {
      assert.notEqual(i18n.nodeName(key), key, `no ${lang} name for node ${key}`);
      assert.ok(i18n.nodeRole(key).length > 0, `no ${lang} role for node ${key}`);
      assert.ok(i18n.nodeAbout(key).length > 0, `no ${lang} explanation for node ${key}`);
    }
    // English labels are sentence case, not shouting.
    if (lang === 'en') for (const p of store.params) assert.doesNotMatch(i18n.paramLabel(p.key), /^[A-Z]{4,}/, p.key);
  }
});

test('tour and UI strings exist', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    const { t } = createI18n(lang);
    for (let n = 1; n <= 8; n++) {
      assert.notEqual(t(`tour.${n}.title`), `tour.${n}.title`);
      assert.notEqual(t(`tour.${n}.body`), `tour.${n}.body`);
    }
    for (const cat of CATEGORIES) assert.notEqual(t(`cat.${cat}`), `cat.${cat}`);
    assert.equal(t('tour.step', { n: 2, total: 8 }).includes('2'), true);
  }
});

test('all presets load without warnings and are distinct', async () => {
  const { store } = await makeStore();
  const seen = new Set();
  for (const preset of PRESETS) {
    assert.ok(CATEGORIES.includes(preset.cat), `${preset.name}: unknown category`);
    const warnings = store.fromJSON(preset);
    assert.deepEqual(warnings, [], `${preset.name}: ${warnings.join('; ')}`);
    assert.equal(store.getName(), preset.name);
    const key = toBase64Url(store.toBytes().slice(store.getName().length + 4));
    assert.ok(!seen.has(key) || preset.name === 'Init Saw', `${preset.name} duplicates another preset`);
    seen.add(key);
    // JSON form round-trips exactly.
    const again = store.toJSON();
    const before = Array.from(store.toBytes());
    store.fromJSON(again);
    assert.deepEqual(Array.from(store.toBytes()), before, `${preset.name}: JSON round trip`);
  }
  assert.ok(PRESETS.length >= 20);
});

test('presets make sound at a sensible level', async () => {
  const { store } = await makeStore();
  const core = store.core;
  for (const preset of PRESETS) {
    store.fromJSON(preset);
    core.x.panic_stop();
    for (const n of [48, 55, 60]) core.noteOn(n, 0.8);
    let peak = 0;
    let energy = 0;
    let count = 0;
    for (let k = 0; k < 600; k++) {
      const [l, r] = core.render(128);
      for (let s = 0; s < 128; s++) {
        assert.ok(Number.isFinite(l[s]) && Number.isFinite(r[s]), `${preset.name}: non-finite output`);
        peak = Math.max(peak, Math.abs(l[s]), Math.abs(r[s]));
        energy += l[s] * l[s];
        count++;
      }
    }
    for (const n of [48, 55, 60]) core.noteOff(n);
    const rms = Math.sqrt(energy / count);
    assert.ok(rms > 0.004, `${preset.name} is too quiet (rms ${rms.toFixed(4)})`);
    assert.ok(peak <= 1.0, `${preset.name} exceeds full scale`);
    assert.ok(rms < 0.6, `${preset.name} is too loud (rms ${rms.toFixed(3)})`);
  }
});

test('store forwards edits to the audio thread and supports undo', async () => {
  const { store, posted } = await makeStore();
  const cutoff = store.idx('filter.cutoff');
  let seen = -1;
  store.watch(cutoff, (v) => (seen = v));
  store.setPlain(cutoff, 1000);
  assert.ok(Math.abs(store.getPlain(cutoff) - 1000) < 1);
  assert.ok(Math.abs(seen - store.get(cutoff)) < 1e-9);
  assert.deepEqual(must(posted.at(-1)).slice(0, 2), ['param', cutoff]);
  store.commit();
  const slot = store.addMod(store.info.sources.indexOf('lfo1'), cutoff, 0.3);
  assert.equal(slot, 0);
  assert.equal(must(posted.at(-1))[0], 'patch');
  assert.equal(store.modsFor(cutoff).length, 1);
  // The same pair again reuses the slot.
  assert.equal(store.addMod(store.info.sources.indexOf('lfo1'), cutoff, 0.5), 0);
  store.commit();
  store.undo();
  assert.equal(store.modsFor(cutoff).length, 0);
  assert.ok(Math.abs(store.getPlain(cutoff) - 1000) < 1);
  store.undo();
  assert.ok(store.getPlain(cutoff) > 19000);
  assert.equal(store.canUndo, false);
  store.redo();
  store.redo();
  assert.equal(store.modsFor(cutoff).length, 1);
  assert.equal(store.canRedo, false);
});

test('fromJSON rejects junk and tolerates unknown keys', async () => {
  const { store } = await makeStore();
  assert.throws(() => store.fromJSON(null));
  assert.throws(() => store.fromJSON({ hello: 1 } as unknown as PatchJSON));
  const warnings = store.fromJSON({
    name: 'x',
    params: { 'filter.cutoff': 500, 'no.such': 1, 'filter.type': 'Nope' },
    mods: [{ source: 'lfo11', target: 'filter.cutoff', amount: 1 }, { source: 'lfo1', target: 'oscA.wt', amount: 1 }],
    fxOrder: ['reverb', 'nope', 'reverb'],
    fxLanes: { delay2: 'a', dist: 'z' },
  });
  assert.equal(warnings.length, 7);
  assert.equal(store.info.fx[store.getFxChain().order[0]], 'reverb');
  assert.equal(store.getFxChain().lanes[store.info.fx.indexOf('delay2')], 1);
  assert.ok(Math.abs(store.plain('filter.cutoff') - 500) < 1);
});

test('share URL encoding', async () => {
  for (const len of [0, 1, 2, 3, 57, 300]) {
    const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    const text = toBase64Url(data);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(Array.from(must(fromBase64Url(text))), Array.from(data));
  }
  const data = Uint8Array.from([78, 1, 250, 251, 252, 253]);
  assert.deepEqual(Array.from(must(await decodeHash(patchToHash(data)))), Array.from(data));
  assert.deepEqual(Array.from(must(await decodeHash(`#x=1&${patchToHash(data).slice(1)}`))), Array.from(data));
  assert.equal(await decodeHash('#nothing'), null);
  assert.equal(await decodeHash('#p=***'), null);
  assert.equal(await decodeHash('#z=bm90LWRlZmxhdGU'), null, 'not deflate data');
  const url = await shareUrl(data, 'https://example.com/seosynth/?a=1#old');
  assert.ok(url.startsWith('https://example.com/seosynth/?a=1#p='), 'tiny: stays plain');

  // Compressed when that is shorter, and either form opens.
  const smooth = Uint8Array.from({ length: 3000 }, (_, i) => Math.round(127 + 100 * Math.sin(i / 9)) & 255);
  const z = await encodeHash(smooth);
  assert.ok(z.startsWith('#z=') && z.length < patchToHash(smooth).length * 0.8, `${z.length} vs ${patchToHash(smooth).length}`);
  assert.deepEqual(Array.from(must(await decodeHash(z))), Array.from(smooth));

  // Something that inflates far beyond any patch is refused.
  const zeros = new Uint8Array(1024 * 1024);
  const bomb = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  assert.ok(bomb.length < 2000);
  assert.equal(await decodeHash('#z=' + toBase64Url(bomb)), null);
});

test('a shared patch survives the URL round trip', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Talking Lead'));
  const url = await shareUrl(store.toBytes(), 'https://example.com/');
  assert.ok(url.length < 400, `URL is ${url.length} characters`);
  const { store: other } = await makeStore();
  assert.ok(other.loadBytes(must(await decodeHash(new URL(url).hash))));
  // Values are stored with 16-bit resolution, so compare the encoded form
  // (which must be stable) and check the readable form is close.
  assert.deepEqual(Array.from(other.toBytes()), Array.from(store.toBytes()));
  const a = other.toJSON();
  const b = store.toJSON();
  assert.deepEqual(Object.keys(a.params), Object.keys(b.params));
  for (const [key, value] of Object.entries(b.params)) {
    if (typeof value === 'number') assert.ok(Math.abs((a.params[key] as number) - value) <= Math.abs(value) * 1e-3 + 1e-4, key);
    else assert.equal(a.params[key], value, key);
  }
  assert.equal(must(a.mods).length, must(b.mods).length);
  assert.equal(must(a.lfoShapes)[1].length, must(b.lfoShapes)[1].length);
});

test('the clip survives JSON, the share link and undo', async () => {
  const { store, posted } = await makeStore();
  const clip = { length: 96 * 8, notes: [{ pitch: 48, start: 0, length: 96, velocity: 120 }, { pitch: 55, start: 384, length: 48, velocity: 60 }] };
  assert.ok(store.setClip(clip));
  assert.equal(posted.at(-1)?.[0], 'patch', 'the audio thread gets the new clip');
  store.commit();
  assert.deepEqual(store.getClip(), clip);
  const json = store.toJSON();
  assert.deepEqual(json.clip, { length: 768, notes: [[48, 0, 96, 120], [55, 384, 48, 60]] });
  const { store: other } = await makeStore();
  assert.deepEqual(other.fromJSON(JSON.parse(JSON.stringify(json))), []);
  assert.deepEqual(other.getClip(), clip);
  const { store: third } = await makeStore();
  assert.ok(third.loadBytes(must(await decodeHash(await encodeHash(store.toBytes())))));
  assert.deepEqual(third.getClip(), clip);
  // The untouched clip is not written, and undo brings the old one back.
  assert.equal((await makeStore()).store.toJSON().clip, undefined);
  store.setClip({ length: 96 * 4, notes: [] });
  store.commit();
  store.undo();
  assert.deepEqual(store.getClip(), clip);
  // Invalid clips are refused.
  assert.equal(store.setClip({ length: 5, notes: [] }), false);
  assert.deepEqual(other.fromJSON({ params: {}, clip: { length: 384, notes: [[60, -1, 1, 1]] } } as unknown as PatchJSON), ['skipped clip']);
});

test('Serum export: the clip becomes a Serum clip', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Learn: Clip Sequencer'));
  const { preset, notes } = store.core.serumExport();
  const { data } = unpackSerum(preset);
  assert.equal(data.ClipPlayer0.plainParams.kParamEnabled, 1);
  const clip = store.getClip();
  assert.equal(data.MidiClip0.clip.notes.length, clip.notes.length);
  assert.equal(data.MidiClip0.clip.regionEndBeats, clip.length / 96);
  assert.ok(notes.some((n) => n.code === 'clip'));
});

test('connections in old links keep their sources after more were added', async () => {
  const { store } = await makeStore();
  // A patch from before step 5: macro 4 (source 16) and envelope 3 (source 3)
  // moving the filter cutoff (stable id 242). Section 3: src, varint sid,
  // i16 amount, flags.
  const slot = (src: number) => [src, 0xf2, 0x01, 0x00, 0x40, 0x00];
  const body = [...slot(16), ...slot(3)];
  assert.ok(store.loadBytes(Uint8Array.from([0x53, 1, 3, body.length, ...body])));
  const used = store.activeSlots().map((s) => [store.info.sources[s.src], store.def(s.dst).key]);
  assert.deepEqual(used, [['macro4', 'filter.cutoff'], ['env3', 'filter.cutoff']]);
  // The new ones are there too.
  for (const key of ['env4', 'lfo10', 'macro8']) assert.ok(store.info.sources.includes(key), key);
  assert.equal(store.info.numSlots, 64);
});

test('value formatting', async () => {
  const { store } = await makeStore();
  const f = (key: string, plain: number) => formatValue(store.def(store.idx(key)), plain);
  assert.equal(f('filter.cutoff', 440), '440 Hz');
  assert.equal(f('filter.cutoff', 2000), '2 kHz');
  assert.equal(f('filter.cutoff', 12500), '12.5 kHz');
  assert.equal(f('env1.attack', 0.001), '1 ms');
  assert.equal(f('env1.attack', 1.5), '1.5 s');
  assert.equal(f('oscA.level', 0.75), '75%');
  assert.equal(f('oscA.pan', 0), 'C');
  assert.equal(f('oscA.pan', -0.5), 'L50');
  assert.equal(f('oscA.oct', -1), '-1');
  assert.equal(f('oscA.semi', 7), '+7 st');
  assert.equal(f('comp.threshold', -18), '-18 dB');
  assert.equal(f('comp.ratio', 4), '4:1');
  assert.equal(f('filter.on', 1), 'ON');
  assert.equal(f('filter.type', 2), 'LP24');
});

// --- Serum 2 export -------------------------------------------------------------

/** A decoded CBOR value: its shape is whatever the exporter wrote. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cbor = any;

/** Just enough CBOR to read back what the exporter writes. */
function decodeCbor(bytes: Uint8Array): Cbor {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let i = 0;
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(i++);
    if (info === 25) return (i += 2), view.getUint16(i - 2);
    if (info === 26) return (i += 4), view.getUint32(i - 4);
    throw new Error('unsupported length');
  };
  const item = (): Cbor => {
    const head = view.getUint8(i++);
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 26) return (i += 4), view.getFloat32(i - 4);
      if (info === 27) return (i += 8), view.getFloat64(i - 8);
      throw new Error(`unsupported simple value ${info}`);
    }
    const n = arg(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 3) return (i += n), text.decode(bytes.subarray(i - n, i));
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) {
      const out: Record<string, Cbor> = {};
      for (let k = 0; k < n; k++) {
        const key = item();
        out[key] = item();
      }
      return out;
    }
    throw new Error(`unsupported major type ${major}`);
  };
  const value = item();
  assert.equal(i, bytes.length, 'trailing bytes after CBOR item');
  return value;
}

/** Reads a zstd frame made only of raw blocks. */
function unstoreZstd(frame: Uint8Array): Uint8Array {
  assert.deepEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd]);
  const desc = frame[4];
  let i = 5 + [1, 2, 4, 8][desc >> 6];
  const chunks: Uint8Array[] = [];
  for (;;) {
    const head = frame[i] | (frame[i + 1] << 8) | (frame[i + 2] << 16);
    i += 3;
    assert.equal((head >> 1) & 3, 0, 'raw block');
    chunks.push(frame.subarray(i, i + (head >> 3)));
    i += head >> 3;
    if (head & 1) break;
  }
  assert.equal(i, frame.length);
  return Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
}

function unpackSerum(file: Uint8Array): { meta: Cbor; data: Cbor } {
  assert.equal(new TextDecoder().decode(file.subarray(0, 9)), 'XferJson\0');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const jsonLength = Number(view.getBigUint64(9, true));
  const meta = JSON.parse(new TextDecoder().decode(file.subarray(17, 17 + jsonLength)));
  const at = 17 + jsonLength;
  assert.equal(view.getUint32(at + 4, true), 2, 'payload encoding');
  const cbor = unstoreZstd(file.subarray(at + 8));
  assert.equal(cbor.length, view.getUint32(at, true));
  return { meta, data: decodeCbor(cbor) };
}

test('Serum export: every preset produces a well-formed file', async () => {
  const { store } = await makeStore();
  for (const preset of PRESETS) {
    store.fromJSON(preset);
    const { preset: file, notes } = store.core.serumExport();
    const { meta, data } = unpackSerum(file);
    assert.equal(meta.fileType, 'SerumPreset');
    assert.equal(meta.product, 'Serum2');
    assert.equal(meta.presetName, preset.name);
    assert.match(meta.hash, /^[0-9a-f]{32}$/);
    assert.equal(Object.keys(data).length, 175, `${preset.name}: module count`);
    assert.equal(data.presetName, preset.name);
    // Oscillators that are on carry their table; the others point at Serum's own.
    for (const o of [0, 1, 2]) {
      const osc = data[`Oscillator${o}`];
      const wt = osc[`WTOsc${o}`];
      if (osc.plainParams.kParamEnable === 1) {
        assert.equal(wt.embeddedWTData.length, wt.numFrames, `${preset.name}: oscillator ${o}`);
        assert.equal(wt.numFrames % 2048, 0);
        assert.ok(wt.embeddedWTData.every((v: number) => Math.abs(v) <= 1.0001));
        assert.equal(wt.relativePathToWT, undefined);
      } else {
        assert.equal(wt.relativePathToWT, 'S2 Tables/Default Shapes.wav');
        assert.equal(wt.embeddedWTData, undefined);
      }
    }
    // Effects: one rack entry per enabled unit.
    const enabled = store.info.fx.filter((k) => store.plain(`${k}.on`) >= 0.5).length;
    assert.equal(data.FXRack0.FX.length, enabled, `${preset.name}: effect count`);
    for (const n of notes) assert.match(n.code, /^[A-Za-z]+$/);
  }
});

test('Serum export: values land in the right modules', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Acid Line'));
  const { data } = unpackSerum(store.core.serumExport().preset);
  assert.equal(data.VoiceFilter0.plainParams.kParamType, 'MgL24');
  assert.ok(Math.abs(data.VoiceFilter0.plainParams.kParamReso - 72) < 0.01);
  assert.equal(data.Global0.plainParams.kParamMonoToggle, 1);
  assert.equal(data.Oscillator0.plainParams.kParamOctave, -1);
  const slot = data.ModSlot0;
  assert.deepEqual(slot.source, [3, 0], 'ENV 2');
  assert.equal(slot.destModuleTypeString, 'VoiceFilter');
  assert.equal(slot.destModuleParamName, 'kParamFreq');
  assert.deepEqual(data.FXRack0.FX.map((f: Cbor) => f.type), [0, 4], 'distortion then delay');
  assert.equal(data.tags[1], 'Mono');
});

test('the second warp survives the share link and reaches the Serum export', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Learn: Dual Warp'));
  assert.equal(store.toJSON().params['oscA.warp2'], 'Sync');
  const link = await encodeHash(store.toBytes());
  store.init();
  assert.equal(store.plain('oscA.warp2'), 0, 'off in a new patch');
  assert.ok(store.loadBytes(must(await decodeHash(link))));
  assert.equal(store.toJSON().params['oscA.warp2'], 'Sync');
  assert.ok(Math.abs(store.plain('oscA.warp2Amt') - 0.1) < 1e-3);
  const wt = unpackSerum(store.core.serumExport().preset).data.Oscillator0.WTOsc0.plainParams;
  assert.equal(wt.kParamWarpMenu, 'kBendPos');
  assert.equal(wt.kParamWarpMenu2, 'kSync');
  // Both warps show in the preview: it differs from the first warp alone.
  const both = store.core.previewOsc(0, 0.5, 0.45, 0.6, 64);
  const first = store.core.previewOsc(0, 0.5, 0.45, 0, 64);
  assert.ok(both.some((v, i) => Math.abs(v - first[i]) > 0.1));
});

test('Serum export: the arpeggiator is switched on in Serum', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Learn: Arpeggiator'));
  const arp = store.core.serumExport();
  assert.equal(unpackSerum(arp.preset).data.Arp0.plainParams.kParamEnabled, 1);
  assert.ok(arp.notes.some((n) => n.code === 'arp'), 'its settings are reported');
  store.fromJSON(PRESETS.find((p) => p.name === 'Acid Line'));
  const plain = store.core.serumExport();
  assert.equal(unpackSerum(plain.preset).data.Arp0.activeClip, -1);
  assert.ok(!plain.notes.some((n) => n.code === 'arp'));
});

test('effect chain: stacking, lanes and the fork', async () => {
  const nodes = await import('../src/ui/nodes.ts');
  const { fxGroups, fxChain, fxSpares, fxPeers, setOn, setLane, shiftFx, unsplit, duplicateFx, laneOf, taps, movableNodes, LANE, SPLIT } = nodes;
  const { store } = await makeStore();
  store.init();
  const groups = () => {
    const { pre, a, b, post } = fxGroups(store);
    return { pre, a, b, post };
  };
  const tap = store.info.tap;
  const unitTap = (id: string) => tap.fx + store.info.fx.indexOf(id);

  // The tray offers one of each kind; switching one on brings out the next copy.
  assert.deepEqual(fxSpares(store), store.info.fxKinds);
  for (const id of ['dist', 'delay', 'reverb']) setOn(store, id, true);
  assert.deepEqual(fxChain(store), ['dist', 'delay', 'reverb']);
  assert.ok(fxSpares(store).includes('dist2') && !fxSpares(store).includes('dist'));
  setOn(store, 'dist2', true);
  assert.deepEqual(fxChain(store), ['dist', 'delay', 'reverb', 'dist2'], 'a new effect joins the end');
  assert.equal(fxGroups(store).split, false);
  assert.deepEqual(taps(store, 'delay'), { in: unitTap('dist'), out: unitTap('delay') });
  assert.equal(taps(store, 'out').in, unitTap('dist2'));

  // Stacking copies the settings and puts the copy right behind.
  store.setPlain(store.idx('delay.feedback'), 0.8);
  assert.equal(duplicateFx(store, 'delay'), 'delay2');
  assert.deepEqual(fxChain(store), ['dist', 'delay', 'delay2', 'reverb', 'dist2']);
  assert.ok(Math.abs(store.plain('delay2.feedback') - 0.8) < 1e-3);
  assert.equal(duplicateFx(store, 'delay'), 'delay3');
  assert.equal(duplicateFx(store, 'delay'), null, 'all three copies are in use');
  setOn(store, 'delay3', false);
  setOn(store, 'delay2', false);

  // Putting the delay on lane A opens the fork where the delay was.
  setLane(store, 'delay', LANE.a);
  assert.deepEqual(groups(), { pre: ['dist'], a: ['delay'], b: [], post: ['reverb', 'dist2'] });
  setLane(store, 'reverb', LANE.b);
  assert.deepEqual(groups(), { pre: ['dist'], a: ['delay'], b: ['reverb'], post: ['dist2'] });
  assert.equal(laneOf(store, 'reverb'), LANE.b);
  assert.deepEqual(taps(store, SPLIT), { in: unitTap('dist'), out: tap.splitOut });
  assert.deepEqual(taps(store, 'reverb'), { in: tap.splitB, out: unitTap('reverb') });
  assert.equal(taps(store, 'dist2').in, tap.splitOut);
  assert.ok(movableNodes(store).includes(SPLIT));

  // The main line treats the fork as one step; lanes have their own order.
  assert.deepEqual(fxPeers(store, 'dist'), ['dist', SPLIT, 'dist2']);
  shiftFx(store, 'dist', 1);
  assert.deepEqual(groups(), { pre: [], a: ['delay'], b: ['reverb'], post: ['dist', 'dist2'] });
  shiftFx(store, SPLIT, 1);
  assert.deepEqual(groups(), { pre: ['dist'], a: ['delay'], b: ['reverb'], post: ['dist2'] });
  setLane(store, 'dist2', LANE.a);
  assert.deepEqual(fxPeers(store, 'dist2'), ['delay', 'dist2']);
  shiftFx(store, 'dist2', -1);
  assert.deepEqual(groups().a, ['dist2', 'delay']);

  // The whole layout survives the binary patch, JSON and a URL-sized budget.
  const before = groups();
  const json = JSON.parse(JSON.stringify(store.toJSON()));
  assert.deepEqual(json.fxLanes, { dist2: 'a', delay: 'a', reverb: 'b' });
  const bytes = store.toBytes();
  store.init();
  assert.ok(store.loadBytes(bytes));
  assert.deepEqual(groups(), before);
  store.init();
  assert.deepEqual(store.fromJSON(json), []);
  assert.deepEqual(groups(), before);

  // Leaving a lane lands right behind the fork; switching off leaves the lane too.
  setLane(store, 'delay', LANE.main);
  assert.deepEqual(groups(), { pre: ['dist'], a: ['dist2'], b: ['reverb'], post: ['delay'] });
  setOn(store, 'reverb', false);
  assert.equal(store.getFxChain().lanes[store.info.fx.indexOf('reverb')], 0);
  setOn(store, 'reverb', true);
  assert.deepEqual(groups(), { pre: ['dist'], a: ['dist2'], b: [], post: ['delay', 'reverb'] });
  unsplit(store);
  assert.deepEqual(groups(), { pre: ['dist', 'dist2', 'delay', 'reverb'], a: [], b: [], post: [] });
  assert.equal(fxGroups(store).split, false);
});

test('old share links with a 10-unit effect order still open', async () => {
  const { store } = await makeStore();
  // 'S', version 1, section 5 (fx order): reverb first.
  const old = Uint8Array.from([0x53, 1, 5, 10, 7, 0, 1, 2, 3, 4, 5, 6, 8, 9]);
  assert.ok(store.loadBytes(old));
  const { order, lanes } = store.getFxChain();
  assert.deepEqual(order.slice(0, 11), [7, 0, 1, 2, 3, 4, 5, 6, 8, 9, 10]);
  assert.ok(lanes.every((l) => l === 0));
});

// --- wavetables from recordings --------------------------------------------------

const SR = 48000;
const record = (seconds: number, fn: (t: number) => number) => Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => fn(i / SR));
const sawAt = (hz: number) => (t: number) => {
  let v = 0;
  for (let k = 1; k * hz < 20000; k++) v += Math.sin(2 * Math.PI * k * hz * t) / k;
  return v * 0.5;
};
/** Strength of harmonic `k` in frame `f`, as [cosine part, sine part]. */
const harmonic = (points: Int8Array, f: number, k: number): [number, number] => {
  let [c, s] = [0, 0];
  for (let i = 0; i < POINTS; i++) {
    const v = points[f * POINTS + i] / 127;
    c += v * Math.cos((2 * Math.PI * k * i) / POINTS);
    s += v * Math.sin((2 * Math.PI * k * i) / POINTS);
  }
  return [(2 * c) / POINTS, (2 * s) / POINTS];
};

test('recordings: the pitch is found across the range', () => {
  for (const hz of [41.2, 110.3, 440, 987.8, 1760]) {
    const x = record(0.5, sawAt(hz));
    const { period, clarity } = findPeriod(x, x.length / 2, SR);
    assert.ok(Math.abs(SR / period - hz) / hz < 0.005, `${hz} Hz was heard as ${(SR / period).toFixed(2)}`);
    assert.ok(clarity > 0.9, `${hz} Hz: clarity ${clarity}`);
  }
  assert.equal(findPeriod(new Float32Array(8), 4, SR).clarity, 0, 'too short to tell');
});

test('recordings: a steady tone becomes one frame with the right harmonics', () => {
  for (const hz of [55, 110.3, 440]) {
    const result = must(audioToFrames(record(1, sawAt(hz)), SR, 8));
    assert.equal(result.frames, 1, `${hz} Hz`);
    assert.equal(result.points.length, POINTS);
    assert.ok(result.pitched && Math.abs(result.hz - hz) / hz < 0.005);
    assert.equal(Math.max(...result.points.map(Math.abs)), 127, 'full height');
    // A saw: harmonic k at 1/k, all in phase with the fundamental.
    const [c1, s1] = harmonic(result.points, 0, 1);
    assert.ok(Math.abs(c1) < 0.01 && s1 > 0.4, 'the fundamental is lined up as a sine');
    for (const k of [2, 3, 5, 8]) {
      const [c, s] = harmonic(result.points, 0, k);
      assert.ok(Math.abs(s / s1 - 1 / k) < 0.02 && Math.abs(c) < 0.02, `${hz} Hz harmonic ${k}: ${(s / s1).toFixed(3)}`);
    }
  }
});

test('recordings: a sound that changes becomes frames that follow it', () => {
  // A sine that turns into a square over two seconds.
  const x = record(2, (t) => {
    let square = 0;
    for (let k = 1; k < 40; k += 2) square += Math.sin(2 * Math.PI * k * 220 * t) / k;
    return (1 - t / 2) * Math.sin(2 * Math.PI * 220 * t) + (t / 2) * square;
  });
  const result = must(audioToFrames(x, SR, 8));
  assert.equal(result.frames, 8);
  const third = Array.from({ length: 8 }, (_, f) => Math.hypot(...harmonic(result.points, f, 3)) / Math.hypot(...harmonic(result.points, f, 1)));
  assert.ok(third[0] < 0.05, 'starts as a sine');
  assert.ok(Math.abs(third[7] - 1 / 3) < 0.04, 'ends as a square');
  for (let f = 1; f < 8; f++) assert.ok(third[f] > third[f - 1], 'and gets there step by step');
  // Every frame starts the same way, so they morph without cancelling.
  for (let f = 0; f < 8; f++) assert.ok(Math.abs(harmonic(result.points, f, 1)[0]) < 0.02);
  assert.equal(must(audioToFrames(x, SR, 4)).frames, 4);
  assert.equal(must(audioToFrames(x, SR, 99)).frames, 16, 'never more than sixteen');
});

test('recordings: single cycles, noise, silence and stereo', () => {
  // A file that is exactly one cycle (600 samples, a rising ramp).
  const one = must(audioToFrames(Float32Array.from({ length: 600 }, (_, i) => i / 300 - 1), SR, 8));
  assert.equal(one.frames, 1);
  assert.ok(Math.abs(one.hz - SR / 600) < 0.5);
  const [, s1] = harmonic(one.points, 0, 1);
  const [, s2] = harmonic(one.points, 0, 2);
  assert.ok(Math.abs(Math.abs(s2 / s1) - 0.5) < 0.03, 'still a ramp');

  // Noise has no pitch: fixed slices, and it says so.
  let seed = 7;
  const noise = record(1, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31 - 1) * 0.5);
  const hiss = must(audioToFrames(noise, SR, 4));
  assert.deepEqual([hiss.frames, hiss.pitched, hiss.hz], [4, false, 0]);
  assert.ok(hiss.points.some((v) => v !== 0));

  assert.equal(audioToFrames(new Float32Array(SR), SR, 8), null, 'silence');
  assert.equal(audioToFrames(new Float32Array(4), SR, 8), null, 'nothing');

  const mono = toMono([Float32Array.of(1, 0, -1), Float32Array.of(0, 0, -1)]);
  assert.deepEqual(Array.from(mono), [0.5, 0, -1]);
  const cycle = extractCycle(record(0.2, (t) => Math.cos(2 * Math.PI * 100 * t)), 4800, 480);
  assert.equal(cycle.length, POINTS);
  assert.ok(Math.abs(cycle[POINTS / 4] - 1) < 0.01, 'a cosine comes out as a sine');
});

test('user wavetables survive JSON, the share link and undo', async () => {
  const { store } = await makeStore();
  store.init();
  const events: number[] = [];
  store.on('table', (slot) => events.push(slot));
  const per = store.info.userPoints;
  const drawn = Int8Array.from({ length: 3 * per }, (_, i) => ((i * 7) % 255) - 127);
  assert.equal(store.tableOf('oscA'), 0);
  assert.ok(store.setUserTable(0, drawn));
  assert.equal(store.setUserTable(0, new Int8Array(5)), false);
  store.setPlain(store.idx('oscA.userTable'), 1);
  store.commit();
  assert.deepEqual(events, [0]);
  assert.equal(store.tableOf('oscA'), store.info.tables.length);
  assert.equal(store.tableOf('oscB'), 0);

  const json = JSON.parse(JSON.stringify(store.toJSON()));
  assert.deepEqual(Object.keys(json.userTables), ['1']);
  assert.equal(json.userTables[1].length, 3);
  assert.equal(json.params['oscA.userTable'], 'User 1');
  const link = await encodeHash(store.toBytes());
  // The table is a regular pattern, which compresses to a fraction.
  assert.ok(link.startsWith('#z=') && link.length < patchToHash(store.toBytes()).length / 2, `the link is ${link.length} characters`);

  store.init();
  assert.equal(store.toJSON().userTables, undefined, 'an untouched table is not written');
  assert.deepEqual(store.fromJSON(json), []);
  assert.deepEqual(Array.from(store.getUserTable(0)), Array.from(drawn));
  store.init();
  assert.ok(store.loadBytes(must(await decodeHash(link))));
  assert.deepEqual(Array.from(store.getUserTable(0)), Array.from(drawn));
  assert.equal(store.plain('oscA.userTable'), 1);

  // Undo takes back an edit of the table.
  const edited = drawn.slice(0, per);
  store.setUserTable(0, edited);
  store.commit();
  assert.equal(store.getUserTable(0).length, per);
  store.undo();
  assert.equal(store.getUserTable(0).length, 3 * per);

  const broken = { params: {}, userTables: { 1: [[1, 2, 3]], 9: 'x', 2: [Array(per).fill(300)] } };
  assert.equal(store.fromJSON(broken as unknown as PatchJSON).length, 3);
});

test('wavetable editor strings exist', () => {
  for (const lang of ['ja', 'en'] as Lang[]) {
    const { t, option } = createI18n(lang);
    for (const key of ['table.user', 'table.mine', 'table.edit', 'table.edit.help', 'editor.title', 'editor.intro', 'editor.canvas', 'editor.start', 'editor.smooth', 'editor.listen', 'editor.frames', 'editor.frames.help', 'editor.frame', 'editor.addFrame', 'editor.removeFrame', 'editor.import.title', 'editor.import.body', 'editor.import.choose', 'editor.import.count', 'editor.import.working', 'editor.import.done', 'editor.import.one', 'editor.import.unpitched', 'editor.import.failed', 'editor.import.silent', 'editor.reset', 'editor.done', 'share.long']) {
      assert.notEqual(t(key), key, `${lang}: ${key}`);
    }
    assert.ok(t('table.user', { n: 2 }).includes('2'));
    assert.notEqual(option('User 1'), 'User 1');
  }
});

// --- envelope playhead -------------------------------------------------------------

test('envelope playhead stays on the drawn line and does not jump', async () => {
  const { envPlayhead } = await import('../src/ui/displays.ts');
  const core = await EngineCore.fromBytes(bytes, 48000);
  const curve = (t: number, c: number) => core.curve(t, c);
  const env = { attack: 0.08, hold: 0.03, decay: 0.25, sustain: 0.5, release: 0.3, atkCurve: 0, decCurve: 0.33, relCurve: 0.33 };
  for (const [k, v] of Object.entries(env)) core.setPlain(core.idx(`env1.${k}`), v);
  // The same geometry the display lays out (times drawn compressed as t^0.4).
  const tw = (t: number) => Math.pow(t, 0.4);
  const top = 7;
  const bottom = 113;
  const scale = 40;
  const xA = 7 + tw(env.attack) * scale;
  const xH = xA + tw(env.hold) * scale;
  const xD = xH + tw(env.decay) * scale;
  const xS = xD + 0.55 * scale;
  const xR = xS + tw(env.release) * scale;
  const g = { v: env, scale, y: (level: number) => bottom - level * (bottom - top), x0: 7, xA, xH, xD, xS, xR, top, bottom };
  const at = (pos: number, sustain = 1) => must(envPlayhead(g, pos, sustain, curve));
  const near = (a: [number, number], b: [number, number], what: string) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5, `${what}: ${a} vs ${b}`);

  assert.equal(envPlayhead(g, 0, 0, curve), null, 'no note, no dot');
  near(at(1), [g.x0, bottom], 'attack starts at the bottom left');
  near(at(1.9999), [xA, top], 'attack ends at the top');
  near(at(2), [xA, top], 'hold starts where attack ended');
  near(at(3), [xH, top], 'decay starts where hold ended');
  near(at(3.9999), [xD, g.y(env.sustain)], 'decay ends at the sustain level');
  near(at(4, 0), [xD, g.y(env.sustain)], 'sustain starts where decay ended');
  near(at(4, 1), [xS, g.y(env.sustain)], 'and stops at the dashed line');
  near(at(4, 5), [xS, g.y(env.sustain)], 'and stays there');
  near(at(5), [xS, g.y(env.sustain)], 'release starts where the dot was waiting');
  near(at(5.9999), [xR, bottom], 'release ends at the bottom right');

  // Driven by the real engine: while the key is held the dot only moves
  // forward, and letting go continues from where it waited.
  const T = core.info.tele;
  const read = (sustain: number) => {
    const pos = core.telemetry()[T.envPos];
    return pos > 0 ? at(pos, sustain) : null;
  };
  core.noteOn(60, 0.9);
  let last = -Infinity;
  for (let n = 0; n < 0.6 * 48000; n += 128) {
    core.render(128);
    const p = must(read(1), 'playhead while held');
    assert.ok(p[0] >= last - 1e-6, `moved back from ${last} to ${p[0]}`);
    last = p[0];
  }
  near([last, 0], [xS, 0], 'held long enough: waiting at the dashed line');
  core.noteOff(60);
  core.render(128);
  const first = must(read(1), 'playhead after release');
  assert.ok(first[0] - xS < 3, `release continued from the dashed line, not ${first[0] - xS}px later`);

  // A key let go during the attack: the dot is still on the release line.
  core.noteOn(62, 0.9);
  core.render(512);
  core.noteOff(62);
  core.render(128);
  const early = must(read(1));
  const k = (early[0] - xS) / (xR - xS);
  near(early, [early[0], g.y(env.sustain * (1 - curve(k, env.relCurve)))], 'on the drawn release line');
});

test('where the board draws a source going matches where the engine sends it', async () => {
  const { sourceDest } = await import('../src/ui/nodes.ts');
  const { store } = await makeStore();
  const core = store.core;
  const t = store.info.tap;
  const level = (tap: number) => {
    const x = core.tap(tap);
    return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  };
  let checked = 0;
  for (const f1 of [0, 1]) {
    for (const f2 of [0, 1]) {
      for (const mode of [0, 1]) {
        for (const through of [0, 1]) {
          for (const sel of [0, 1, 2]) {
            store.init();
            const set = (k: string, v: number) => store.setPlain(store.idx(k), v);
            set('filter.on', f1);
            set('filter2.on', f2);
            set('filter2.mode', mode);
            set('oscA.toFilter', through);
            set('oscA.filterSel', sel);
            core.noteOn(57, 0.9);
            for (let k = 0; k < 20; k++) core.render(128);
            core.noteOff(57);
            const dest = sourceDest(store, 'oscA');
            const into1 = level(t.filterIn) > 1e-3;
            const into2 = level(t.filter2In) > 1e-3;
            const what = JSON.stringify({ f1, f2, mode, through, sel, dest });
            const series = f2 === 1 && mode === 0;
            if (dest === 'direct') assert.ok(!into1 && !into2, what);
            if (dest === 'filter') assert.ok(into1 && into2 === series, what);
            if (dest === 'filter2') assert.ok(!into1 && into2, what);
            if (dest === 'both') assert.ok(into1 && into2, what);
            for (let k = 0; k < 200; k++) core.render(128); // let the release die away
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 48);
});
