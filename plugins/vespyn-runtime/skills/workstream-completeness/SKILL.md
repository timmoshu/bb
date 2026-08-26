---
name: workstream-completeness
description: Grade this Room's workstream against its charter and toward-objective via workstream_completeness. Propose-only; never marks Done or objective met.
---

# Grade workstream completeness through Work Together

Use the native `workstream_completeness` tool to ask whether this Room's workstream is complete against its charter, toward-objective, and current result.

## When to call

- Before `room_result_publish`
- When you are about to claim the work is done
- When a human asks whether we are done

Do not call it every turn.

## Required sequence

1. Call `workstream_completeness` with no extra arguments. The bound Room is the workstream.
2. Read `verdict`, `missing`, `contradictions`, and `proposedNext`.
3. If blocked on charter or toward items, stay on those. If blocked only because there is no result (`missing` includes `result` and nothing else blocking), publish a result if the work produced one, then call again. If `ready`, ask the human to Ack.

## Boundaries

- `apply` is always false. Do not write workstream `Done`.
- Do not mark Goal success conditions / objectives met.
- Empty acceptance is legal and non-blocking (`grading: toward_and_goal_only`). The remaining bar is toward-objective attachment plus a current result. This tool does not compare result text to the toward-objective or Goal outcome.
- Do not put secrets, coordinator URLs, or raw coordinator error internals in the user-facing reply.
