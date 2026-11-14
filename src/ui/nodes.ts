// The nodes of the board: which exist, which are in use, how they connect,
// and which signal tap shows the sound entering and leaving each of them.
//
// Effects come as units: every kind of effect has a few copies ("dist",
// "dist2", "dist3") so the same effect can be stacked. The units that are
// switched on form the chain. The chain can fork once into two lanes that
// run side by side and join again:
//
//   amp -> pre... -> [ lane A... | lane B... ] -> post... -> out
//
// The fork is the node "split". It exists while any unit is on a lane.

import type { Store } from '../store.ts';

export const SOURCES = ['oscA', 'oscB', 'oscC', 'sub', 'noise'];
export const OSCS = ['oscA', 'oscB', 'oscC'];
export const FILTERS = ['filter', 'filter2'];

/** Things that move sliders. Each is one modulation source of the engine
 * (envelope 1 is also one, but it lives inside the amp node). */
export const MOVERS = [
  ...Array.from({ length: 10 }, (_, k) => `lfo${k + 1}`),
  'env2', 'env3', 'env4',
  ...Array.from({ length: 8 }, (_, k) => `macro${k + 1}`),
  'velocity', 'note', 'random', 'modWheel', 'pitchBend', 'aftertouch',
];

export const SPLIT = 'split';
/** Lane numbers as the engine stores them. */
export const LANE = { main: 0, a: 1, b: 2 } as const;
export type Lane = (typeof LANE)[keyof typeof LANE];

export type MoverKind = 'lfo' | 'env' | 'macro' | 'play';

/** The enabled effects, grouped around the fork. */
export interface FxGroups {
  pre: string[];
  a: string[];
  b: string[];
  post: string[];
  /** True while there is a fork. */
  split: boolean;
}
type Group = 'pre' | 'a' | 'b' | 'post';

export const isFx = (store: Store, id: string): boolean => store.info.fx.includes(id);
export const isMover = (id: string): boolean => MOVERS.includes(id);
export const moverKind = (id: string): MoverKind => (/^lfo/.test(id) ? 'lfo' : /^env/.test(id) ? 'env' : /^macro/.test(id) ? 'macro' : 'play');

/** The kind of effect a unit is a copy of: "dist2" -> "dist". */
export const fxKind = (store: Store, id: string): string => store.info.fxKinds[store.info.fx.indexOf(id) % store.info.fxKinds.length];

/** All copies of the same kind of effect as `id`, first copy first. */
export function fxCopies(store: Store, id: string): string[] {
  const { fx, fxKinds } = store.info;
  const kind = fx.indexOf(id) % fxKinds.length;
  return fx.filter((_, unit) => unit % fxKinds.length === kind);
}

/** Nodes that have an on/off switch. */
export const hasSwitch = (store: Store, id: string): boolean => SOURCES.includes(id) || FILTERS.includes(id) || isFx(store, id);

export function isOn(store: Store, id: string): boolean {
  return hasSwitch(store, id) ? store.plain(`${id}.on`) >= 0.5 : true;
}

/**
 * The effect chain as groups of unit ids: { pre, a, b, post, split }.
 * The fork sits where the first unit on a lane is found in the stored
 * order; the other lane units join it there (the engine does the same).
 */
export function fxGroups(store: Store): FxGroups {
  const { fx } = store.info;
  const { order, lanes } = store.getFxChain();
  const g: FxGroups = { pre: [], a: [], b: [], post: [], split: false };
  for (const unit of order) {
    const id = fx[unit];
    if (!isOn(store, id)) continue;
    if (lanes[unit] === LANE.a) g.a.push(id);
    else if (lanes[unit] === LANE.b) g.b.push(id);
    else (g.split ? g.post : g.pre).push(id);
    g.split ||= lanes[unit] !== LANE.main;
  }
  return g;
}

const flat = (g: Pick<FxGroups, Group>): string[] => [...g.pre, ...g.a, ...g.b, ...g.post];
const groupOf = (g: Pick<FxGroups, Group>, id: string): Group | undefined => (['pre', 'a', 'b', 'post'] as const).find((k) => g[k].includes(id));

/** Effects that are switched on, in the order the sound meets them. */
export const fxChain = (store: Store): string[] => flat(fxGroups(store));

