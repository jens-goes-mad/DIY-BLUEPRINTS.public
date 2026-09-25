# Scenario tests

Plain-text scripts (`*.scn`) describing versions, edits and merges. `run.mjs`
plays each one against real Y.Docs and compares the resulting **transcript**
with a committed `expected/<name>.out`. The merge itself is the real
`backend/collab-server/src/mergeDocs.js` -- the same function the live merge
pipeline calls -- so these show what the product would actually do.

```sh
# from collaboration-server/ (no local node needed)
docker run --rm -v "$(pwd):/work" -w /work node:20-alpine node tests/scenarios/run.mjs
docker run --rm -v "$(pwd):/work" -w /work node:20-alpine node tests/scenarios/run.mjs 03   # one scenario
... run.mjs --update    # rewrite expected/*.out -- READ the diff before committing it
```

A scenario passes only if every `expect` line held **and** the transcript is
byte-identical to the committed one. A golden file records what happened, not
what should have; `expect` lines are the actual assertions. Scenarios that
say "characterization" in their header pin down behavior we observed but
don't promise.

## Commands (one per line, `#` for full-line comments)

```
doc <version>                       # a fresh root version; indented block below:
  heading level=1 "Title"           #   para "text" | heading key=value... "text"
  para "First paragraph."
branch <new> from <existing>
as <user> on <version> insert pN at start|end "text"
as <user> on <version> insert pN after|before "anchor" "text"
as <user> on <version> replace pN "old" -> "new"
as <user> on <version> delete pN                 # whole paragraph
as <user> on <version> delete pN "text"          # just that text
as <user> on <version> set pN key=value          # attribute, e.g. level=2
as <user> on <version> add para|heading [key=value] after pN | at start | at end "text"
commit <version>
merge <source> -> <target> [force]
show <version>
expect merged true|false
expect conflicts <count>
expect conflict <type> [attribute]               # e.g. attribute level, delete-vs-edit
expect doc <version>                             # indented block, same syntax as `doc`
```

`pN` is the Nth top-level paragraph/heading (1-based) in the version's
*current* state. Anchors are searched in that paragraph's text; a missing
anchor is a scenario error, not a silent no-op.

## Semantics worth knowing

- **Checkpoints.** The live app commits to git periodically; here `branch`
  and `merge` implicitly commit their inputs (`commit` does it explicitly),
  and the merge base is the git-style lowest common ancestor in the
  scenario's commit graph (`c0`, `c1`, ... in the transcript).
- **clientIDs are fixed per (user, version)**, assigned by order of first
  appearance in the script. Yjs orders concurrent inserts, and decides
  concurrent attribute writes, by clientID -- so this is what makes
  transcripts reproducible. It also means *who wins depends on who is
  introduced first* (scenarios 03 vs 07). In the real app clientIDs are random
  per browser session, so such outcomes are effectively arbitrary there.
- **`merge ... force`** ignores detected conflicts and lets Yjs resolve them
  its own way. The real pipeline never does this (it refuses); force is a
  preview of what a merge *would* produce, to inform designing a real
  conflict-resolution step.
- One user edit can appear as several conflict records (scenario 05): a
  paragraph is stored as several Yjs items.
