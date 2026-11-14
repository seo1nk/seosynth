# pianoroll

Notes on a grid of time and pitch, and the component that edits them. It is
written to be lifted out of seosynth as it is (for example into a score
editor that several people edit together), so it follows a few rules:

- **No imports from outside this folder.** Only the DOM and a 2D canvas.
  A test in `tests/web.test.ts` checks this.
- **The program around it owns the data.** The component shows a clip and
  reports each change as operations; it never stores, plays or sends
  anything itself.
- **Words and colours come from outside.** Labels and note names are
  options; colours are CSS custom properties (`--pr-bg`, `--pr-note`, … see
  `COLORS` in `editor.ts`), with plain defaults.

## Model (`model.ts`)

```ts
interface Note { id: string; pitch: number; start: number; length: number; velocity: number }
interface Clip { ppq: number; length: number; notes: Note[] }
```

Time is in whole ticks, `ppq` to a quarter note. Pitch and velocity are MIDI
values (0–127, velocity 1–127).

Every change is a list of operations:

| op | meaning |
|---|---|
| `insert` | adds a note (the whole note, with its id) |
| `delete` | removes a note (carries the whole note, so it can be put back) |
| `set` | changes fields of the note with `id`; carries `before` and `after` |
| `length` | changes the length of the clip |

- `applyOps(clip, ops)` returns the new clip. An operation that no longer
  fits (its note was deleted, its id is taken) is skipped instead of failing.
- `invertOps(ops)` gives the operations that undo them.
- `diffClips(a, b)` gives the operations from one state to another.
- `adoptIds(prev, next, newId)` gives notes that come back from storage
  without ids the ids of the matching notes, so selections survive.
- `idMaker(site)` makes ids `"<site>.<n>"`; give each client its own site.

### For collaborative editing

Notes are addressed by id and `set` only touches the fields it names, so
two people moving different notes, or changing the pitch and the velocity
of the same note, do not conflict. When both change the same field, the
operation applied last wins. A server (or a CRDT library) only has to put
the operations of all clients in one order and send them to everyone; each
client applies them with `applyOps` and its own unconfirmed edits on top.
Undo is per client: invert your own operations.

## Component (`editor.ts`)

```ts
const roll = new PianoRoll(clip, {
  onChange(ops, done) { /* apply ops to your copy; on done, record undo / send */ },
  onAudition(pitch, velocity) { /* play a preview */ },
  onAuditionEnd(pitch) { /* stop it */ },
  noteName: (p) => ..., label: 'Piano roll', grid: 24,
});
host.append(roll.el);          // give the host element a height
roll.setClip(clip);            // after a change made elsewhere
roll.setPlayhead(tick | null); // while playing
roll.setGrid(ticks);
roll.apply(ops);               // edits made by your own buttons
roll.deleteSelection(); roll.select(ids); roll.reveal(pitch);
roll.dispose();
```

During a drag `onChange` is called with `done` false at every step and
once more with `done` true when the gesture ends. The steps are complete
operations, so applying them one after another always gives the state that
is on the screen.

Gestures: press an empty cell to add a note and drag to lengthen it; drag a
note to move it (selected notes move together); drag its right end to
change the length; double-click or right-click removes it; Shift + drag
selects a range; drag the marker at the end of the ruler to change the
length of the clip. Keys: Delete, arrows (Shift: octave), Ctrl/Cmd+A,
Ctrl/Cmd+D, Escape. On touch screens the grid is for editing and the keys
on the left and the ruler scroll.
