# Collaborative Editor

A prototype: a TipTap rich-text editor, multiple users editing the same
document in real time via Yjs, with git as a durable, branchable,
audit-trailed persistence layer underneath. Everything runs in Docker.

For the full current status, what's verified, and known limitations, see
[STATE.md](STATE.md) — that file is kept up to date and is the source of
truth for "what actually works right now."

## Quick start

```sh
cd docker
docker compose up -d --build
```

Then open **http://localhost:8090** in a couple of browser tabs — each one
gets assigned `User-N` and edits are synced live between them, including
remote cursors.

## Services

| Service | Port | What it is |
|---|---|---|
| `frontend` | 8090 | The TipTap editor (static, nginx) |
| `collab-server` | 1234 (ws), 3000 (http) | Node/Hocuspocus — realtime Yjs sync, `/api/whoami` |
| `persistence-service` | 8081 | Spring Boot + JGit — git-backed snapshot storage, branch/merge |
| `git-frontend` | 8096 | cgit — read-only browser for the persisted git history |
| `minio` | 9000 (api), 9001 (console) | Object storage, reserved for future image/asset uploads |

## The core design decision

Git is used purely as a **persistence and audit layer** — an immutable
commit log of snapshots, with real branches. It is **never** asked to
content-merge anything. All actual merging of concurrent edits is done by
**Yjs's CRDT algorithm**, which merges automatically and deterministically
with no conflicts, by construction. When two branches need combining, the
already-CRDT-merged result is what gets committed — git just records that
the resulting commit descends from both branches' tips.

See STATE.md for the full architecture writeup, including why the
persisted format is a binary Yjs snapshot (not Markdown/HTML/JSON) with a
Markdown file generated alongside purely for human-readable diffs.
