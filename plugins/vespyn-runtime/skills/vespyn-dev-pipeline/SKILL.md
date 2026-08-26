---
name: vespyn-dev-pipeline
description: Drive a substantial feature, backlog item, or scoped build request from idea or approved design through a feature PRD, adversarial review, dependency-ordered TDD plan, implementation, cleanup, final review, real dogfood, verification, and handoff. Use when the user invokes dev-pipeline, asks for its Spec or Build phase, provides an epic/PRD to execute, or requests a change substantial enough to deserve a PRD, adversarial review, or real-system regression evidence.
---

# Dev pipeline

Drive the target from the user's request through the requested pipeline phase. Default to autonomy.
Ask only when a decision is genuinely ambiguous, materially changes scope/cost, or belongs to the
human. Keep moving otherwise.

## Select the run boundary

- **Full pipeline:** run every applicable phase.
- **Spec phase:** run Phases 0–3, produce a feature-specific PRD revised after adversarial review, a
  dependency-ordered TDD implementation plan, a decision log, verification gaps, and one exact first
  Build slice. Do not implement product code unless the user also requests Build.
- **Build phase:** verify the approved Spec and exact starting point, then run Phases 4–8. Do not silently
  reopen settled product decisions.
- **Named later phase:** load the approved outputs of every prior phase and run only the requested phase
  plus its required verification.

State the selected boundary and which fallback path is active.

## Skill and orchestration fallbacks

Use applicable project skills when installed, including BMAD skills named below. Read each selected
skill completely before acting.

When a named skill is unavailable:

- authoring and implementation phases: work directly;
- review phases: use two independent reviewers with distinct named lenses;
- cleanup: run a direct whole-diff debt/simplification pass with false-positive verification.

Use Codex collaboration subagents for independent reviewers when available and permitted; launch both
lenses in parallel when capacity allows. Give each a bounded review task and raw artifacts, not the
intended findings. If collaboration is unavailable, prohibited by the harness/user, or lacks capacity,
run the same named lenses sequentially inline and record each lens separately. Do not substitute another
orchestration skill without checking that its artifact/task conventions match the project.

## Phase 0 — Isolation and backlog

- Before writes, set up an isolated Git worktree and branch. Assume other sessions share the checkout.
- If the target depends on uncommitted owner changes, preserve them and obtain an exact safe starting
  point; never reset, overwrite, or sweep them into this work.
- On resume, verify the cwd/worktree/branch still exist before the first command.
- Inspect `git status` before staging. Never use bare `git add -A` in a shared checkout.
- Capture the target in the project's backlog (`backlog.md` under the planning-artifacts directory;
  create it if absent) and move its status with the pipeline. Drafting the PRD before backlog capture is
  acceptable.
- Record the full starting SHA, branch, worktree state, upstream, and relevant diff. Historical handoff
  anchors do not replace verification of current reality.

## Phase 1 — One-shot PRD

Author the full feature PRD in one pass from the product brief, backlog, research, codebase, closest
analog PRD, and dependency outputs. Do not run interactive step-by-step PRD facilitation.

- If an approved design, charter, or PRD exists, inherit it. Do not re-elicit settled decisions.
- After drafting, compare the PRD against the approved source point by point.
- Read every authoritative input and dependency artifact completely.
- Inspect the actual current code, tests, branch, worktree, and deployment boundary.
- Verify unstable external assumptions against current primary/official sources before designing around
  remembered behavior.
- Default non-material open questions and record rationale.
- If human input is essential, ask all decision-required questions together in one concise consolidated
  message using the available user-input mechanism. Do not serially ask one question at a time.
- Record owner decisions and knowingly accepted risks in the PRD decision log.
- Write a feature-specific file such as `planning-artifacts/<feature>-prd.md`; never clobber the product
  `prd.md`.
- Include problem/outcome, goals, non-goals, user-visible shape, functional requirements, explicit
  out-of-scope, acceptance criteria, security/destructive boundaries, decisions, verification gaps, and
  thesis/residual fit when the project uses it.

## Phase 2 — Adversarial PRD review and revision

Use `bmad-review-adversarial-general` / `bmad-validate-prd` when installed. Otherwise run two independent
reviewers:

1. **Product, design-fidelity, and feasibility lens**
2. **Risk, edge-case, security, and destructive-operations lens**

Require file/line grounding for code claims. Check findings against inherited decisions and the PRD
decision log. Verify suspected issues before accepting them. Resolve material findings in the PRD and
record the review/resolution. Surface only genuine disagreements or unresolved human decisions.

For a complex or security-sensitive PRD, repeat with fresh reviewers until no material finding remains.

## Phase 3 — Dependency-ordered epics and TDD stories

Use `bmad-create-epics-and-stories` when installed; otherwise author directly.

