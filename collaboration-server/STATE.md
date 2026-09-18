# STATE

Kept up to date as the project evolves. This is the detailed "what's
actually true right now" doc — README.md is just the quick-start pointer.

Last updated: 2026-09-18.

## Architecture

Three concerns, deliberately separated:

| Concern | Owned by |
|---|---|
| Merging concurrent edits | **Yjs CRDT** — the only merge algorithm in this system |
| Durable storage, history, branch bookkeeping | **git**, storing opaque binary snapshots |
| Human legibility (review, `git log -p`, the cgit UI) | **A generated Markdown export**, regenerated on save, never read back in |

### Two-tier persistence

`collab-server` never talks to git directly on every edit — that would
flood git history, since every commit is a *full* document snapshot (see
below), not a diff.

1. **Fast tier** (`live-data` volume, `/data/live/<docId>.ydoc`): written on
   every Hocuspocus debounce (8s after the last edit, capped at 30s of
   continuous typing). This is what actually protects against data loss —
   a `collab-server` crash or restart can never lose more than the last
   unsaved debounce window, and that window is tiny.
2. **Slow tier** (git, via `persistence-service`): checkpointed on a
   coarse interval (`GIT_CHECKPOINT_INTERVAL_MS`, default 60s), and only if
   something changed since the last checkpoint. On load, if a document was
   restored from the fast tier (meaning git might be behind), it's marked
   dirty immediately so the next checkpoint reconciles git even if nobody
   types anything further — verified by hard-killing the container mid-edit
   and confirming both (a) the edit survived the crash via the fast tier
   alone, and (b) git caught up on its own on the next interval with no
   further edits, logged as `edited by restored` to distinguish
   crash-recovery reconciliation from a live edit in the audit trail.

**Trade-off, explicit:** less frequent git commits means coarser
`git blame` granularity — if several users edit within one checkpoint
window, the resulting commit (and therefore the blame) credits whoever's
author set got merged into that one commit's message, not each person's
specific lines within that window. Per-debounce commits (the old behavior)
had finer blame granularity but flooded history. Tunable via
`GIT_CHECKPOINT_INTERVAL_MS` if the trade-off needs adjusting.

### What's actually stored in git, and why

Each commit stores the **full** Yjs binary state
(`Y.encodeStateAsUpdate(doc)`, called with no state vector — i.e. "encode
as if from nothing"), not an incremental diff. Verified directly: extracted
a single early commit's `.ydoc` blob in isolation (no chaining with any
other commit) and it decoded to a complete, correct document on its own.
Git's own commit history is already the incremental log; encoding Yjs's
own incremental updates *inside* the blob would just duplicate that and
break the simplicity of loading (one blob, one `Y.applyUpdate`, done — no
replaying a chain in the right order).

Alongside the binary snapshot, a `.md` file is regenerated from the same
state on every save, **purely for human legibility** (cgit diffs, `git log
-p`). It is never parsed back in. This resolved an earlier design mistake:
Markdown/HTML/JSON were briefly considered as the *merge* substrate, which
doesn't work — Markdown has no syntax for arbitrary node/mark attributes
(text color, alignment, colspan/rowspan, custom nodes), and JSON diffs/
merges terribly at the git level. Full edit fidelity (every TipTap
extension, present or future) is guaranteed by using Yjs's own binary
format as the source of truth; the export is decorative.

### Branching and merging

- A **branch** = a git branch. `persistence-service`'s `save`/`load` never
  touch the working tree at all (pure object-database plumbing via JGit —
  read a blob straight out of a branch's tree, write a new commit via
  `ObjectInserter`/`DirCache`/`RefUpdate`), so concurrent branches never
  race over a checkout.
- A **merge**: compute `Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))`
  application-side (in `collab-server`, where the Yjs runtime lives) — this
  is unconditional and conflict-free by CRDT construction. The already-
  resolved result is handed to `persistence-service`'s merge endpoint,
  which uses JGit's `MergeCommand` with `MergeStrategy.OURS` to produce a
  real two-parent commit (verified: parent count 2, correct parent SHAs),
  then amends that commit's tree to the actual CRDT-merged bytes while the
  parents stay untouched. Git supplies ancestry; Yjs supplies content. Full
  pipeline (diverge → independent edits → CRDT merge → two-parent commit →
  reload the binary blob from git → identical merged text) verified
  end-to-end with real Yjs docs and confirmed rendering correctly in cgit
  (log, commit detail with both parent links, branch decorations).

## Verified and working

- Realtime collaboration: TipTap + Yjs + Hocuspocus, multiple browser tabs,
  live remote cursors with per-user color/label.
- Sequential `User-N` identity, assigned by `collab-server`.
- A basic formatting toolbar (Bold/Italic/Strike/Code, H1–H3/Paragraph,
  Bullet/Ordered List, Blockquote, Code Block, HR) — StarterKit already
  had all these nodes/marks; the toolbar just exposes them as buttons with
  live active-state highlighting instead of keyboard-shortcut-only.
- Two-tier persistence (fast local volume + periodic git checkpoint), full
  crash-recovery semantics proven via hard `docker kill` tests.
- Git branch/merge mechanics, proven via a standalone JGit test and a full
  Node+real-Yjs end-to-end test against the live stack.
- `git-frontend` (cgit): read-only, mounted `:ro` against the same repo
  volume — log, blame, diff, branch decorations, merge-commit parent links
  all confirmed rendering correctly against real data.
- Resilience: `onLoadDocument`/`onStoreDocument` wrapped so a
  persistence-service hiccup degrades gracefully instead of crashing
  `collab-server` (this happened for real once — see "Incidents" below —
  and is now fixed and covered by a process-level `unhandledRejection`
  handler as a last resort). Every service has `restart: unless-stopped`.

## Not done yet

- No image/asset upload wired to MinIO (MinIO container exists, unused).
- No table markdown-fidelity spike needed anymore — moot now that binary
  Yjs is the source of truth; the Markdown export's fidelity only affects
  how *readable* a diff is, never whether a feature works live.
- No branch-switching UI in the actual editor — the branch/merge mechanism
  is proven at the API/backend level (persistence-service endpoints,
  exercised via direct calls and a test script) but `collab-server` has no
  live "merge these two branches" HTTP trigger wired into normal operation
  yet, and the frontend has no UI for picking a branch at all — still
  hardcoded to `docId: "default"`, branch `master`.
- Links, task lists, tables, images have native representations planned
  (markdown syntax exists for all of them) but aren't added as Tiptap
  extensions yet — StarterKit only.

## Incidents (for context on why some guardrails exist)

- **2026-09-18**: `collab-server` was left calling persistence-service's
  old markdown-only save API after persistence-service was upgraded to the
  binary-snapshot API in the same session. The mismatch caused a 500 from
  persistence-service, which threw inside Hocuspocus's debounced store
  hook as an uncaught rejection and crashed the whole `collab-server`
  process — with no restart policy at the time, the container just stayed
  dead, breaking everything (including `/api/whoami`) until noticed. Fixed
  by: rewiring collab-server to the current API, wrapping both
  `onLoadDocument`/`onStoreDocument` in try/catch so a persistence failure
  can never crash the realtime server again, adding a process-level
  `unhandledRejection` handler as a last resort, and adding
  `restart: unless-stopped` to every service as a second safety net.
