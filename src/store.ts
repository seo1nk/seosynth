// The patch as the UI sees it.
//
// The main-thread engine instance holds the authoritative patch. Every edit
// goes through this store, which applies it there, forwards it to the audio
// thread, and tells the widgets that display it.

import type { EngineCore } from './engine/core.ts';
import type { AudioMessage, EngineInfo, FxChain, LfoPoint, ParamInfo, Slot } from './engine/types.ts';
import type { PatchJSON } from './patch-json.ts';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const MAX_HISTORY = 200;

/** Where edits are forwarded to: the audio thread (or a stand-in in tests). */
export interface AudioSink {
  post(msg: AudioMessage): void;
}

/** Events and the arguments their listeners receive. */
export interface StoreEvents {
  /** Everything may have changed (preset load, undo). */
  patch: [];
  /** Modulation routings changed. */
  slots: [];
  /** An LFO shape changed. */
  lfo: [lfo: number];
  /** The effect chain changed (order or lanes). */
  fx: [];
  /** A user wavetable changed. */
  table: [slot: number];
  /** The patch name changed. */
  name: [];
  /** An edit was completed (a good moment to update the share URL). */
  commit: [];
}

export type StoreEvent = keyof StoreEvents;
type Listener<E extends StoreEvent> = (...args: StoreEvents[E]) => void;

/** A routing in use, with the slot it lives in. */
export type ActiveSlot = Slot & { index: number };

export class Store {
  readonly core: EngineCore;
  readonly audio: AudioSink;
  readonly info: EngineInfo;
  readonly params: ParamInfo[];
  readonly watchers = new Map<number, Set<(norm: number) => void>>();
  readonly listeners = new Map<StoreEvent, Set<Listener<StoreEvent>>>();
  slots: Slot[];
  history: Uint8Array<ArrayBuffer>[];
  cursor: number;

  constructor(core: EngineCore, audio: AudioSink) {
    this.core = core;
    this.audio = audio;
    this.info = core.info;
    this.params = core.params;
    this.slots = core.getSlots();
    this.history = [core.save()];
    this.cursor = 0;
  }

  // --- events (see StoreEvents) -----------------------------------------------

  on<E extends StoreEvent>(event: E, fn: Listener<E>): () => void {
    let set = this.listeners.get(event) as Set<Listener<E>> | undefined;
    if (!set) this.listeners.set(event, (set = new Set()) as Set<Listener<StoreEvent>>);
    set.add(fn);
    return () => void set.delete(fn);
  }

  emit<E extends StoreEvent>(event: E, ...args: StoreEvents[E]): void {
    for (const fn of this.listeners.get(event) ?? []) (fn as Listener<E>)(...args);
  }

  /** Calls `fn(norm)` whenever parameter `i` changes. */
  watch(i: number, fn: (norm: number) => void): () => void {
    let set = this.watchers.get(i);
    if (!set) this.watchers.set(i, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  #notify(i: number) {
    const v = this.core.get(i);
    for (const fn of this.watchers.get(i) ?? []) fn(v);
  }

  #notifyAll() {
    for (const i of this.watchers.keys()) this.#notify(i);
  }

  // --- parameters -----------------------------------------------------------

  idx(key: string): number {
    return this.core.idx(key);
  }
  def(i: number): ParamInfo {
    return this.params[i];
  }
  get(i: number): number {
    return this.core.get(i);
  }
  getPlain(i: number): number {
    return this.core.getPlain(i);
  }
  /** Value of a parameter by key, in real units. */
  plain(key: string): number {
    return this.core.getPlain(this.idx(key));
  }

  set(i: number, norm: number): void {
    const v = Math.min(1, Math.max(0, norm));
    if (v === this.core.get(i)) return;
    this.core.set(i, v);
    this.audio.post(['param', i, v]);
    this.#notify(i);
  }

  setPlain(i: number, plain: number): void {
    this.set(i, this.core.toNorm(i, plain));
  }

  reset(i: number): void {
    this.set(i, this.params[i].defNorm);
  }

  // --- structure ------------------------------------------------------------

