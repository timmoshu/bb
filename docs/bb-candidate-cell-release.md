# BB candidate cell release (agent-vespyn)

Immutable source-managed roll for the dogfood cell under `~/.bb-candidate`.
This is **not** the npm/desktop publish path in
[bb-release-process.md](bb-release-process.md).

Scope: BB cell + its one source-managed host daemon only. Do not redeploy Work
Together MCP/web/worker services, spare cells, or publish npm/desktop from this
runbook.

Live topology (readback-confirmed): one active enrolled daemon
`host_uiiksngxic` (`wt-v2`), launched from `current` with `autoUpdate` off.
Upgrade proof is coordinated cell+daemon restart onto the new release at
protocol **181**. npm tarball self-update is not part of this path.

User authorization for this cell roll is granted; record the outcome in the
rollout receipt under `~/.bb-candidate` / `/tmp/bb042-release-report.md`.

## Preconditions

Pin Node on every shell:

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

`systemctl --user` needs `XDG_RUNTIME_DIR`.

Before downtime:

1. Release commit is on `main` and matches the **tested** SHA
   (`BB_RELEASE_SHA=<40-hex>` — do not assume merge source `e141f3e3e…` is
   final if a later test/docs commit lands on top).
2. `~/bb` `main` is clean and equals `origin/main` at that SHA (or you will
   add the release worktree from a fetchable object).
3. No conflicting active BB work that must finish on the live cell first.
4. Record identities:

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
readlink -f /home/hoid/.bb-candidate/current /home/hoid/.bb-candidate/previous
git -C /home/hoid/.bb-candidate/current rev-parse HEAD
curl -fsS http://127.0.0.1:47780/health
systemctl --user is-active bb-candidate-cell.service bb-candidate-daemon.service
```

## Prepare release artifact (before downtime)

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
BB_RELEASE_SHA=<40-hex>   # tested release commit (placeholder until known)
BB_RELEASE_DIR=/home/hoid/.bb-candidate/releases/$BB_RELEASE_SHA
test ! -e "$BB_RELEASE_DIR"
git -C /home/hoid/bb fetch origin
git -C /home/hoid/bb worktree add --detach "$BB_RELEASE_DIR" "$BB_RELEASE_SHA"
cd "$BB_RELEASE_DIR"
test "$(git rev-parse HEAD)" = "$BB_RELEASE_SHA"
pnpm install --frozen-lockfile
# SERIAL: one Turbo process; concurrency 1; no --force
pnpm exec turbo run build --concurrency=1 \
  --filter=@bb/scripts --filter=@bb/app --filter=@bb/server \
  --filter=@bb/host-daemon --filter=@bb/cli --filter=bb-app
test -x node_modules/.bin/tsx
```

Do not start downtime until install+build finish in the release directory.
Do not leave services down during install/build.

## Quiesce, backup, record prior release

Prefer a restore-grade snapshot with writers stopped (WAL DB). Use a private
backup directory and verify backup integrity before switching:

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user stop bb-candidate-daemon.service bb-candidate-cell.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest=/home/hoid/.bb-candidate/backups/pre-roll-$stamp
mkdir -p "$dest"
umask 077
cp -a /home/hoid/.bb-candidate/v2-cell-data "$dest/v2-cell-data"
cp -a /home/hoid/.bb-candidate/v2-daemon-data "$dest/v2-daemon-data"
readlink -f /home/hoid/.bb-candidate/current > "$dest/current-release.path"
git -C "$(cat "$dest/current-release.path")" rev-parse HEAD > "$dest/current-release.sha"
printf '%s\n' "$stamp" > "$dest/stamp"
chmod -R go-rwx "$dest"
# Verify backup SQLite integrity before switching (writers already stopped)
test "$(sqlite3 "$dest/v2-cell-data/bb.db" 'PRAGMA integrity_check;')" = ok
# Confirm pre-roll head is still 0111 (hash for even_exiles), not 0112 yet
sqlite3 "$dest/v2-cell-data/bb.db" \
  "SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1;" \
  > "$dest/pre-roll-migration-head.hash"
# Record migration count for receipt
sqlite3 "$dest/v2-cell-data/bb.db" \
  "SELECT COUNT(*) FROM __drizzle_migrations;" > "$dest/pre-roll-migration-count"
```

Do not copy `bb.db` alone while services are writing. Do not switch `current`
until backup integrity is confirmed.

## Atomic roll and restart

Restart **only** these two units (not gateway, WT MCP, spare cell, or workers):

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
candidate_root=/home/hoid/.bb-candidate
release_root=$candidate_root/releases
new=$release_root/$BB_RELEASE_SHA
old=$(readlink -f "$candidate_root/current")
case "$old" in "$release_root"/*) ;; *) echo "refusing unexpected current"; exit 1;; esac
test "$(git -C "$new" rev-parse HEAD)" = "$BB_RELEASE_SHA"
ln -sfn "$old" "$candidate_root/previous.next"
mv -Tf "$candidate_root/previous.next" "$candidate_root/previous"
ln -sfn "$new" "$candidate_root/current.next"
mv -Tf "$candidate_root/current.next" "$candidate_root/current"
systemctl --user start bb-candidate-cell.service bb-candidate-daemon.service
```

Scripts under `~/.bb-candidate/scripts/run-cell.sh` and `run-daemon.sh` already
`cd` to `current` and run source entrypoints.

## Readback

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user is-active bb-candidate-cell.service bb-candidate-daemon.service
readlink -f /home/hoid/.bb-candidate/current
test "$(git -C /home/hoid/.bb-candidate/current rev-parse HEAD)" = "$BB_RELEASE_SHA"
curl -fsS http://127.0.0.1:47780/health
# Expect package/version surfaces at 0.42.0 on the release tree:
node -p "require('/home/hoid/.bb-candidate/current/packages/bb-app/package.json').version"
# DB head must be 0112_v42_reconciliation; SQL sha256:
# f0c9d873d5dc39695f731adeabd25879d2b4e13a1c92d59793680f6e7d41a9ab
journalctl --user -u bb-candidate-cell.service -u bb-candidate-daemon.service -n 80 --no-pager
```

Confirm:

- Source SHA = release SHA = `origin/main`.
- Package **0.42.0**.
- Active host session protocol **181**.
- `__drizzle_migrations` head hash =
  `f0c9d873d5dc39695f731adeabd25879d2b4e13a1c92d59793680f6e7d41a9ab`
  (tag `0112_v42_reconciliation`).
- Daemon reconnect for `host_uiiksngxic` with a new active session.
- External WT MCP base URL still reachable (unchanged held WT release; do not
  roll it here).

Do not paste secret env values from coordination files into logs or tickets.

## Rollback

Restore matching **data + app** together. Symlink-only rollback does not undo
migrations. There are **no** automatic downgrade migrations for 0.42.

```bash
set -euo pipefail
export PATH=/home/hoid/.nvm/versions/node/v22.23.1/bin:$PATH
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user stop bb-candidate-daemon.service bb-candidate-cell.service
# Restore v2-cell-data (and v2-daemon-data if snapshotted) from $dest
# Point current at the recorded prior release SHA under releases/
systemctl --user start bb-candidate-cell.service bb-candidate-daemon.service
```

## Non-goals

- No Vespyn bundled-runtime install for this roll.
- No `work-together-v2-mcp` / worker / spare-cell restart.
- No npm `bb-app` publish or desktop workflow from this runbook.
