// The data a piano roll edits, and every change to it as an operation.
//
// Nothing here knows about the screen or about seosynth: a clip is plain
// data, and an edit is a list of operations that can be applied, undone
// (inverted), compared (diffed) and sent elsewhere. That is what lets the
// same model back a collaborative editor later:
//
// - Every note has an id that never changes, so an operation names the note
//   it acts on rather than its position in a list.
// - `set` operations carry both the old and the new values of the fields
//   they touch. Applying one where the note is gone does nothing; applying
//   two to different fields of the same note keeps both.
// - Ids start with a site name, so two people adding notes at the same time
//   never make the same id.

export interface NoteFields {
  /** MIDI note number, 0..127. */
  pitch: number;
  /** Ticks from the start of the clip. */
  start: number;
  /** Ticks; at least 1. */
  length: number;
  /** 1..127, as in MIDI. */
  velocity: number;
}

export interface Note extends NoteFields {
  readonly id: string;
}

export interface Clip {
  /** Ticks per quarter note. */
  readonly ppq: number;
  /** Ticks; the clip ends (and loops) here. */
  readonly length: number;
  readonly notes: readonly Note[];
}

export type Op =
  | { kind: 'insert'; note: Note }
  | { kind: 'delete'; note: Note }
  | { kind: 'set'; id: string; before: Partial<NoteFields>; after: Partial<NoteFields> }
  | { kind: 'length'; before: number; after: number };

const FIELDS = ['pitch', 'start', 'length', 'velocity'] as const;

/** Keeps a note's values in range (whole ticks, valid pitch and velocity). */
export function clampNote<T extends NoteFields>(n: T): T {
  return {
    ...n,
    pitch: Math.min(127, Math.max(0, Math.round(n.pitch))),
    start: Math.max(0, Math.round(n.start)),
    length: Math.max(1, Math.round(n.length)),
    velocity: Math.min(127, Math.max(1, Math.round(n.velocity))),
  };
}

/** Notes in playing order: by start, then pitch. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch || (a.id < b.id ? -1 : 1));
}

/** Applies operations in order and returns the new clip (the old one is not
 * changed). Operations that no longer fit (a note already gone, an id
 * already taken) are skipped, which is what concurrent edits need. */
export function applyOps(clip: Clip, ops: readonly Op[]): Clip {
  const byId = new Map(clip.notes.map((n) => [n.id, n]));
  let length = clip.length;
  for (const op of ops) {
    switch (op.kind) {
      case 'insert':
        if (!byId.has(op.note.id)) byId.set(op.note.id, clampNote(op.note));
        break;
      case 'delete':
        byId.delete(op.note.id);
        break;
      case 'set': {
        const n = byId.get(op.id);
        if (n) byId.set(op.id, clampNote({ ...n, ...op.after }));
        break;
      }
      case 'length':
        length = Math.max(1, Math.round(op.after));
        break;
    }
  }
  return { ...clip, length, notes: sortNotes([...byId.values()]) };
}

/** Operations that undo `ops` (apply them after `ops` to get back). */
export function invertOps(ops: readonly Op[]): Op[] {
  return [...ops].reverse().map((op): Op => {
    switch (op.kind) {
      case 'insert':
        return { kind: 'delete', note: op.note };
      case 'delete':
        return { kind: 'insert', note: op.note };
      case 'set':
        return { kind: 'set', id: op.id, before: op.after, after: op.before };
      case 'length':
        return { kind: 'length', before: op.after, after: op.before };
    }
  });
}

/** The operations that turn clip `a` into clip `b`, matching notes by id. */
export function diffClips(a: Clip, b: Clip): Op[] {
  const ops: Op[] = [];
  if (a.length !== b.length) ops.push({ kind: 'length', before: a.length, after: b.length });
  const before = new Map(a.notes.map((n) => [n.id, n]));
  const after = new Map(b.notes.map((n) => [n.id, n]));
  for (const n of a.notes) if (!after.has(n.id)) ops.push({ kind: 'delete', note: n });
  for (const n of b.notes) {
    const old = before.get(n.id);
    if (!old) {
      ops.push({ kind: 'insert', note: n });
      continue;
    }
    const was: Partial<NoteFields> = {};
    const now: Partial<NoteFields> = {};
    for (const f of FIELDS) {
      if (old[f] !== n[f]) {
        was[f] = old[f];
        now[f] = n[f];
      }
    }
    if (Object.keys(now).length) ops.push({ kind: 'set', id: n.id, before: was, after: now });
  }
  return ops;
}

