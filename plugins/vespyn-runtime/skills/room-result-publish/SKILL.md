---
name: room-result-publish
description: Publish one typed Workstream result for this Room through Work Together's room_result_publish tool when the work is done.
---

# Publish a Room result through Work Together

Use the native `room_result_publish` tool when this Room's work is complete and a human should Acknowledge the result on the board.

## Required sequence

1. Call `workstream_completeness` first (unless you just did). If blocked on charter or toward items, stay on those. If the only gap is a missing result, publish, then re-grade.
2. Summarize the completed work in a bounded summary. Do not invent Goal condition closure.
3. Call `room_result_publish` with that summary. Include `nextActions` only when you actually recommend concrete follow-ups as `{text}` entries.
4. Treat the tool receipt (`resultId` / `resultRevision`) as the published result. Do not paste the result as chat JSON.

## Boundaries

- Do not mark Goal success conditions met, tick defaults, or mutate Goal lifecycle.
- Do not invent nextActions from the summary when you have no real follow-ups.
- Do not put secrets, coordinator URLs, or raw coordinator error internals in the user-facing reply.
- Call this from the Primary when the Room's work is done, including git Rooms. Subagents do not publish.
- Do not attach Git evidence. Human Deliver owns `branch.publish`.
