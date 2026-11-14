// The piano roll's model, and the rule that the folder stands on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { adoptIds, applyOps, diffClips, duplicateNotes, idMaker, invertOps, moveNotes, quantize, snap } from '../src/pianoroll/model.ts';
import type { Clip, Note, Op } from '../src/pianoroll/model.ts';

const note = (id: string, pitch: number, start: number, length = 24, velocity = 100): Note => ({ id, pitch, start, length, velocity });
const clip = (...notes: Note[]): Clip => ({ ppq: 96, length: 384, notes });

test('operations apply, invert and diff', () => {
  const a = clip(note('a', 60, 0), note('b', 64, 96));
  const ops: Op[] = [
    { kind: 'insert', note: note('c', 67, 48) },
    { kind: 'set', id: 'a', before: { pitch: 60 }, after: { pitch: 62 } },
    { kind: 'delete', note: note('b', 64, 96) },
    { kind: 'length', before: 384, after: 768 },
  ];
  const b = applyOps(a, ops);
  assert.deepEqual(b.notes.map((n) => [n.id, n.pitch, n.start]), [['a', 62, 0], ['c', 67, 48]]);
  assert.equal(b.length, 768);
  assert.deepEqual(applyOps(b, invertOps(ops)), a);
  // The diff of two states reproduces the second from the first.
  assert.deepEqual(applyOps(a, diffClips(a, b)), b);
  assert.deepEqual(diffClips(a, a), []);
  assert.equal(a.notes[0].pitch, 60, 'the input is not changed');
});

test('operations that no longer fit are skipped, so concurrent edits merge', () => {
  const base = clip(note('a', 60, 0), note('b', 64, 96));
  // One person moves note a in time while another changes its velocity, and
  // a third deletes note b that the first person also edits.
  const mine: Op[] = [
    { kind: 'set', id: 'a', before: { start: 0 }, after: { start: 48 } },
    { kind: 'set', id: 'b', before: { pitch: 64 }, after: { pitch: 65 } },
  ];
  const theirs: Op[] = [
    { kind: 'set', id: 'a', before: { velocity: 100 }, after: { velocity: 40 } },
    { kind: 'delete', note: note('b', 64, 96) },
  ];
  const one = applyOps(applyOps(base, mine), theirs);
  const other = applyOps(applyOps(base, theirs), mine);
  assert.deepEqual(one, other);
  assert.deepEqual(one.notes, [note('a', 60, 48, 24, 40)]);
  // Inserting an id twice keeps the first.
  assert.equal(applyOps(base, [{ kind: 'insert', note: note('a', 70, 0) }]).notes[0].pitch, 60);
});

test('values are kept in range', () => {
  const c = applyOps(clip(), [{ kind: 'insert', note: note('x', 200, -5, 0, 0) }]);
  assert.deepEqual(c.notes[0], note('x', 127, 0, 1, 1));
});

test('ids are unique per site and survive a round trip through storage', () => {
  const a = idMaker('a');
  const b = idMaker('b');
  const ids = [a(), a(), b(), b()];
  assert.equal(new Set(ids).size, 4);
  const prev = clip(note('keep', 60, 0), note('gone', 62, 24));
  const stored = { ppq: 96, length: 384, notes: [{ pitch: 60, start: 0, length: 48, velocity: 90 }, { pitch: 65, start: 96, length: 24, velocity: 100 }] };
  const next = adoptIds(prev, stored, idMaker('n'));
  assert.deepEqual(next.notes.map((n) => n.id), ['keep', 'n.0']);
  assert.equal(next.notes[0].length, 48);
});

test('editing helpers', () => {
  const c = clip(note('a', 60, 10), note('b', 64, 100));
  const moved = applyOps(c, moveNotes(c, new Set(['a']), 24, 12));
  assert.deepEqual([moved.notes[0].start, moved.notes[0].pitch], [34, 72]);
  const q = applyOps(c, quantize(c, new Set(['a', 'b']), 24));
  assert.deepEqual(q.notes.map((n) => n.start), [0, 96]);
  const d = applyOps(c, duplicateNotes(c, new Set(['a', 'b']), idMaker('d'), 24));
  assert.deepEqual(d.notes.map((n) => n.start), [10, 100, 130, 220]);
  assert.equal(snap(37, 24), 48);
});

test('the piano roll imports nothing from outside its folder', async () => {
  const dir = new URL('../src/pianoroll/', import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) continue;
    const text = await readFile(new URL(name, dir), 'utf8');
    for (const [, from] of text.matchAll(/from '([^']+)'/g)) assert.match(from, /^\.\/[\w-]+\.ts$/, `${name} imports ${from}`);
  }
});
