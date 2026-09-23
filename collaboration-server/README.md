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

Then open **http://localhost:8085** in a couple of browser tabs — each one
gets assigned `User-N` and edits are synced live between them, including
remote cursors.

## Services

| Service | Port | What it is |
|---|---|---|
| `frontend` | 8085 | The TipTap editor (static, nginx) |
| `collab-server` | 1234 (ws), 3000 (http) | Node/Hocuspocus — realtime Yjs sync, `/api/whoami` |
| `persistence-service` | 8081 | Spring Boot + JGit — git-backed snapshot storage, branch/merge |
| `git-frontend` | 8096 | cgit — read-only browser for the persisted git history |
| `artifact-keeper` | 8082 | Image/binary storage for dropped-in images (drag-and-drop → uploaded → read-only URL reference in the document) |

## Testing / Analyzing

The quickest way to tell "did it actually save" from "is the browser just
showing me something stale" is to bypass the browser entirely — hit the
APIs and logs directly. These are the commands that came up repeatedly
while verifying features against the live stack (container names below
match this compose project's defaults; adjust if yours differ).

### Single-tenant document API (`persistence-service`, port 8081)

```sh
# Branches
curl http://localhost:8081/api/branches
curl -X POST http://localhost:8081/api/branches \
  -H 'Content-Type: application/json' -d '{"newBranch":"foo","fromBranch":"master"}'
curl -X DELETE http://localhost:8081/api/branches/foo
curl "http://localhost:8081/api/branches/merge-base?a=foo&b=master"

# Document content (ydoc is base64-encoded Yjs state)
curl "http://localhost:8081/api/documents/default?branch=master"
curl "http://localhost:8081/api/documents/default/changelog?branch=master"
curl "http://localhost:8081/api/documents/default/history?branch=master"
```

### Multi-tenant API (`persistence-service`, port 8081, `/api/mt` prefix)

```sh
BASE=http://localhost:8081/api/mt

# Customers
curl $BASE/customers
curl -X POST $BASE/customers -H 'Content-Type: application/json' \
  -d '{"customerId":"acme-corp","displayName":"Acme Corp"}'
curl -X DELETE $BASE/customers/acme-corp

# Documents
curl $BASE/customers/acme-corp/documents
curl -X POST $BASE/customers/acme-corp/documents -H 'Content-Type: application/json' \
  -d '{"docId":"onboarding-guide","title":"Onboarding Guide"}'

# Versions
curl $BASE/customers/acme-corp/documents/onboarding-guide/versions
curl -X POST $BASE/customers/acme-corp/documents/onboarding-guide/versions \
  -H 'Content-Type: application/json' -d '{"versionName":"review-q3","fromVersionName":"master"}'
curl -X DELETE $BASE/customers/acme-corp/documents/onboarding-guide/versions/review-q3

# Languages + content (language is fixed to "en" by the live editor for now)
curl $BASE/customers/acme-corp/documents/onboarding-guide/versions/master/languages
curl $BASE/customers/acme-corp/documents/onboarding-guide/versions/master/languages/en/content
```

### Git history, straight from cgit (no browser cache in the way)

`curl`ing cgit's own pages is the fastest way to confirm what's actually
committed, independent of whatever the browser has cached:

```sh
curl http://localhost:8096/                                                        # repo index
curl "http://localhost:8096/cgit.cgi/<repo>.git/refs/?h=<branch>"                   # does this branch exist
curl "http://localhost:8096/cgit.cgi/<repo>.git/log/?h=<branch>"                    # commit list
curl "http://localhost:8096/cgit.cgi/<repo>.git/commit/?h=<branch>"                 # latest commit + diffstat
```

For multi-tenant repos, `<repo>` is `<customerId>.git` (e.g. `acme-corp.git`);
the single-tenant repo is `default`. Branch names for multi-tenant versions
are `docs/<docId>/<versionName>` (e.g. `docs/onboarding-guide/review-q3`).

### Container logs and disk state

```sh
# collab-server: connect/checkpoint/error activity (git-checkpoint runs every
# GIT_CHECKPOINT_INTERVAL_MS, 60s by default -- not on every keystroke)
docker logs docker-collab-server-1 --tail 50
docker logs docker-collab-server-1 --since 5m --timestamps | grep -i "<docId or customerId>"

# persistence-service: JGit/Spring errors
docker logs docker-persistence-service-1 --tail 50

# What's actually on disk (single-tenant vs. multi-tenant repo roots)
docker exec docker-persistence-service-1 ls /data/repo
docker exec docker-persistence-service-1 ls /data/repos
```

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
