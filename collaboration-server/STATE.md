# STATE

Kept up to date as the project evolves. This is the detailed "what's
actually true right now" doc — README.md is just the quick-start pointer.

Last updated: 2026-09-20.

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

1. **Fast tier** (`live-data` volume, `/data/live/<docId>.base.ydoc` +
   `<docId>.updates.log`): written on every Hocuspocus debounce (8s after
   the last edit, capped at 30s of continuous typing). This is what
   actually protects against data loss — a `collab-server` crash or
   restart can never lose more than the last unsaved debounce window, and
   that window is tiny.

   Each debounced save writes only the **delta** since the last save
   (`Y.encodeStateAsUpdate(doc, lastSavedStateVector)`), appended to
   `<docId>.updates.log` as a length-framed chunk — not the whole document.
   This matters once a document is genuinely large (hundreds of pages):
   re-encoding and rewriting the full state on every ~8s debounce would
   mean write cost scales with total document size, not edit size. Loading
   replays `<docId>.base.ydoc` (if present) followed by every chunk in the
   log, in order, onto a fresh `Y.Doc` — verified correct both from
   log-only (no base yet) and from a compacted base with an empty log.

   The log is periodically **compacted** (merged into a fresh base,
   log truncated to empty) via two triggers: (a) `afterUnloadDocument` —
   the natural "all users logged out" point, cheap since nobody's actively
   editing and the document is about to leave memory anyway; (b) a
   size-based safety net (`COMPACT_LOG_BYTES`, default 5MB) for a long
   session that never fully empties out. Both triggers verified directly:
   forced (a) by disconnecting the only open session and confirming the
   log reset to 0 while the base absorbed its content; forced (b) with a
   tiny 100-byte override and confirming compaction fired mid-session with
   zero disconnects.
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

### Per-edit changelog (who changed what, durably)

**Why we built this:** a single Yjs update chunk, decoded in isolation, turns
out to be more readable than expected — an insertion's actual text
(`ContentString`) and a formatting/attribute change's new value
(`ContentFormat`/`ContentAny`) are both directly visible without needing the
surrounding document (verified: decoded an isolated chunk and found the
literal inserted text and a bold-toggle's new value sitting right in the
struct). Deletions are the exception — a delta only records a tombstone
(`{clock, length}`), never the deleted content itself, so reading a deletion
requires the state as it existed immediately before that chunk.

That raised the real question: could we decode *any* historical chunk this
way, not just ones still sitting in memory? The answer is no, not for free —
our fast tier's **compaction** (merging chunks into a fresh base, see above)
is specifically what breaks this. Once chunks are merged, the individual
per-user boundary between them is gone; there's no way to ask "what did
chunk 2 do" once chunk 2 no longer exists as a distinct thing. So durable
per-edit attribution requires archiving the individual chunks somewhere
*before* compaction discards them — git, since we already checkpoint there
periodically, is the natural place.

**What it costs:** each git checkpoint now commits a third file,
`<docId>.changelog.jsonl` — one JSON line per debounced save since the
*previous* commit on that branch (`{author, timestamp, delta}`, delta
base64-encoded), built from the exact same per-save delta the fast tier
already computes for `<docId>.updates.log` (no extra encoding work, just
also keeping a copy). This is **not** "store the document twice" — the full
snapshot per commit was already happening for an unrelated reason (no
chain-replay risk on load); this adds only the small trail of changes in
that window, bounded by edit volume in ~60s (the checkpoint interval), not
document size. It does mean every chunk between two commits must survive
individually and untouched until archived — pre-merging even one would
silently break attribution for whatever it absorbed.

**What it brings:** git blame's per-line attribution is limited to whichever
commit last touched a line (see the checkpoint-interval trade-off above);
the changelog is a finer-grained, complementary record that survives
independent of checkpoint frequency — "exactly what did User-X change, and
when" for every save, not just "which commit touched this line."

**Verified precisely as intended:** connected once, made an edit, let it
checkpoint (commit N-1), made a second edit, let *that* checkpoint (commit
N). Commit N's changelog held exactly one entry, tagged with its real
author and timestamp. Replaying that single entry onto commit N-1's own
stored snapshot reproduced commit N's content exactly — not just matching
text, but a byte-identical Yjs state vector against commit N's actual
stored snapshot. I.e.: `replay(commit[N-1], changelog[N]) == commit[N]`,
confirmed at the CRDT level, not just visually.

Exposed via `GET /api/documents/:docId/changelog?branch=X` on
`persistence-service` (also folded into the main document-load response).
Note the changelog for a given commit only covers *that* commit's window —
to see further back, walk the branch's commit log and read each commit's
own changelog blob, the same way `git blame` walks history one commit at a
time. `merge()` does not currently write a changelog entry (a merge
commit's "previous commit" is ambiguous — relative to which parent — and
nothing consumes this yet, so it's left as an open question rather than a
guessed-at design).

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

### Conflict detection before committing a merge

`POST /api/documents/:docId/merge` on `collab-server` (`sourceBranch`,
`targetBranch`, `author`) either returns `{merged: false, conflicts: [...]}`
without touching git at all, or performs the merge and commits it, returning
`{merged: true, commitId, parentCount}` — never both, never neither.

**What "conflict" means here, precisely:** the CRDT merge itself *never*
fails or produces an ambiguous result — that's proven in
`tests/unit/merge-conflict-resolution.mjs` (order-independent, never
throws, even across concurrent inserts/deletes/attribute writes). A
"conflict" is not an algorithm failure; it's collab-server's own
`conflicts.js` flagging that the merge *would* silently resolve something
in a way neither side necessarily wanted — the two categories established
in the branching RFC:

1. **Attribute/formatting collisions** — both branches changed the *same*
   node attribute (heading level, text-align, colspan, ...) to *different*
   values since their common ancestor. Yjs resolves this via silent
   last-writer-wins with zero trace of the loser.
2. **Delete-vs-edit** — one branch deleted something the other branch
   concurrently touched (edited, formatted, attached new content to).

**How it's computed** (`GitRepositoryService.findMergeBase`, cross-checked
directly against the real `git merge-base` binary — identical commit SHA):
load the branches' common-ancestor snapshot plus each branch's own current
snapshot, then compare.

- Attribute conflicts are detected by walking the fully-**integrated**
  base/target/source documents directly (matching nodes across all three
  by their stable internal Yjs item id — identical across replicas for
  anything created before the fork) and diffing attribute values, *not* by
  decoding raw update bytes. That was tried first and found unreliable:
  a raw decoded item's `parentSub`/`parent` fields are only populated for
  the *first-ever* write to a key (verified directly) — overwriting an
  *existing* value, the realistic conflict case, encodes as an
  origin-chained item with both fields null instead.
- A second, related trap caught along the way: overwriting an attribute
  value internally tombstones the *old* value in Yjs's own DeleteSet as an
  implementation detail of last-writer-wins (verified directly, and only
  visible after realizing `JSON.stringify` silently renders any `Map` as
  `{}` — it had been hiding the real DeleteSet contents in earlier
  debugging). Without excluding those from the delete-vs-edit check, every
  attribute conflict was double-counted as a phantom deletion too.
- Delete-vs-edit conflicts *are* reliably detected from raw decoded update
  bytes (an item's parent/origin/rightOrigin references are present
  regardless), cross-referenced against the other side's DeleteSet.
- A third false positive, found from real usage rather than a test (see
  the 2026-09-20 incident below): a document's *own prior editing
  history* — content typed and deleted long before either branch
  existed, completely ordinary — still shows up in a from-base-vector
  delta, because Yjs re-signals any deletion the receiving vector
  predates. An unrelated edit whose origin/rightOrigin happened to chain
  near that long-dead position was getting flagged as touching a
  deletion that, from either branch's perspective, never happened. Fixed
  by excluding anything already present in the merge-base's *own*
  DeleteSet from counting as a "new" deletion by either side. Covered by
  `tests/unit/conflict-detection.mjs` Case 5.

