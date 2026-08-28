# bb-plugin-vespyn-runtime

Server-owned BB plugin for Work Together cells. It ships Vespyn's portable
engineering workflows plus the Room cell tools. The plugin selects every
tool and skill for **standard** BB projects and contributes nothing to the
personal project.

This package is not a user-managed catalog plugin. Configure it with
environment variables on the owner cell; there are no plugin settings.

## Environment

Read once when the plugin factory loads:

| Variable                              | Meaning                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `BB_WORK_TOGETHER_COORDINATOR_ORIGIN` | HTTPS DNS origin, or loopback HTTP with an explicit port. No userinfo, path, query, or fragment. |
| `BB_WORK_TOGETHER_CELL_TOOL_SECRET`   | Shared secret sent as `x-wt-cell-tool-secret`. At least 32 UTF-8 bytes. Never put this in a URL. |

Invalid values fail plugin load with a sanitized error. Error text never
includes the origin or the secret.

Every cell-tool POST sends:

- `content-type: application/json`
- `x-wt-cell-tool-secret`
- `x-wt-cell-tool-contract-version: 1`

## Tools

- `goal_document_propose`
- `workstream_completeness`
- `room_result_publish`
- `room_subagent_spawn`
- `filespace_list`
- `filespace_get`
- `filespace_put`

## Skills

Portable Vespyn workflows:

- `vespyn-dev-pipeline`
- `vespyn-review-and-clean`
- `vespyn-codebase-design`
- `vespyn-domain-modeling`
- `vespyn-delegate-external`
- `vespyn-fresh-session-kickoff`

Work Together Room skills:

- `goal-document-propose`
- `workstream-completeness`
- `room-result-publish`
- `room-delegate`
- `filespace`

## Verify

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-vespyn-runtime
pnpm exec turbo run test --filter=bb-plugin-vespyn-runtime
```