/** The lane an enabled effect is on: 0 main, 1 A, 2 B. */
export function laneOf(store: Store, id: string): Lane {
  const group = groupOf(fxGroups(store), id);
  return group === 'a' ? LANE.a : group === 'b' ? LANE.b : LANE.main;
}

/** The effects waiting in the tray: of each kind, the first copy that is off. */
export function fxSpares(store: Store): string[] {
  return store.info.fxKinds.map((kind) => fxCopies(store, kind).find((id) => !isOn(store, id))).filter((id) => id !== undefined);
}

/** Filter 2 is on and beside filter 1 rather than after it. */
export const filtersParallel = (store: Store): boolean => isOn(store, 'filter2') && Math.round(store.plain('filter2.mode')) === 1;

/** Filter 2 is on and after filter 1. */
export const filtersSeries = (store: Store): boolean => isOn(store, 'filter2') && !filtersParallel(store);

export type SourceDest = 'direct' | 'filter' | 'filter2' | 'both';

/**
 * Where a source's sound goes (the same rule as the engine's): around the
 * filters, into the first one that is on, or, with the filters in
 * parallel, into the filter it picked. A filter that is off is passed by.
 */
export function sourceDest(store: Store, id: string): SourceDest {
  const f1 = isOn(store, 'filter');
  const f2 = isOn(store, 'filter2');
  if (store.plain(`${id}.toFilter`) < 0.5) return 'direct';
  if (!filtersParallel(store)) return f1 ? 'filter' : f2 ? 'filter2' : 'direct';
  const pick = Math.round(store.plain(`${id}.filterSel`));
  if (pick === 0) return f1 ? 'filter' : 'direct';
  if (pick === 1) return 'filter2';
  return f1 ? 'both' : 'filter2';
}

/** The tap that carries what leaves an effect unit or the fork. */
export const tapOf = (store: Store, id: string): number => (id === SPLIT ? store.info.tap.splitOut : store.info.tap.fx + store.info.fx.indexOf(id));

/** Signal taps for a node: { in, out } (in is null for sources). */
export function taps(store: Store, id: string): { in: number | null; out: number } {
  const t = store.info.tap;
  if (SOURCES.includes(id)) return { in: null, out: t[id] };
  if (id === 'filter') return { in: t.filterIn, out: t.filterOut };
  if (id === 'filter2') return { in: t.filter2In, out: t.filter2Out };
  if (id === 'amp') return { in: t.preAmp, out: t.amp };
  const g = fxGroups(store);
  const out = (ids: string[], before: number) => (ids.length ? tapOf(store, ids[ids.length - 1]) : before);
  const beforeSplit = out(g.pre, t.mix);
  const afterSplit = g.split ? t.splitOut : beforeSplit;
  if (id === 'out') return { in: out(g.post, afterSplit), out: t.out };
  if (id === SPLIT) return { in: beforeSplit, out: t.splitOut };
  const group = groupOf(g, id);
  if (!group) return { in: t.mix, out: tapOf(store, id) }; // switched off
  const first = { pre: t.mix, a: t.splitA, b: t.splitB, post: afterSplit }[group];
  const at = g[group].indexOf(id);
  return { in: at > 0 ? tapOf(store, g[group][at - 1]) : first, out: tapOf(store, id) };
}

/** Which node a parameter belongs to. */
export function nodeOfParam(key: string): string {
  const [mod] = key.split('.');
  if (mod === 'env1') return 'amp';
  if (mod === 'master') return 'out';
  return mod;
}

/** Which node a modulation source lives in. */
export const nodeOfSource = (sourceKey: string): string => (sourceKey === 'env1' ? 'amp' : sourceKey);

/** Sliders of a node that can be moved by something, as parameter infos. */
export function movableParams(store: Store, id: string) {
  return store.params.filter((p) => p.mod && nodeOfParam(p.key) === id);
}

/** Nodes on the board that have at least one movable slider, in signal order. */
export function movableNodes(store: Store): string[] {
  const g = fxGroups(store);
  return [...SOURCES, ...FILTERS, 'amp', ...g.pre, ...(g.split ? [SPLIT] : []), ...g.a, ...g.b, ...g.post, ...fxSpares(store), 'out'];
}

// --- changing the chain ---------------------------------------------------------

/** Stores the groups: enabled units first, in the order the sound meets
 * them, then the rest in the order they had, back on the main lane. */
