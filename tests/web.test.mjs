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

const bytes = await readFile(new URL('../web/wasm/nami.wasm', import.meta.url));
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
  const url = shareUrl(data, 'https://example.com/nami/?a=1#old');
  assert.ok(url.startsWith('https://example.com/nami/?a=1#p='));
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
