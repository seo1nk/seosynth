// The readable form of a patch: preset files and the built-in presets.

export type ParamValue = number | boolean | string;

export interface ModJSON {
  source: string;
  target: string;
  amount: number;
  bipolar?: boolean;
}

export interface PatchJSON {
  format?: string;
  version?: number;
  name?: string;
  /** Only what differs from the init patch, in real units; menus by option name. */
  params: Record<string, ParamValue>;
  mods?: ModJSON[];
  /** Drawn LFO shapes by LFO number: [x, y, curve] points. */
  lfoShapes?: Record<string, [number, number, number?][]>;
  /** Effect units that come first, in order; the rest keep their default order. */
  fxOrder?: string[];
  /** Units on a lane of the fork: "a" or "b". */
  fxLanes?: Record<string, string>;
  /** User wavetables by number: frames of signed byte points. */
  userTables?: Record<string, number[][]>;
  /** The clip sequencer's notes, in ticks of 96 to a quarter note:
   * [pitch, start, length, velocity]. */
  clip?: { length: number; notes: [number, number, number, number][] };
}
