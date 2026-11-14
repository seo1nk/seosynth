// A piano roll: notes on a grid of time (across) and pitch (down), edited
// with a mouse, a finger or the keyboard.
//
// The component shows a clip and reports every change as operations
// (model.ts); the program around it owns the clip and decides what happens
// with them (play them, store them, send them to other people). It only
// uses the DOM and a canvas, takes its colours from CSS custom properties
// (`--pr-*`, see `COLORS`) and its words from the options, so it can be
// dropped into another app as it is.
//
//   const roll = new PianoRoll(clip, { onChange: (ops, done) => ... });
//   host.append(roll.el);
//   roll.setClip(next);     // when the clip changed elsewhere
//   roll.setPlayhead(tick); // while it plays (null when stopped)
//
// Gestures:
//   empty cell: press to add a note, drag right to make it longer
//   note: drag to move (selected notes move together), drag its right end
//     to change the length, double-click or right-click to remove it
//   Shift + drag on empty cells: select a range; Shift + click: add to the
//     selection
//   the marker at the end of the ruler: drag to make the clip longer/shorter
//   keys: Delete removes, arrows move (Shift: an octave), Ctrl/Cmd+A selects
//     all, Ctrl/Cmd+D duplicates, Escape clears the selection
// On touch screens the grid takes the finger for editing; the keys on the
// left and the ruler scroll the view.

import { applyOps, clampNote, diffClips, duplicateNotes, idMaker, snap, snapDown } from './model.ts';
import type { Clip, Note, Op } from './model.ts';

export interface PianoRollOptions {
  /** Lowest and highest pitch shown. */
  lowest?: number;
  highest?: number;
  /** Height of one pitch row, in CSS pixels. */
  rowHeight?: number;
  /** Narrowest a quarter note may be drawn; longer clips scroll sideways. */
  minBeatWidth?: number;
  /** Ticks between grid lines (where notes snap to). Default: a 16th. */
  grid?: number;
  beatsPerBar?: number;
  /** Shortest and longest the clip can be made with the end marker, in ticks. */
  minLength?: number;
  maxLength?: number;
  /** Name of a pitch for the keys on the left (default: C4 = 60). */
  noteName?: (pitch: number) => string;
  /** Accessible name of the editing area. */
  label?: string;
  /** Prefix for the ids of new notes (one per editing client). */
  site?: string;
  /**
   * Called with the operations of every change. While a drag goes on it is
   * called on each step with `done` false, then once with `done` true (and
   * possibly no operations) when the gesture ends: a good moment to record
   * an undo step or send the change on.
   */
  onChange?: (ops: Op[], done: boolean) => void;
  onSelect?: (ids: ReadonlySet<string>) => void;
  /** A note should be heard (placing it, moving it to another pitch). */
  onAudition?: (pitch: number, velocity: number) => void;
  onAuditionEnd?: (pitch: number) => void;
}

/** Custom properties read for colours, with what is used without them. */
export const COLORS = {
  bg: ['--pr-bg', '#ffffff'],
  rowAlt: ['--pr-row-alt', '#f2f4f5'],
  line: ['--pr-line', '#e6e9eb'],
  beatLine: ['--pr-beat-line', '#cdd4d9'],
  barLine: ['--pr-bar-line', '#7d8a94'],
  outside: ['--pr-outside', 'rgba(0, 0, 0, 0.06)'],
  note: ['--pr-note', '#1f9d6b'],
  noteEdge: ['--pr-note-edge', '#0f5c3e'],
  noteSelected: ['--pr-note-selected', '#0b3d2c'],
  noteText: ['--pr-note-text', '#ffffff'],
  band: ['--pr-band', 'rgba(31, 157, 107, 0.16)'],
  text: ['--pr-text', '#5b6975'],
  keyWhite: ['--pr-key-white', '#ffffff'],
  keyBlack: ['--pr-key-black', '#26333d'],
  keyText: ['--pr-key-text', '#5b6975'],
  playhead: ['--pr-playhead', '#e0632a'],
} as const;
type Colors = Record<keyof typeof COLORS, string>;

const GUTTER = 46;
const RULER = 24;
const BLACK = [1, 3, 6, 8, 10];
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const defaultName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

