// Playing notes: on-screen piano, computer keyboard, MIDI, the
// arpeggiator's switch, and a small phrase player so you can listen while
// both hands are on the knobs.

import { h, clamp } from './dom.ts';
import { noteName } from '../format.ts';
import { Segmented, Select, Slider, Stepper, Switch } from './controls.ts';
import { ClipPanel } from './clip-panel.ts';
import type { ClipPanel as ClipPanelApi } from './clip-panel.ts';
import type { App, Scope } from '../app.ts';

const LOW = 36; // C2
const KEYS = 49; // four octaves and a top C
const BLACK = [1, 3, 6, 8, 10];

// Two rows of the computer keyboard laid out like piano keys.
const KEYMAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

/** A demo phrase: semitone offsets from `root` (arrays are chords, null
 * rests), steps per beat, and how long each note is held (in steps);
 * `hold` gives a step its own length instead. */
interface Phrase {
  root: number;
  steps: (number | number[] | null)[];
  div: number;
  gate: number;
  hold?: (number | undefined)[];
}

/** A melody as [start, note, length] in steps of 1/`div` beat, `length` steps long in all. */
function melody(div: number, length: number, notes: [number, number, number][]): Phrase {
  const steps: (number | null)[] = Array(length).fill(null);
  const hold: (number | undefined)[] = Array(length).fill(undefined);
  for (const [at, note, len] of notes) {
    steps[at] = note;
    // Short notes a little detached, long ones nearly joined.
    hold[at] = len < 1 ? len : len - (len <= 2 ? 0.3 : 0.15);
  }
  return { root: 0, steps, div, gate: 1, hold };
}

// MIDI notes of the lead melody.
const D5 = 74, E5 = 76, F5 = 77, Gb5 = 78, A5 = 81, B5 = 83;

interface DemoState {
  step: number;
  next: number;
  timer?: ReturnType<typeof setTimeout>;
  timers: Set<ReturnType<typeof setTimeout>>;
  sounding: number[];
}

/** How the keys play: as they are, through the arpeggiator, or as the clip. */
const MODES = ['keys', 'arp', 'clip'] as const;
export type Mode = (typeof MODES)[number];

/** Where the mod wheel was left (kept when the page is rebuilt). */
let modWheel = 0;

const PHRASES: Record<string, Phrase> = {
  // The same progression as the chords below, its notes one at a time in eighths:
  // up through each chord and back down, a bar each.
  arp: {
    root: 48,
    steps: [
      5, 9, 12, 16, 17, 16, 12, 9, // FM7
      4, 8, 11, 14, 17, 14, 11, 8, // E7(b9)
      9, 12, 16, 19, 21, 19, 16, 12, // Am7
      7, 10, 14, 17, 19, 17, 14, 10, // Gm7
    ],
    div: 2,
    gate: 0.6,
  },
  bass: { root: 36, steps: [0, null, 0, 12, null, 0, 3, null, 0, null, 10, 12, null, 0, 7, 5], div: 4, gate: 0.7 },
  // Seven bars in sixteenths, then round again (written for 160 bpm).
  lead: melody(4, 112, [
    [4, Gb5, 2], [8, D5, 4], [14, D5, 2],
    [16, E5, 2], [18, Gb5, 2], [22, D5, 6],
    [36, Gb5, 2], [40, D5, 4], [46, D5, 2],
    [48, E5, 2], [50, D5, 2], [53, E5, 0.5], [54, F5, 4], [58, E5, 2], [60, D5, 2], [62, E5, 2],
    [68, Gb5, 2], [72, D5, 4], [78, D5, 2],
    [80, E5, 2], [82, Gb5, 2], [86, D5, 6], [92, B5, 2],
    [96, A5, 8],
  ]),
  pad: { root: 48, steps: [[0, 7, 12, 15, 19], null, null, null, null, null, null, null, [-4, 3, 8, 12, 15], null, null, null, null, null, null, null], div: 1, gate: 7.6 },
  hit: { root: 60, steps: [0, null, null, null, -5, null, null, null], div: 1, gate: 0.5 },
  // Chord sounds: IVM7, III7(b9), VIm7, Vm7 in C (FM7, E7(b9), Am7, Gm7),
  // a bar each, the bass note under close voicings that move by small steps.
  progression: { root: 48, steps: [[-7, 5, 9, 12, 16], null, null, null, [-8, 8, 11, 14, 17], null, null, null, [-3, 7, 12, 16, 19], null, null, null, [-5, 5, 10, 14, 17], null, null, null], div: 1, gate: 3.9 },
  // With the arpeggiator on: the same chords without the bass, a bar each, for it to play.
  chords: { root: 48, steps: [[5, 9, 12, 16], null, null, null, [4, 8, 11, 14], null, null, null, [9, 12, 16, 19], null, null, null, [7, 10, 14, 17], null, null, null], div: 1, gate: 3.9 },
  // With the clip on: the progression's roots (F, E, A, G), held a bar each, from the clip's root.
  clip: { root: 0, steps: [5, null, null, null, 4, null, null, null, -3, null, null, null, -5, null, null, null], div: 1, gate: 3.9 },
};

