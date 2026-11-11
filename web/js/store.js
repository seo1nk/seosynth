// The patch as the UI sees it.
//
// The main-thread engine instance holds the authoritative patch. Every edit
// goes through this store, which applies it there, forwards it to the audio
// thread, and tells the widgets that display it.

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const MAX_HISTORY = 200;

export class Store {
  constructor(core, audio) {
    this.core = core;
    this.audio = audio;
    this.info = core.info;
    this.params = core.params;
    this.watchers = new Map();
    this.listeners = new Map();
    this.slots = core.getSlots();
    this.history = [core.save()];
    this.cursor = 0;
  }

  // --- events ---------------------------------------------------------------
  // 'patch'  everything may have changed (preset load, undo)
  // 'slots'  modulation routings changed
  // 'lfo'    (index) an LFO shape changed
  // 'fx'     the effect chain changed (order or lanes)
  // 'table'  (slot) a user wavetable changed
  // 'name'   patch name changed
  // 'commit' an edit was completed (good moment to update the share URL)

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  /** Calls `fn(norm)` whenever parameter `i` changes. */
  watch(i, fn) {
    if (!this.watchers.has(i)) this.watchers.set(i, new Set());
    this.watchers.get(i).add(fn);
    return () => this.watchers.get(i).delete(fn);
  }

  #notify(i) {
    const v = this.core.get(i);
    for (const fn of this.watchers.get(i) ?? []) fn(v);
  }

  #notifyAll() {
    for (const i of this.watchers.keys()) this.#notify(i);
  }

  // --- parameters -----------------------------------------------------------

  idx(key) {
    return this.core.idx(key);
  }
  def(i) {
    return this.params[i];
  }
  get(i) {
    return this.core.get(i);
  }
  getPlain(i) {
    return this.core.getPlain(i);
  }
  /** Value of a parameter by key, in real units. */
  plain(key) {
    return this.core.getPlain(this.idx(key));
  }

  set(i, norm) {
    const v = Math.min(1, Math.max(0, norm));
    if (v === this.core.get(i)) return;
    this.core.set(i, v);
    this.audio.post(['param', i, v]);
    this.#notify(i);
  }

  setPlain(i, plain) {
    this.set(i, this.core.toNorm(i, plain));
  }

  reset(i) {
    this.set(i, this.params[i].defNorm);
  }

  // --- structure ------------------------------------------------------------

  #sync() {
    this.audio.post(['patch', this.core.save()]);
  }

  setSlot(i, slot) {
    this.core.setSlot(i, slot);
    this.slots = this.core.getSlots();
    this.#sync();
    this.emit('slots');
  }

  clearSlot(i) {
    this.setSlot(i, { src: 0, dst: -1, amount: 0, bipolar: false });
  }

  /** Routings as [{ index, src, dst, amount, bipolar }] for the used slots. */
  activeSlots() {
    return this.slots.map((s, index) => ({ index, ...s })).filter((s) => s.src > 0 && s.dst >= 0);
  }

  modsFor(dst) {
    return this.activeSlots().filter((s) => s.dst === dst);
  }

  /**
   * Routes `src` to `dst`. If that pair already exists its amount is
   * replaced. Returns the slot index, or -1 if all slots are in use.
   */
  addMod(src, dst, amount = 0.25, bipolar = false) {
    let i = this.slots.findIndex((s) => s.src === src && s.dst === dst);
    if (i < 0) i = this.slots.findIndex((s) => s.src === 0 || s.dst < 0);
    if (i < 0) return -1;
    this.setSlot(i, { src, dst, amount, bipolar });
    return i;
  }

  getLfoShape(l) {
    return this.core.getLfoShape(l);
  }

  setLfoShape(l, points) {
    this.core.setLfoShape(l, points);
    this.#sync();
    this.emit('lfo', l);
  }

  /** Index of the wavetable oscillator `name` ("oscA") plays, for previews:
   * a factory table, or a user table (those follow the factory ones). */
  tableOf(name) {
    const user = Math.round(this.plain(`${name}.userTable`));
    return user > 0 ? this.info.tables.length + user - 1 : Math.round(this.plain(`${name}.wt`));
  }

  /** The points of a user wavetable: frames of `info.userPoints` signed bytes. */
  getUserTable(slot) {
    return this.core.getUserTable(slot);
  }

  setUserTable(slot, points) {
    if (!this.core.setUserTable(slot, points)) return false;
    this.#sync();
    this.emit('table', slot);
    return true;
  }

  /** { order, lanes }: see EngineCore.getFxChain. */
  getFxChain() {
    return this.core.getFxChain();
  }

  setFxChain(order, lanes) {
    if (this.core.setFxChain(order, lanes)) {
      this.#sync();
      this.emit('fx');
    }
  }

  getName() {
    return this.core.getName();
  }

  setName(name) {
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

  toBytes() {
    return this.core.save();
  }

  /** Loads a binary patch. Returns false if the data is not valid. */
  loadBytes(bytes, { commit = true } = {}) {
    if (!this.core.load(bytes)) return false;
    this.#reloaded();
    if (commit) this.commit();
    return true;
  }

  init() {
    this.core.init();
    this.#reloaded();
    this.commit();
  }

  /** Human-readable form, used for preset files and the built-in presets. */
  toJSON() {
    const c = this.core;
    const out = { format: 'seosynth-patch', version: 1, name: c.getName(), params: {} };
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
    const shapes = {};
    for (let l = 0; l < 4; l++) {
      const pts = c.getLfoShape(l);
      const isDefault = pts.length === 3 && pts[0].y === 0 && pts[1].x === 0.5 && pts[1].y === 1 && pts[2].y === 0 && pts.every((p) => p.curve === 0);
      if (!isDefault) shapes[l + 1] = pts.map((p) => [p.x, p.y, p.curve].map((v) => Number(v.toFixed(4))));
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
    const tables = {};
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
  fromJSON(obj, { commit = true } = {}) {
    const warnings = [];
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
    const start = [];
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
  commit() {
    const bytes = this.core.save();
    if (!same(bytes, this.history[this.cursor])) {
      this.history.length = this.cursor + 1;
      this.history.push(bytes);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.cursor = this.history.length - 1;
    }
    this.emit('commit');
  }

  get canUndo() {
    return this.cursor > 0;
  }
  get canRedo() {
    return this.cursor < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo) return;
    this.cursor--;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }

  redo() {
    if (!this.canRedo) return;
    this.cursor++;
    this.core.load(this.history[this.cursor]);
    this.#reloaded();
    this.emit('commit');
  }
}
