// Turning a recording into wavetable frames.
//
// A wavetable frame is one cycle of a sound. To get frames out of a recording
// we look at a few moments spread over it; at each one we find how long one
// cycle is (its pitch), measure the strength and timing of the harmonics
// over a few cycles, and write that cycle down as 128 points.
//
// Nothing here needs a browser: the functions take plain arrays of samples.

export const POINTS = 128;
/** Harmonics a frame of POINTS points can hold. */
const MAX_HARMONICS = POINTS / 2 - 1;
/** Sounds shorter than this are repeated before they are analysed, so a
 * file holding a single cycle works too. */
const MIN_LENGTH = 8192;

/** Averages the channels of a recording into one. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * Length of one cycle of `x` around sample `center`, by the YIN method: the
 * shift at which the sound best matches itself.
 * Returns { period (in samples, with fractions), clarity (0..1) }.
 */
export function findPeriod(x: Float32Array, center: number, sampleRate: number, { minHz = 20, maxHz = 2000 } = {}): { period: number; clarity: number } {
  let maxLag = Math.floor(sampleRate / minHz);
  let size = 2048;
  if (x.length < size + maxLag) {
    maxLag = Math.min(maxLag, Math.floor(x.length / 2));
    size = x.length - maxLag;
  }
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxLag <= minLag + 2 || size < 16) return { period: 0, clarity: 0 };
  const start = Math.max(0, Math.min(x.length - size - maxLag, Math.round(center - (size + maxLag) / 2)));

  // d[lag]: how different the sound is from itself `lag` samples later,
  // divided by the average difference so far (which removes the bias
  // towards short lags).
  const d = new Float32Array(maxLag + 1);
  let running = 0;
  d[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let n = 0; n < size; n++) {
      const diff = x[start + n] - x[start + n + lag];
      sum += diff * diff;
    }
    running += sum;
    d[lag] = running > 0 ? (sum * lag) / running : 1;
  }

  // The first clear dip, followed down to its lowest point; failing that,
  // the deepest dip anywhere.
  let best = -1;
  for (let lag = minLag; lag < maxLag; lag++) {
    if (d[lag] < 0.15) {
      while (lag + 1 < maxLag && d[lag + 1] < d[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    best = minLag;
    for (let lag = minLag; lag < maxLag; lag++) if (d[lag] < d[best]) best = lag;
  }
  // A parabola through the dip and its neighbours finds the fraction.
  let period = best;
  if (best > 1 && best < maxLag) {
    const [a, b, c] = [d[best - 1], d[best], d[best + 1]];
    const curve = a - 2 * b + c;
    if (curve > 0) period += (0.5 * (a - c)) / curve;
  }
  return { period, clarity: Math.max(0, Math.min(1, 1 - d[best])) };
}

/**
 * One cycle of `x`, `period` samples long, taken around `center` and
 * written as POINTS values in -1..1.
 *
 * The cycle is described by its harmonics, measured over several cycles so
 * that noise and small pitch errors average out. It is then shifted so its
 * fundamental starts at zero going up: frames lined up like this morph into
 * each other smoothly instead of cancelling.
 */
export function extractCycle(x: Float32Array, center: number, period: number): Float32Array {
  const cycles = Math.max(1, Math.min(8, Math.floor(2048 / period)));
  const length = Math.min(x.length, Math.round(cycles * period));
  const start = Math.max(0, Math.min(x.length - length, Math.round(center - length / 2)));
  const count = Math.max(1, Math.min(MAX_HARMONICS, Math.floor(period / 2) - 1));

  const cos = new Float64Array(count + 1);
  const sin = new Float64Array(count + 1);
  for (let k = 1; k <= count; k++) {
    // A rotating pointer saves calling cos and sin for every sample.
    const step = (2 * Math.PI * k) / period;
    const [stepCos, stepSin] = [Math.cos(step), Math.sin(step)];
    let [c, s, sumCos, sumSin] = [1, 0, 0, 0];
    for (let n = 0; n < length; n++) {
      const v = x[start + n];
      sumCos += v * c;
      sumSin += v * s;
      [c, s] = [c * stepCos - s * stepSin, s * stepCos + c * stepSin];
    }
    cos[k] = (2 * sumCos) / length;
    sin[k] = (2 * sumSin) / length;
  }

  // Shift in time so the fundamental becomes a plain sine.
  const total = Math.hypot(...cos, ...sin);
  const shift = Math.hypot(cos[1], sin[1]) > total * 1e-3 ? Math.atan2(cos[1], sin[1]) : 0;
  const out = new Float32Array(POINTS);
  for (let k = 1; k <= count; k++) {
    const [rc, rs] = [Math.cos(k * shift), Math.sin(k * shift)];
    const a = cos[k] * rc - sin[k] * rs;
    const b = cos[k] * rs + sin[k] * rc;
    for (let i = 0; i < POINTS; i++) {
      const phase = (2 * Math.PI * k * i) / POINTS;
      out[i] += a * Math.cos(phase) + b * Math.sin(phase);
    }
  }
  return out;
}

/** Scales a cycle to full height and rounds it to signed bytes. */
export function toPoints(cycle: Float32Array): Int8Array {
  let peak = 0;
  for (const v of cycle) peak = Math.max(peak, Math.abs(v));
  const out = new Int8Array(cycle.length);
  if (peak > 0) for (let i = 0; i < cycle.length; i++) out[i] = Math.round((cycle[i] / peak) * 127);
  return out;
}

/**
 * Makes up to `frameCount` wavetable frames from a mono recording.
 *
 * Returns null for silence. Otherwise:
 *   points   Int8Array of frames * POINTS values
 *   frames   how many frames (one, if they all came out the same)
 *   pitched  false if no steady pitch was found; the frames are then slices
 *            of a fixed length, which keeps the colour of a noise or a drum
 *   hz       the pitch that was found (the middle one, if it changes)
 */
export interface ImportedFrames {
  points: Int8Array;
  frames: number;
  pitched: boolean;
  hz: number;
}

export function audioToFrames(samples: Float32Array, sampleRate: number, frameCount = 8): ImportedFrames | null {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (samples.length < 16 || !(peak > 1e-4)) return null;

  // Leave out the silence before and after. A short sound is used whole
  // (it may be exactly one cycle) and repeated to give the analysis room.
  let x = samples;
  if (x.length >= MIN_LENGTH) {
    let [first, last] = [0, x.length - 1];
    while (Math.abs(x[first]) < peak * 0.02) first++;
    while (Math.abs(x[last]) < peak * 0.02) last--;
    if (last - first + 1 >= MIN_LENGTH) x = x.subarray(first, last + 1);
  } else {
    const tiled = new Float32Array(Math.ceil(MIN_LENGTH / x.length) * x.length);
    for (let at = 0; at < tiled.length; at += x.length) tiled.set(x, at);
    x = tiled;
  }

  const count = Math.max(1, Math.min(16, Math.round(frameCount)));
  const centers = Array.from({ length: count }, (_, j) => ((j + 0.5) / count) * x.length);
  const found = centers.map((c) => findPeriod(x, c, sampleRate));
  const clear = found.filter((f) => f.clarity >= 0.5 && f.period > 2).map((f) => f.period).sort((a, b) => a - b);
  const pitched = clear.length * 2 >= count;
  // Without a pitch: slices of 2048 samples, the usual wavetable frame.
  const usual = pitched ? clear[clear.length >> 1] : Math.min(2048, x.length);

  const points = new Int8Array(count * POINTS);
  centers.forEach((center, j) => {
    const period = pitched && found[j].clarity >= 0.5 && found[j].period > 2 ? found[j].period : usual;
    points.set(toPoints(extractCycle(x, center, period)), j * POINTS);
  });

  // Frames that all came out alike (a steady tone, a single cycle) are one frame.
  let apart = 0;
  for (let i = POINTS; i < points.length; i++) apart += (points[i] - points[i % POINTS]) ** 2;
  const frames = count > 1 && Math.sqrt(apart / (points.length - POINTS)) < 4 ? 1 : count;
  return { points: points.slice(0, frames * POINTS), frames, pitched, hz: pitched ? sampleRate / usual : 0 };
}
