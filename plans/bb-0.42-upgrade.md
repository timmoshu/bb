# BB 0.42 upgrade: finish the merge, verify, release

Status: local verification complete; isolated cell smoke **19/19** passed;
docs/test commit pending on `upgrade/bb-0.42`, then authorized `main` push +
candidate cell roll. Pre-roll snapshot **2026-09-05**: live cell still
`5c33756e2e63b188f66634bf85c8309c37892096` (package `0.40.0`, protocol **175**,
DB **0111**). Rollout receipt (not this plan) records the deploy result.

Merge source SHA `e141f3e3eaf1b0e2c40b9e1bc79ea3a8fe17f92f` is the verified
0.42 merge tip. The forthcoming test/docs commit on `upgrade/bb-0.42` is the
release SHA (merge + generator test + this plan + cell runbook).

This plan supersedes `/tmp/bb-0.42-upgrade-spike.md` and `/tmp/bb-0.42-s1.md`
as operational guidance; those files remain historical evidence only.

## Decision

Keep merge `e141f3e3eaf1b0e2c40b9e1bc79ea3a8fe17f92f`. It merges fork
`5c33756e2e63b188f66634bf85c8309c37892096` with exact upstream
`desktop-v0.42.0` (`960255b98ce3dccdcb5754eb67a7f989236602a1`).

Use upstream queue, provider, packaging, and self-update implementations;
retain the fork's WT context, execution-cwd, delivery-authority, and Codex
missing-rollout behavior. Fork migrations `0110`/`0111` and generated
`0112_v42_reconciliation` stay as shipped — migration content is unchanged.

## Live rollout topology (candidate cell)

| Fact          | Value                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| Cell root     | `~/.bb-candidate` (immutable `releases/<SHA>` + `current`/`previous`)           |
| Pre-roll live | `5c33756e2…` · package `0.40.0` · protocol **175** · DB head **0111**           |
| Release tip   | test/docs commit on merge `e141f3e3e…` · `0.42.0` · protocol **181** · **0112** |
| Active daemon | **one** source-managed host `host_uiiksngxic` (`wt-v2`); `autoUpdate` **false** |
| Units to roll | `bb-candidate-cell.service` + `bb-candidate-daemon.service` only                |
| Out of scope  | Vespyn runtime port; WT MCP/web/worker redeploy; npm/desktop publish            |

Proof for this topology is a coordinated server/daemon source release restart
with protocol-181 reconnect. Separately installed npm self-update paths are
not applicable (no active enrolled remote host with autoUpdate).

Runbook: [docs/bb-candidate-cell-release.md](../docs/bb-candidate-cell-release.md).
`docs/bb-release-process.md` remains npm/desktop only.

## Completed verification (merge source `e141f3e3e` + generator test)

Serial Turbo policy: Node `v22.23.1`, `--concurrency=1`, no `--force`.

| Gate                  | Result                   | Evidence                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------------ |
| DB migrate suite      | **450** passed           | `/tmp/bb042-finish-db-tests.log`                                         |
| Focused fork/server   | **82** tests / 9 files   | `/tmp/bb042-finish-server-focused.log`                                   |
| Host-daemon contract  | PASS                     | `/tmp/bb042-finish-host-contract.log`                                    |
| Codex focused         | **12** passed            | `/tmp/bb042-finish-codex-focused.log`                                    |
| Marketplace generator | **6/6** passed           | `/tmp/bb042-final-cleanup-generator-test.log` (and earlier serial gate1) |
| Touched typecheck     | **11** successful        | `/tmp/bb042-serial-gate2-typecheck.log`                                  |
| Root production build | **13** successful        | `/tmp/bb042-serial-gate3-build.log`                                      |
| Fake integration      | **77** passed / 26 files | `/tmp/bb042-serial-gate4-integration.log`                                |
| Final cleanup typecheck | **5** tasks pass       | `/tmp/bb042-final-cleanup-typecheck.log` (generator restored to HEAD)    |
| Final cleanup build   | **13** tasks pass        | `/tmp/bb042-final-cleanup-build.log` (production generator = HEAD)       |

Marketplace residual disposition: production
`apps/server/scripts/generate-bb-official-marketplace.ts` matches merge HEAD
`e141f3e3e` (no retained `%cI`→`Z` normalizer). Only the generator test was
fixed to assert exact instants plus schema validity under Git `%cI` `+00:00`.

## Historical residuals (not green; not blockers for cell roll)

These remain accepted baselines from earlier full-shard / long-bridge runs and
were **not** re-run as release gates:

- Installer readiness under full-shard load (timeout under load).
- Codex `bridge.recorded-conformance` 240s timeout.

Do not treat them as failures of the green focus/build/integration set above.

## Isolated cell smoke (required before roll; **19/19**)

Evidence:

- Final: `/tmp/bb042-cell-smoke-final-report.md` — **19/19 PASS** (2026-09-05)
- Prior fixture misses preserved: `/tmp/bb042-cell-smoke-report.md`

Real OS-process server+daemon under `/tmp/bb042-cell-smoke*`; did not touch
live `~/.bb-candidate` or WT MCP. No new production fake-override allowlists.

| Scenario                                                 | Result |
| -------------------------------------------------------- | ------ |
| Bring-up, enroll, protocol **181** session               | PASS   |
| Normal thread send/resume (packaged fake)                | PASS   |
| WT create → context → send/resume + none-authority bwrap | PASS   |
| Coordinated restart/reconnect @ 181; threads preserved   | PASS   |
| Post-restart ordinary steer/resume turn                  | PASS   |
| Post-restart WT turn + credential exclusion + pool HTTP  | PASS   |

Required smoke is **done before roll**. Live inference was not used (dummy
HTTP routing probe only).

## Remaining release steps (authorized)

1. Commit generator test + plan + runbook on `upgrade/bb-0.42`; fast-forward
   `~/bb` `main` and push `origin/main` (no force; no upstream/npm publish).
2. Follow [docs/bb-candidate-cell-release.md](../docs/bb-candidate-cell-release.md):
   prepare immutable release worktree at the **tested release SHA**, quiesce+backup,
   atomic symlink roll, restart cell+daemon only, read back
   health/SHA/package/protocol/DB/daemon/WT.

## Separate work

Bundled Vespyn runtime remains a separate feature. Live WT flows use the
external held MCP on the host; do not redeploy WT services as part of this BB
roll.

## Audit notes

Two independent read-only reviews recommended keeping the merge. Primary review
rejected guard consolidation that missed wait mutations or context-error
ordering, and rejected treating absent Vespyn as an upgrade regression.
Custom reconciliation spans 41 files (`git show --remerge-diff --stat`);
upstream volume alone is not a mandate for new architecture.
