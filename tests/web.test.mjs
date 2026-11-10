// Tests for the browser-side modules that do not need a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EngineCore } from '../web/js/engine/core.js';
import { Store } from '../web/js/store.js';
import { createI18n, hasParamText } from '../web/js/i18n.js';
import { PRESETS, CATEGORIES } from '../web/js/presets.js';
import { toBase64Url, fromBase64Url, patchToHash, hashToPatch, shareUrl } from '../web/js/share.js';
import { formatValue } from '../web/js/format.js';

const bytes = await readFile(new URL('../web/wasm/seosynth.wasm', import.meta.url));
const makeStore = async () => {
  const posted = [];
  const store = new Store(await EngineCore.fromBytes(bytes), { post: (m) => posted.push(m) });
  return { store, posted };
};

test('every parameter has a label and help text in both languages', async () => {
  const { store } = await makeStore();
  for (const lang of ['ja', 'en']) {
    const i18n = createI18n(lang);
    for (const p of store.params) {
      assert.ok(hasParamText(p.key), `no text for ${p.key}`);
      assert.ok(i18n.paramLabel(p.key).length > 0, `no ${lang} label for ${p.key}`);
      assert.ok(i18n.paramHelp(p.key).length > 0, `no ${lang} help for ${p.key}`);
      assert.ok(!i18n.paramTitle(p.key).includes('undefined'));
    }
    for (const key of store.info.sources) assert.notEqual(i18n.sourceName(key), '', key);
    for (const key of store.info.fx) assert.notEqual(i18n.fxName(key), key, `no ${lang} name for effect ${key}`);
  }
});

