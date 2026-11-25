// Lessons: building a preset from the init sound, one node at a time.
//
// The steps come from the preset itself: every setting that differs from
// the init patch, grouped by the node it belongs to, in the order the sound
// meets those nodes. A modulation joins the step of the node that moves it.
// No DOM here, so the steps can be checked in tests.

import type { Store } from './store.ts';
import type { ParamValue, PatchJSON } from './patch-json.ts';

export interface ParamTarget {
  kind: 'param';
  key: string;
  value: ParamValue;
}

export interface ModTarget {
  kind: 'mod';
  source: string;
  target: string;
  amount: number;
  bipolar: boolean;
  curve: number;
  /** Source key of the second source, '' for none. */
  aux: string;
}

export type Target = ParamTarget | ModTarget;

export interface LessonStep {
  /** Node or mover whose settings this step makes; 'keys' for how the keys play. */
  node: string;
  targets: Target[];
}

const SOURCE_NODES = ['oscA', 'oscB', 'oscC', 'sub', 'noise'];

/** The step a parameter is set in. */
export function stepOfParam(key: string): string {
  const [mod] = key.split('.');
  if (mod === 'env1') return 'amp';
  if (mod === 'master') return 'out';
  if (mod === 'arp' || mod === 'clip') return 'keys';
  return mod;
}

/** The step a modulation is made in: the node of what moves it. */
const stepOfSource = (source: string): string => (source === 'env1' ? 'amp' : source);

/**
 * The steps that turn the init patch into `preset`.
 * @param store  gives the parameter order, the effect units and the sources
 */
export function lessonSteps(preset: PatchJSON, store: Pick<Store, 'params' | 'info'>): LessonStep[] {
  const movers = store.info.sources.filter((s, k) => k > 0 && s !== 'env1');
  const order = [...SOURCE_NODES, 'filter', 'filter2', 'amp', ...movers, ...store.info.fx, 'out', 'keys'];
  const rank = (node: string) => (order.includes(node) ? order.indexOf(node) : order.length);
  const position = new Map(store.params.map((p) => [p.key, p.i]));
  const byKey = new Map(store.params.map((p) => [p.key, p]));
  // A preset may spell out a value the init sound already has: nothing to do.
  const isDefault = (key: string, value: ParamValue) => {
    const p = byKey.get(key)!;
    const plain = p.curve === 'enum' ? (typeof value === 'string' ? p.options.indexOf(value) : Number(value)) : p.curve === 'bool' ? Number(!!value) : Number(value);
    return Math.abs(plain - p.def) <= 1e-6 * Math.max(1, Math.abs(p.def));
  };
  const steps = new Map<string, LessonStep>();
  const stepFor = (node: string) => {
    let step = steps.get(node);
    if (!step) steps.set(node, (step = { node, targets: [] }));
    return step;
  };
  // Switches first, then in the order the panel shows the sliders.
  const params = Object.entries(preset.params ?? {})
    .filter(([key, value]) => position.has(key) && !isDefault(key, value))
    .sort(([a], [b]) => Number(b.endsWith('.on')) - Number(a.endsWith('.on')) || position.get(a)! - position.get(b)!);
  for (const [key, value] of params) stepFor(stepOfParam(key)).targets.push({ kind: 'param', key, value });
  for (const m of preset.mods ?? []) {
    stepFor(stepOfSource(m.source)).targets.push({
      kind: 'mod',
      source: m.source,
      target: m.target,
      amount: m.amount,
      bipolar: !!m.bipolar,
      curve: m.curve ?? 0,
      aux: m.aux ?? '',
    });
  }
  return [...steps.values()].sort((a, b) => rank(a.node) - rank(b.node));
}

/** A preset value in the engine's real units. */
function plainOf(store: Store, key: string, value: ParamValue): number {
  const p = store.def(store.idx(key));
  if (p.curve === 'enum') return typeof value === 'string' ? p.options.indexOf(value) : Number(value);
  if (p.curve === 'bool') return value ? 1 : 0;
  return Number(value);
}

/** The routing slot that already joins the target's source and destination. */
function slotOf(store: Store, t: ModTarget) {
  const src = store.info.sources.indexOf(t.source);
  const dst = store.idx(t.target);
  return store.activeSlots().find((s) => s.src === src && s.dst === dst);
}

/** Has the sound reached this target? Close is enough for sliders. */
export function isDone(store: Store, t: Target): boolean {
  if (t.kind === 'mod') {
    const s = slotOf(store, t);
    if (!s) return false;
    const aux = t.aux ? store.info.sources.indexOf(t.aux) : 0;
    return Math.abs(s.amount - t.amount) < 0.03 && s.bipolar === t.bipolar && Math.abs(s.curve - t.curve) < 0.05 && s.aux === aux;
  }
  const i = store.idx(t.key);
  const p = store.def(i);
  const plain = plainOf(store, t.key, t.value);
  if (p.curve === 'enum' || p.curve === 'bool' || p.curve === 'int') return Math.round(store.getPlain(i)) === Math.round(plain);
  // Sliders: within about one percent of their travel.
  return Math.abs(store.get(i) - store.core.toNorm(i, plain)) < 0.012;
}

/** Sets the sound to this target (the "do it for me" button). Does not commit. */
export function applyTarget(store: Store, t: Target): void {
  if (t.kind === 'param') {
    store.setPlain(store.idx(t.key), plainOf(store, t.key, t.value));
    return;
  }
  const src = store.info.sources.indexOf(t.source);
  const dst = store.idx(t.target);
  const at = slotOf(store, t)?.index ?? store.addMod(src, dst, t.amount, t.bipolar);
  if (at < 0) return;
  const aux = t.aux ? Math.max(0, store.info.sources.indexOf(t.aux)) : 0;
  store.setSlot(at, { src, dst, amount: t.amount, bipolar: t.bipolar, curve: t.curve, aux });
}

/** What a lesson starts from: the init patch plus what cannot be built with
 * sliders (drawn shapes, tables and phrases), which is laid out in advance. */
export function lessonStart(preset: PatchJSON, name: string): PatchJSON {
  const { lfoShapes, userTables, clip, clips, fxOrder, fxLanes } = preset;
  return { name, params: {}, lfoShapes, userTables, clip, clips, fxOrder, fxLanes };
}

/** True when the start already holds something of the preset's own. */
export const hasPrepared = (preset: PatchJSON): boolean =>
  !!(preset.lfoShapes || preset.userTables || preset.clip || preset.clips || preset.fxOrder || preset.fxLanes);