export class Keyboard {
  readonly app: App;
  octave = 0;
  /** note -> number of things holding it */
  readonly counts = new Map<number, number>();
  readonly latched = new Set<number>();
  hold = false;
  /** pointer id -> note it holds */
  readonly pointers = new Map<number, number>();
  /** key code -> note it holds */
  readonly codes = new Map<string, number>();
  readonly keyEls = new Map<number, HTMLElement>();
  demo: DemoState | null = null;
  sustain = false;
  readonly sustained = new Set<number>();
  /** Something was played since the page opened (the guide checks this). */
  played = false;
  /** The key lit for the note the arpeggiator or the clip is playing. */
  lit: HTMLElement | null = null;
  /** Modes whose tip was shown already (once each). */
  readonly told = new Set<Mode>();
  /** The drawer with the settings of the arpeggiator or the clip is open. */
  drawerOpen = false;
  renderDrawer: () => void = () => {};
  /** The clip editor, while it is open. */
  clipPanel: ClipPanelApi | null = null;
  readonly el: HTMLElement;
  midiBtn!: HTMLButtonElement;
  shiftOctave!: (d: number) => void;
  onKeyDown!: (e: KeyboardEvent) => void;
  onKeyUp!: (e: KeyboardEvent) => void;
  onBlur!: () => void;

