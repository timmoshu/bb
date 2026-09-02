import { getWorkTogetherThreadContext } from "@bb/db";
import type { DbQueryConnection } from "@bb/db";
import type { DynamicTool, ToolCallResponse } from "@bb/domain";
import { z } from "zod";

export const WT_FILESPACE_PUBLISH_TOOL_NAME = "wt_filespace_publish";

const inputSchema = z
  .object({
    path: z.string().min(1).max(512),
    expectedGeneration: z.number().int().nonnegative(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const WT_FILESPACE_PUBLISH_TOOL: DynamicTool = {
  name: WT_FILESPACE_PUBLISH_TOOL_NAME,
  description:
    "Publish a file into the Goal filespace. Use this to write UTF-8 text at a relative path with CAS expectedGeneration. Do not include actor, goal, workspace, or thread identifiers.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative Goal filespace path. No leading slash or .. segments.",
      },
      expectedGeneration: {
        type: "integer",
        minimum: 0,
        description: "CAS generation. 0 creates a new file.",
      },
      digest: {
        type: "string",
        description: "sha256 hex of the UTF-8 bytes.",
      },
      text: {
        type: "string",
        description: "UTF-8 file contents.",
      },
      idempotencyKey: {
        type: "string",
        description: "Caller-chosen idempotency key for this put.",
      },
    },
    required: ["path", "expectedGeneration", "digest", "text", "idempotencyKey"],
    additionalProperties: false,
  },
};

export type WorkTogetherCellToolsConfig = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
};

let cellTools: WorkTogetherCellToolsConfig | undefined;

export function setWorkTogetherCellTools(next: WorkTogetherCellToolsConfig | undefined): void {
  cellTools = next;
}

export function getWorkTogetherCellTools(): WorkTogetherCellToolsConfig | undefined {
  return cellTools;
}

export function workTogetherFilespaceToolForThread(
  db: DbQueryConnection,
  threadId: string,
): DynamicTool | undefined {
  if (!cellTools) return undefined;
  if (!getWorkTogetherThreadContext(db, threadId)) return undefined;
  return WT_FILESPACE_PUBLISH_TOOL;
}

function textResponse(success: boolean, text: string): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

export async function handleWtFilespacePublishToolCall(args: {
  threadId: string;
  input: unknown;
}): Promise<ToolCallResponse> {
  if (!cellTools) {
    return textResponse(false, "Work Together cell tools are not configured");
  }
  const parsed = inputSchema.safeParse(args.input);
  if (!parsed.success) {
    return textResponse(false, "Invalid filespace publish input");
  }
  const url = `${cellTools.baseUrl.replace(/\/$/u, "")}/cell-tools/v1/filespace/put`;
  const fetchFn = cellTools.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cellTools.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bbThreadId: args.threadId,
        ...parsed.data,
      }),
    });
  } catch {
    return textResponse(false, "Goal filespace publish failed");
  }
  if (!response.ok) {
    return textResponse(false, "Goal filespace publish failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return textResponse(false, "Goal filespace publish failed");
  }
  return textResponse(true, JSON.stringify(body));
}
