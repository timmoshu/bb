---
name: room-delegate
description: Delegate Room work by spawning a BB child thread in the same project and environment so Work Together projects it as a Subagent.
---

# Delegate Room work through a BB child thread

When this Room's work should be decomposed, spawn a BB child thread with the `room_subagent_spawn` tool. Work Together already projects that child as a visible Subagent. Do not use native Grok `spawn_subagent` or Codex multi-agent helpers for Room work.

## Required path

Call `room_subagent_spawn` with a clear `prompt` for the child. That cell tool creates a BB child thread in the **same** project and environment (reuse; no new environment) and returns `childThreadId`.

Do **not** use `bb thread spawn` from the Room agent. Live dogfood showed unauthenticated `bb` CLI calls return HTTP 401 (`bb status` had no context). The cell-tool fence is the required path.

## Boundaries

- Do not use Grok `spawn_subagent`, Codex native multi-agent, or any other provider-native subagent helper for Room delegation.
- Do not commit, push, or publish Git. Human Deliver owns `branch.publish`.
- Do not call `room_result_publish` from a Subagent. The Primary publishes the Room result. Git Deliver stays human.
- Do not mark Goal success conditions met or mutate Goal lifecycle.