// --- ids ---------------------------------------------------------------------------

/** Makes note ids: "<site>.<counter>". Give each editing client its own site. */
export function idMaker(site: string = Math.random().toString(36).slice(2, 8)): () => string {
  let n = 0;
  return () => `${site}.${(n++).toString(36)}`;
}

/**
 * Gives the notes of `next` (which came without meaningful ids, e.g. read
 * back from storage) the ids of the matching notes in `prev`, so selections
 * and references survive. A note matches one with the same pitch and start;
 * the rest get new ids.
 */
export function adoptIds(prev: Clip, next: Omit<Clip, 'notes'> & { notes: readonly NoteFields[] }, newId: () => string): Clip {
  const free = new Map<string, Note[]>();
  for (const n of prev.notes) {
    const key = `${n.pitch}:${n.start}`;
    free.set(key, [...(free.get(key) ?? []), n]);
  }
  const notes = next.notes.map((n): Note => {
    const same = free.get(`${n.pitch}:${n.start}`)?.shift();
    return { ...clampNote(n), id: same ? same.id : newId() };
  });
  return { ppq: next.ppq, length: next.length, notes: sortNotes(notes) };
}

// --- time ------------------------------------------------------------------------------

/** The nearest grid line to `tick` (`grid` ticks apart). */
export const snap = (tick: number, grid: number): number => (grid > 0 ? Math.round(tick / grid) * grid : Math.round(tick));

/** The grid line at or before `tick`. */
export const snapDown = (tick: number, grid: number): number => (grid > 0 ? Math.floor(tick / grid) * grid : Math.floor(tick));

/** Ticks in a bar of `beats` quarter notes. */
export const barTicks = (clip: Pick<Clip, 'ppq'>, beats = 4): number => clip.ppq * beats;

// --- edits as operations --------------------------------------------------------------------

/** Moves the notes `ids` by `ticks` and `semitones` (clamped to the clip). */
export function moveNotes(clip: Clip, ids: ReadonlySet<string>, ticks: number, semitones: number): Op[] {
  const moved = clip.notes.map((n) => (ids.has(n.id) ? clampNote({ ...n, start: Math.min(clip.length - 1, n.start + ticks), pitch: n.pitch + semitones }) : n));
  return diffClips(clip, { ...clip, notes: moved });
}

/** Puts the starts of the notes `ids` on the grid. */
export function quantize(clip: Clip, ids: ReadonlySet<string>, grid: number): Op[] {
  const moved = clip.notes.map((n) => (ids.has(n.id) ? { ...n, start: Math.min(snap(n.start, grid), Math.max(0, clip.length - grid)) } : n));
  return diffClips(clip, { ...clip, notes: moved });
}

/** Copies of the notes `ids`, placed right after the last of them. */
export function duplicateNotes(clip: Clip, ids: ReadonlySet<string>, newId: () => string, grid: number): Op[] {
  const picked = clip.notes.filter((n) => ids.has(n.id));
  if (!picked.length) return [];
  const first = Math.min(...picked.map((n) => n.start));
  const end = Math.max(...picked.map((n) => n.start + n.length));
  const shift = Math.max(grid, Math.ceil((end - first) / grid) * grid);
  return picked.filter((n) => n.start + shift < clip.length).map((n) => ({ kind: 'insert', note: { ...n, id: newId(), start: n.start + shift } }));
}

/** Notes that sound during [from, to) at `pitch` (for hit testing). */
export const notesAt = (clip: Clip, tick: number, pitch: number): Note[] => clip.notes.filter((n) => n.pitch === pitch && tick >= n.start && tick < n.start + n.length);
