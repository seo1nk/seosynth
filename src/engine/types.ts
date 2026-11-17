// Shapes of what the wasm engine exports and describes about itself.

/** One parameter, as listed by the engine's `describe()`. */
export interface ParamInfo {
  /** Dense index, used in every call. */
  i: number;
  /** Stable id: never changes between versions (share links depend on it). */
  sid: number;
  /** "filter.cutoff" */
  key: string;
  min: number;
  max: number;
  /** Default in real units. */
  def: number;
  /** Default as a normalised 0..1 value. */
  defNorm: number;
  curve: 'lin' | 'pow' | 'sympow' | 'log' | 'int' | 'bool' | 'enum';
  /** Exponent of a 'pow' or 'sympow' curve. */
  k: number;
  unit: string;
  /** Can be moved by a modulation source. */
  mod: boolean;
  /** One value for the whole synth rather than per voice. */
  global: boolean;
  options: string[];
}

/** Indices of the signal taps the engine records for the displays. */
export interface TapLayout {
  count: number;
  len: number;
  oscA: number;
  oscB: number;
  sub: number;
  noise: number;
  filterIn: number;
  filterOut: number;
  amp: number;
  mix: number;
  /** First of the per-unit effect taps, indexed by unit. */
  fx: number;
  splitA: number;
  splitB: number;
  splitOut: number;
  out: number;
  [name: string]: number;
}

/** Offsets into the telemetry array the audio thread reports. */
export interface TeleLayout {
  len: number;
  voices: number;
  peakL: number;
  peakR: number;
  note: number;
  pitch: number;
  tapPos: number;
  gate: number;
  /** Where the clip sequencer is, in ticks; -1 while it is not playing. */
  clipPos: number;
  compReduction: number;
  envPos: number;
  envVal: number;
  lfoPhase: number;
  lfoVal: number;
  sources: number;
  params: number;
}

/** The engine's description of itself (`describe()`). */
export interface EngineInfo {
  params: ParamInfo[];
  /** Modulation sources; index 0 is "none". */
  sources: string[];
  /** Effect units ("dist", "dist2", ...). */
  fx: string[];
  /** Kinds of effect the units are copies of. */
  fxKinds: string[];
  /** Factory wavetables. User table `slot` is table `tables.length + slot`. */
  tables: string[];
  userTables: number;
  userPoints: number;
  userMaxFrames: number;
  divisionBeats: number[];
  /** The clip sequencer: ticks per quarter note and the limits of a clip. */
  clip: { ppq: number; minLength: number; maxLength: number; maxNotes: number };
  numSlots: number;
  numLfos: number;
  /** Envelopes, the amp envelope (env1) included. */
  numEnvs: number;
  numMacros: number;
  numVoices: number;
  block: number;
  maxLfoPoints: number;
  tap: TapLayout;
  tele: TeleLayout;
}

/** A modulation routing. `src` 0 or `dst` < 0 means the slot is empty. */
export interface Slot {
  src: number;
  dst: number;
  amount: number;
  bipolar: boolean;
  /** Bends the source: -1..1, 0 = straight. */
  curve: number;
  /** A second source that scales the routing, 0 = none. */
  aux: number;
}

/** A point of a drawn LFO shape. */
export interface LfoPoint {
  x: number;
  y: number;
  curve: number;
}

/** A note of the clip sequencer. Times are in ticks (`info.clip.ppq` to a
 * quarter note); pitch and velocity are MIDI values. */
export interface ClipNote {
  pitch: number;
  start: number;
  length: number;
  velocity: number;
}

/** The clip as the engine keeps it. */
export interface ClipData {
  length: number;
  notes: ClipNote[];
}

/** The effect chain: unit indices in processing order, and the lane of each unit. */
export interface FxChain {
  order: number[];
  lanes: number[];
}

export interface SerumNote {
  code: string;
  detail: string;
}

/** The functions the wasm module exports (see engine/src/api.rs). */
export interface EngineExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  io_ptr(): number;
  io_cap(): number;
  process(frames: number): void;
  out_l_ptr(): number;
  out_r_ptr(): number;
  taps_ptr(): number;
  telemetry_ptr(): number;
  note_on(note: number, velocity: number): void;
  note_off(note: number): void;
  audition_on(note: number, velocity: number): void;
  audition_off(note: number): void;
  all_notes_off(): void;
  panic_stop(): void;
  pitch_bend(v: number): void;
  mod_wheel(v: number): void;
  aftertouch(v: number): void;
  param_count(): number;
  get_param(i: number): number;
  set_param(i: number, norm: number): void;
  param_plain(i: number, norm: number): number;
  param_norm(i: number, plain: number): number;
  slot_set(i: number, src: number, dst: number, amount: number, bipolar: number, curve: number, aux: number): void;
  slot_get(i: number): number;
  lfo_shape_set(l: number, count: number): void;
  lfo_shape_get(l: number): number;
  set_realtime(on: number): void;
  table_wanted(): number;
  table_raw(index: number): number;
  table_offer(index: number, frames: number): number;
  table_offer_ready(): void;
  user_table_set(slot: number, frames: number): number;
  user_table_get(slot: number): number;
  clip_set(len: number): number;
  clip_get(): number;
  clip_default(): number;
  fx_chain_set(): number;
  fx_chain_get(): number;
  name_set(len: number): void;
  name_get(): number;
  patch_save(): number;
  patch_load(len: number): number;
  patch_init(): void;
  preview_osc(osc: number, pos: number, warpAmt: number, warp2Amt: number, n: number): number;
  preview_table(table: number, pos: number, n: number): number;
  table_frames(table: number): number;
  preview_lfo(l: number, n: number): number;
  filter_response(type: number, cutoffHz: number, res: number, variation: number, n: number): number;
  curve(t: number, c: number): number;
  blob_ptr(): number;
  serum_export(): number;
  serum_notes(): number;
  describe(): number;
}

/** Messages from the main thread to the audio thread. */
export type AudioMessage =
  | ['param', number, number]
  | ['on', number, number]
  | ['off', number]
  /** A note straight on the voices, past the arpeggiator and the clip. */
  | ['hear', number, number]
  | ['unhear', number]
  | ['patch', Uint8Array]
  | ['bend', number]
  | ['wheel', number]
  | ['touch', number]
  | ['allOff']
  | ['panic']
  | ['taps', boolean]
  /** Raw (not yet band-limited) frames of a factory table, 2048 samples each. */
  | ['table', number, Float32Array];

/** Messages from the audio thread. */
export type AudioReply =
  | { type: 'ready'; sampleRate: number }
  | { type: 'tele'; tele: Float32Array; taps?: Float32Array }
  /** The audio thread needs this factory table: answer with a 'table' message. */
  | { type: 'needTable'; index: number };

/** What the main thread hands the audio processor when it is created. */
export interface ProcessorOptions {
  wasm: ArrayBuffer;
  tele: TeleLayout;
  tap: TapLayout;
}
