// Thin, DOM-free wrapper around one instance of the wasm engine.
// Used on the main thread (as the source of truth for the patch and for
// drawing previews) and in Node tests. The audio thread talks to its own
// instance directly, see worklet.ts.

import type { EngineExports, EngineInfo, FxChain, LfoPoint, ParamInfo, SerumNote, Slot } from './types.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class EngineCore {
  readonly x: EngineExports;
  readonly sampleRate: number;
  /** Engine self-description: parameter table, option lists, layouts. */
  readonly info: EngineInfo;
  readonly params: ParamInfo[];
  readonly byKey: Map<string, ParamInfo>;
  readonly bySid: Map<number, ParamInfo>;

  constructor(instance: WebAssembly.Instance, sampleRate = 48000) {
    this.x = instance.exports as unknown as EngineExports;
    this.x.init(sampleRate);
    this.sampleRate = sampleRate;
    this.info = JSON.parse(this.#readString(this.x.describe())) as EngineInfo;
    this.params = this.info.params;
    this.byKey = new Map(this.params.map((p) => [p.key, p]));
    this.bySid = new Map(this.params.map((p) => [p.sid, p]));
  }

  static async fromBytes(bytes: BufferSource, sampleRate = 48000): Promise<EngineCore> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new EngineCore(instance, sampleRate);
  }

  // --- shared buffer --------------------------------------------------------
  // Views are re-created on every use: growing wasm memory detaches old ones.
  // Ask for the pointer before taking `memory.buffer`, since asking can
  // allocate (and so grow the memory) the first time.

  #bytes(): Uint8Array {
    const ptr = this.x.io_ptr();
    return new Uint8Array(this.x.memory.buffer, ptr, this.x.io_cap());
  }
  #floats(n: number): Float32Array {
    const ptr = this.x.io_ptr();
    return new Float32Array(this.x.memory.buffer, ptr, n);
  }
  #readString(len: number): string {
    return decoder.decode(this.#bytes().subarray(0, len));
  }
  #readFloats(n: number): Float32Array {
    return this.#floats(n).slice();
  }

  // --- parameters -----------------------------------------------------------

  /** Index of a parameter key such as "filter.cutoff". */
  idx(key: string): number {
    const p = this.byKey.get(key);
    if (!p) throw new Error(`unknown parameter: ${key}`);
    return p.i;
  }
  get(i: number): number {
    return this.x.get_param(i);
  }
  set(i: number, norm: number): void {
    this.x.set_param(i, norm);
  }
  /** Normalised 0..1 value to real units. */
  toPlain(i: number, norm: number): number {
    return this.x.param_plain(i, norm);
  }
  toNorm(i: number, plain: number): number {
    return this.x.param_norm(i, plain);
  }
  getPlain(i: number): number {
    return this.toPlain(i, this.get(i));
  }
  setPlain(i: number, plain: number): void {
    this.set(i, this.toNorm(i, plain));
  }

  // --- modulation -----------------------------------------------------------

  getSlot(i: number): Slot {
    this.x.slot_get(i);
    const [src, dst, amount, bipolar] = this.#floats(4);
    return { src, dst, amount, bipolar: bipolar !== 0 };
  }
  /** `dst` < 0 or `src` 0 clears the slot. */
  setSlot(i: number, { src, dst, amount, bipolar }: Slot): void {
    this.x.slot_set(i, src, dst, amount, bipolar ? 1 : 0);
  }
  getSlots(): Slot[] {
    return Array.from({ length: this.info.numSlots }, (_, i) => this.getSlot(i));
  }

  getLfoShape(l: number): LfoPoint[] {
    const n = this.x.lfo_shape_get(l);
    const f = this.#floats(n * 3);
    return Array.from({ length: n }, (_, k) => ({ x: f[k * 3], y: f[k * 3 + 1], curve: f[k * 3 + 2] }));
  }
  setLfoShape(l: number, points: readonly (Omit<LfoPoint, 'curve'> & { curve?: number })[]): void {
    const pts = points.slice(0, this.info.maxLfoPoints);
    const f = this.#floats(pts.length * 3);
    pts.forEach((p, k) => {
      f[k * 3] = p.x;
      f[k * 3 + 1] = p.y;
      f[k * 3 + 2] = p.curve ?? 0;
    });
    this.x.lfo_shape_set(l, pts.length);
  }

  // --- user wavetables --------------------------------------------------------
  // A patch carries a few wavetables of its own (`info.userTables` of them).
  // Each is 1..`info.userMaxFrames` frames of `info.userPoints` points, one
  // signed byte per point. Where a table index is asked for (previewTable,
  // tableFrames), user table `slot` is table `info.tables.length + slot`.

  getUserTable(slot: number): Int8Array {
    const n = this.x.user_table_get(slot);
    return new Int8Array(this.#bytes().subarray(0, n));
  }
  /** Returns false, changing nothing, if `points` is not whole frames. */
  setUserTable(slot: number, points: Int8Array): boolean {
    const per = this.info.userPoints;
    if (points.length % per !== 0 || points.length > per * this.info.userMaxFrames) return false;
    this.#bytes().set(new Uint8Array(points.buffer, points.byteOffset, points.length));
    return this.x.user_table_set(slot, points.length / per) === 1;
  }

  /**
   * The effect chain: `order` lists every unit (as an index into `info.fx`)
   * in processing order, `lanes` gives the lane of each unit, indexed by
   * unit: 0 main, 1 lane A, 2 lane B.
   */
  getFxChain(): FxChain {
    const n = this.x.fx_chain_get() / 2;
    const bytes = this.#bytes();
    return { order: Array.from(bytes.subarray(0, n)), lanes: Array.from(bytes.subarray(n, n * 2)) };
  }
  /** Returns false, changing nothing, if the chain is not valid. */
  setFxChain(order: readonly number[], lanes: readonly number[]): boolean {
    const n = this.info.fx.length;
    if (order.length !== n || lanes.length !== n) return false;
    const bytes = this.#bytes();
    bytes.set(order);
    bytes.set(lanes, n);
    return this.x.fx_chain_set() === 1;
  }

  // --- whole patch ----------------------------------------------------------

  getName(): string {
    return this.#readString(this.x.name_get());
  }
  setName(name: string): void {
    const bytes = encoder.encode(String(name)).subarray(0, 250);
    this.#bytes().set(bytes);
    this.x.name_set(bytes.length);
  }
  /** Compact binary form of the patch (what share URLs carry). */
  save(): Uint8Array<ArrayBuffer> {
    const n = this.x.patch_save();
    return this.#bytes().slice(0, n);
  }
  /** Returns false (and changes nothing) if `bytes` is not a valid patch. */
  load(bytes: Uint8Array): boolean {
    if (bytes.length > this.x.io_cap()) return false;
    this.#bytes().set(bytes);
    return this.x.patch_load(bytes.length) === 1;
  }
  init(): void {
    this.x.patch_init();
  }

  // --- previews -------------------------------------------------------------

  previewOsc(osc: number, pos: number, warpAmt: number, n = 256): Float32Array {
    return this.#readFloats(this.x.preview_osc(osc, pos, warpAmt, n));
  }
  previewTable(table: number, pos: number, n = 128): Float32Array {
    return this.#readFloats(this.x.preview_table(table, pos, n));
  }
  tableFrames(table: number): number {
    return this.x.table_frames(table);
  }
  previewLfo(l: number, n = 256): Float32Array {
    return this.#readFloats(this.x.preview_lfo(l, n));
  }
  /** dB at n log-spaced points 20 Hz..20 kHz, or null if not applicable. */
  filterResponse(type: number, cutoffHz: number, res: number, variation: number, n = 128): Float32Array | null {
    const len = this.x.filter_response(type, cutoffHz, res, variation, n);
    return len ? this.#readFloats(len) : null;
  }
  curve(t: number, c: number): number {
    return this.x.curve(t, c);
  }

  // --- Serum 2 export ---------------------------------------------------------

  #blob(len: number): Uint8Array<ArrayBuffer> {
    const ptr = this.x.blob_ptr();
    return new Uint8Array(this.x.memory.buffer, ptr, len).slice();
  }

  /**
   * The current patch as a Serum 2 preset.
   * `notes` lists what could not be translated exactly ({ code, detail });
   * `tables` are the wavetables the preset expects in Serum's Tables folder.
   */
  serumExport(): { preset: Uint8Array<ArrayBuffer>; notes: SerumNote[]; tables: { index: number; path: string }[] } {
    const preset = this.#blob(this.x.serum_export());
    const notes = this.#readString(this.x.serum_notes())
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, detail = ''] = line.split('\t');
        return { code, detail };
      });
    const count = this.x.serum_tables();
    const tables = Array.from(this.#bytes().subarray(0, count)).map((index) => ({
      index,
      path: this.#readString(this.x.serum_table_path(index)),
    }));
    return { preset, notes, tables };
  }

  /**
   * The frames of factory table `index` as generated, before band-limiting
   * (2048 samples each): what the audio thread asks for, since generating
   * some tables takes too long for an audio callback.
   */
  tableRaw(index: number): Float32Array<ArrayBuffer> {
    const frames = this.x.table_raw(index);
    const bytes = this.#blob(frames * 2048 * 4);
    return new Float32Array(bytes.buffer, bytes.byteOffset, frames * 2048);
  }

  /** A wavetable of the bank as a WAV file Serum can load. */
  serumTableWav(index: number): Uint8Array<ArrayBuffer> {
    return this.#blob(this.x.serum_table_wav(index));
  }

  // --- audio (tests and offline rendering) -----------------------------------

  noteOn(note: number, velocity = 0.8): void {
    this.x.note_on(note, velocity);
  }
  noteOff(note: number): void {
    this.x.note_off(note);
  }
  /** Renders `frames` (<= 1024) and returns copies of both channels. */
  render(frames: number): [Float32Array, Float32Array] {
    this.x.process(frames);
    const buf = this.x.memory.buffer;
    return [new Float32Array(buf, this.x.out_l_ptr(), frames).slice(), new Float32Array(buf, this.x.out_r_ptr(), frames).slice()];
  }
  telemetry(): Float32Array {
    const ptr = this.x.telemetry_ptr();
    return new Float32Array(this.x.memory.buffer, ptr, this.info.tele.len);
  }
  tap(index: number): Float32Array {
    const { len } = this.info.tap;
    const ptr = this.x.taps_ptr();
    return new Float32Array(this.x.memory.buffer, ptr + index * len * 4, len);
  }
}
