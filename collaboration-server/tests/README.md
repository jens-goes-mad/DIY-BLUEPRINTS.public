# Tests

These are the actual scripts used to verify every non-obvious design
decision in STATE.md — not illustrative snippets, the real thing that was
run against real Yjs/JGit/the live stack to confirm each claim before it
was written down. Kept here so that verification, not just conclusions.

## Setup

One shared install at the project root — deliberately, not one per test
category. Two separate copies of `yjs` on disk means two separate class
instances, which silently breaks Yjs's own internal `instanceof` checks
(a real bug hit while building `conflicts.js`: see `../STATE.md`'s
"Conflict detection" section). Everything under `tests/` resolves `yjs`
(and every other shared package) by walking up to this one install.

```sh
cd .. # collaboration-server/
npm install
```

`markdown/markdown-roundtrip.mjs` is the one exception — see its own
section below, it needs a second, separate install.

## `unit/` — pure Yjs behavior, no running services needed

- **`vector-and-delta.mjs`** — proves `Y.encodeStateAsUpdate(doc, stateVector)`
  produces a real, independently-applicable delta (not just a smaller full
  copy), and that `Y.mergeUpdates` collapses multiple deltas into one
  update. Backs the append-only delta log design (`localStore.js`).
- **`decode-chunk-content.mjs`** / **`decode-chunk-format.mjs`** — proves an
  isolated Yjs update chunk, decoded via `Y.decodeUpdate`, exposes inserted
  text and attribute/formatting changes directly (`ContentString`/
  `ContentFormat`/`ContentAny`) — but deletions only ever show a tombstone
  (`{clock, length}`), never the deleted content itself. Backs the
  per-edit changelog design and its documented limitations.
- **`merge-conflict-resolution.mjs`** — proves CRDT merges are always
  order-independent and never throw, that normal (causally-chained)
  concurrent typing does not interleave into garbled text, and that
  concurrent attribute writes resolve via silent last-writer-wins with no
  notification. Backs the branching/merging RFC in the conversation history
  and the "semantic vs. algorithmic conflict" distinction in STATE.md.
- **`conflict-detection.mjs`** — imports the actual
  `backend/collab-server/src/conflicts.js` and proves it against four
  scenarios: a clean non-overlapping edit (0 conflicts), a genuine
  attribute collision (exactly 1, correctly typed and valued), two sides
  agreeing on the same value (0 — not a conflict), and delete-vs-edit
  (correctly flagged). This is the test that caught two real bugs before
  they shipped — a raw-decoded item's `parentSub` being null for any
  attribute *overwrite* (not first-write), and an attribute overwrite's
  implicit DeleteSet tombstone being double-counted as a phantom deletion.
  See STATE.md for the full story.

Run any of them directly:

```sh
node unit/vector-and-delta.mjs
```

## `markdown/` — tests the real serializer/parser shipped in collab-server

- **`markdown-roundtrip.mjs`** — imports the actual
  `backend/collab-server/src/markdown.js` (not a copy) and round-trips a
  document exercising headings, all marks, blockquote, fenced code with a
  language, tight lists, an ordered list with a non-1 start offset, and hr.
  Asserts the reparsed JSON is byte-identical to the original.

  Because it imports `markdown.js` directly from its real location, Node
  resolves that file's own imports (`prosemirror-markdown`, `markdown-it`,
  `@tiptap/*`) relative to *its* directory, not `tests/` — so this one
  needs `backend/collab-server`'s own dependencies installed too:

  ```sh
  (cd ../backend/collab-server && npm install)
  node markdown/markdown-roundtrip.mjs
  ```

## `integration/` — needs the real stack running

Requires `docker compose up -d` from `docker/` first (uses the published
ports: `1234`/`3000` for collab-server, `8081` for persistence-service).

- **`branch-merge-e2e.mjs`** — the full pipeline proof: create a branch,
  diverge both branches independently, compute the actual Yjs CRDT merge,
  hand it to persistence-service's merge endpoint, and confirm decoding the
  resulting git commit's stored binary reproduces the merged text exactly.
- **`changelog-replay.mjs`** — connects to collab-server as a real client
  (same as a browser would), makes two edits far enough apart to land as
  two separate git checkpoints, then replays the second commit's changelog
  onto the first commit's snapshot and confirms the result matches the
  second commit's own stored snapshot with a byte-identical Yjs state
  vector, not just matching text. Polls for each checkpoint to actually
  land rather than sleeping a fixed duration, so it's correct against
  whatever `GIT_CHECKPOINT_INTERVAL_MS` the running stack is using (default
  60s — so this one's slow by design, not a shortcut worth taking).
- **`merge-with-conflict-detection.mjs`** — exercises collab-server's real
  `POST /api/customers/:customerId/documents/:docId/merge` endpoint both ways against the live
  stack: a clean divergence merges and commits with a real two-parent
  commit; a divergence where both branches change the same attribute to
  different values returns exactly one correctly-typed conflict and —
  confirmed by comparing the target branch's stored snapshot before and
  after — commits nothing at all.

```sh
node integration/branch-merge-e2e.mjs
node integration/changelog-replay.mjs
node integration/merge-with-conflict-detection.mjs
```

## `scenarios/` — plain-text version/edit/merge scripts, played against real Yjs

Readable scripts (`branch`, `insert`, `delete`, `set`, `merge`, ...) with a
transcript per scenario showing the document after every step and how
conflicts are detected or resolved. Uses the real `mergeDocs.js`. See
[`scenarios/README.md`](scenarios/README.md) for the command reference and how
to run it.

## `jgit-merge-mechanics/` — standalone Java/JGit proof, no app code involved

A throwaway Maven project (not part of `persistence-service`) proving the
exact JGit mechanism `GitDocumentStorageService.merge()` relies on: that
`MergeCommand` with `MergeStrategy.OURS` produces a real two-parent commit,
and that amending that commit afterward to swap in different tree content
preserves both parents untouched. This is what justified building the
merge feature the way it's built, rather than trying to get git's own
content-merge algorithm to do anything.

```sh
cd jgit-merge-mechanics
mvn -q compile exec:java
```