- Order epics/stories by hard dependencies.
- Give each story explicit Red, Green, Refactor, adversarial, and gate expectations where appropriate.
- Include migration/recovery/evidence work rather than treating it as release polish.
- Preserve the PRD's scope and stopping point.
- Name exact verification commands and residual real-system gaps.
- End with one exact, independently reviewable first Build slice: prerequisites, owned files/surfaces,
  required tests, exit gate, and explicit exclusions.

For a Spec-only run, stop here. Validate the artifacts and report that Build still requires approval when
the project uses an approval gate.

## Phase 4 — Story-by-story development

Use `bmad-dev-story` / `bmad-quick-dev` when installed; otherwise implement directly.

- Implement one dependency-ready story at a time.
- Follow project TDD/testing discipline; keep lint, types, tests, and builds green.
- Treat suite-runtime growth as debt to investigate.
- Any implementer subagent must verify its assigned worktree/branch before its first write.
- Preserve unrelated owner changes in dirty trees.
- Give long-silent test/build runs a liveness check (process state and wall clock), not open-ended waiting.
- If code proves a locked decision infeasible, reopen it explicitly with one targeted human question
  rather than bending implementation around it.
- Do not perform production migration, deployment, push, invitation, or provisioning unless separately
  and explicitly authorized.

## Phase 5 — Review and clean

Use `vespyn-review-and-clean` when installed. Otherwise inspect the entire diff for:

- duplication and avoidable indirection;
- stale compatibility paths and dead abstractions;
- weakened types/bounds/authorization;
- accidental scope expansion;
- unnecessary dependency or runtime cost;
- tests that assert implementation detail instead of behavior.

Verify every suspected issue before changing code. Apply holistic simplifications, then rerun focused
gates.

## Phase 6 — Final adversarial code review

Run after Phase 5 so reviewers see the cleaned diff. Use `bmad-code-review` / `/code-review` when
available; otherwise run two independent reviewers:

1. **Whole-diff correctness, contract, and feasibility**
2. **Security, privacy, and destructive/irreversible operations**

The destructive lens must inspect what is deleted, copied, migrated, overwritten, or published; ordering
and atomicity; partial failures; rollback; and whether read-back proves durability before deletion.
State its verdict explicitly even when not applicable: `no delete/migrate/overwrite surface`.

Fix verified findings and justify dismissals. Security-sensitive mechanisms often require multiple fresh
passes; continue until a fresh review finds no material bypass.

## Phase 7 — Live dogfood and committed regression

CI and code review are necessary but insufficient. Exercise the feature through the real applicable
pipeline: actual datastore, process, locks, Git operations, browser, or build. Keep mocks at outermost
paid/external seams unless the feature specifically integrates that service.

- Convert dogfood into a committed repeatable script/test.
- UI/web-route changes require a visual artifact. Interactive/mobile work also checks overlap,
  overflow, scroll/zoom, responsive behavior, and live updates, or records the gap.
- Backend/data work uses a real compatible datastore and real process/restart/concurrency behavior.
- Diagnose build defects versus measurement defects before changing a correct build to satisfy a broken
  grader.
- Confirm the surface the human will try is fresh, reachable, and on the reviewed revision.
- For external setup requiring SaaS console access, secrets, or sudo, provide a precise tested checklist
  and scrub temporary credentials.

Do not use production as a substitute for a missing staging/non-production target.

## Phase 8 — Closeout and handoff

- Run the full project gate from a clean state and capture exact results.
- Record exact revision/diff, evidence artifacts, migration/checksum inventory, rollback/recovery,
  destructive-ops verdict, and gaps.
- Update backlog/status only to the level actually proven.
- Hand downstream work the approved IDs, schemas, commands, versions, authorization, events/cursors,
  ownership, and stopping contracts it must inherit.
- Do not claim `DONE`, `READY_FOR_BUILD`, deployed, or production-verified without the corresponding
  project approval/evidence.

## Rules throughout

- Track progress with the plan/backlog. Post concise updates at phase boundaries and during long runs.
- Verify before claiming completion; evidence precedes assertions.
- State what each gate does not cover.
- Be autonomous for reversible in-scope work. Stop for explicit authorization before deploy, shared
  push, destructive production migration, external message/invitation, secret/config mutation, or data
  egress.
- Before merge/push, fetch and re-check the base branch, isolate the intended diff, and confirm no
  concurrent overlap.
- Put commit messages containing backticks or shell metacharacters in a message file and use
  `git commit -F`.
- Commit/push only when the user asks; branch first when on the default branch.
- Use the fast lane for small post-ship polish while keeping gates green. Start a new scoped pipeline when
  a tweak becomes a new system, mechanic, authority, or data surface.
- Stop and ask only when the decision is genuinely the human's; otherwise continue.
