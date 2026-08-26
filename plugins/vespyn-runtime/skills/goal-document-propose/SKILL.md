---
name: goal-document-propose
description: Apply a forming Goal document draft through Work Together's goal_document_propose tool using the Room snapshot version.
---

# Shape a Goal draft through Work Together

Use the native `goal_document_propose` tool when this Room is shaping a Goal document.

## Required sequence

1. Read the Goal snapshot from Room context. Note its `documentVersion`.
2. Call `goal_document_propose` with:
   - `expectedGoalDocumentVersion` = that snapshot `documentVersion`
   - `title`, `outcome`, and `openConditionTexts` for the draft
3. Treat the tool result's `resultingVersion` as the new document version for any follow-up patch.

## Boundaries

- Do not activate, drop, or otherwise change Goal lifecycle.
- Do not omit or rewrite met success conditions; only propose open-condition texts.
- Do not put secrets, coordinator URLs, or raw coordinator error internals in the user-facing reply.
- A rejected propose is not safe to replay blindly. Re-read the snapshot version first.