type Gesture =
  | { kind: 'create'; base: Clip; id: string; start: number }
  | { kind: 'move'; base: Clip; ids: Set<string>; tick: number; pitch: number; grabbed: Note; sounding: number }
  | { kind: 'resize'; base: Clip; ids: Set<string>; tick: number }
  | { kind: 'band'; base: Clip; x0: number; y0: number; x1: number; y1: number; keep: Set<string> }
  | { kind: 'length'; base: Clip; span: number };

function canvas(cls: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = cls;
  c.style.display = 'block';
  return c;
}

export class PianoRoll {
  readonly el: HTMLDivElement;
  clip: Clip;
  readonly selection = new Set<string>();
  grid: number;
  /** Length and velocity given to the next note drawn (follows the last one). */
  nextLength: number;
  nextVelocity = 100;

  readonly #o: Required<Omit<PianoRollOptions, 'onChange' | 'onSelect' | 'onAudition' | 'onAuditionEnd' | 'site' | 'grid'>> & PianoRollOptions;
  readonly #newId: () => string;
  readonly #scroll: HTMLDivElement;
  readonly #sheet: HTMLDivElement;
  readonly #ruler: HTMLCanvasElement;
  readonly #keys: HTMLCanvasElement;
  readonly #grid: HTMLCanvasElement;
  readonly #corner: HTMLDivElement;
  readonly #playhead: HTMLDivElement;
  readonly #ro: ResizeObserver;
  #gesture: Gesture | null = null;
  /** A clip handed in during a drag, applied when the drag ends. */
  #pending: Clip | null = null;
  #frame = 0;
  /** A `reveal` asked for before the sheet had its size. */
  #revealing: number | null = null;
  #width = 0;
  #tickPx = 1;

