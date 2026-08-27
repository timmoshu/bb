---
name: filespace
description: Persist Goal files via filespace_list, filespace_get, and filespace_put. Not git.
---

# Goal filespace

Use the native `filespace_list`, `filespace_get`, and `filespace_put` tools for
the Goal file tree. This is **not** the bound git repository.

## When to use

- Notes, briefs, screenshots, and decision logs that should survive this Room
- Reading what a previous Room saved on this Goal

Do not `filespace_put` anything under the git checkout. Edit git with ordinary
file tools and Git Deliver. Scratch for filespace is `$SCRATCH/filespace/`
(sibling of the repo), then `filespace_put`.

## Calls

1. `filespace_list` — optional `prefix`
2. `filespace_get` — `path`
3. `filespace_put` — `path`, `expectedGeneration` (0 to create), `text`,
   `mediaType` (`text/markdown` for notes)

Folders are path prefixes. Putting `notes/decision.md` creates `notes/`. No
preset taxonomy.

Do not put secrets, coordinator URLs, or git-root paths in the user-facing reply.