  constructor(app: App) {
    this.app = app;
    this.el = this.#build();
    this.#bindComputerKeys();
    app.onFrame((live) => this.#lightPlayed(live.gate ? live.note : -1));
  }

  // --- notes ------------------------------------------------------------------

  noteOn(note: number, velocity = 0.8): void {
    if (note < 0 || note > 127) return;
    this.app.audio.resume();
    const n = (this.counts.get(note) ?? 0) + 1;
    this.counts.set(note, n);
    this.sustained.delete(note);
    this.app.audio.post(['on', note, clamp(velocity, 0.05, 1)]);
    this.keyEls.get(note)?.classList.add('down');
    this.played = true;
    this.app.onPlay?.(note);
  }

  noteOff(note: number): void {
    const n = (this.counts.get(note) ?? 0) - 1;
    if (n > 0) {
      this.counts.set(note, n);
      return;
    }
    this.counts.delete(note);
    if (this.sustain) {
      this.sustained.add(note);
      return;
    }
    this.app.audio.post(['off', note]);
    this.keyEls.get(note)?.classList.remove('down');
  }

  /** Key press from the screen or computer keyboard, honouring Hold. */
  press(note: number, velocity: number): void {
    if (this.hold) {
      if (this.latched.has(note)) {
        this.latched.delete(note);
        this.noteOff(note);
      } else {
        this.latched.add(note);
        this.noteOn(note, velocity);
      }
    } else this.noteOn(note, velocity);
  }

  release(note: number): void {
    if (!this.hold) this.noteOff(note);
  }

  allOff(): void {
    this.counts.clear();
    this.latched.clear();
    this.sustained.clear();
    this.app.audio.post(['allOff']);
    for (const el of this.keyEls.values()) el.classList.remove('down');
  }

  setSustain(on: boolean): void {
    this.sustain = on;
    if (!on) {
      for (const note of this.sustained) {
        this.app.audio.post(['off', note]);
        this.keyEls.get(note)?.classList.remove('down');
      }
      this.sustained.clear();
    }
  }

  // --- on-screen piano ----------------------------------------------------------

  #build(): HTMLElement {
    const app = this.app;
    const { store, i18n } = app;
    const t = i18n.t;
    const piano = h('div', { class: 'piano', role: 'group', 'aria-label': t('kb.piano') });
    const whites: HTMLElement[] = [];
    for (let k = 0; k < KEYS; k++) {
      const note = LOW + k;
      const black = BLACK.includes(note % 12);
      const el = h('div', { class: `key ${black ? 'black' : 'white'}`, dataset: { note: String(note) } }, note % 12 === 0 ? h('span', {}, noteName(note)) : null);
      this.keyEls.set(note, el);
      if (black) whites[whites.length - 1].append(el);
      else {
        whites.push(el);
        piano.append(el);
      }
    }
    const noteAt = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.key');
      if (!el || !piano.contains(el)) return null;
      const r = el.getBoundingClientRect();
      return { note: Number(el.dataset.note) + this.octave * 12, velocity: 0.35 + 0.65 * clamp((e.clientY - r.top) / r.height) };
    };
    piano.addEventListener('pointerdown', (e) => {
      const hit = noteAt(e);
      if (!hit) return;
      e.preventDefault();
      piano.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, hit.note);
      this.press(hit.note, hit.velocity);
    });
    piano.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const hit = noteAt(e);
      const cur = this.pointers.get(e.pointerId);
      if (hit && cur !== undefined && hit.note !== cur) {
        // Sliding across the keys plays them like a glissando.
        this.release(cur);
        this.pointers.set(e.pointerId, hit.note);
        this.press(hit.note, hit.velocity);
      }
    });
    const up = (e: PointerEvent) => {
      const note = this.pointers.get(e.pointerId);
      if (note === undefined) return;
      this.release(note);
      this.pointers.delete(e.pointerId);
    };
    piano.addEventListener('pointerup', up);
    piano.addEventListener('pointercancel', up);

    // --- octave -------------------------------------------------------------------
    const octLabel = h('output', { class: 'kb-octave', 'aria-live': 'polite' }, 'C3');
    const shift = (d: number) => {
      this.allOff();
      this.octave = clamp(this.octave + d, -2, 3);
      octLabel.textContent = noteName(48 + this.octave * 12);
      for (const [note, el] of this.keyEls) {
        const span = el.querySelector(':scope > span');
        if (span) span.textContent = noteName(note + this.octave * 12);
      }
    };
    this.shiftOctave = shift;
    const octave = h(
      'div',
      { class: 'kb-group kb-octaves', role: 'group', 'aria-label': t('kb.octave') },
      h('span', { class: 'ctl-label' }, t('kb.octave')),
      h('button', { type: 'button', class: 'step', 'aria-label': t('kb.octave.down'), title: `${t('kb.octave.down')} ( [ )`, onclick: () => shift(-1) }, '‹'),
      octLabel,
      h('button', { type: 'button', class: 'step', 'aria-label': t('kb.octave.up'), title: `${t('kb.octave.up')} ( ] )`, onclick: () => shift(1) }, '›'),
    );

    // --- hold, MIDI, how the instrument answers -----------------------------------------
    const holdBtn = h(
      'button',
      {
        type: 'button',
        class: 'chip-toggle',
        'aria-pressed': 'false',
        title: t('kb.hold.help'),
        onclick: () => {
          this.hold = !this.hold;
          holdBtn.setAttribute('aria-pressed', String(this.hold));
          if (!this.hold) this.allOff();
        },
      },
      t('btn.hold'),
    );
    this.midiBtn = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': 'false', title: t('kb.midi.help'), onclick: () => this.#connectMidi() }, t('kb.midi'));
    const settings: HTMLButtonElement = h(
      'button',
      {
        type: 'button',
        class: 'chip-toggle',
        onclick: () => {
          const [content, scope] = app.inScope(() =>
            h(
              'div',
              { class: 'menu play-settings' },
              h('div', { class: 'menu-title' }, t('kb.settings')),
              Switch(app, 'master.mono'),
              Switch(app, 'master.legato'),
              Slider(app, 'master.porta'),
              Switch(app, 'master.portaAlways'),
              Slider(app, 'master.voices'),
              Slider(app, 'master.bendRange'),
            ),
          );
          app.popover(settings, content, { onClose: () => scope.dispose() });
        },
      },
      t('kb.settings'),
    );

    // --- how the keys play: as they are, broken into an arpeggio, or the clip ----------
    const modeBtns = MODES.map((m) =>
      h('button', { type: 'button', 'aria-pressed': 'false', title: t(`kb.mode.${m}.help`), onclick: () => this.setMode(m) }, t(`kb.mode.${m}`)),
    );
    const modeGroup = h('div', { class: 'segmented kb-mode', role: 'group', 'aria-label': t('kb.mode') }, modeBtns);
    const drawerBtn = h('button', { type: 'button', class: 'chip-toggle kb-drawer-btn', 'aria-expanded': 'false', onclick: () => this.openDrawer(!this.drawerOpen) });
    const drawer = h('div', { class: 'kb-drawer', id: 'kb-drawer', hidden: true });
    drawerBtn.setAttribute('aria-controls', 'kb-drawer');
    let drawerScope: Scope | null = null;
    let shown: Mode | null = null;
    this.renderDrawer = () => {
      const mode = this.mode();
      modeBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(MODES[k] === mode)));
      const open = this.drawerOpen && mode !== 'keys';
      drawerBtn.hidden = mode === 'keys';
      drawerBtn.setAttribute('aria-expanded', String(open));
      const what = mode === 'clip' ? 'clip' : 'arp';
      drawerBtn.replaceChildren(
        h('span', { class: 'long' }, t(`kb.drawer.${what}`)),
        h('span', { class: 'short' }, t(`kb.drawer.${what}.short`)),
        ` ${open ? '▴' : '▾'}`,
      );
      drawerBtn.setAttribute('aria-label', t(`kb.drawer.${what}`));
      drawer.hidden = !open;
      const want = open ? mode : null;
      if (want === shown) return;
      drawerScope?.dispose();
      drawerScope = null;
      this.clipPanel = null;
      shown = want;
      if (!want) {
        drawer.replaceChildren();
        return;
      }
      const [content, scope] = app.inScope(() => {
        if (want === 'arp') return this.#arpSettings();
        this.clipPanel = ClipPanel(app);
        return this.clipPanel.el;
      });
      drawerScope = scope;
      drawer.replaceChildren(content);
    };
    app.watch(store.idx('arp.on'), () => this.renderDrawer());
    app.watch(store.idx('clip.on'), () => this.renderDrawer());
    app.onDispose(() => drawerScope?.dispose());
    this.renderDrawer();

    // --- wheels: pitch bend (springs back) and modulation -------------------------------
    const wheel = (label: string, min: number, value: number, send: (v: number) => void, spring: boolean) => {
      const input = h('input', { type: 'range', class: 'wheel', min, max: 100, value, 'aria-label': label, 'aria-orientation': 'vertical', oninput: () => send(Number(input.value)) });
      if (spring) {
        const back = () => {
          input.value = '0';
          send(0);
        };
        input.addEventListener('pointerup', back);
        input.addEventListener('pointercancel', back);
        input.addEventListener('keyup', back);
      }
      return h('label', { class: 'wheel-wrap', title: label }, input, h('span', {}, label));
    };
    const wheels = h(
      'div',
      { class: 'wheels' },
      wheel(t('kb.wheel.bend'), -100, 0, (v) => app.audio.post(['bend', v / 100]), true),
      wheel(t('kb.wheel.mod'), 0, modWheel, (v) => {
        modWheel = v;
        app.audio.post(['wheel', v / 100]);
      }, false),
    );

    return h(
      'div',
      { class: 'keyboard' },
      h(
        'div',
        { class: 'kb-bar' },
        h('div', { class: 'kb-group' }, h('span', { class: 'ctl-label' }, t('kb.mode')), modeGroup, drawerBtn),
        h('div', { class: 'kb-group' }, holdBtn, octave),
        h('div', { class: 'kb-group kb-end' }, this.midiBtn, settings),
      ),
      drawer,
      h('div', { class: 'kb-play' }, wheels, piano),
    );
  }

  // --- how the keys play -----------------------------------------------------------

  mode(): Mode {
    const { store } = this.app;
    return store.plain('clip.on') >= 0.5 ? 'clip' : store.plain('arp.on') >= 0.5 ? 'arp' : 'keys';
  }

  /** Plays the keys as they are, through the arpeggiator, or as the clip.
   * Choosing the arpeggiator or the clip opens its settings. */
  setMode(mode: Mode): void {
    const { store, i18n } = this.app;
    if (mode === this.mode()) {
      if (mode !== 'keys') this.openDrawer(true);
      return;
    }
    store.set(store.idx('arp.on'), mode === 'arp' ? 1 : 0);
    store.set(store.idx('clip.on'), mode === 'clip' ? 1 : 0);
    store.commit();
    if (mode !== 'keys') {
      this.openDrawer(true);
      if (!this.told.has(mode)) {
        this.told.add(mode);
        this.app.toast(i18n.t(`kb.${mode}.tip`), 6000);
      }
    }
  }

  openDrawer(open: boolean): void {
    this.drawerOpen = open;
    this.renderDrawer();
  }

  /** The arpeggiator's settings, laid out in the drawer. */
  #arpSettings(): HTMLElement {
    const app = this.app;
    return h(
      'div',
      { class: 'arp-settings' },
      Segmented(app, 'arp.mode', { class: 'wrap' }),
      h('div', { class: 'arp-col' }, Select(app, 'arp.div', { arrows: true }), Stepper(app, 'arp.octaves')),
      h('div', { class: 'arp-col' }, Slider(app, 'arp.gate'), Slider(app, 'arp.swing')),
      h('div', { class: 'arp-col' }, Slider(app, 'master.bpm'), h('p', { class: 'editor-note' }, app.i18n.t('kb.arp.hold'))),
    );
  }

  /** Lights the key of the note the arpeggiator or the clip is playing (-1: none). */
  #lightPlayed(note: number): void {
    const el = this.mode() !== 'keys' && note >= 0 ? (this.keyEls.get(note - this.octave * 12) ?? null) : null;
    if (el === this.lit) return;
    this.lit?.classList.remove('arp');
    el?.classList.add('arp');
    this.lit = el;
  }

  #bindComputerKeys() {
    this.onKeyDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      if (target instanceof HTMLInputElement && target.type !== 'range') return;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      // Dialogs take the keys, except those that ask for notes (the wavetable editor).
      if (document.querySelector('dialog[open]:not(.keys-through)')) return;
      if (e.code === 'BracketLeft') return this.shiftOctave(-1);
      if (e.code === 'BracketRight') return this.shiftOctave(1);
      const offset = KEYMAP[e.code];
      if (offset === undefined || this.codes.has(e.code)) return;
      e.preventDefault();
      const note = 48 + this.octave * 12 + offset;
      this.codes.set(e.code, note);
      this.press(note, 0.8);
    };
    this.onKeyUp = (e) => {
      const note = this.codes.get(e.code);
      if (note === undefined) return;
      this.codes.delete(e.code);
      this.release(note);
    };
    this.onBlur = () => {
      // Keys released while the window is in the background never arrive.
      for (const note of this.codes.values()) this.release(note);
      this.codes.clear();
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.stopDemo();
    this.allOff();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  // --- MIDI -----------------------------------------------------------------------

  async #connectMidi() {
    const { i18n } = this.app;
    if (!navigator.requestMIDIAccess) {
      this.app.toast(i18n.t('kb.midi.denied'));
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess();
      const attach = () => {
        let count = 0;
        for (const input of access.inputs.values()) {
          input.onmidimessage = (e) => {
            if (e.data) this.#midi(e.data);
          };
          count++;
        }
        this.midiBtn.setAttribute('aria-pressed', String(count > 0));
        return count;
      };
      access.onstatechange = attach;
      this.app.toast(attach() ? i18n.t('kb.midi.on') : i18n.t('kb.midi.none'));
    } catch {
      this.app.toast(i18n.t('kb.midi.denied'));
    }
  }

  #midi([status, d1 = 0, d2 = 0]: Uint8Array): void {
    const kind = status & 0xf0;
    const { audio } = this.app;
    if (kind === 0x90 && d2 > 0) this.noteOn(d1, d2 / 127);
    else if (kind === 0x80 || kind === 0x90) this.noteOff(d1);
    else if (kind === 0xe0) audio.post(['bend', (((d2 << 7) | d1) - 8192) / 8192]);
    else if (kind === 0xd0) audio.post(['touch', d1 / 127]);
    else if (kind === 0xb0 && d1 === 1) audio.post(['wheel', d2 / 127]);
    else if (kind === 0xb0 && d1 === 64) this.setSustain(d2 >= 64);
    else if (kind === 0xb0 && (d1 === 120 || d1 === 123)) this.allOff();
  }

  // --- demo player ------------------------------------------------------------------

  toggleDemo(): void {
    if (this.demo) this.stopDemo();
    else this.startDemo();
  }

  startDemo(): void {
    this.stopDemo();
    this.app.audio.resume();
    const state: DemoState = { step: 0, next: performance.now() + 60, timers: new Set(), sounding: [] };
    this.demo = state;
    this.app.onDemo?.(true);
    const tick = () => {
      if (this.demo !== state) return;
      // The arpeggiator gets chords to play; the clip the roots, from its own root note.
      const mode = this.mode();
      const phrase =
        mode === 'clip'
          ? { ...PHRASES.clip, root: Math.round(this.app.store.plain('clip.root')) }
          : (PHRASES[mode === 'arp' ? 'chords' : (this.app.demoPhrase?.() ?? 'arp')] ?? PHRASES.arp);
      const bpm = this.app.store.plain('master.bpm');
      const stepMs = 60000 / bpm / phrase.div;
      const entry = phrase.steps[state.step % phrase.steps.length];
      if (entry !== null) {
        const notes = (Array.isArray(entry) ? entry : [entry]).map((o) => phrase.root + o);
        for (const n of notes) this.noteOn(n, 0.8);
        const held = phrase.hold?.[state.step % phrase.steps.length] ?? phrase.gate;
        const t = setTimeout(() => {
          state.timers.delete(t);
          for (const n of notes) this.noteOff(n);
        }, stepMs * held);
        state.timers.add(t);
        state.sounding = notes;
      }
      state.step++;
      state.next += stepMs;
      state.timer = setTimeout(tick, Math.max(0, state.next - performance.now()));
    };
    state.timer = setTimeout(tick, 60);
  }

  stopDemo(): void {
    if (!this.demo) return;
    clearTimeout(this.demo.timer);
    for (const t of this.demo.timers) clearTimeout(t);
    this.demo = null;
    this.app.onDemo?.(false);
    this.allOff();
  }
}
