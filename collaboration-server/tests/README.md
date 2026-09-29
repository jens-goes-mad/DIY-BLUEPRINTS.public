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

`markdown/markdown-roundtrip.mjs` and `unit/changelog-diff.mjs` are the
exceptions — see their own sections below, they need `backend/collab-
server`'s own install too. **Remove `backend/collab-server/node_modules`
again once you're done with those** (`rm -rf ../backend/collab-server/
node_modules`) before running anything under `scenarios/` or anything else
that imports from `backend/collab-server/src/` (`mergeDocs.js`,
`conflicts.js`) — hit directly by testing (2026-09-27): once that install
exists on disk, Node resolves `mergeDocs.js`'s own `import 'yjs'` from the
CLOSER `backend/collab-server/node_modules`, not the root install this
whole directory is built around, silently reintroducing the exact two-
copies-of-yjs failure this section opens with. It doesn't announce itself
as an error -- `conflicts.js`'s `instanceof` checks just quietly stop
matching, and a real clean merge started looking like edits were being
dropped.

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
- **`local-store-compact.mjs`** — crash safety of the fast tier's
  `compact()`. Simulates a process kill mid-write and before the atomic
  rename and asserts the previous base survives intact, no temp files are
  left, and overlapping compactions of one document don't corrupt each
  other. Regression test for a real loss (2026-09-24, see STATE.md): fails
  on the original `fs.writeFile` implementation.
- **`changelog-diff.mjs`** — imports the actual `changelogDiff.js` and
  proves it recovers full insert AND delete content (not just a delta's
  tombstone length), chains sequential entries correctly, reproduces the
  live document's real final state when replayed end to end, and treats a
  missing previous checkpoint as empty rather than an error. Needs
  `backend/collab-server`'s own dependencies installed (same reason as
  `markdown-roundtrip.mjs` below):

  ```sh
  (cd ../backend/collab-server && npm install)
  node changelog-diff.mjs
  ```

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
- **`room-rejects-unknown-customer.mjs`** — collab-server must refuse a live
  editing room whose customer doesn't exist (close code 4401, readable
  reason, not retried in a loop) and keep accepting rooms whose customer
  does. Regression test for the 2026-09-24 incident where such a room was
  accepted and a day of edits could never be checkpointed (see STATE.md).
- **`readable-changes.mjs`** — drives persistence-service's content endpoint
  directly to create two deterministic checkpoints, then confirms the real
  `GET .../changes` endpoint returns the correct readable, attributed,
  word-diffed change. Regression test for a real bug (2026-09-27, see
  STATE.md): the first version fetched the previous checkpoint's content
  and the current changelog as two separate calls, and a checkpoint
  landing in between silently mixed states from two different commits.
- **`checkpoint-baseline-reset.mjs`** — drives a real Hocuspocus session
  (not a direct content-PUT bypass) across two real, separate checkpoints
  on one stable connection, and confirms the second checkpoint's changelog
  replays onto the first to reproduce the exact stored state, and its
  readable diff shows only the second edit, not the first reappearing.
  Regression test for a real bug (2026-09-30, see STATE.md) found while
  investigating a `changes-between` result: a changelog delta could be
  computed relative to a stale baseline and replay into something that
  didn't match what was actually committed.
- **`changes-between.mjs`** — three deterministic checkpoints, then
  confirms `GET .../changes-between` returns exactly the checkpoints after
  `from` up to `to`, oldest first, correctly attributed/diffed; that
  omitting `to` defaults to the version's current tip; and that a `from`
  that isn't actually an ancestor of `to` fails with a clear error instead
  of silently walking to the document's first commit.

- **`room-rejects-unknown-customer.mjs`** — collab-server must refuse a live
  editing room whose customer doesn't exist (close code 4401, readable
  reason, not retried in a loop) and keep accepting rooms whose customer
  does. Regression test for the 2026-09-24 incident where such a room was
  accepted and a day of edits could never be checkpointed (see STATE.md).

```sh
node integration/branch-merge-e2e.mjs
node integration/changelog-replay.mjs
node integration/merge-with-conflict-detection.mjs
node integration/room-rejects-unknown-customer.mjs
node integration/readable-changes.mjs
node integration/changes-between.mjs
node integration/checkpoint-baseline-reset.mjs
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
