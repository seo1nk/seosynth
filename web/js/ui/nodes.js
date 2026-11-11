// The nodes of the board: which exist, which are in use, how they connect,
// and which signal tap shows the sound entering and leaving each of them.

export const SOURCES = ['oscA', 'oscB', 'sub', 'noise'];

/** Things that move sliders. Each is one modulation source of the engine
 * (envelope 1 is also one, but it lives inside the amp node). */
export const MOVERS = [
  'lfo1', 'lfo2', 'lfo3', 'lfo4', 'env2', 'env3', 'macro1', 'macro2', 'macro3', 'macro4',
  'velocity', 'note', 'random', 'modWheel', 'pitchBend', 'aftertouch',
];

export const isFx = (store, id) => store.info.fx.includes(id);
export const isMover = (id) => MOVERS.includes(id);
export const moverKind = (id) => (/^lfo/.test(id) ? 'lfo' : /^env/.test(id) ? 'env' : /^macro/.test(id) ? 'macro' : 'play');

/** Nodes that have an on/off switch. */
export const hasSwitch = (store, id) => SOURCES.includes(id) || id === 'filter' || isFx(store, id);

export function isOn(store, id) {
  return hasSwitch(store, id) ? store.plain(`${id}.on`) >= 0.5 : true;
}

/** Effects that are switched on, in processing order. */
export function fxChain(store) {
  return store
    .getFxOrder()
    .map((i) => store.info.fx[i])
    .filter((key) => isOn(store, key));
}

/** Effects that are switched off, in their stored order. */
export function fxIdle(store) {
  return store
    .getFxOrder()
    .map((i) => store.info.fx[i])
    .filter((key) => !isOn(store, key));
}

/** True when a source goes through the filter rather than around it. */
export const throughFilter = (store, id) => isOn(store, 'filter') && store.plain(`${id}.toFilter`) >= 0.5;

/** Signal taps for a node: { in, out } (in is null for sources). */
export function taps(store, id) {
  const t = store.info.tap;
  if (SOURCES.includes(id)) return { in: null, out: t[id] };
  if (id === 'filter') return { in: t.filterIn, out: t.filterOut };
  if (id === 'amp') return { in: t.filterOut, out: t.amp };
  const chain = fxChain(store);
  const tapOf = (key) => t.fx + store.info.fx.indexOf(key);
  if (id === 'out') return { in: chain.length ? tapOf(chain.at(-1)) : t.mix, out: t.out };
  const at = chain.indexOf(id);
  return { in: at > 0 ? tapOf(chain[at - 1]) : t.mix, out: tapOf(id) };
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

/** Nodes that have at least one movable slider, in signal order. */
export function movableNodes(store) {
  return [...SOURCES, 'filter', 'amp', ...store.info.fx, 'out'];
}

/** Switching an effect on puts it at the end of the chain. */
export function setOn(store, id, on) {
  if (on && isFx(store, id)) {
    const fx = store.info.fx.indexOf(id);
    const order = store.getFxOrder().filter((i) => i !== fx);
    const lastOn = order.reduce((acc, i, k) => (isOn(store, store.info.fx[i]) ? k : acc), -1);
    order.splice(lastOn + 1, 0, fx);
    store.setFxOrder(order);
  }
  store.setPlain(store.idx(`${id}.on`), on ? 1 : 0);
}

/** Moves an enabled effect one step earlier (-1) or later (+1) in the chain. */
export function shiftFx(store, key, delta) {
  const chain = fxChain(store);
  const at = chain.indexOf(key);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= chain.length) return;
  [chain[at], chain[to]] = [chain[to], chain[at]];
  const ids = chain.map((k) => store.info.fx.indexOf(k));
  const rest = store.getFxOrder().filter((i) => !ids.includes(i));
  store.setFxOrder([...ids, ...rest]);
}