**Deliberately not covered:** two branches concurrently formatting the
*same inline mark* (e.g. both toggling bold on overlapping text) without
either side deleting anything. An inline mark's position is established
via origin/rightOrigin chains within the surrounding text, not a stable
parent+key pair, so robustly detecting "same range" needs more analysis
than a single pass covers — left as a known gap rather than a guessed-at
heuristic, documented in `conflicts.js` itself.

**Verified end-to-end against the live stack**, both outcomes: a clean
two-branch divergence (non-overlapping text edits) merged and committed
with a real two-parent commit; a divergence where both branches changed
the same attribute to different values returned exactly one correctly-typed
`attribute` conflict, and — confirmed by comparing the branch tip's stored
snapshot before and after — **master was left completely untouched** by
the rejected merge attempt.

### Branch-aware live editing, and the admin page

Until now, `collab-server` only ever live-edited a single hardcoded branch
(`master`, via a `BRANCH` env var) — branches existed only on the
persistence side, never in the live Hocuspocus layer. A branch dropdown in
the editor needed that to become real, not decorative.

**The branch is encoded directly into the Hocuspocus document identity**
(`docId@branch`, e.g. `default@feature-x`) rather than treated as a
per-connection parameter, because it has to be: Hocuspocus's whole model is
one shared `Y.Doc` per document name, and two people can't collaboratively
co-edit two diverged branches as if they were the same live document.
`server.js`'s `parseDocumentName` splits on `@`, defaulting to `master` for
old-style plain docIds so nothing already connected breaks. This is also
why the fast tier needed no changes at all: `documentName` (now the
combined `docId@branch` string) was already its file-naming key, so
different branches automatically get separate fast-tier storage for free.

Switching branches in the UI is a full page navigation
(`?branch=<name>`), not a live in-place swap — deliberate, not a shortcut:
it gives a clean reconnect (new Hocuspocus room, fresh `onLoadDocument`)
for free instead of needing to manually tear down and rebuild the
Yjs doc/provider/editor triplet in place.