  constructor(clip: Clip, options: PianoRollOptions = {}) {
    this.clip = clip;
    this.#o = {
      lowest: 24,
      highest: 108,
      rowHeight: 14,
      minBeatWidth: 36,
      beatsPerBar: 4,
      minLength: clip.ppq,
      maxLength: clip.ppq * 32,
      noteName: defaultName,
      label: 'Piano roll',
      ...options,
    };
    this.grid = options.grid ?? clip.ppq / 4;
    this.nextLength = this.grid;
    const make = idMaker(options.site);
    // Never an id the clip already has (ids from elsewhere may share the site).
    this.#newId = () => {
      let id = make();
      while (this.clip.notes.some((n) => n.id === id)) id = make();
      return id;
    };

    this.el = document.createElement('div');
    this.el.className = 'pianoroll';
    Object.assign(this.el.style, { position: 'relative', overflow: 'hidden', minHeight: '120px' });
    this.#scroll = document.createElement('div');
    this.#scroll.className = 'pr-scroll';
    this.#scroll.tabIndex = 0;
    this.#scroll.setAttribute('role', 'application');
    this.#scroll.setAttribute('aria-label', this.#o.label);
    Object.assign(this.#scroll.style, { position: 'absolute', inset: '0', overflow: 'auto', outlineOffset: '-2px' });
    this.#sheet = document.createElement('div');
    this.#sheet.className = 'pr-sheet';
    this.#sheet.style.display = 'grid';
    this.#corner = document.createElement('div');
    this.#ruler = canvas('pr-ruler');
    this.#keys = canvas('pr-keys');
    this.#grid = canvas('pr-grid');
    const sticky = (el: HTMLElement, top: boolean, left: boolean, z: number) =>
      Object.assign(el.style, { position: 'sticky', top: top ? '0' : '', left: left ? '0' : '', zIndex: String(z) });
    sticky(this.#corner, true, true, 3);
    sticky(this.#ruler, true, false, 2);
    sticky(this.#keys, false, true, 2);
    this.#ruler.style.touchAction = 'pan-x';
    this.#keys.style.touchAction = 'pan-y';
    this.#grid.style.touchAction = 'none';
    const area = document.createElement('div');
    area.style.position = 'relative';
    this.#playhead = document.createElement('div');
    this.#playhead.className = 'pr-playhead';
    Object.assign(this.#playhead.style, { position: 'absolute', top: '0', bottom: '0', width: '2px', marginLeft: '-1px', pointerEvents: 'none', display: 'none' });
    area.append(this.#grid, this.#playhead);
    this.#sheet.append(this.#corner, this.#ruler, this.#keys, area);
    this.#scroll.append(this.#sheet);
    this.el.append(this.#scroll);

    this.#bindGrid();
    this.#bindRuler();
    this.#bindKeys();
    this.#ro = new ResizeObserver(() => this.#layout());
    this.#ro.observe(this.el);
  }

  // --- what the program around it calls ------------------------------------------------

  /** Shows another version of the clip (edited elsewhere, undo, ...). */
  setClip(clip: Clip): void {
    if (this.#gesture) {
      this.#pending = clip;
      return;
    }
    this.clip = clip;
    const ids = new Set(clip.notes.map((n) => n.id));
    let changed = false;
    for (const id of [...this.selection]) {
      if (!ids.has(id)) {
        this.selection.delete(id);
        changed = true;
      }
    }
    if (changed) this.#o.onSelect?.(this.selection);
    this.#layout();
  }

  /** Ticks between grid lines. */
  setGrid(ticks: number): void {
    this.grid = Math.max(1, Math.round(ticks));
    this.nextLength = Math.max(this.grid, snap(this.nextLength, this.grid));
    this.#draw();
  }

  /** Where playback is, in ticks, or null to hide the line. */
  setPlayhead(tick: number | null): void {
    const ph = this.#playhead;
    if (tick === null || !(tick >= 0)) {
      ph.style.display = 'none';
      return;
    }
    ph.style.display = 'block';
    ph.style.left = `${tick * this.#tickPx}px`;
    ph.style.background = this.#colors().playhead;
  }

  /**
   * Applies operations made outside the editor (a velocity slider, a
   * "clear" button) and reports them like an edit of its own. Pass `done`
   * false for the steps of a continuous change, then call `apply([], true)`
   * once it is over.
   */
  apply(ops: Op[], done = true): void {
    if (!ops.length && !done) return;
    if (ops.length) this.clip = applyOps(this.clip, ops);
    this.#o.onChange?.(ops, done);
    this.setClip(this.clip);
  }

  select(ids: Iterable<string>): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.#o.onSelect?.(this.selection);
    this.#draw();
  }

  selectedNotes(): Note[] {
    return this.clip.notes.filter((n) => this.selection.has(n.id));
  }

  deleteSelection(): void {
    this.apply(this.selectedNotes().map((note) => ({ kind: 'delete', note })));
    this.select([]);
  }

  /** Scrolls so that `pitch` (or the middle of the notes) is in view. */
  reveal(pitch?: number): void {
    const notes = this.clip.notes;
    const p = pitch ?? (notes.length ? notes.reduce((s, n) => s + n.pitch, 0) / notes.length : 60);
    // Before it is laid out there is nothing to scroll: do it right after.
    if (!this.#width || !this.#scroll.clientHeight) {
      this.#revealing = p;
      return;
    }
    const y = (this.#o.highest - p + 0.5) * this.#o.rowHeight + RULER;
    this.#scroll.scrollTop = Math.max(0, y - this.#scroll.clientHeight / 2);
  }

  focus(): void {
    this.#scroll.focus({ preventScroll: true });
  }

  dispose(): void {
    this.#ro.disconnect();
    cancelAnimationFrame(this.#frame);
    this.el.remove();
  }

  // --- geometry ------------------------------------------------------------------------------

  #colors(): Colors {
    const style = getComputedStyle(this.el);
    const out = {} as Colors;
    for (const [k, [prop, fallback]] of Object.entries(COLORS) as [keyof Colors, readonly [string, string]][]) {
      out[k] = style.getPropertyValue(prop).trim() || fallback;
    }
    return out;
  }

  /** Ticks shown: the clip and room to make it a bar longer. */
  #span(): number {
    // While the end marker is dragged the view keeps its scale.
    if (this.#gesture?.kind === 'length') return this.#gesture.span;
    const bar = this.clip.ppq * this.#o.beatsPerBar;
    return Math.min(this.#o.maxLength, Math.ceil(this.clip.length / bar) * bar + bar);
  }

  #layout(): void {
    const avail = Math.max(0, this.el.clientWidth - GUTTER);
    const beats = this.#span() / this.clip.ppq;
    this.#width = Math.max(avail, beats * this.#o.minBeatWidth);
    this.#tickPx = this.#width / this.#span();
    const rows = this.#o.highest - this.#o.lowest + 1;
    this.#sheet.style.gridTemplateColumns = `${GUTTER}px ${this.#width}px`;
    this.#sheet.style.gridTemplateRows = `${RULER}px ${rows * this.#o.rowHeight}px`;
    if (this.#revealing !== null && this.#width && this.#scroll.clientHeight) {
      const p = this.#revealing;
      this.#revealing = null;
      this.reveal(p);
    }
    this.#draw();
  }

  #size(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /** Grid coordinates of a pointer: tick (unsnapped) and pitch. */
  #at(e: { clientX: number; clientY: number }): { tick: number; pitch: number; x: number; y: number } {
    const r = this.#grid.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pitch = Math.min(this.#o.highest, Math.max(this.#o.lowest, this.#o.highest - Math.floor(y / this.#o.rowHeight)));
    return { tick: Math.max(0, x / this.#tickPx), pitch, x, y };
  }

  #noteBox(n: Note): { x: number; y: number; w: number; h: number } {
    const rh = this.#o.rowHeight;
    return { x: n.start * this.#tickPx, y: (this.#o.highest - n.pitch) * rh + 1, w: Math.max(4, n.length * this.#tickPx - 1), h: rh - 2 };
  }

  /** The note under a point (the one drawn on top), and whether the point
   * is on its right end (where it is resized). */
  #hit(x: number, y: number): { note: Note; edge: boolean } | null {
    for (let k = this.clip.notes.length - 1; k >= 0; k--) {
      const n = this.clip.notes[k];
      const b = this.#noteBox(n);
      if (x >= b.x && x <= b.x + b.w && y >= b.y - 1 && y <= b.y + b.h + 1) {
        const grip = Math.min(10, Math.max(4, b.w / 3));
        return { note: n, edge: x >= b.x + b.w - grip };
      }
    }
    return null;
  }

  // --- drawing -----------------------------------------------------------------------------------

  #draw(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#paint();
    });
  }

  #paint(): void {
    const c = this.#colors();
    const o = this.#o;
    const { ppq, length } = this.clip;
    const w = this.#width;
    const rows = o.highest - o.lowest + 1;
    const h = rows * o.rowHeight;
    const px = this.#tickPx;
    const bar = ppq * o.beatsPerBar;
    const span = this.#span();
    this.#corner.style.background = c.bg;

    // Grid.
    const g = this.#size(this.#grid, w, h);
    g.fillStyle = c.bg;
    g.fillRect(0, 0, w, h);
    for (let p = o.highest; p >= o.lowest; p--) {
      const y = (o.highest - p) * o.rowHeight;
      if (BLACK.includes(p % 12)) {
        g.fillStyle = c.rowAlt;
        g.fillRect(0, y, w, o.rowHeight);
      }
      // A line under every B (the bottom of an octave is C).
      g.fillStyle = p % 12 === 0 ? c.beatLine : c.line;
      g.fillRect(0, y + o.rowHeight - 1, w, p % 12 === 0 ? 1 : 0.5);
    }
    const line = (t: number, color: string, width: number) => {
      g.fillStyle = color;
      g.fillRect(Math.round(t * px) - width / 2, 0, width, h);
    };
    if (this.grid * px >= 5) for (let t = 0; t <= span; t += this.grid) line(t, c.line, 1);
    for (let t = 0; t <= span; t += ppq) line(t, c.beatLine, 1);
    for (let t = 0; t <= span; t += bar) line(t, c.barLine, 1);
    g.fillStyle = c.outside;
    g.fillRect(length * px, 0, w - length * px, h);
    line(length, c.barLine, 2);

    // Notes.
    g.font = `600 ${Math.max(8, o.rowHeight - 5)}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (const n of this.clip.notes) {
      const b = this.#noteBox(n);
      const on = this.selection.has(n.id);
      g.globalAlpha = on ? 1 : 0.45 + 0.55 * (n.velocity / 127);
      g.fillStyle = on ? c.noteSelected : c.note;
      g.fillRect(b.x, b.y, b.w, b.h);
      g.globalAlpha = 1;
      g.strokeStyle = c.noteEdge;
      g.lineWidth = 1;
      g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      if (n.start >= length) {
        g.fillStyle = c.outside;
        g.fillRect(b.x, b.y, b.w, b.h);
      }
      if (b.w > 30 && o.rowHeight >= 12) {
        g.fillStyle = c.noteText;
        g.fillText(o.noteName(n.pitch), b.x + 4, b.y + b.h / 2 + 0.5, b.w - 6);
      }
    }
    const gs = this.#gesture;
    if (gs?.kind === 'band') {
      g.fillStyle = c.band;
      g.fillRect(Math.min(gs.x0, gs.x1), Math.min(gs.y0, gs.y1), Math.abs(gs.x1 - gs.x0), Math.abs(gs.y1 - gs.y0));
    }

    // Ruler: bar numbers, beats, and the end marker.
    const r = this.#size(this.#ruler, w, RULER);
    r.fillStyle = c.bg;
    r.fillRect(0, 0, w, RULER);
    r.fillStyle = c.outside;
    r.fillRect(length * px, 0, w - length * px, RULER);
    r.font = '600 11px system-ui, sans-serif';
    r.textBaseline = 'middle';
    for (let t = 0; t <= span; t += ppq) {
      const x = Math.round(t * px);
      const isBar = t % bar === 0;
      r.fillStyle = isBar ? c.barLine : c.beatLine;
      r.fillRect(x, isBar ? 4 : RULER - 7, 1, isBar ? RULER - 4 : 7);
      if (isBar && t < span) {
        r.fillStyle = c.text;
        r.fillText(String(t / bar + 1), x + 4, RULER / 2 - 1);
      }
    }
    r.fillStyle = c.barLine;
    r.fillRect(0, RULER - 1, w, 1);
    // The end marker: a tab to drag.
    const ex = length * px;
    r.fillStyle = c.noteSelected;
    r.beginPath();
    r.moveTo(ex, RULER);
    r.lineTo(ex, 3);
    r.lineTo(ex - 9, 3);
    r.lineTo(ex - 9, RULER - 9);
    r.closePath();
    r.fill();

    // Keys.
    const k = this.#size(this.#keys, GUTTER, h);
    k.fillStyle = c.keyWhite;
    k.fillRect(0, 0, GUTTER, h);
    k.font = `600 ${Math.min(10, o.rowHeight - 3)}px system-ui, sans-serif`;
    k.textBaseline = 'middle';
    for (let p = o.highest; p >= o.lowest; p--) {
      const y = (o.highest - p) * o.rowHeight;
      if (BLACK.includes(p % 12)) {
        k.fillStyle = c.keyBlack;
        k.fillRect(0, y, GUTTER * 0.62, o.rowHeight);
      } else {
        k.fillStyle = c.line;
        k.fillRect(0, y + o.rowHeight - 0.5, GUTTER, 0.5);
      }
      if (p % 12 === 0) {
        k.fillStyle = c.keyText;
        k.fillText(o.noteName(p), GUTTER * 0.64 - 18 > 0 ? 3 : 2, y + o.rowHeight / 2);
        k.fillStyle = c.beatLine;
        k.fillRect(0, y + o.rowHeight - 1, GUTTER, 1);
      }
    }
    k.fillStyle = c.barLine;
    k.fillRect(GUTTER - 1, 0, 1, h);
  }

  // --- editing ------------------------------------------------------------------------------------

  /** Shows `draft` and reports how it differs from what was shown. */
  #update(draft: Clip): void {
    const ops = diffClips(this.clip, draft);
    this.clip = draft;
    if (ops.length) this.#o.onChange?.(ops, false);
    this.#draw();
  }

  #end(): void {
    const gs = this.#gesture;
    if (!gs) return;
    if (gs.kind === 'create') {
      const n = this.clip.notes.find((x) => x.id === gs.id);
      if (n) this.nextLength = n.length;
      if (n) this.#o.onAuditionEnd?.(n.pitch);
    }
    if (gs.kind === 'move') this.#o.onAuditionEnd?.(gs.sounding);
    this.#gesture = null;
    // The clip may have a new length: room for one more bar after it.
    if (gs.kind === 'length') this.#layout();
    this.#o.onChange?.([], true);
    if (this.#pending) {
      const next = this.#pending;
      this.#pending = null;
      this.setClip(next);
    }
    this.#draw();
  }

  /** Moves the notes `ids` of `base` by whole grid steps and semitones,
   * keeping all of them inside the clip and the pitch range. */
  #moved(base: Clip, ids: Set<string>, ticks: number, semis: number): Clip {
    const picked = base.notes.filter((n) => ids.has(n.id));
    if (!picked.length) return base;
    const o = this.#o;
    const lo = Math.min(...picked.map((n) => n.start));
    const hi = Math.max(...picked.map((n) => n.start));
    const dt = Math.min(Math.max(ticks, -lo), base.length - 1 - hi);
    const pLo = Math.min(...picked.map((n) => n.pitch));
    const pHi = Math.max(...picked.map((n) => n.pitch));
    const dp = Math.min(Math.max(semis, o.lowest - pLo), o.highest - pHi);
    return { ...base, notes: base.notes.map((n) => (ids.has(n.id) ? clampNote({ ...n, start: n.start + dt, pitch: n.pitch + dp }) : n)) };
  }

  #bindGrid(): void {
    const el = this.#grid;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.focus();
      const { tick, pitch, x, y } = this.#at(e);
      const hit = this.#hit(x, y);
      const base = this.clip;
      if (hit && e.shiftKey) {
        if (this.selection.has(hit.note.id)) this.selection.delete(hit.note.id);
        else this.selection.add(hit.note.id);
        this.#o.onSelect?.(this.selection);
        this.#draw();
        return;
      }
      el.setPointerCapture(e.pointerId);
      if (hit) {
        if (!this.selection.has(hit.note.id)) this.select([hit.note.id]);
        this.nextLength = hit.note.length;
        this.nextVelocity = hit.note.velocity;
        const ids = new Set(this.selection);
        if (hit.edge) this.#gesture = { kind: 'resize', base, ids, tick };
        else {
          this.#gesture = { kind: 'move', base, ids, tick, pitch, grabbed: hit.note, sounding: hit.note.pitch };
          this.#o.onAudition?.(hit.note.pitch, hit.note.velocity);
        }
        return;
      }
      if (e.shiftKey) {
        this.#gesture = { kind: 'band', base, x0: x, y0: y, x1: x, y1: y, keep: new Set(this.selection) };
        return;
      }
      const start = snapDown(tick, this.grid);
      if (start >= base.length) {
        this.select([]);
        return;
      }
      const note: Note = clampNote({ id: this.#newId(), pitch, start, length: Math.min(this.nextLength, base.length - start), velocity: this.nextVelocity });
      const withNote = applyOps(base, [{ kind: 'insert', note }]);
      // Dragging changes the length of the note just added.
      this.#gesture = { kind: 'create', base: withNote, id: note.id, start };
      this.select([note.id]);
      this.#update(withNote);
      this.#o.onAudition?.(pitch, note.velocity);
    });

    el.addEventListener('pointermove', (e) => {
      const gs = this.#gesture;
      if (!gs || gs.kind === 'length') return;
      const { tick, pitch, x, y } = this.#at(e);
      switch (gs.kind) {
        case 'create': {
          const len = Math.min(Math.max(this.grid, snap(tick - gs.start, this.grid)), gs.base.length - gs.start);
          this.#update(applyOps(gs.base, [{ kind: 'set', id: gs.id, before: {}, after: { length: len } }]));
          break;
        }
        case 'move': {
          const draft = this.#moved(gs.base, gs.ids, snap(tick - gs.tick, this.grid), pitch - gs.pitch);
          const grabbed = draft.notes.find((n) => n.id === gs.grabbed.id);
          if (grabbed && grabbed.pitch !== gs.sounding) {
            this.#o.onAuditionEnd?.(gs.sounding);
            gs.sounding = grabbed.pitch;
            this.#o.onAudition?.(grabbed.pitch, grabbed.velocity);
          }
          this.#update(draft);
          break;
        }
        case 'resize': {
          const d = snap(tick - gs.tick, this.grid);
          const notes = gs.base.notes.map((n) => (gs.ids.has(n.id) ? { ...n, length: Math.min(Math.max(Math.min(this.grid, n.length), n.length + d), gs.base.length - n.start) } : n));
          this.#update({ ...gs.base, notes });
          break;
        }
        case 'band': {
          Object.assign(gs, { x1: x, y1: y });
          const [x0, x1] = [Math.min(gs.x0, x), Math.max(gs.x0, x)];
          const [y0, y1] = [Math.min(gs.y0, y), Math.max(gs.y0, y)];
          const inside = this.clip.notes.filter((n) => {
            const b = this.#noteBox(n);
            return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
          });
          this.select([...gs.keep, ...inside.map((n) => n.id)]);
          break;
        }
      }
    });
    el.addEventListener('pointerup', () => this.#end());
    el.addEventListener('pointercancel', () => this.#end());

    const remove = (e: MouseEvent) => {
      const { x, y } = this.#at(e);
      const hit = this.#hit(x, y);
      if (!hit) return false;
      this.selection.delete(hit.note.id);
      this.apply([{ kind: 'delete', note: hit.note }]);
      return true;
    };
    el.addEventListener('dblclick', (e) => remove(e));
    el.addEventListener('contextmenu', (e) => {
      if (remove(e)) e.preventDefault();
    });

    this.#scroll.addEventListener('keydown', (e) => this.#key(e));
  }

  #bindRuler(): void {
    const el = this.#ruler;
    el.style.cursor = 'ew-resize';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      // Only the end marker can be dragged; elsewhere the ruler scrolls.
      if (Math.abs(e.clientX - r.left - this.clip.length * this.#tickPx) > 16 && e.pointerType !== 'mouse') return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.#gesture = { kind: 'length', base: this.clip, span: this.#span() };
      this.#lengthTo(e.clientX - r.left);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.#gesture?.kind !== 'length') return;
      this.#lengthTo(e.clientX - el.getBoundingClientRect().left);
    });
    el.addEventListener('pointerup', () => this.#end());
    el.addEventListener('pointercancel', () => this.#end());
  }

  /** Drag of the end marker: whole beats; notes past the new end go, and
   * come back if the end is dragged out again before letting go. */
  #lengthTo(x: number): void {
    const gs = this.#gesture;
    if (gs?.kind !== 'length') return;
    const { ppq } = gs.base;
    const len = Math.min(this.#o.maxLength, Math.max(this.#o.minLength, snap(x / this.#tickPx, ppq)));
    const notes = gs.base.notes.filter((n) => n.start < len).map((n) => (n.start + n.length > len ? { ...n, length: len - n.start } : n));
    this.#update({ ...gs.base, length: Math.min(len, gs.span), notes });
  }

  #bindKeys(): void {
    // Pressing a key on the left plays its note.
    const el = this.#keys;
    let sounding: number | null = null;
    const stop = () => {
      if (sounding !== null) this.#o.onAuditionEnd?.(sounding);
      sounding = null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return; // touch: the keys scroll
      const r = el.getBoundingClientRect();
      sounding = Math.min(this.#o.highest, Math.max(this.#o.lowest, this.#o.highest - Math.floor((e.clientY - r.top) / this.#o.rowHeight)));
      this.#o.onAudition?.(sounding, this.nextVelocity);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
  }

  #key(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const ids = new Set(this.selection);
    const step = (ticks: number, semis: number) => {
      e.preventDefault();
      const ops = diffClips(this.clip, this.#moved(this.clip, ids, ticks, semis));
      this.apply(ops);
    };
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (!ids.size) return;
        e.preventDefault();
        this.deleteSelection();
        return;
      case 'ArrowUp':
        if (ids.size) step(0, e.shiftKey ? 12 : 1);
        return;
      case 'ArrowDown':
        if (ids.size) step(0, e.shiftKey ? -12 : -1);
        return;
      case 'ArrowLeft':
        if (ids.size) step(-this.grid, 0);
        return;
      case 'ArrowRight':
        if (ids.size) step(this.grid, 0);
        return;
      case 'Escape':
        if (ids.size) {
          e.preventDefault();
          e.stopPropagation();
          this.select([]);
        }
        return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.select(this.clip.notes.map((n) => n.id));
    } else if (mod && e.key.toLowerCase() === 'd' && ids.size) {
      e.preventDefault();
      const ops = duplicateNotes(this.clip, ids, this.#newId, this.grid);
      this.apply(ops);
      this.select(ops.flatMap((op) => (op.kind === 'insert' ? [op.note.id] : [])));
    }
  }
}
