// Playing notes: on-screen piano, computer keyboard, MIDI, and a small
// phrase player so you can listen while both hands are on the knobs.

import { h, clamp } from './dom.ts';
import { noteName } from '../format.ts';
import { Slider, Switch } from './controls.ts';
import type { App } from '../app.ts';

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
 * rests), steps per beat, and how long each note is held (in steps). */
interface Phrase {
  root: number;
  steps: (number | number[] | null)[];
  div: number;
  gate: number;
}

interface DemoState {
  step: number;
  next: number;
  timer?: ReturnType<typeof setTimeout>;
  timers: Set<ReturnType<typeof setTimeout>>;
  sounding: number[];
}

const PHRASES: Record<string, Phrase> = {
  arp: { root: 48, steps: [0, 12, 7, 12, 3, 12, 7, 10, 0, 12, 8, 12, 3, 12, 8, 10], div: 2, gate: 0.6 },
  bass: { root: 36, steps: [0, null, 0, 12, null, 0, 3, null, 0, null, 10, 12, null, 0, 7, 5], div: 4, gate: 0.7 },
  lead: { root: 60, steps: [0, null, 3, 7, null, 10, 12, null, 10, 7, null, 3, 5, null, 7, null], div: 2, gate: 0.85 },
  pad: { root: 48, steps: [[0, 7, 12, 15, 19], null, null, null, null, null, null, null, [-4, 3, 8, 12, 15], null, null, null, null, null, null, null], div: 1, gate: 7.6 },
  hit: { root: 60, steps: [0, null, null, null, -5, null, null, null], div: 1, gate: 0.5 },
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
    const { i18n } = this.app;
    const piano = h('div', { class: 'piano', role: 'group', 'aria-label': 'Keyboard' });
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

    const octLabel = h('output', { class: 'kb-octave' }, 'C3');
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

    const holdBtn = h(
      'button',
      {
        type: 'button',
        class: 'chip-toggle',
        'aria-pressed': 'false',
        title: i18n.t('kb.hold.help'),
        onclick: () => {
          this.hold = !this.hold;
          holdBtn.setAttribute('aria-pressed', String(this.hold));
          if (!this.hold) this.allOff();
        },
      },
      i18n.t('btn.hold'),
    );
    this.midiBtn = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': 'false', onclick: () => this.#connectMidi() }, i18n.t('kb.midi'));
    const bend = h('input', {
      type: 'range',
      class: 'bend',
      min: -100,
      max: 100,
      value: 0,
      'aria-label': i18n.sourceName('pitchBend'),
      oninput: () => this.app.audio.post(['bend', Number(bend.value) / 100]),
    });
    const spring = () => {
      bend.value = '0';
      this.app.audio.post(['bend', 0]);
    };
    bend.addEventListener('pointerup', spring);
    bend.addEventListener('keyup', spring);

    // How the instrument answers the keys: these belong with the keyboard.
    const settings = h(
      'button',
      {
        type: 'button',
        class: 'chip-toggle',
        'aria-haspopup': 'true',
        onclick: () => {
          const app = this.app;
          const [content, scope] = app.inScope(() =>
            h(
              'div',
              { class: 'menu play-settings' },
              h('div', { class: 'menu-title' }, i18n.t('kb.settings')),
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
      i18n.t('kb.settings'),
    );

    return h(
      'div',
      { class: 'keyboard' },
      h(
        'div',
        { class: 'kb-side' },
        h(
          'div',
          { class: 'kb-row' },
          h('span', { class: 'ctl-label' }, i18n.t('kb.octave')),
          h('button', { type: 'button', class: 'step', 'aria-label': i18n.t('kb.octave.down'), onclick: () => shift(-1) }, '‹'),
          octLabel,
          h('button', { type: 'button', class: 'step', 'aria-label': i18n.t('kb.octave.up'), onclick: () => shift(1) }, '›'),
        ),
        h('div', { class: 'kb-row' }, holdBtn, this.midiBtn, settings),
        h('label', { class: 'kb-row' }, h('span', { class: 'ctl-label' }, i18n.sourceName('pitchBend')), bend),
      ),
      piano,
    );
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
      const phrase = PHRASES[this.app.demoPhrase?.() ?? 'arp'] ?? PHRASES.arp;
      const bpm = this.app.store.plain('master.bpm');
      const stepMs = 60000 / bpm / phrase.div;
      const entry = phrase.steps[state.step % phrase.steps.length];
      if (entry !== null) {
        const notes = (Array.isArray(entry) ? entry : [entry]).map((o) => phrase.root + o);
        for (const n of notes) this.noteOn(n, 0.8);
        const t = setTimeout(() => {
          state.timers.delete(t);
          for (const n of notes) this.noteOff(n);
        }, stepMs * phrase.gate);
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