**The admin page** (`admin.html`, linked from the editor) creates branches
and merges them, using only the existing APIs — `GET`/`POST /api/branches`
on `persistence-service` and `POST /api/documents/:docId/merge` on
`collab-server` (the conflict-detecting one, not persistence-service's
lower-level commit-only merge endpoint). A conflict response renders as a
table (type, attribute, both sides' values) rather than raw JSON.
(**Superseded 2026-09-24**: `admin.html`/`admin.js` deleted along with the
single-tenant model they were built against -- `admin-mt.html` is now the
one admin page. This paragraph stays as the historical record of why CORS
was added below.)

This required one real backend addition: `persistence-service` had no CORS
configuration at all, so the browser would have silently blocked every
cross-origin call from the frontend (`:8085`) to `persistence-service`
(`:8081`) even though `collab-server` (`:3000`) already had `cors()`
enabled for the merge endpoint. Added a `CorsConfig` bean, verified via a
real headless browser (not curl, which doesn't enforce or reveal CORS at
all).

**Building this surfaced the merge() data-loss incident below** — the
branch dropdown loading empty content on its very first real exercise is
what exposed it. Worth naming plainly: that bug predates this feature and
would eventually have surfaced some other way, but it was this change that
actually triggered and caught it.

### Image upload (drag-and-drop → Artifact Keeper)

**Goal, per the RFC that shaped this:** store images/binaries outside git
entirely and keep only a read-only *reference* (a URL) in the document.
Editing an inserted image's pixels in place was never a requirement — a
TipTap `Image` node is already an atom node the user can't edit inline, so
no locking mechanism was needed beyond that. Drag-and-drop is the only
insertion path built (no toolbar button/URL-prompt), per explicit scope.

**Storage backend: [Artifact Keeper](https://github.com/artifact-keeper/artifact-keeper)**,
an open-source self-hostable artifact registry, chosen over building a raw
object-store integration from scratch. Deployed trimmed to just what its
backend hard-depends on to boot — Postgres (with self-signed TLS, the
backend requires `sslmode=require`) + OpenSearch (`DISABLE_SECURITY_PLUGIN`)
— dropping the upstream getting-started compose's Trivy/OpenSCAP/
Dependency-Track scanners, the Next.js web UI, and Caddy (irrelevant to
storing an inserted image; direct port publishing replaces Caddy's routing
role for a local prototype). No auth hardening beyond what the backend
itself refuses to skip (see incidents below) — real auth (Keycloak) is a
later, separate concern, per explicit instruction for this prototype.

**Data flow:** `frontend/src/main.js`'s `editorProps.handleDrop` intercepts
TipTap's drop handling before its default runs, filters to image files,
and — because the upload is a real async round trip — sets the editor's
**text selection** synchronously at drop time
(`editor.chain().focus().setTextSelection(pos).run()`) rather than holding
onto the raw captured `pos` across the `await`. Verified directly why this
matters: a raw position captured before the async gap can drift (further
edits, doc growth) and lands the image in the wrong place or silently
nowhere. Once the upload resolves, TipTap's own `setImage({src, alt})`
command inserts at the *current* selection, sidestepping the staleness
entirely. The browser never talks to Artifact Keeper directly — it POSTs
raw bytes to `collab-server`'s `/api/upload`, which holds the admin
credential server-side (`artifactKeeperClient.js`) and returns a public,
anonymously-downloadable URL. That URL string is the only thing that ever
enters the Yjs document; the image bytes never touch Yjs or git.

**Repository setup:** a single `editor-assets` generic repository, created
`is_public: true` + `allow_anonymous_access: true` via a follow-up `PATCH`
(the real field names — a guessed `"public": true` on creation is silently
ignored) so a plain `<img src>` can fetch it with no auth header at all
(essential: `<img>` tags can't send an `Authorization` header).

**Token handling:** `artifactKeeperClient.js` caches the access token
(`expires_in`, 60s safety margin) rather than logging in fresh per upload —
Artifact Keeper rate-limits its login endpoint, and a real user dragging a
few images into one session would otherwise risk tripping it. A 401 *or*
403 on the actual upload triggers exactly one forced-fresh-login retry
before giving up (403's reason: see incident below).

**Verified end-to-end** via a real headless-browser test (Playwright,
simulated OS-level drag/drop event sequence onto a live `.ProseMirror`
element, not a synthetic transaction): the `<img>` element lands in the
DOM with a `src` pointing at Artifact Keeper, that URL resolves with no
auth header (`200`), and the returned bytes are byte-identical to the
dropped file.

## RFC: multi-tenant scale (agreed direction, not yet built)

**The question this answers:** the current model is one shared git repo
(`repo-data`, no customer/tenant concept at all) with a flat `docId@branch`
namespace. That's fine for a single-customer prototype, but doesn't hold up
at "hundreds of customers, each with hundreds of documents, in different
languages and branches" — specifically for *querying*: "show me all
branches for customer X," "show docs for customer X," "show the branches
of doc Y." Git has no secondary indexes; answering these from raw git
alone means linear-scanning ref names against some naming convention, which
doesn't extend to real filtering (by language, recency, etc.) and gets
slower as the ref count grows across every tenant sharing one repo.

**Decision: keep git as a pure content-addressable snapshot/history store
(same separation of concerns as "What's actually stored in git, and why"
above), and add a real Postgres index that `persistence-service` maintains
alongside every git write.** Git remains authoritative for document
content and history; Postgres exists purely to make "show me X" queries
fast and expressive, and is treated as a rebuildable cache of what git
already contains — never the other way around.

**Repo topology: one bare-in-spirit git repo per customer** (technically
non-bare on disk like today's single repo, but never checked out — see
below), sharded on disk to avoid one flat directory at scale:
`/data/repos/<customerId[0:2]>/<customerId>.git`. None of the example
queries cross a customer boundary, so per-customer repos give free tenant
isolation (natural access-control boundary, independent backup/restore,
no risk of one customer's ref namespace colliding with another's) at the
cost of operating hundreds of repos instead of one — the same shape
GitHub/GitLab already solve, and for the same reason: they don't query raw
git refs for their own UI either, they maintain their own DB index over
git and use git purely for object storage.

~~**Document identity includes language**: `("onboarding-guide", "en")`
and `("onboarding-guide", "de")` are two independent documents with
independent branch histories, not two branches of one document.~~
**Superseded 2026-09-23 — see "REVISED: version/language model" below.**
This was flagged at the time as the biggest assumption in the design,
explicitly pending revisit "if translation workflows turn out to need
shared history between language variants" — that revisit happened, and
the assumption was wrong. Left here, struck through, for the same reason
this project keeps every other corrected misreading on record rather than
quietly rewriting history (see CLAUDE.md's "no guessing, ever" section).

~~**Branch ref naming stays self-describing**, not just index-dependent:
`refs/heads/docs/<docId>/<language>/<branchName>`~~ — the ref shape
changed too (language dropped from it entirely); see the revision below
for the current one. The *principle* — ref naming stays self-describing,
not solely dependent on the index — still holds, only the shape changed.

**Descriptive metadata (doc title, etc.) lives in git too, written once,
not only in Postgres**: a `<docId>.meta.json` committed at
`createDocument` time, alongside `<docId>.ydoc`/`.md`. This metadata is
effectively read-only in practice (a title rename is a hypothetical future
feature, not a current need — build that encoder only if it's ever actually
needed, same reasoning as everywhere else in this codebase), so writing it
once and treating it as immutable is a deliberate, low-cost decision, not
a limitation. Every branch forked afterward inherits the file automatically
via ordinary git ancestry — no per-branch rewrite needed — so the
reconciliation sweep (see the RFC addendum below) can recover full document
identity, including title, from *any* branch's tip tree alone, closing what
was otherwise a real gap: without this, a lost `document_created` event
with no surviving outbox row would reconcile structure correctly but lose
the title permanently, since nothing in the git ref/branch naming scheme
itself carries it. The same idea extends to the customer level — a
`_customer.meta.json` at repo root, written once at `createCustomer` — with
a nice side effect: even a fully-lost `customers` table becomes
reconstructable by scanning `/data/repos/**/*.git` and reading each repo's
own metadata file, not just its documents/branches.

### REVISED 2026-09-23: version/language model, readable IDs (built, live)

Two real design changes from real usage, both implemented and verified
against the live stack (not just discussed) — see "Java scaffolding"
below for the verification detail.

**A version (branch) is a unit of change that may touch several
languages over its lifetime, not a per-language branch namespace.** The
actual workflow: an existing master document changes at some point in
time, and that change must eventually be reflected in every translated
version too — sooner or later, not necessarily all at once. A version
typically starts by changing one language (often master's own) and picks
up translations incrementally as they're done, all within the *same*
version, until merging to master means "every language is ready to ship,
finalize and freeze." Keeping one commit as the bracket around every
language's state at that point is what makes that in-flight, partially-
translated state coherent — splitting it across independent per-language
branches would mean tracking and eventually reconciling N separate
histories for what's really one unit of work.

Concretely: `DocumentRef` shrank from `(customerId, docId, language)` to
just `(customerId, docId)` — language is no longer part of document
identity, it's a parameter alongside `versionName` on the content methods
(`load`/`save`/`merge`) instead, since it's a property of what a
version's tree currently contains, not of which branch history it
belongs to. Ref naming dropped the language segment:
`refs/heads/docs/<docId>/<versionName>`. Tree layout: `<docId>/meta.json`
is now document-level (not per-language), sitting alongside however many
`<docId>/<language>/{content.ydoc,content.md,changelog.jsonl}`
subdirectories that version's tree currently has — which can differ
commit to commit as translations land. `GitDocumentStorageService`'s
existing `buildTreeWithOverride` (carries forward every path not being
overridden) already made this work with zero changes to that method —
languages coexisting and evolving independently within one version falls
out of it for free. A new `listLanguages(doc, versionName)` walks a
version's tree (JGit `TreeWalk.forPath` positioned at the doc directory,
then a non-recursive child walk) to answer "which languages does this
version have."

**Customer and document IDs are readable, git-URL-friendly slugs (e.g.
`acme-corp`), not UUIDs** — the repo directory name itself
(`/data/repos/<customerId>.git`) is human-legible, matching what a repo
listing should look like. This also **dropped the sharding scheme**
entirely (`/data/repos/<id[0:2]>/<id>.git` → flat `/data/repos/<id>.git`):
sharding by a readable name's leading characters clusters badly (company
names aren't uniformly distributed the way a UUID's random bytes are),
and a flat directory of a few hundred repos is fine on any modern
filesystem — not worth a hash-based sharding scheme to solve a problem
that doesn't meaningfully exist at this scale. `Customer.id` (the Postgres
entity) changed from `UUID` to `String` to match, and `CustomerMeta`
dropped its now-redundant separate `slug` field (the id *is* the slug).

### Reconciliation sweep (addendum, agreed but not yet built)

Beyond the outbox's fast path (write to Postgres immediately after the git
write succeeds), a periodic sweep is the actual durability guarantee —
the outbox row itself isn't atomic with the git write (they're two
different systems), so if Postgres is unreachable at that exact instant,
neither the direct index update nor the outbox insert happens, and
nothing is left to retry from except git itself. Two cadences, mirroring
the pattern already built and verified for `collab-server`'s own
git-checkpoint retry (see "Verified and working" above): a startup sweep
(catches drift from whenever `persistence-service` was last down) and a
coarser periodic full sweep (every 10–15 min, not seconds — ref reads are
cheap individually but adds up across hundreds of repos on a tight
interval, and the outbox already covers the common case).

For each `ready` customer, list every ref under `refs/heads/` and its tip
SHA, then diff against `branches`: a ref with no matching row is an
INSERT (recovering `docId`/`language`/`branchName` from the ref path, and
now the title too, from that branch's `<docId>.meta.json`); a row whose
`head_commit_sha` doesn't match the ref's actual tip is an UPDATE; a row
whose ref no longer exists is a DELETE. No locking needed — a ref that's
mid-update during a sweep just means that row is briefly one commit
behind, caught on the next pass or the normal write path either way. Log
every actual correction, stay silent on no-ops — an unusually high
correction rate is itself the signal that the outbox/direct-write path
needs attention.

### Postgres schema

Updated 2026-09-23 to match the revised version/language model above —
`documents` dropped its `language` column/constraint entirely (language
moved to being a `branches`-adjacent concern, discoverable per-version via
`listLanguages`, not a Postgres-indexed dimension yet — see "Open topics"),
and `customers.id` is the readable slug itself (`TEXT`, no separate `slug`
or `repo_path` columns — the latter is trivially `'/data/repos/' || id ||
'.git'`, not worth storing):

```sql
CREATE TABLE customers (
  id           TEXT PRIMARY KEY,       -- readable, git-URL-friendly (e.g. "acme-corp")
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | ready | archived
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  doc_id      TEXT NOT NULL,           -- stable slug, e.g. "onboarding-guide"
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, doc_id)
);

CREATE TABLE branches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id),
  version_name    TEXT NOT NULL,       -- leaf name, e.g. "review-q3"
  git_ref         TEXT NOT NULL,       -- refs/heads/docs/onboarding-guide/review-q3
  is_default      BOOLEAN NOT NULL DEFAULT false,
  head_commit_sha TEXT,                -- kept in sync by persistence-service after every write
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_name)
);

CREATE INDEX idx_documents_customer ON documents(customer_id);
CREATE INDEX idx_branches_document  ON branches(document_id);
```

This directly answers the three motivating queries as plain joins, no
ref-name parsing at query time: versions for a customer is
`branches JOIN documents … WHERE customer_id = ?`; docs for a customer is
`documents WHERE customer_id = ?`; versions of a doc is
`branches WHERE document_id = ?`.

### New API surface (on `persistence-service`)

- **Customer/repo lifecycle**: `createCustomer(customerId, displayName)` —
  `customerId` is caller-supplied (the readable slug), not generated —
  folds what was originally asked as `createRepo(Customer)` into one call:
  inserts the row as `provisioning`, `git init`s the repo at
  `/data/repos/<customerId>.git`, flips to `ready`. A two-phase status
  column instead of a separate call means a crash mid-provisioning is
  visible and retryable rather than silently inconsistent. Plus
  `getCustomer`, `listCustomers(filter?)`, `archiveCustomer` (soft-delete
  only — hard repo deletion stays a separate, explicitly-confirmed
  operation, same caution as the 2026-09-22 volume wipe below).
- **Document lifecycle**: `createDocument(DocumentRef, meta)` — one git
  commit seeding an empty master version (no language content yet) and
  recording identity together (see "REVISED" above for why these aren't
  two separate calls), plus the matching Postgres rows. Plus
  `listDocuments(customerId)`, `getDocument(customerId, docId)` — neither
  takes a language filter anymore, since language isn't part of document
  identity.
- **Version lifecycle**: `createVersion(DocumentRef, versionName,
  fromVersionName)`, `deleteVersion(DocumentRef, versionName)` (renamed
  from createBranch/deleteBranch during implementation — "branch" only
  survives where it's genuinely git-specific now; we had no equivalent of
  delete at all before this RFC — the 2026-09-22 "reset everything"
  request had to fall back to a full Docker volume wipe because no
  branch-delete API existed), `listBranches(customerId, docId?)` (the
  general-purpose query behind all three motivating lookups), and
  `mergeBranch(DocumentRef, source, target, language, author)` — same
  conflict logic `conflicts.js` already has, scoped to the customer's repo
  and one language within that version.
- **Languages**: `listLanguages(DocumentRef, versionName)` — new, not
  Postgres-backed at all (see "Open topics"): walks that version's tree
  directly.
- **Content**: `load(DocumentRef, versionName, language)`/
  `save(DocumentRef, versionName, language, ...)` — `save` additionally
  updates `branches.head_commit_sha` and `documents.updated_at` after the
  git write succeeds.

`DocumentRef(customerId, docId)` bundles the two-string identity that
used to be repeated across nearly every method above — see "REVISED"
above for why it no longer includes language.

### Consistency caveat

Git and Postgres are two systems with no free atomic transaction across
both. The rule has to be **git write first, index update second** — if
the index update fails, git is still correct and a background
reconciliation job (walk each repo's refs, diff against `branches`) can
self-heal the gap. Never the reverse order, or the index could claim a
branch exists that git never actually got.

### Confirmed: today's single repo is already git-object-only, no working-tree clone

Directly relevant groundwork already in place for this RFC, verified by
reading `GitRepositoryService.java` and inspecting the running container:
`persistence-service` opens the repo via
`Git.init().setDirectory(repoRoot.toFile())` (non-bare on disk, matching
today's single-repo setup) but never calls `checkout()` or touches a
working tree anywhere in the current code — confirmed no `git` binary
even exists in the container, so there's no way it could be shelling out
to one either. Every read/write goes through JGit's object-database API
directly (`ObjectInserter`/`DirCache`/`RefUpdate`), the same pattern this
RFC's multi-repo design assumes. `collab-server` never touches git or a
filesystem clone at all; it only talks to `persistence-service` over
HTTP — there is exactly one copy of the repository, not a clone plus a
working copy some other service reads from.

### Java scaffolding — storage layer now LIVE, index/orchestration layer still dormant

**Status changed 2026-09-23: `GitDocumentStorageService` and a new
`MultiTenantAdminController` are genuinely live**, serving real HTTP
traffic behind a real UI (`admin-mt.html`) — not just compiled-but-unused
scaffolding anymore. `DocumentIndexService`/`DocumentPersistenceCoordinator`/
`OutboxWorker`/`GitReconciliationService` (the Postgres-backed layer)
remain exactly as dormant as before — nothing about their status changed,
only the git-storage layer graduated. See "Verified and working" below
for what's actually been exercised against the live stack.

The layered design (`DocumentStorageService` interface hiding git
internals behind private methods, `DocumentIndexService` shielding the
Postgres repositories, `DocumentPersistenceCoordinator` as the one place
that sequences a git write then an index update, `OutboxWorker` and
`GitReconciliationService` for the two failure-recovery tiers) is written
as real, final-shape Java under `backend/persistence-service/src/main/
java/.../persistence/{storage,index,orchestration,reconcile}/` plus the
live `MultiTenantAdminController` directly under `.../persistence/` — not
pseudocode. Verified by actually compiling it (`docker build --target
build`, a separate tag from the live image, never touching the running
container) after every change below, not just the first pass: all 26
source files build clean, jar packages, Spring Boot repackages.

**Refined through several rounds of real feedback after the first pass**,
each verified by recompiling, not just eyeballed:
- `DocumentRef(customerId, docId, language)` replaces the repeated
  three-string parameter group that used to appear on nearly every
  `DocumentStorageService`/`DocumentPersistenceCoordinator` method.
- `initCustomer(customerId, meta)` and `createDocument(doc, meta)` fold
  what were originally two separately-callable primitives each
  (`initRepo` + a standalone `writeCustomerMeta`; a standalone
  `writeDocumentMeta` + an empty `save()`) into one atomic git commit
  apiece. They were never legitimately called independently of one
  another, and exposing them separately invited a caller to leak *how*
  git durably records identity (a file every branch inherits via
  ordinary ancestry) as if that were itself a generic storage primitive.
  `readDocumentMeta` was demoted off the interface entirely for the same
  reason — its only caller, `GitReconciliationService`, is already
  explicitly typed to the concrete git class, not the interface, so
  keeping it on the interface never bought anything.
- `createBranch`/`deleteBranch` renamed to `createVersion`/
  `deleteVersion` everywhere they meant "a named line of history you can
  save to," across `DocumentStorageService`, `GitDocumentStorageService`,
  `DocumentPersistenceCoordinator`, and `DocumentIndexService` — "branch"
  now survives only where it's genuinely git-specific (ref paths, the
  git-only `GitDocumentStorageService.listAllRefs`/`findMergeBase` extras,
  `GitReconciliationService`'s own ref-parsing).
- No method on `DocumentStorageService` declares a checked exception —
  forcing every implementation (including a fake test one with no real
  I/O to fail) and every caller (most of whom can't meaningfully recover
  from a storage failure) to handle a failure mode that's really an
  implementation detail was never the interface's job. `GitDocumentStorageService`
  funnels every method body through a small `unchecked(message, lambda)`
  helper that catches whatever JGit/Jackson/java.io actually throws and
  rewraps it as the new unchecked `StorageException`; a `RuntimeException`
  already thrown deliberately inside a method body (e.g. "branch already
  exists") passes through unwrapped, not double-wrapped.
- `ReconciliationService` renamed to `GitReconciliationService`, and its
  constructor now takes the concrete `GitDocumentStorageService` instead
  of the generic `DocumentStorageService` interface — reconciliation is
  inherently about diffing an actual git repo's ref state, not a generic
  storage concern, so pretending otherwise was the wrong shape.
  `listAllRefs` moved off the interface to match, same category as
  `readDocumentMeta`/`findMergeBase`.
- Git-specific vocabulary was audited out of every generic layer's
  *public* surface (interface method/parameter names, the `Branch`
  entity's `versionName` field, its `BranchRepository` query method) —
  see "Open topics" below for the two spots (`Branch.headCommitSha`,
  `MergeOutcome.commitId`) explicitly left as-is or still undecided.

**The Postgres/index/orchestration layer stays deliberately dormant**, per
this project's own small-iterations rule — only the git-storage layer
went live, and even that never touched the currently-running single-tenant
app (`GitRepositoryService`, `DocumentController`), which is completely
untouched, not modified or replaced. Concretely:
- `spring-boot-starter-data-jpa` + the Postgres driver were added to
  `pom.xml` so the index/orchestration/reconciliation layer compiles as
  real JPA code, but `application.yml` explicitly excludes
  `DataSourceAutoConfiguration`/`HibernateJpaAutoConfiguration`/
  `JpaRepositoriesAutoConfiguration` — without that, merely having the
  starter on the classpath makes Spring Boot try to auto-create a
  `DataSource` at startup with no Postgres container to point at, which
  would have broken the currently-running app the next time it restarts.
- `GitDocumentStorageService` is `@Service`-annotated and **now actually
  used** — `MultiTenantAdminController` (new, also directly under
  `.../persistence/`) depends on it directly, bypassing
  `DocumentIndexService`/`DocumentPersistenceCoordinator` entirely on
  purpose (STATE.md's own explicit scoping: "omit postgres and all other
  stuff right now, just make admin-ui compatible with existing classes").
  Customer/document/version/language listing is derived live from git on
  every request (`listCustomerIds`/`listAllRefs`/`listLanguages`) — real,
  verified behavior at this prototype's scale, not the fast indexed path
  the full RFC design eventually wants.
  `DocumentIndexServiceImpl`, `DocumentPersistenceCoordinator`,
  `OutboxWorker`, and `GitReconciliationService` are still deliberately
  **not** Spring-annotated — they depend on the Spring Data repository
  beans that don't exist while JPA autoconfiguration stays excluded, and
  `@SpringBootApplication`'s default component scan would otherwise try to
  instantiate them at boot regardless of whether any controller calls
  them, failing startup. The remaining wiring step for *that* layer, once
  a real Postgres container exists and the exclusion is lifted, is
  unchanged from before: add `@Service`/`@Component` to those four
  classes, and point a controller at `DocumentPersistenceCoordinator`/
  `DocumentIndexService`.
- Two real bugs were caught and fixed during the first pass by actually
  compiling and reasoning through the write paths, not just writing code
  and reading it back: `Customer`'s client-assigned id (needed before the
  first save, to derive the repo path) made Spring Data JPA's default
  insert-vs-update detection wrong until it was made to implement
  `Persistable` explicitly; and `upsertBranch`/`upsertDocument` originally
  saved the caller's fresh transient instance directly, which would have
  collided with the unique constraint on every call after the first for
  the same version/document — fixed to look up the existing row by
  natural key and update it in place.
- **A missing persistent volume, found the hard way (2026-09-23)**: the
  `docker-compose.yml` volume for the single-tenant repo (`repo-data:
  /data/repo`) was never mirrored for the new multi-tenant repo root
  (`/data/repos`, plural) — every customer repo created by
  `MultiTenantAdminController` was living only in `persistence-service`'s
  ephemeral container layer and would have vanished on the next rebuild.
  Caught while verifying `listLanguages` (below), not by inspection —
  fixed by adding a `repos-data:/data/repos` volume, same pattern as the
  existing one.
- **`listLanguages` verified against real, independently-created git
  content, not just its own round-trip** — and that verification surfaced
  a real testing-methodology hazard worth recording: injecting content via
  an external C-git client (`alpine/git`) into the same bare-ish repo
  *while* `persistence-service` (JGit) was still running produced a
  corrupted ref state (refs silently vanished). Stopping
  `persistence-service` first, injecting via the external client against
  a fully idle repo, then restarting, worked cleanly and is now the
  established pattern for this kind of cross-implementation verification —
  never mix JGit and a live C-git process against the same repo
  concurrently, even read-only-looking operations.

### Open topics on the RFC scaffolding (deliberately unresolved — read before touching this code)

**Why any of this exists at all:** the motivating problem (see "RFC: multi-tenant
scale" above) is that "hundreds of customers × hundreds of documents ×
languages × branches" makes git alone unusable for *querying* — "show me
all branches for customer X," "docs for a customer," "branches of a doc"
have no git-native answer beyond a linear ref scan by naming convention.
The scaffolding below exists to answer those queries from Postgres while
keeping git as the sole source of truth for content and history — nothing
here is scope creep, all of it traces back to that one query problem.

Several follow-ups were raised and explicitly **not** decided yet, on
purpose — noted here so the reasoning (and the fact that a decision is
still pending, not forgotten or silently abandoned) survives even if this
thread isn't picked back up for a while:

- **`Branch.headCommitSha`** (the JPA entity field, `index/entity/Branch.java`)
  still names a git-specific concept (a commit SHA) on what's meant to be
  a storage-agnostic Postgres index row. Flagged, genuinely left
  undecided — the last round of instructions covered items 2–11 of a
  numbered list but skipped item 1 (this one) without saying so
  explicitly, so it's being carried forward as open rather than assumed
  either way.
- **`MergeOutcome.commitId`** — same git-specific naming issue, but
  **deliberately kept as-is for now**, a real decision (not an oversight):
  unlike everything else in this RFC pass, `MergeOutcome` isn't new/dormant
  code — it's already live, consumed today by `GitRepositoryService.merge()`,
  `collab-server`'s `mergeBranches.js`, and the branch-admin UI's conflict
  display. Renaming it means touching shipped, working code across two
  languages, not just inert scaffolding — a higher-risk change than
  anything else in this pass, explicitly deferred to a separate, more
  careful pass rather than bundled in here.
- **Wiring the scaffolding into the live app is explicitly not being
  pursued right now** (a real "ignored for now," not an oversight): no
  Postgres container in `docker-compose.yml` for the index yet;
  `DocumentIndexServiceImpl`/`DocumentPersistenceCoordinator`/
  `OutboxWorker`/`GitReconciliationService` still lack `@Service`/
  `@Component`; `DocumentController` still talks only to the old
  single-repo `GitRepositoryService`; the JPA autoconfiguration exclusion
  in `application.yml` hasn't been lifted; `OutboxWorker`/
  `GitReconciliationService` have no `@Scheduled` cadence. All of this is
  one coherent next step (see "Java scaffolding exists and compiles"
  above for exactly what that step is), deliberately not started until
  it's actually prioritized — this project's small-iterations rule means
  proving the scaffolding compiles and reasons correctly first, wiring it
  live second, not both in the same pass.
- **`OutboxWorker.applyCustomer`** doesn't reconstruct `status` on retry
  (a retried customer always lands as `PROVISIONING`) — accepted as a
  known simplification, revisit only if a real scenario needs status to
  survive a retry.
- **The fake in-memory `DocumentStorageService` implementation** that the
  interface's own javadoc justifies its existence by (unit-testing
  merge/conflict logic without a real git repo) doesn't exist yet either
  — nothing has actually exercised that promised testability benefit so
  far.

## Verified and working

- **Single-tenant model retired entirely; `DocumentController` rebuilt onto
  `DocumentStorageService`** (2026-09-24) — a multi-step RFC-then-implement
  refactor prompted by "`DocumentController` is strictly bound to
  `GitRepositoryService`. Do not like it." The end state:
  - `DocumentStorageService` gained five methods that used to be either
    concrete-only extras or missing entirely: `listDocuments`,
    `listVersions`, `loadChangelog`, `history` (blame), `findMergeBase`.
    The dividing line settled on for what belongs on the generic interface
    vs. stays git-specific: "could a different backend answer this in its
    own way" (yes for all five -- any version-aware store needs to answer
    "what documents/versions exist," "who touched this line," "where did
    these diverge"), not "does today's implementation happen to use git
    for it." What stayed off the interface: `readCustomerMeta`,
    `readDocumentMeta`, `listCustomerIds`, `listAllRefs`, `deleteCustomer`
    -- raw metadata reads and whole-customer enumeration/deletion really
    are implementation-specific admin operations.
  - `DocumentController` rebuilt from scratch: constructor takes only
    `DocumentStorageService`, no git type crosses the boundary anywhere in
    it, every endpoint is `customerId`/`docId`/`versionName`/`language`-
    shaped. Covers documents, versions, languages, content (load/save),
    changelog, history, merge-base, and merge -- the full tenant-scoped
    content API a JWT-authenticated editing session would use in the real
    flow (JWT resolves customerId; the client's own session already knows
    document/version/language).
  - `MultiTenantAdminController` shrunk to exactly `listCustomers`/
    `createCustomer`/`deleteCustomer` -- platform/ops customer lifecycle,
    the one thing a regular user's JWT would never self-authorize, unlike
    everything that moved to `DocumentController`. Still bound to the
    concrete `GitDocumentStorageService` (needs the metadata/enumeration
    extras above).
  - `GitRepositoryService` deleted outright, along with the single-tenant
    `/data/repo` volume (`docker-compose.yml`), its `repo.path` config
    (`application.yml`), and its `cgitrc` entry -- `GitDocumentStorageService`
    is now the only storage implementation in the app.
  - `collab-server` rewired to match: `persistenceClient.js` simplified
    back to one `loadSnapshot`/`saveSnapshot`/`findMergeBase`/`commitMerge`
    set (no more `Tenant`-suffixed duplicates now that there's only one
    model), `server.js`'s `parseDocumentName` dropped the `mt:` prefix
    (no longer needed once there's nothing to distinguish from) and the
    legacy `docId@branch` fallback entirely, `mergeBranches.js` and its
    HTTP route now take `customerId`/`versionName`/`language` throughout.
  - `frontend/src/main.js`: dropped the "(legacy single-tenant)" dropdown
    entries; the flattened dropdown is purely customer/document/version
    now. Added two states the old code never needed: no `?doc=` at all
    now defaults to the first available document (reflected into the URL
    via `history.replaceState`, not a reload) instead of falling back to
    a guaranteed-to-exist "default" document, and zero documents
    provisioned anywhere shows "No documents yet -- create a customer and
    document via /admin-mt.html" instead of trying to connect to a bogus
    room.
  - **Real bug found by testing, not by reasoning about the code**: the
    interface's `load(doc, versionName, language)` couldn't actually back
    `collab-server`'s pre-merge conflict detection, because merge-base
    loading needs the content *as of an arbitrary commit* (the merge-base,
    which has no version name of its own), and `versionName` was always
    resolved as `refs/heads/docs/<docId>/<versionName>` -- a raw commit
    SHA passed in that slot would just fail to resolve as a ref path.
    Fixed in `GitDocumentStorageService.load()`: try resolving as a named
    version first, then fall back to resolving `versionName` itself as a
    raw revision -- matches how `save()`/`createVersion()`/`findMergeBase()`
    already document their return values as "opaque identifiers" a caller
    can hand back in.
  - **Also found while deploying**: leftover fast-tier files
    (`/data/live/*.base.ydoc`/`.updates.log`) from before this refactor
    used the old room-name shapes (`default@master`, the old `mt:`-
    prefixed form) -- the new `parseDocumentName` doesn't special-case
    `mt:` anymore, so it silently became part of a wrong `customerId`
    (`"mt:cust-001"` instead of `"cust-001"`), and the startup-reconcile
    sweep picked these up and repeatedly failed to checkpoint them (HTTP
    500, customer not found). Deleted the stale files directly (all five
    were pure test debris or already safely checkpointed to git under
    their correct customerId, verified before deleting) and restarted
    `collab-server` to drop the matching in-memory entries. One lingering
    stale `mt:`-prefixed connection persisted through the restart, almost
    certainly a leftover open browser tab from earlier this session
    reconnecting via HocuspocusProvider's auto-reconnect -- not a code
    issue, expected to clear once that tab closes/refreshes.
  - Verified at every step: `docker build --target build` compile checks
    after each of the six sub-changes (interface+impl, `DocumentController`
    rewrite, `MultiTenantAdminController` strip-down, `GitRepositoryService`
    deletion, `collab-server` rewiring, `frontend` rewiring) before ever
    deploying; full curl coverage of every moved/new endpoint (documents,
    versions, languages, content, changelog, history, merge-base, and
    master-deletion protection); a real headless-browser session covering
    both the no-`?doc=` auto-pick path and an explicit `?doc=` path,
    typing, checkpoint landing in git, and visibility via both the new
    `DocumentController` content endpoint and cgit directly.
  - `frontend/admin.html`/`admin.js` (the standalone single-tenant branch-
    admin page, non-functional once the endpoints it called were gone)
    deleted outright -- `admin-mt.html` is the one admin page now, its
    stale "back to branch admin" link and "prototype"/"multi-tenant"
    framing (nothing left to distinguish from) cleaned up to match.
  - `tests/integration/branch-merge-e2e.mjs`, `merge-with-conflict-
    detection.mjs`, and `changelog-replay.mjs` all called the now-gone
    single-tenant HTTP shape directly against `persistence-service:8081` --
    checked first whether the existing unit tests (`conflict-detection.mjs`,
    `merge-conflict-resolution.mjs`) covered the same ground before touching
    anything: they don't (grep confirms zero unit tests call `fetch` at
    all -- they're pure in-memory Yjs logic, never exercising git or HTTP),
    so all three were updated to the customer/document/version/language
    shape rather than deleted. `merge-with-conflict-detection.mjs` in
    particular contains `testMergePreservesUnrelatedDocs`, a named
    regression test for the real 2026-09-19 incident (an earlier `merge()`
    silently dropped an unrelated document's content from the resulting
    commit's tree) -- deleting it would have removed the one thing still
    guarding against that regression recurring. The regression maps
    directly onto the multi-tenant model: merging one docId's version must
    not touch a different docId's content in the same customer's repo.
    `changelog-replay.mjs` needed one structural change beyond the URL
    shape: the content endpoint no longer returns markdown (see
    `DocumentController`'s own comment on why), so checkpoint-detection
    switched from polling on markdown-string changes to polling on the
    ydoc bytes themselves -- a more direct signal anyway, since markdown
    is derived from the ydoc, not the other way round. All three run
    against `node:20-alpine` (no local `node` in this environment) with
    `--network host` against the live stack and pass end to end, including
    the regression check (`bystander ydoc unchanged: true`) and the
    changelog-replay's byte-for-byte state-vector match.

- Multi-tenant admin prototype (`admin-mt.html`, `MultiTenantAdminController`,
  `GitDocumentStorageService`) — customer creation (readable id + display
  name), customer deletion (`deleteCustomer`, `DELETE /api/mt/customers/
  {customerId}`), document creation, version create/delete (master
  protected), and language listing per version, all live and derived
  straight from git (no Postgres). Verified end-to-end: full curl
  lifecycle tests, real headless-browser interaction through the actual
  UI panels, and `listLanguages` specifically checked against content
  injected by an independent git client (not just round-tripped through
  this app's own write path) — see "Java scaffolding" above for the
  corruption hazard that verification surfaced and how it was worked
  around.
  - Unlike `deleteVersion` (which refuses to delete `master`, since that
    would orphan a document's history), `deleteCustomer` has no
    equivalent guard — deleting a whole customer takes everything
    (every document, version, and commit) with it atomically by design,
    since there's nothing left to orphan. The confirmation dialog in
    `admin-mt.js` is the only safety net, and its wording spells out the
    full blast radius rather than reusing `deleteVersion`'s shorter text.
  - Verified via curl: created a customer with a document in it, deleted
    the customer, confirmed it's gone from `GET /customers` and its repo
    directory is actually removed from `/data/repos` on disk (not just
    hidden from listings). Verified via headless Playwright: create →
    select → delete button → confirm-dialog text asserted → dropdown
    updates → result message shows.
  - Side finding, not fixed (pre-existing, not introduced by this
    change): `GET /customers/{customerId}/documents` for a customerId
    with no repo (e.g. right after deletion, or just a typo) returns
    HTTP 500 rather than 404/empty — `listAllRefs`/`listDocuments`
    assume the repo exists and throw if it's missing. Not currently
    reachable from the UI (the dropdown only ever holds real customer
    ids), so left as-is rather than fixed speculatively.
- **Live editor now reaches multi-tenant documents, not just the
  single-tenant repo** (2026-09-23) — closes the gap the multi-tenant admin
  prototype above left open: until now, `GitDocumentStorageService` had
  metadata endpoints (customers/documents/versions/languages) but no
  content load/save, so the real-time editor (`frontend/src/main.js`,
  `collab-server`) had no way to reach anything created via `admin-mt.html`
  at all, and its branch dropdown only ever showed the untouched
  single-tenant repo's own branches (just `master`) — which is what
  actually prompted this, reported as "the Editor UI stopped working."
  - New content endpoints on `MultiTenantAdminController`: `GET`/`PUT
    .../versions/{versionName}/languages/{language}/content`, wrapping
    `GitDocumentStorageService.load`/`save` directly (ydoc as base64, same
    shape as the single-tenant `DocumentController` endpoints). Language
    is a real parameter here but the live editor always passes a fixed
    `"en"` for now — no multi-language editing UI exists yet (explicit
    scope call: adding a 4th cascading dropdown was the other option,
    deferred since nothing needs it yet).
  - `collab-server`: `persistenceClient.js` gained
    `loadTenantSnapshot`/`saveTenantSnapshot` as parallel functions
    alongside the existing `loadSnapshot`/`saveSnapshot`, rather than
    branching inside them — keeps the long-working single-tenant path
    untouched. `server.js`'s `parseDocumentName` now recognizes an `"mt:"`-
    prefixed room name (`mt:<customerId>~<docId>@<versionName>`) alongside
    the historical `<docId>@<branch>` shape, and every call site that used
    to destructure `{docId, branch}` now spreads `parseDocumentName(...)`
    into the live-document entry so both shapes flow through
    `onLoadDocument`/`checkpointToGit`/`reconcileFastTierOnStartup`
    unchanged.
  - `frontend/src/main.js`: the branch dropdown is now one flattened list
    covering both the legacy single-tenant branches (`(legacy
    single-tenant) master`) and every multi-tenant customer/document/
    version combination (`<displayName> / <docId> / <versionName>`),
    fetched by walking `/api/mt/customers` → `.../documents` →
    `.../versions` and flattening client-side — a cascading picker would
    be more complete but a flattened list was explicitly agreed as enough
    for testing. Selecting an entry now sets a `?doc=` URL param (not
    `?branch=`); legacy keys are translated back to the historical
    `default@<branch>` room name before reaching Hocuspocus, so
    `collab-server`'s single-tenant path never sees anything new.
  - **Real bug caught by testing, not by reasoning about the code**: the
    first version of the `mt:` room-name format used `/` between
    customerId and docId (`mt:acme-corp/onboarding-guide@master`).
    `documentName` doubles as a fast-tier filename in `localStore.js`
    (`path.join(LIVE_STORE_PATH, documentName + '.updates.log')`), so that
    `/` silently became an unintended, nonexistent nested directory —
    `onStoreDocument`/`afterUnloadDocument` failed with `ENOENT` every
    time, caught only because the real headless-browser test actually
    waited for the debounce and checked the logs, not from a curl check
    or reading the diff. Fixed by switching the separator to `~`
    (customerId/docId are git-URL-friendly slugs and never contain `~` in
    practice) — re-verified clean afterward: typed content survived the
    debounce → fast-tier compact → git checkpoint → and read back from
    `GitDocumentStorageService` as real, decodable Yjs update bytes (not
    just non-empty bytes).
- **cgit (`git-frontend`) now shows multi-tenant repos, not just the
  single-tenant one** (2026-09-23) — reported as "cgit does not show
  branches cust-001-doc-001-ver-001, no save after 60 seconds." The save
  itself was never broken (`collab-server` logs showed real
  `git-checkpoint` commits landing, and the content endpoint returned real,
  substantial Yjs bytes) — the user just had no way to see it, since
  `git-frontend` only ever mounted `repo-data:/data/repo` and `cgitrc`
  hardcoded exactly one static `repo.url=default` entry, with zero
  awareness that `/data/repos/*.git` (the multi-tenant repos) existed at
  all. Fixed by mounting `repos-data:/data/repos:ro` into `git-frontend`
  alongside the existing single-tenant mount, and adding `scan-path=
  /data/repos` to `cgitrc` — cgit's own tree-scan already understands a
  non-bare repo (finds the nested `.git` and registers the parent
  directory), same layout `/data/repo` already uses, so no directory
  restructuring was needed. New customers show up automatically as they're
  created, no per-customer cgit entry or redeploy required. Verified via
  curl against the deployed container: the repo list now includes
  `cust-001.git` alongside `default`, and its refs page lists
  `cust-001-doc-001-ver-001`. `remove-suffix=1` was added to strip the
  `.git` suffix from auto-discovered names for display but doesn't
  currently take effect (repos still list as `cust-001.git` rather than
  `cust-001`) — cosmetic only, left as a known minor quirk rather than
  chased further.
- Realtime collaboration: TipTap + Yjs + Hocuspocus, multiple browser tabs,
  live remote cursors with per-user color/label.
- Sequential `User-N` identity, assigned by `collab-server`.
- A basic formatting toolbar (Bold/Italic/Strike/Code, H1–H3/Paragraph,
  Bullet/Ordered List, Blockquote, Code Block, HR) — StarterKit already
  had all these nodes/marks; the toolbar just exposes them as buttons with
  live active-state highlighting instead of keyboard-shortcut-only.
- Two-tier persistence (fast local volume + periodic git checkpoint), full
  crash-recovery semantics proven via hard `docker kill` tests.
- Fast tier is an append-only delta log with periodic compaction (not a
  full-snapshot overwrite) — needed once the target document is genuinely
  large (200+ pages); proven with real ~2KB edits producing proportionally
  small log growth, correct reconstruction from log-only and from a
  compacted base, and both compaction triggers (all-users-logged-out and
  the size-based safety net) firing correctly.
- Git branch/merge mechanics, proven via a standalone JGit test and a full
  Node+real-Yjs end-to-end test against the live stack.
- Pre-merge conflict detection (`POST /api/documents/:docId/merge`):
  proven against the live stack both ways — a clean divergence merges and
  commits with a real two-parent commit; a divergence with a genuine
  attribute collision returns the conflict and leaves the target branch's
  stored snapshot provably untouched (compared byte-for-byte before/after).
- Per-edit changelog (`<docId>.changelog.jsonl`, committed alongside the
  snapshot): proven by replaying a single commit's changelog onto the
  *previous* commit's snapshot and getting a byte-identical Yjs state
  vector match against that commit's own stored snapshot, using the real
  server code end-to-end (not a simulated/hand-rolled version).
- `git-frontend` (cgit): read-only, mounted `:ro` against the same repo
  volume — log, blame, diff, branch decorations, merge-commit parent links
  all confirmed rendering correctly against real data.
- Branch-aware live editing (branch dropdown, page-navigation-based
  switching) and the admin page (create branch, merge with conflict
  display) — proven with a real headless browser: dropdown populates from
  the real branch list with no CORS errors, switching branches loads that
  branch's actual distinct content, and the admin page's create/merge
  flows exercise the real APIs end-to-end.
- Resilience: `onLoadDocument`/`onStoreDocument` wrapped so a
  persistence-service hiccup degrades gracefully instead of crashing
  `collab-server` (this happened for real once — see "Incidents" below —
  and is now fixed and covered by a process-level `unhandledRejection`
  handler as a last resort). Every service has `restart: unless-stopped`.
- Git-checkpoint retry survives the last viewer disconnecting: originally
  `afterUnloadDocument` deleted a document's in-memory tracking entry
  unconditionally once all viewers left, even if its one last checkpoint
  attempt had just failed — meaning a persistence-service outage that
  happened to align with everyone disconnecting left that document's git
  commit permanently un-retried, with nothing watching to pick it back up
  until someone happened to reconnect to that *exact* document again. Fixed
  by only deleting the entry once it's actually clean (`checkpointToGit`
  clears `dirty` solely on success); a still-dirty entry now stays in
  `liveDocuments` with zero viewers attached, so the same 60s periodic
  sweep keeps retrying it in the background, logged every attempt, same as
  if someone were still connected. No data is ever at risk either way — the
  fast tier already has every edit durably on local disk within ~8s
  regardless of git's state — this is purely about *how long git can stay
  behind unnoticed* and closing the gap that mattered for the "container/
  pod gets destroyed before git catches up" scenario. Verified directly
  against the live stack: stopped `persistence-service`, connected, edited,
  and disconnected (triggering the expected first failure), then watched
  the periodic sweep keep retrying with zero active connections across
  multiple 60s ticks, then restarted `persistence-service` and confirmed
  the very next tick committed the edit successfully with no reconnect
  needed at any point.
- Git-checkpoint retry survives `collab-server` itself restarting, not just
  the last viewer disconnecting: the above fix only helps as long as
  `liveDocuments` (purely in-memory) still has the entry — a `collab-server`
  restart wipes it entirely, even though the fast tier's files on disk are
  untouched, so a document that was mid-retry when the process stopped
  previously had nothing resuming it until someone happened to reconnect to
  that *exact* document again. Fixed with a startup scan
  (`listLocalDocuments()` in `localStore.js`, `reconcileFastTierOnStartup()`
  in `server.js`) that lists everything present in the fast tier, loads
  each into a fresh `Y.Doc`, and seeds `liveDocuments` with `dirty: true` —
  mirroring `onLoadDocument`'s own fast-tier-recovery convention
  (`contributors: ['restored']`) — so the very next periodic sweep picks
  them up exactly like any other dirty document, no reconnect required.
  Verified against the live stack end-to-end: edited a fresh branch while
  `persistence-service` was down, disconnected, confirmed the fast-tier
  files existed on disk, then restarted `collab-server` itself (wiping its
  memory) while `persistence-service` was *still* down, confirmed the
  startup scan found and queued the doc from disk alone, then brought
  `persistence-service` back up and confirmed the next periodic tick
  committed it successfully — zero reconnects at any point in the whole
  chain. One transient, non-fatal side effect observed during testing: a
  `local store read failed: Unexpected end of array` on one document,
  caused by the new startup scan's read racing a lingering live
  reconnect's own read/write of the same fast-tier files at boot; already
  caught by existing error handling (falls through gracefully, no crash),
  and that same document still checkpointed successfully on the very next
  attempt.
- Image upload (drag-and-drop → Artifact Keeper → read-only URL reference
  in the document): proven end-to-end with a real headless-browser
  simulated drop — see "Image upload" above.

## Not done yet

- No table markdown-fidelity spike needed anymore — moot now that binary
  Yjs is the source of truth; the Markdown export's fidelity only affects
  how *readable* a diff is, never whether a feature works live.
- Links, task lists, tables have native representations planned (markdown
  syntax exists for all of them) but aren't added as Tiptap extensions yet
  — StarterKit only, plus `Image` (see "Image upload" above).

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

- **2026-09-19**: `merge()`'s original implementation silently **deleted**
  the live "default" document's entire content on the very first merge run
  against a branch that had unrelated `save()` commits interleaved on it —
  a real production-content-loss bug, not a test artifact. Root cause: it
  used JGit's `MergeCommand` + `checkout()` + working-tree `git add` +
  `commit --amend`, all of which read from/write to the git **index**. But
  `save()` never touches the working tree or index at all (deliberate, for
  concurrency — see "Branching and merging" above), so the index is
  permanently stale the moment any `save()` runs. A later checkout-based
  commit builds its tree from that stale index rather than the branch's
  actual HEAD tree, silently **dropping** any file the index didn't know
  about — including files completely unrelated to the docId being merged.
  Traced precisely via git archaeology (`git log --full-history -- path`,
  since default git log simplification was hiding the real picture): the
  file existed with real content one commit before the first-ever merge,
  and was gone immediately after, with no error anywhere. Content was
  recoverable from git history (nothing already committed is ever lost —
  only what a broken *later* commit could see), but the live branch tip
  needed manual recovery. Fixed by rewriting `merge()` to use the exact
  same pure object-database plumbing `save()` already used — never
  touching the working tree at all eliminates the whole class of bug, not
  just this instance of it. Covered by a permanent regression test
  (`tests/integration/merge-with-conflict-detection.mjs`,
  `testMergePreservesUnrelatedDocs`) that specifically merges one docId and
  asserts an unrelated docId's snapshot is byte-identical before and after
  — the exact shape of what broke.

- **2026-09-20**: a real user-created branch (`feature-test-001`, a
  genuine one-word wording change on an otherwise-untouched sentence)
  could not be merged — every attempt returned a `delete-vs-edit`
  conflict, reproducibly, reload or not. Traced by decoding the actual
  branches' real data with the real `conflicts.js`: the flagged target ID
  was already a garbage-collected placeholder in the merge-base itself,
  and the merge-base's own DeleteSet already contained that exact
  deletion — ordinary prior editing history (something typed and deleted
  long before this branch existed), not anything either branch did. See
  "Conflict detection" above for the fix. This is the same false-positive
  *class* as the attribute-overwrite-tombstone issue found while first
  building `conflicts.js` — a reminder that this detector inherently
  works by walking Yjs's low-level CRDT structures directly rather than
  through an API designed to answer "is this new," so new categories of
  "technically in the delta, not actually a new conflict" are the
  expected shape of future bugs here, not a one-off.

- **2026-09-20**: Artifact Keeper uploads started failing with a `403` from
  `collab-server` (distinct from an earlier, separately-fixed `429` —
  see the token-caching note above) *after* a container restart, even
  though login with the already-set password kept succeeding (`200`, valid
  token). Traced directly: restarting `artifact-keeper` flips its built-in
  admin account's `must_change_password` flag back to `true`, which gates
  **every** authenticated endpoint with `403 SETUP_REQUIRED` — confirmed by
  finding even the public, anonymous-access download URL 403ing site-wide,
  not just the upload path. Re-submitting the password-change endpoint with
  the *same* password (no actual credential change) immediately unlocked
  the entire API again. Root cause is presumably the compose file's fixed
  `ADMIN_PASSWORD: admin` env var re-arming provisioning on every boot
  without literally resetting the password value. Fixed properly, not as a
  one-off manual unlock: `artifactKeeperClient.js`'s `login()` now checks
  `must_change_password` on every login response and re-confirms the
  password automatically if set; the upload retry path also treats a `403`
  the same as a `401` (one forced-fresh-login retry) in case the flag flips
  while a cached token is still otherwise valid. Means any future
  `artifact-keeper` restart self-heals instead of silently breaking uploads
  until someone notices and manually curls the unlock.