test('tour and UI strings exist', () => {
  for (const lang of ['ja', 'en']) {
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
  let seen = null;
  store.watch(cutoff, (v) => (seen = v));
  store.setPlain(cutoff, 1000);
  assert.ok(Math.abs(store.getPlain(cutoff) - 1000) < 1);
  assert.ok(Math.abs(seen - store.get(cutoff)) < 1e-9);
  assert.deepEqual(posted.at(-1).slice(0, 2), ['param', cutoff]);
  store.commit();
  const slot = store.addMod(store.info.sources.indexOf('lfo1'), cutoff, 0.3);
  assert.equal(slot, 0);
  assert.equal(posted.at(-1)[0], 'patch');
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
  assert.throws(() => store.fromJSON({ hello: 1 }));
  const warnings = store.fromJSON({
    name: 'x',
    params: { 'filter.cutoff': 500, 'no.such': 1, 'filter.type': 'Nope' },
    mods: [{ source: 'lfo9', target: 'filter.cutoff', amount: 1 }, { source: 'lfo1', target: 'oscA.wt', amount: 1 }],
    fxOrder: ['reverb'],
  });
  assert.equal(warnings.length, 5);
  assert.ok(Math.abs(store.plain('filter.cutoff') - 500) < 1);
});

test('share URL encoding', () => {
  for (const len of [0, 1, 2, 3, 57, 300]) {
    const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    const text = toBase64Url(data);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(Array.from(fromBase64Url(text)), Array.from(data));
  }
  const data = Uint8Array.from([78, 1, 250, 251, 252, 253]);
  assert.deepEqual(Array.from(hashToPatch(patchToHash(data))), Array.from(data));
  assert.deepEqual(Array.from(hashToPatch(`#x=1&${patchToHash(data).slice(1)}`)), Array.from(data));
  assert.equal(hashToPatch('#nothing'), null);
  assert.equal(hashToPatch('#p=***'), null);
  const url = shareUrl(data, 'https://example.com/seosynth/?a=1#old');
  assert.ok(url.startsWith('https://example.com/seosynth/?a=1#p='));
});

test('a shared patch survives the URL round trip', async () => {
  const { store } = await makeStore();
  store.fromJSON(PRESETS.find((p) => p.name === 'Talking Lead'));
  const url = shareUrl(store.toBytes(), 'https://example.com/');
  assert.ok(url.length < 400, `URL is ${url.length} characters`);
  const { store: other } = await makeStore();
  assert.ok(other.loadBytes(hashToPatch(new URL(url).hash)));
  // Values are stored with 16-bit resolution, so compare the encoded form
  // (which must be stable) and check the readable form is close.
  assert.deepEqual(Array.from(other.toBytes()), Array.from(store.toBytes()));
  const a = other.toJSON();
  const b = store.toJSON();
  assert.deepEqual(Object.keys(a.params), Object.keys(b.params));
  for (const [key, value] of Object.entries(b.params)) {
    if (typeof value === 'number') assert.ok(Math.abs(a.params[key] - value) <= Math.abs(value) * 1e-3 + 1e-4, key);
    else assert.equal(a.params[key], value, key);
  }
  assert.equal(a.mods.length, b.mods.length);
  assert.equal(a.lfoShapes[1].length, b.lfoShapes[1].length);
});

test('value formatting', async () => {
  const { store } = await makeStore();
  const f = (key, plain) => formatValue(store.def(store.idx(key)), plain);
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

import { zip, crc32 } from '../web/js/zip.js';

/** Just enough CBOR to read back what the exporter writes. */
function decodeCbor(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let i = 0;
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(i++);
    if (info === 25) return (i += 2), view.getUint16(i - 2);
    if (info === 26) return (i += 4), view.getUint32(i - 4);
    throw new Error('unsupported length');
  };
  const item = () => {
    const head = view.getUint8(i++);
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 27) return (i += 8), view.getFloat64(i - 8);
      throw new Error(`unsupported simple value ${info}`);
    }
    const n = arg(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 3) return (i += n), text.decode(bytes.subarray(i - n, i));
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) {
      const out = {};
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
function unstoreZstd(frame) {
  assert.deepEqual(Array.from(frame.subarray(0, 4)), [0x28, 0xb5, 0x2f, 0xfd]);
  const desc = frame[4];
  let i = 5 + [1, 2, 4, 8][desc >> 6];
  const chunks = [];
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

function unpackSerum(file) {
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
    const { preset: file, notes, tables } = store.core.serumExport();
    const { meta, data } = unpackSerum(file);
    assert.equal(meta.fileType, 'SerumPreset');
    assert.equal(meta.product, 'Serum2');
    assert.equal(meta.presetName, preset.name);
    assert.match(meta.hash, /^[0-9a-f]{32}$/);
    assert.equal(Object.keys(data).length, 175, `${preset.name}: module count`);
    assert.equal(data.presetName, preset.name);
    assert.equal(notes[0].code, 'tables');
    // Every table the preset points at is offered for download, and nothing else.
    const referenced = ['Oscillator0', 'Oscillator1']
      .filter((o) => data[o].plainParams.kParamEnable === 1)
      .map((o, k) => data[o][`WTOsc${o.at(-1)}`].relativePathToWT);
    assert.deepEqual([...new Set(referenced)].sort(), tables.map((t) => t.path).sort(), preset.name);
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
  assert.deepEqual(data.FXRack0.FX.map((f) => f.type), [0, 4], 'distortion then delay');
  assert.equal(data.tags[1], 'Mono');
});

test('Serum export: wavetable WAV', async () => {
  const { store } = await makeStore();
  const wav = store.core.serumTableWav(store.info.tables.indexOf('PWM'));
  const text = new TextDecoder('latin1').decode(wav.subarray(0, 120));
  assert.ok(text.startsWith('RIFF'));
  assert.ok(text.includes('<!>2048'), 'cycle length marker for wavetable synths');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  const samples = new Float32Array(wav.buffer.slice(wav.length - 256 * 2048 * 4));
  assert.ok(samples.every((v) => Math.abs(v) <= 1.0001));
  assert.ok(samples.some((v) => Math.abs(v) > 0.9));
});

test('zip writer', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const archive = zip([
    { name: 'a.txt', data: 'hello' },
    { name: 'Tables/seosynth/音.wav', data: Uint8Array.from([1, 2, 3, 4]) },
  ]);
  const view = new DataView(archive.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = archive.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  const dirStart = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(dirStart, true), 0x02014b50);
  // Stored data is readable in place.
  assert.equal(new TextDecoder().decode(archive.subarray(30 + 5, 30 + 5 + 5)), 'hello');
});
