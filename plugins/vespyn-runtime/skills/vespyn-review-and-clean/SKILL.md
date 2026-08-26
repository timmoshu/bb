---
name: vespyn-review-and-clean
description: Review a branch, PR, or diff for verified technical debt and needless complexity, apply root-cause simplifications, and rerun the relevant gates before handoff.
---

# Review and clean

Review the complete changeset before it is merged or delivered. Verify every suspected issue against
the repository before changing anything; fix the pattern, not merely the first visible symptom.

## Workflow

1. Identify the exact base, head, dirty state, and changed files. Read every changed source file in
   full and read the repository instructions.
2. Run two independent read-only lenses:
   - technical debt, correctness, and contract integrity;
   - simplification, duplication, and unnecessary indirection.
3. Prefer the `vespyn-delegate-external` skill for those bounded lenses. If external providers are
   unavailable, run the two lenses sequentially yourself and record them separately. Do not silently
   substitute paid subagents.
4. Merge and deduplicate the findings. Before accepting one:
   - search the full codebase for uses, re-exports, dynamic loading, config, and tests;
   - confirm allegedly duplicated sites have identical semantics;
   - check repository conventions and history before calling a path stale;
   - distinguish pre-existing issues from changes introduced by this diff.
5. Report verified findings by severity with file and line grounding. When the user has already
   authorized implementation and the fix stays inside the requested scope, apply it without another
   approval round.
6. Fix holistically but do not expand into unrelated cleanup. Prefer deletion and a deeper existing
   module over another wrapper or compatibility path.
7. Rerun focused tests, type checking, the production build, and any project-specific full gate.
   Reinspect the final diff and state what the gates do not cover.

## False-positive checks

- An import is not dead until full-repository search proves it.
- Similar-looking blocks are not duplication when their authority, failure, or lifecycle semantics
  differ.
- A file is not accidental until the merge base and history prove it.
- A convention is not violated until the repository instructions and established patterns agree.
- A simplification is not an improvement if it weakens types, bounds, authorization, recovery, or
  testability.