function writeGroups(store: Store, g: Pick<FxGroups, Group>): void {
  const { fx } = store.info;
  const used = flat(g);
  const rest = store.getFxChain().order.map((unit) => fx[unit]).filter((id) => !used.includes(id));
  const lanes = fx.map((id) => (g.a.includes(id) ? LANE.a : g.b.includes(id) ? LANE.b : LANE.main));
  store.setFxChain([...used, ...rest].map((id) => fx.indexOf(id)), lanes);
}

/** Switches a node on or off. An effect that is switched on joins the end
 * of the chain; one that is switched off leaves its lane. */
export function setOn(store: Store, id: string, on: boolean): void {
  const i = store.idx(`${id}.on`);
  if (!isFx(store, id)) {
    store.setPlain(i, on ? 1 : 0);
    return;
  }
  if (on && !isOn(store, id)) {
    const g = fxGroups(store);
    (g.split ? g.post : g.pre).push(id);
    writeGroups(store, g);
  }
  store.setPlain(i, on ? 1 : 0);
  if (!on) writeGroups(store, fxGroups(store));
}

/**
 * The row an effect (or the fork) can be moved along: the units of its own
 * lane, or the main line with the fork as one step in it.
 */
export function fxPeers(store: Store, id: string): string[] {
  const g = fxGroups(store);
  const group = id === SPLIT ? 'pre' : groupOf(g, id);
  if (!group || (id === SPLIT && !g.split)) return [];
  return group === 'a' || group === 'b' ? g[group] : [...g.pre, ...(g.split ? [SPLIT] : []), ...g.post];
}

/** Moves an effect (or the fork) one step earlier (-1) or later (+1). */
export function shiftFx(store: Store, id: string, delta: number): void {
  const g = fxGroups(store);
  const row = [...fxPeers(store, id)];
  const at = row.indexOf(id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= row.length) return;
  [row[at], row[to]] = [row[to], row[at]];
  const group = groupOf(g, id);
  if (group === 'a' || group === 'b') g[group] = row;
  else {
    const fork = row.indexOf(SPLIT);
    g.pre = fork < 0 ? row : row.slice(0, fork);
    g.post = fork < 0 ? [] : row.slice(fork + 1);
  }
  writeGroups(store, g);
}

/**
 * Puts an enabled effect on a lane (see LANE). The first effect that goes
 * to lane A or B creates the fork where that effect was; when the last one
 * returns to the main line the fork is gone.
 */
export function setLane(store: Store, id: string, lane: Lane): void {
  const g = fxGroups(store);
  const from = groupOf(g, id);
  if (!from || laneOf(store, id) === lane) return;
  const at = g[from].indexOf(id);
  const after = g[from].slice(at + 1);
  g[from] = g[from].filter((other) => other !== id);
  if (lane === LANE.main) {
    // Out of the fork: it lands right behind it, or stays put if the fork is gone.
    if (g.a.length || g.b.length) g.post.unshift(id);
    else g.pre.push(id);
  } else {
    if (!g.split) {
      // The fork opens here: what came after this effect now follows the fork.
      g.pre = g.pre.slice(0, at);
      g.post = after;
    }
    g[lane === LANE.a ? 'a' : 'b'].push(id);
  }
  writeGroups(store, g);
}

/** Removes the fork: its effects line up on the main line, lane A first. */
export function unsplit(store: Store): void {
  const g = fxGroups(store);
  writeGroups(store, { pre: [...g.pre, ...g.a, ...g.b], a: [], b: [], post: g.post });
}

/**
 * Stacks another copy of an effect right behind it, with the same settings.
 * Returns the id of the new unit, or null if every copy is already in use.
 */
export function duplicateFx(store: Store, id: string): string | null {
  const spare = fxCopies(store, id).find((other) => !isOn(store, other));
  const g = fxGroups(store);
  const group = groupOf(g, id);
  if (!spare || !group) return null;
  for (const p of store.params) {
    if (!p.key.startsWith(`${id}.`) || p.key === `${id}.on`) continue;
    store.set(store.idx(`${spare}${p.key.slice(id.length)}`), store.get(p.i));
  }
  g[group].splice(g[group].indexOf(id) + 1, 0, spare);
  writeGroups(store, g);
  store.setPlain(store.idx(`${spare}.on`), 1);
  return spare;
}
