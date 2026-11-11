// Application start-up: loads the engine, builds the UI, runs the frame loop.

import { EngineCore } from './engine/core.js';
import { AudioEngine } from './engine/audio.js';
import { Store } from './store.js';
import { createI18n, detectLang } from './i18n.js';
import { hashToPatch, patchToHash } from './share.js';
import { PRESETS, presetTitle } from './presets.js';
import { applyTheme, savedTheme, onSystemThemeChange } from './theme.js';
import { h } from './ui/dom.js';
import { Mods } from './ui/mods.js';
import { ScopeBank } from './ui/displays.js';
import { Board } from './ui/board.js';
import { buildPanel } from './ui/panel.js';
import { isMover } from './ui/nodes.js';
import { Keyboard } from './ui/keyboard.js';
import { Help, Header, Tour, createToaster, popover, dialog } from './ui/chrome.js';

/** Collects the clean-up work of one part of the UI, so that part can be
 * thrown away (a closed panel, a language switch) without leaking listeners. */
class Scope {
  constructor() {
    this.cleanups = [];
  }
  add(fn) {
    this.cleanups.push(fn);
  }
  dispose() {
    for (const fn of this.cleanups.splice(0)) fn();
  }
}

async function boot() {
  const root = document.getElementById('app');
  applyTheme(savedTheme());
  let bytes;
  let core;
  try {
    const response = await fetch(new URL('../wasm/seosynth.wasm', import.meta.url));
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
    source: (s) => (tele && s > 0 ? tele[T.sources + s] : 0),
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

  const frameFns = new Set();
  let panelScope = null;
  let slot = null;
  let dock = null;

  const app = {
    root,
    core,
    store,
    audio,
    toast,
    live,
    popover,
    /** Movers the user put on the board that are not connected to anything yet. */
    movers: new Set(),
    selected: null,
    presetIndex: null,
    loading: false,
    scope: new Scope(),

    // Subscriptions made through these belong to the part of the UI that is
    // being built at that moment and go away with it.
    watch(i, fn) {
      const off = store.watch(i, fn);
      app.scope.add(off);
      return off;
    },
    on(event, fn) {
      const off = store.on(event, fn);
      app.scope.add(off);
      return off;
    },
    onFrame(fn) {
      frameFns.add(fn);
      app.scope.add(() => frameFns.delete(fn));
    },
    onDispose: (fn) => app.scope.add(fn),
    /** Runs `build` with a fresh scope; returns [result, scope]. */
    inScope(build) {
      const outer = app.scope;
      const scope = new Scope();
      app.scope = scope;
      try {
        return [build(), scope];
      } finally {
        app.scope = outer;
      }
    },

    dialog: (title, content, opts) => dialog(app, title, content, opts),
    commitSoon: debounce(() => store.commit(), 500),

    /** Opens the settings of a node, or closes the panel with `null`. */
    select(id) {
      if (id && isMover(id)) app.movers.add(id);
      panelScope?.dispose();
      panelScope = null;
      app.help.clear();
      app.selected = id ?? null;
      if (id) {
        const [el, scope] = app.inScope(() => buildPanel(app, id));
        panelScope = scope;
        slot.replaceChildren(el);
      } else slot.replaceChildren();
      slot.classList.toggle('open', !!id);
      if (id && isMover(id)) app.board.layout(true);
      app.board.setSelected(app.selected);
    },

    toggleKeyboard(show = dock.hidden) {
      dock.hidden = !show;
      app.onKeyboardShown?.(show);
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
        localStorage.setItem('seosynth.lang', lang);
      } catch {
        /* ignore */
      }
      mount(lang);
    },
    setTheme(theme) {
      applyTheme(theme);
      mount(app.i18n.lang);
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
    const reopen = app.selected;
    const keysShown = dock ? !dock.hidden : window.innerWidth >= 640;
    app.keyboard?.dispose();
    app.tour?.stop();
    panelScope?.dispose();
    panelScope = null;
    app.scope.dispose();
    app.scope = new Scope();
    toast.clear();
    document.querySelector('.popover')?.dispatchEvent(new Event('dismiss'));

    app.i18n = createI18n(lang);
    document.documentElement.lang = lang;
    document.title = app.i18n.t('app.title');
    app.help = new Help(app);
    app.mods = new Mods(app);
    app.scopes = new ScopeBank(app);
    app.tour = new Tour(app);
    app.keyboard = new Keyboard(app);
    app.board = new Board(app);
    slot = h('div', { class: 'panel-slot' });
    dock = h('footer', { class: 'dock', hidden: !keysShown }, app.keyboard.el);
    root.replaceChildren(Header(app), h('main', { class: 'work' }, app.board.el, slot), dock);
    app.onKeyboardShown?.(keysShown);

    // A loaded sound may no longer contain the mover that was open.
    app.on('patch', () => {
      app.movers.clear();
      if (app.selected && isMover(app.selected) && !app.board.visibleMovers().includes(app.selected)) app.select(null);
    });
    app.on('commit', writeHash);
    app.select(reopen);
  }

  mount(detectLang());
  const shared = readHash(true);
  if (!shared) app.loadPreset(0);
  store.history = [store.toBytes()];
  store.cursor = 0;
  store.emit('commit');
  onSystemThemeChange(() => mount(app.i18n.lang));

  // --- audio ---------------------------------------------------------------------
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
    if (e.key === 'Escape' && app.selected && !document.querySelector('.popover, dialog[open]')) {
      app.select(null);
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    if (e.target?.tagName === 'INPUT' && e.target.type === 'text') return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  });

  // --- frame loop ------------------------------------------------------------------
  function frame() {
    if (freshTaps) {
      app.scopes.update(live, freshTaps);
      freshTaps = null;
    }
    for (const fn of frameFns) fn(live);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // First visit: offer the guide (not when opening a shared sound).
  let seen = true;
  try {
    seen = localStorage.getItem('seosynth.tour') === 'seen';
  } catch {
    /* ignore */
  }
  if (!seen && !shared) app.tour.start();

  // Handy for debugging from the console.
  window.seosynth = app;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

boot();
