# DIY Blueprints

A collection of small, from-scratch prototype implementations ("blueprints")
that explore a specific architecture or integration pattern end-to-end.
Each blueprint is self-contained, runnable via Docker Compose, and exists to
answer a concrete design question through a real, working system — not to
be production-ready or reused as a library. Think of it as a set of spikes
you can `docker compose up` and poke at, with the reasoning behind every
non-obvious decision written down alongside the code.

Every blueprint keeps its own `README.md` (quick start) and `STATE.md`
(detailed, continuously-updated "what's actually true right now": what's
verified, what's deliberately not built yet, and an incident log of real
bugs found and how they were fixed). The `STATE.md` files are usually the
more interesting read — they capture the *why*, including design choices
that were tried and reverted.

## Blueprints

### [`collaboration-server/`](collaboration-server/) — real-time collaborative editor with git-backed history

A prototype rich-text editor where multiple people edit the same document
live, with **git as a durable, branchable, audit-trailed persistence
layer** underneath — explicitly *not* using git to merge content. All
concurrent-edit merging is done by a CRDT (Yjs); git only stores immutable
snapshots and records ancestry, branches, and per-edit attribution.

**Core design question it answers:** can you get git's branching/audit/
review ergonomics for a live collaborative document without asking git to
solve concurrent-editing conflict resolution (which it's bad at) or asking
a CRDT to solve durable history/branching (which it doesn't do)?

**Stack:**

| Tool | Role |
|---|---|
| [TipTap](https://tiptap.dev/) | Rich-text editor framework (ProseMirror-based), frontend |
| [Yjs](https://yjs.dev/) + [Hocuspocus](https://tiptap.dev/hocuspocus) | CRDT engine and realtime sync server for concurrent editing |
| [JGit](https://www.eclipse.org/jgit/) (via Spring Boot) | Pure object-database git plumbing — commits, branches, merges, no working tree |
| [Artifact Keeper](https://github.com/artifact-keeper/artifact-keeper) | Self-hosted artifact registry, repurposed as image/binary storage for dropped-in images |
| [cgit](https://git.zx2c4.com/cgit/about/) | Read-only web UI for browsing the persisted git history |
| Docker Compose | Runs the whole stack (7 services) locally with one command |

**Ports:**

| Service | Port | What it is |
|---|---|---|
| `frontend` | 8085 | The TipTap editor (static, nginx) |
| `collab-server` | 1234 (ws), 3000 (http) | Node/Hocuspocus — realtime Yjs sync, upload proxy |
| `persistence-service` | 8081 | Spring Boot + JGit — git-backed snapshot storage, branch/merge |
| `git-frontend` | 8096 | cgit — read-only browser for the persisted git history |
| `artifact-keeper` | 8082 | Image/binary storage for dropped-in images |
| `ak-postgres` | 30432 | Postgres — Artifact Keeper's metadata store |
| `ak-opensearch` | 9200 | OpenSearch — Artifact Keeper's search index |

See [`collaboration-server/README.md`](collaboration-server/README.md) for
quick start, and [`collaboration-server/STATE.md`](collaboration-server/STATE.md)
for the full architecture writeup, verified behavior, and incident log.

## A note on scope

These are **prototypes**, not hardened services: auth is deliberately
minimal or disabled where a blueprint's focus is elsewhere (documented
explicitly in each one's `STATE.md`), secrets used for local Docker
networking are fixed/example values rather than production credentials,
and error handling covers the paths that were actually exercised, not
every theoretical edge case. Treat each blueprint as a reference for the
pattern it demonstrates, not as a starting point to deploy as-is.