  #sync() {
    this.audio.post(['patch', this.core.save()]);
  }

  setSlot(i: number, slot: Slot): void {
    this.core.setSlot(i, slot);
    this.slots = this.core.getSlots();
    this.#sync();
    this.emit('slots');
  }

  clearSlot(i: number): void {
    this.setSlot(i, { src: 0, dst: -1, amount: 0, bipolar: false });
  }

  /** Routings as [{ index, src, dst, amount, bipolar }] for the used slots. */
  activeSlots(): ActiveSlot[] {
    return this.slots.map((s, index) => ({ index, ...s })).filter((s) => s.src > 0 && s.dst >= 0);
  }

  modsFor(dst: number): ActiveSlot[] {
    return this.activeSlots().filter((s) => s.dst === dst);
  }

  /**
   * Routes `src` to `dst`. If that pair already exists its amount is
   * replaced. Returns the slot index, or -1 if all slots are in use.
   */
  addMod(src: number, dst: number, amount = 0.25, bipolar = false): number {
    let i = this.slots.findIndex((s) => s.src === src && s.dst === dst);
    if (i < 0) i = this.slots.findIndex((s) => s.src === 0 || s.dst < 0);
    if (i < 0) return -1;
    this.setSlot(i, { src, dst, amount, bipolar });
    return i;
  }

  getLfoShape(l: number): LfoPoint[] {
    return this.core.getLfoShape(l);
  }

  setLfoShape(l: number, points: readonly LfoPoint[]): void {
    this.core.setLfoShape(l, points);
    this.#sync();
    this.emit('lfo', l);
  }

  /** Index of the wavetable oscillator `name` ("oscA") plays, for previews:
   * a factory table, or a user table (those follow the factory ones). */
  tableOf(name: string): number {
    const user = Math.round(this.plain(`${name}.userTable`));
    return user > 0 ? this.info.tables.length + user - 1 : Math.round(this.plain(`${name}.wt`));
  }

  /** The points of a user wavetable: frames of `info.userPoints` signed bytes. */
  getUserTable(slot: number): Int8Array {
    return this.core.getUserTable(slot);
  }

  setUserTable(slot: number, points: Int8Array): boolean {
    if (!this.core.setUserTable(slot, points)) return false;
    this.#sync();
    this.emit('table', slot);
    return true;
  }

  /** { order, lanes }: see EngineCore.getFxChain. */
  getFxChain(): FxChain {
    return this.core.getFxChain();
  }

  setFxChain(order: readonly number[], lanes: readonly number[]): void {
    if (this.core.setFxChain(order, lanes)) {
      this.#sync();
      this.emit('fx');
    }
  }

  getName(): string {
    return this.core.getName();
  }

  setName(name: string): void {
    this.core.setName(name);
    this.#sync();
    this.emit('name');
  }

  // --- whole patch ----------------------------------------------------------

  #reloaded() {
    this.slots = this.core.getSlots();
    this.#sync();
    this.#notifyAll();
    this.emit('patch');
    this.emit('slots');
    this.emit('fx');
    for (let slot = 0; slot < this.info.userTables; slot++) this.emit('table', slot);
    this.emit('name');
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return this.core.save();
  }

  /** Loads a binary patch. Returns false if the data is not valid. */
  loadBytes(bytes: Uint8Array, { commit = true } = {}): boolean {
    if (!this.core.load(bytes)) return false;
    this.#reloaded();
    if (commit) this.commit();
    return true;
  }

  init(): void {
    this.core.init();
    this.#reloaded();
    this.commit();
  }

  /** Human-readable form, used for preset files and the built-in presets. */
  toJSON(): PatchJSON {
    const c = this.core;
    const out: PatchJSON & { params: Record<string, number | boolean | string> } = { format: 'seosynth-patch', version: 1, name: c.getName(), params: {} };
    for (const p of this.params) {
      const plain = c.getPlain(p.i);
      if (p.curve === 'enum') {
        if (Math.round(plain) !== Math.round(p.def)) out.params[p.key] = p.options[Math.round(plain)];
      } else if (p.curve === 'bool') {
        if (plain !== p.def) out.params[p.key] = plain >= 0.5;
      } else if (p.curve === 'int') {
        if (plain !== p.def) out.params[p.key] = plain;
      } else if (Math.abs(c.get(p.i) - p.defNorm) > 1e-5) {
        out.params[p.key] = Number(plain.toPrecision(6));
      }
    }
    const mods = this.activeSlots().map((s) => ({
      source: this.info.sources[s.src],
      target: this.params[s.dst].key,
      amount: Number(s.amount.toFixed(4)),
      ...(s.bipolar ? { bipolar: true } : {}),
    }));
    if (mods.length) out.mods = mods;
    const shapes: NonNullable<PatchJSON['lfoShapes']> = {};
    for (let l = 0; l < 4; l++) {
      const pts = c.getLfoShape(l);
      const isDefault = pts.length === 3 && pts[0].y === 0 && pts[1].x === 0.5 && pts[1].y === 1 && pts[2].y === 0 && pts.every((p) => p.curve === 0);
      const round = (v: number) => Number(v.toFixed(4));
      if (!isDefault) shapes[l + 1] = pts.map((p) => [round(p.x), round(p.y), round(p.curve)]);
    }
    if (Object.keys(shapes).length) out.lfoShapes = shapes;
    // The effect chain, up to the point from where the rest is in its
    // default place: units in ascending order on the main lane.
    const { order, lanes } = c.getFxChain();
    let keep = order.length;
    while (keep > 0 && lanes[order[keep - 1]] === 0 && (keep === order.length || order[keep - 1] < order[keep])) keep--;
    if (keep > 0) {
      const listed = order.slice(0, keep);
      out.fxOrder = listed.map((u) => this.info.fx[u]);
      const onLane = listed.filter((u) => lanes[u] > 0);
      if (onLane.length) out.fxLanes = Object.fromEntries(onLane.map((u) => [this.info.fx[u], lanes[u] === 1 ? 'a' : 'b']));
    }
    // User wavetables that are not the untouched sine, frame by frame.
    const per = this.info.userPoints;
    const tables: NonNullable<PatchJSON['userTables']> = {};
    for (let slot = 0; slot < this.info.userTables; slot++) {
      const points = Array.from(c.getUserTable(slot));
      const untouched = points.length === per && points.every((v, i) => v === Math.round(127 * Math.sin((2 * Math.PI * i) / per)));
      if (!untouched) tables[slot + 1] = Array.from({ length: points.length / per }, (_, f) => points.slice(f * per, (f + 1) * per));
    }
    if (Object.keys(tables).length) out.userTables = tables;
    return out;
  }

  /**
   * Applies a patch in JSON form on top of the init patch. Unknown keys are
   * ignored so files from other versions still load. Returns a list of
   * warnings for anything that was skipped.
   */
  fromJSON(obj: PatchJSON | null | undefined, { commit = true } = {}): string[] {
    const warnings: string[] = [];
    if (!obj || typeof obj !== 'object' || typeof obj.params !== 'object') throw new Error('not a patch file');
    const c = this.core;
    c.init();
    for (const [key, value] of Object.entries(obj.params ?? {})) {
      const p = c.byKey.get(key);
      if (!p) {
        warnings.push(`unknown parameter: ${key}`);
        continue;
      }
      let plain;
      if (p.curve === 'enum') {
        plain = typeof value === 'string' ? p.options.indexOf(value) : Number(value);
        if (!(plain >= 0)) {
          warnings.push(`unknown option for ${key}: ${value}`);
          continue;
        }
      } else if (p.curve === 'bool') {
        plain = value ? 1 : 0;
      } else {
        plain = Number(value);
        if (!Number.isFinite(plain)) continue;
      }
      c.setPlain(p.i, plain);
    }
    let slot = 0;
    for (const m of obj.mods ?? []) {
      const src = this.info.sources.indexOf(m.source);
      const dst = c.byKey.get(m.target);
      if (src <= 0 || !dst || !dst.mod) {
        warnings.push(`skipped modulation: ${m.source} -> ${m.target}`);
        continue;
      }
      if (slot >= this.info.numSlots) break;
      c.setSlot(slot++, { src, dst: dst.i, amount: Number(m.amount) || 0, bipolar: !!m.bipolar });
    }
    for (const [l, pts] of Object.entries(obj.lfoShapes ?? {})) {
      const index = Number(l) - 1;
      if (index >= 0 && index < 4 && Array.isArray(pts)) {
        c.setLfoShape(index, pts.map(([x, y, curve]) => ({ x, y, curve: curve ?? 0 })));
      }
    }
    // `fxOrder` lists the units that come first; the rest follow in their
    // default order. `fxLanes` puts units on lane "a" or "b" of the fork.
    const fx = this.info.fx;
    const start: number[] = [];
    for (const key of Array.isArray(obj.fxOrder) ? obj.fxOrder : []) {
      const unit = fx.indexOf(key);
      if (unit < 0 || start.includes(unit)) warnings.push(`skipped effect in the order: ${key}`);
      else start.push(unit);
    }
    const lanes = fx.map(() => 0);
    for (const [key, name] of Object.entries(obj.fxLanes ?? {})) {
      const unit = fx.indexOf(key);
      const lane = ['a', 'b'].indexOf(name) + 1;
      if (unit < 0 || !lane) warnings.push(`skipped lane: ${key} -> ${name}`);
      else lanes[unit] = lane;
    }
    c.setFxChain([...start, ...fx.map((_, u) => u).filter((u) => !start.includes(u))], lanes);
    for (const [key, frames] of Object.entries(obj.userTables ?? {})) {
      const flat = Array.isArray(frames) ? frames.flat() : [];
      const ok = flat.length > 0 && flat.every((v) => Number.isInteger(v) && v >= -128 && v <= 127);
      if (!ok || !c.setUserTable(Number(key) - 1, Int8Array.from(flat))) warnings.push(`skipped wavetable: ${key}`);
    }
    c.setName(typeof obj.name === 'string' ? obj.name : 'Untitled');
    this.#reloaded();
    if (commit) this.commit();
    return warnings;
  }

  // --- undo / redo ----------------------------------------------------------

  /** Marks the end of an edit: records an undo step if anything changed. */
  commit(): void {
    const bytes = this.core.save();
    if (!same(bytes, this.history[this.cursor])) {
      this.history.length = this.cursor + 1;
      this.history.push(bytes);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.cursor = this.history.length - 1;
    }
    this.emit('commit');
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }
  get canRedo(): boolean {
    return this.cursor < this.history.length - 1;
  }

  undo(): void {
    if (!this.canUndo) return;
    this.cursor--;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }

  redo(): void {
    if (!this.canRedo) return;
    this.cursor++;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }
}
