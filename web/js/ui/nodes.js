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

export const SOURCES = ['oscA', 'oscB', 'sub', 'noise'];

/** Things that move sliders. Each is one modulation source of the engine
 * (envelope 1 is also one, but it lives inside the amp node). */
export const MOVERS = [
  'lfo1', 'lfo2', 'lfo3', 'lfo4', 'env2', 'env3', 'macro1', 'macro2', 'macro3', 'macro4',
  'velocity', 'note', 'random', 'modWheel', 'pitchBend', 'aftertouch',
];

export const SPLIT = 'split';
/** Lane numbers as the engine stores them. */
export const LANE = { main: 0, a: 1, b: 2 };

export const isFx = (store, id) => store.info.fx.includes(id);
export const isMover = (id) => MOVERS.includes(id);
export const moverKind = (id) => (/^lfo/.test(id) ? 'lfo' : /^env/.test(id) ? 'env' : /^macro/.test(id) ? 'macro' : 'play');

/** The kind of effect a unit is a copy of: "dist2" -> "dist". */
export const fxKind = (store, id) => store.info.fxKinds[store.info.fx.indexOf(id) % store.info.fxKinds.length];

/** All copies of the same kind of effect as `id`, first copy first. */
export function fxCopies(store, id) {
  const { fx, fxKinds } = store.info;
  const kind = fx.indexOf(id) % fxKinds.length;
  return fx.filter((_, unit) => unit % fxKinds.length === kind);
}

/** Nodes that have an on/off switch. */
export const hasSwitch = (store, id) => SOURCES.includes(id) || id === 'filter' || isFx(store, id);

export function isOn(store, id) {
  return hasSwitch(store, id) ? store.plain(`${id}.on`) >= 0.5 : true;
}

/**
 * The effect chain as groups of unit ids: { pre, a, b, post, split }.
 * The fork sits where the first unit on a lane is found in the stored
 * order; the other lane units join it there (the engine does the same).
 */
export function fxGroups(store) {
  const { fx } = store.info;
  const { order, lanes } = store.getFxChain();
  const g = { pre: [], a: [], b: [], post: [], split: false };
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

const flat = (g) => [...g.pre, ...g.a, ...g.b, ...g.post];
const groupOf = (g, id) => ['pre', 'a', 'b', 'post'].find((k) => g[k].includes(id));

/** Effects that are switched on, in the order the sound meets them. */
export const fxChain = (store) => flat(fxGroups(store));

/** The lane an enabled effect is on: 0 main, 1 A, 2 B. */
export function laneOf(store, id) {
  const group = groupOf(fxGroups(store), id);
  return group === 'a' ? LANE.a : group === 'b' ? LANE.b : LANE.main;
}

/** The effects waiting in the tray: of each kind, the first copy that is off. */
export function fxSpares(store) {
  return store.info.fxKinds.map((kind) => fxCopies(store, kind).find((id) => !isOn(store, id))).filter(Boolean);
}

/** True when a source goes through the filter rather than around it. */
export const throughFilter = (store, id) => isOn(store, 'filter') && store.plain(`${id}.toFilter`) >= 0.5;

/** The tap that carries what leaves an effect unit or the fork. */
export const tapOf = (store, id) => (id === SPLIT ? store.info.tap.splitOut : store.info.tap.fx + store.info.fx.indexOf(id));

/** Signal taps for a node: { in, out } (in is null for sources). */
export function taps(store, id) {
  const t = store.info.tap;
  if (SOURCES.includes(id)) return { in: null, out: t[id] };
  if (id === 'filter') return { in: t.filterIn, out: t.filterOut };
  if (id === 'amp') return { in: t.filterOut, out: t.amp };
  const g = fxGroups(store);
  const out = (ids, before) => (ids.length ? tapOf(store, ids.at(-1)) : before);
  const beforeSplit = out(g.pre, t.mix);
  const afterSplit = g.split ? t.splitOut : beforeSplit;
  if (id === 'out') return { in: out(g.post, afterSplit), out: t.out };
  if (id === SPLIT) return { in: beforeSplit, out: t.splitOut };
  const group = groupOf(g, id);
  const first = { pre: t.mix, a: t.splitA, b: t.splitB, post: afterSplit }[group] ?? t.mix;
  const at = group ? g[group].indexOf(id) : 0;
  return { in: at > 0 ? tapOf(store, g[group][at - 1]) : first, out: tapOf(store, id) };
}

/** Which node a parameter belongs to. */
export function nodeOfParam(key) {
  const [mod] = key.split('.');
  if (mod === 'env1') return 'amp';
  if (mod === 'master') return 'out';
  return mod;
}

/** Which node a modulation source lives in. */
export const nodeOfSource = (sourceKey) => (sourceKey === 'env1' ? 'amp' : sourceKey);

/** Sliders of a node that can be moved by something, as parameter infos. */
export function movableParams(store, id) {
  return store.params.filter((p) => p.mod && nodeOfParam(p.key) === id);
}

/** Nodes on the board that have at least one movable slider, in signal order. */
export function movableNodes(store) {
  const g = fxGroups(store);
  return [...SOURCES, 'filter', 'amp', ...g.pre, ...(g.split ? [SPLIT] : []), ...g.a, ...g.b, ...g.post, ...fxSpares(store), 'out'];
}

// --- changing the chain ---------------------------------------------------------

/** Stores the groups: enabled units first, in the order the sound meets
 * them, then the rest in the order they had, back on the main lane. */
function writeGroups(store, g) {
  const { fx } = store.info;
  const used = flat(g);
  const rest = store.getFxChain().order.map((unit) => fx[unit]).filter((id) => !used.includes(id));
  const lanes = fx.map((id) => (g.a.includes(id) ? LANE.a : g.b.includes(id) ? LANE.b : LANE.main));
  store.setFxChain([...used, ...rest].map((id) => fx.indexOf(id)), lanes);
}

/** Switches a node on or off. An effect that is switched on joins the end
 * of the chain; one that is switched off leaves its lane. */
export function setOn(store, id, on) {
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
export function fxPeers(store, id) {
  const g = fxGroups(store);
  const group = id === SPLIT ? 'pre' : groupOf(g, id);
  if (!group || (id === SPLIT && !g.split)) return [];
  return group === 'a' || group === 'b' ? g[group] : [...g.pre, ...(g.split ? [SPLIT] : []), ...g.post];
}

/** Moves an effect (or the fork) one step earlier (-1) or later (+1). */
export function shiftFx(store, id, delta) {
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
export function setLane(store, id, lane) {
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
export function unsplit(store) {
  const g = fxGroups(store);
  writeGroups(store, { pre: [...g.pre, ...g.a, ...g.b], a: [], b: [], post: g.post });
}

/**
 * Stacks another copy of an effect right behind it, with the same settings.
 * Returns the id of the new unit, or null if every copy is already in use.
 */
export function duplicateFx(store, id) {
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
