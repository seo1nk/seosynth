// Application start-up: loads the engine, builds the UI, runs the frame loop.

import { EngineCore } from './engine/core.js';
import { AudioEngine } from './engine/audio.js';
import { Store } from './store.js';
import { createI18n, detectLang } from './i18n.js';
import { hashToPatch, patchToHash } from './share.js';
import { PRESETS, presetTitle } from './presets.js';
import { h } from './ui/dom.js';
import { Mods } from './ui/mods.js';
import { Cables } from './ui/cables.js';
import { ScopeBank } from './ui/displays.js';
import { buildStage } from './ui/modules.js';
import { Keyboard } from './ui/keyboard.js';
import { Help, Header, Tour, createToaster, popover, dialog } from './ui/chrome.js';

const DESIGN_WIDTH = 1400;

async function boot() {
  const root = document.getElementById('app');
  let bytes;
  let core;
  try {
    const response = await fetch(new URL('../wasm/nami.wasm', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
    core = await EngineCore.fromBytes(bytes, 48000);
  } catch (err) {
    root.replaceChildren(h('p', { class: 'boot error' }, `Could not load the synth engine (${err.message}). Run ./scripts/build.sh and reload.`));
    throw err;
  }

  const audio = new AudioEngine(bytes, core.info);
  const store = new Store(core, audio);
  const T = core.info.tele;
  const toast = createToaster();

  // Latest state reported by the audio thread. Before audio runs, values
  // fall back to the patch so the displays still make sense.
  let tele = null;
  let freshTaps = null;
  const live = {
    param: (i) => (tele ? tele[T.params + i] : store.get(i)),
    envPos: (e) => (tele ? tele[T.envPos + e] : 0),
    envVal: (e) => (tele ? tele[T.envVal + e] : 0),
    lfoPhase: (l) => (tele ? tele[T.lfoPhase + l] : 0),
    lfoVal: (l) => (tele ? tele[T.lfoVal + l] : 0),
    get active() { return tele ? tele[T.voices] > 0 : false; },
    get voices() { return tele ? tele[T.voices] : 0; },
    get note() { return tele ? tele[T.note] : -1; },
    get pitch() { return tele ? tele[T.pitch] : 60; },
    get peakL() { return tele ? tele[T.peakL] : 0; },
    get peakR() { return tele ? tele[T.peakR] : 0; },
  };
  audio.onTelemetry = (t, taps) => {
    tele = t;
    if (taps) freshTaps = taps;
  };

  const app = {
    root,
    core,
    store,
    audio,
    toast,
    live,
    popover,
    presetIndex: null,
    loading: false,
    frameFns: [],
    slotFns: [],
    mountFns: [],
    onFrame: (fn) => app.frameFns.push(fn),
    onSlots: (fn) => app.slotFns.push(fn),
    afterMount: (fn) => app.mountFns.push(fn),
    dialog: (title, content, opts) => dialog(app, title, content, opts),
    commitSoon: debounce(() => store.commit(), 500),
    flash(param) {
      const el = root.querySelector(`.knob[data-param="${param}"]`);
      if (!el) return;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 900);
    },
    demoPhrase: () => (app.presetIndex != null ? PRESETS[app.presetIndex].demo : 'arp'),
    loadPreset(index) {
      const preset = PRESETS[index];
      app.loading = true;
      try {
        const warnings = store.fromJSON({ ...preset, name: presetTitle(preset, app.i18n.lang) });
        if (warnings.length) console.warn(`preset "${preset.name}":`, warnings);
      } finally {
        app.loading = false;
      }
      app.presetIndex = index;
      if (preset.note) toast(preset.note[app.i18n.lang === 'ja' ? 0 : 1], 6000);
      else toast.clear();
    },
    setLang(lang) {
      try {
        localStorage.setItem('nami.lang', lang);
      } catch {
        /* ignore */
      }
      mount(lang);
    },
  };

  // --- share URL ---------------------------------------------------------------
  let lastHash = '';
  const writeHash = debounce(() => {
    lastHash = patchToHash(store.toBytes());
    history.replaceState(null, '', lastHash);
  }, 400);
  const readHash = (announce) => {
    if (location.hash === lastHash) return false;
    const patch = hashToPatch(location.hash);
    if (!patch) return false;
    app.loading = true;
    const ok = store.loadBytes(patch);
    app.loading = false;
    if (announce) toast(app.i18n.t(ok ? 'share.loaded' : 'share.invalid'), 4000);
    if (ok) {
      app.presetIndex = null;
      lastHash = location.hash;
    }
    return ok;
  };
  window.addEventListener('hashchange', () => readHash(true));

  // --- building the page ---------------------------------------------------------
  function mount(lang) {
    app.keyboard?.dispose();
    app.tour?.stop();
    store.watchers.clear();
    store.listeners.clear();
    app.frameFns = [];
    app.slotFns = [];
    app.mountFns = [];
    app.cables = null;
    toast.clear();
    document.querySelector('.popover')?.dispatchEvent(new Event('dismiss'));

    app.i18n = createI18n(lang);
    document.documentElement.lang = lang;
    document.title = lang === 'ja' ? 'Nami — ブラウザで動くウェーブテーブルシンセ' : 'Nami — a wavetable synth in your browser';
    app.help = new Help(app);
    app.mods = new Mods(app);
    app.scopes = new ScopeBank(app);
    app.tour = new Tour(app);
    app.keyboard = new Keyboard(app);
    const stage = buildStage(app);
    root.replaceChildren(Header(app), stage, h('footer', { class: 'bottom' }, app.help.el, app.keyboard.el));
    app.cables = new Cables(app, stage);
    for (const fn of app.mountFns) fn();

    store.on('slots', () => app.slotFns.forEach((fn) => fn()));
    store.on('commit', writeHash);
    app.setAudioStatus(audio.running);
    fit();
  }

  // Scale the whole instrument down on screens narrower than its design
  // width (like resizing a plug-in window); phones get a stacked layout.
  function fit() {
    const w = window.innerWidth;
    const zoom = w >= 760 && w < DESIGN_WIDTH ? w / DESIGN_WIDTH : 1;
    root.style.zoom = zoom === 1 ? '' : String(zoom);
    app.cables?.schedule();
  }
  window.addEventListener('resize', fit);

  mount(detectLang());
  const shared = readHash(true);
  if (!shared) app.loadPreset(0);
  store.history = [store.toBytes()];
  store.cursor = 0;
  store.emit('commit');

  // --- audio ---------------------------------------------------------------------
  audio.onState = () => app.setAudioStatus?.(audio.running);
  audio.start().catch((err) => {
    console.error(err);
    toast(app.i18n.t('audio.error'), 8000);
  });
  // Browsers only start audio after a user gesture.
  const unlock = () => audio.resume();
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  // --- global shortcuts ------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    if (e.target?.tagName === 'INPUT' && e.target.type === 'text') return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  });

  // --- frame loop ------------------------------------------------------------------
  function frame() {
    for (const fn of app.frameFns) fn(live);
    if (freshTaps) {
      app.scopes.update(live, freshTaps);
      freshTaps = null;
    }
    app.cables.frame(app.scopes);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // First visit: offer the guided tour (not when opening a shared sound).
  let seen = true;
  try {
    seen = localStorage.getItem('nami.tour') === 'seen';
  } catch {
    /* ignore */
  }
  if (!seen && !shared) app.tour.start();

  // Handy for debugging from the console.
  window.nami = app;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

boot();
