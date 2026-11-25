// Application start-up: loads the engine, builds the UI, runs the frame loop.

import { EngineCore } from './engine/core.ts';
import { AudioEngine } from './engine/audio.ts';
import { Store } from './store.ts';
import { createI18n, detectLang } from './i18n.ts';
import { decodeHash, encodeHash } from './share.ts';
import { PRESETS, presetTitle } from './presets.ts';
import { applyTheme, savedTheme, onSystemThemeChange } from './theme.ts';
import { h } from './ui/dom.ts';
import { Mods } from './ui/mods.ts';
import { ScopeBank } from './ui/displays.ts';
import { Lesson } from './ui/lesson.ts';
import { Board } from './ui/board.ts';
import { buildPanel } from './ui/panel.ts';
import { isMover, SPLIT, fxGroups } from './ui/nodes.ts';
import { Keyboard } from './ui/keyboard.ts';
import { Help, Header, Tour, createToaster, popover, dialog } from './ui/chrome.ts';
import { Scope } from './app.ts';
import type { App, Live } from './app.ts';
import type { Lang } from './i18n.ts';
import type { Theme } from './theme.ts';

declare global {
  interface Window {
    /** The running app, for poking at from the browser console. */
    seosynth?: App;
  }
}

async function boot() {
  const found = document.getElementById('app');
  if (!found) throw new Error('#app is missing from the page');
  const root: HTMLElement = found;
  applyTheme(savedTheme());
  let bytes: ArrayBuffer;
  let core: EngineCore;
  try {
    const response = await fetch(new URL('../wasm/seosynth.wasm', import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
    core = await EngineCore.fromBytes(bytes, 48000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    root.replaceChildren(h('p', { class: 'boot error' }, `Could not load the synth engine (${message}). Run "pnpm build" and reload.`));
    throw err;
  }

  const audio = new AudioEngine(bytes, core.info);
  // Factory tables for the audio thread: generated here, band-limited there.
  audio.tableSource = (index) => core.tableRaw(index);
  const store = new Store(core, audio);
  const T = core.info.tele;
  // Words are looked up when a message is shown (the language can change).
  const toast = createToaster((key) => app.i18n.t(key));

  // Latest state reported by the audio thread. Before audio runs, values
  // fall back to the patch so the displays still make sense.
  let tele: Float32Array | null = null;
  let freshTaps: Float32Array | null = null;
  const live: Live = {
    param: (i) => (tele ? tele[T.params + i] : store.get(i)),
    source: (s) => (tele && s > 0 ? tele[T.sources + s] : 0),
    envPos: (e) => (tele ? tele[T.envPos + e] : 0),
    envVal: (e) => (tele ? tele[T.envVal + e] : 0),
    lfoPhase: (l) => (tele ? tele[T.lfoPhase + l] : 0),
    lfoVal: (l) => (tele ? tele[T.lfoVal + l] : 0),
    get active() { return tele ? tele[T.voices] > 0 : false; },
    get voices() { return tele ? tele[T.voices] : 0; },
    get note() { return tele ? tele[T.note] : -1; },
    get gate() { return tele ? tele[T.gate] > 0.5 : false; },
    get clipPos() { return tele ? tele[T.clipPos] : -1; },
    get clipSlot() { return tele ? tele[T.clipSlot] : 0; },
    get pitch() { return tele ? tele[T.pitch] : 60; },
    get peakL() { return tele ? tele[T.peakL] : 0; },
    get peakR() { return tele ? tele[T.peakR] : 0; },
  };
  audio.onTelemetry = (t, taps) => {
    tele = t;
    if (taps) freshTaps = taps;
  };

  const frameFns = new Set<(live: Live) => void>();
  let panelScope: Scope | null = null;
  let slot: HTMLElement | null = null;
  let dock: HTMLElement | null = null;

  // The parts that depend on the language (i18n, help, board, keyboard...)
  // are filled in by mount(), before anything uses them.
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
    watch(i: number, fn: (norm: number) => void) {
      const off = store.watch(i, fn);
      app.scope.add(off);
      return off;
    },
    on(event, fn) {
      const off = store.on(event, fn);
      app.scope.add(off);
      return off;
    },
    onFrame(fn: (live: Live) => void) {
      frameFns.add(fn);
      app.scope.add(() => void frameFns.delete(fn));
    },
    onDispose: (fn: () => void) => app.scope.add(fn),
    /** Runs `build` with a fresh scope; returns [result, scope]. */
    inScope<T>(build: () => T): [T, Scope] {
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
    select(id: string | null) {
      if (id && isMover(id)) app.movers.add(id);
      panelScope?.dispose();
      panelScope = null;
      app.help.clear();
      app.selected = id ?? null;
      if (id) {
        const [el, scope] = app.inScope(() => buildPanel(app, id));
        panelScope = scope;
        slot?.replaceChildren(el);
      } else slot?.replaceChildren();
      slot?.classList.toggle('open', !!id);
      if (id && isMover(id)) app.board.layout(true);
      app.board.setSelected(app.selected);
    },

    toggleKeyboard(show?: boolean) {
      if (!dock) return;
      const shown = show ?? dock.hidden === true;
      dock.hidden = !shown;
      app.onKeyboardShown?.(shown);
    },

    demoPhrase: () => (app.presetIndex != null ? PRESETS[app.presetIndex].demo : 'arp'),
    loadPreset(index: number) {
      const preset = PRESETS[index];
      app.lesson?.stop();
      app.loading = true;
      try {
        const warnings = store.fromJSON({ ...preset, name: presetTitle(preset, app.i18n.lang) });
        if (warnings.length) console.warn(`preset "${preset.name}":`, warnings);
      } finally {
        app.loading = false;
      }
      app.presetIndex = index;
      app.onPresetChange?.();
      if (preset.note) toast(preset.note[app.i18n.lang === 'ja' ? 0 : 1], 6000);
      else toast.clear();
    },
    setLang(lang: Lang) {
      try {
        localStorage.setItem('seosynth.lang', lang);
      } catch {
        /* ignore */
      }
      mount(lang);
    },
    setTheme(theme: Theme) {
      applyTheme(theme);
      mount(app.i18n.lang);
    },
  } as App;

  // --- share URL ---------------------------------------------------------------
  let lastHash = '';
  let writing = 0;
  const writeHash = debounce(async () => {
    const n = ++writing;
    const hash = await encodeHash(store.toBytes());
    if (n !== writing) return; // a newer edit is on its way
    lastHash = hash;
    history.replaceState(null, '', hash);
  }, 400);
  const readHash = async (announce: boolean) => {
    if (location.hash === lastHash) return false;
    const patch = await decodeHash(location.hash);
    if (!patch) {
      // A link that carries a sound but cannot be read: say so.
      if (announce && /[#&][pz]=/.test(location.hash)) toast(app.i18n.t('share.invalid'), 4000);
      return false;
    }
    app.loading = true;
    const ok = store.loadBytes(patch);
    app.loading = false;
    if (announce) toast(app.i18n.t(ok ? 'share.loaded' : 'share.invalid'), 4000);
    if (ok) {
      // A built-in sound keeps its name in the link: find it again, so
      // the demo phrase and "Learn" still know which sound this is.
      const name = store.getName();
      const k = PRESETS.findIndex((p) => p.name === name || p.ja === name);
      app.presetIndex = k >= 0 ? k : null;
      app.onPresetChange?.();
      lastHash = location.hash;
    }
    return ok;
  };
  window.addEventListener('hashchange', () => void readHash(true));

  // --- building the page ---------------------------------------------------------
  function mount(lang: Lang) {
    const reopen = app.selected;
    const keysShown = dock ? dock.hidden !== true : window.innerWidth >= 640;
    app.keyboard?.dispose();
    app.tour?.stop();
    app.lesson?.stop();
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
    app.lesson = new Lesson(app);
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
    // Undo or a loaded sound may take away the fork whose settings are open.
    app.on('fx', () => {
      if (app.selected === SPLIT && !fxGroups(store).split) app.select(null);
    });
    app.on('commit', writeHash);
    app.select(reopen === SPLIT && !fxGroups(store).split ? null : reopen);
  }

  mount(detectLang());
  const shared = await readHash(true);
  if (!shared) {
    // A link that carried a sound which could not be read: say so after
    // the first preset is in, so its own tip does not hide the message.
    const broken = /[#&][pz]=/.test(location.hash);
    app.loadPreset(0);
    if (broken) toast(app.i18n.t('share.invalid'), 6000);
  }
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
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
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

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

boot();
