import { getThread, getWorkTogetherThreadContext } from "@bb/db";
import type { DbQueryConnection } from "@bb/db";
import type { DynamicTool, ToolCallResponse } from "@bb/domain";
import { z } from "zod";
import { getWorkTogetherCellTools } from "./work-together-filespace-tool.js";

export const WT_CHECKPOINT_REPORT_TOOL_NAME = "wt_checkpoint_report";
export const WT_RESULT_REPORT_TOOL_NAME = "wt_result_report";
export const WT_NEEDS_YOU_REPORT_TOOL_NAME = "wt_needs_you_report";
export const WT_REPOSITORY_DELIVER_TOOL_NAME = "wt_repository_deliver";

const checkpointInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    progress: z.string().min(1).max(4000),
    nextAction: z.string().min(1).max(4000),
    headRevision: z.number().int().nonnegative().optional(),
    resourceGeneration: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

const resultInputSchema = checkpointInputSchema.extend({
  summary: z.string().min(1).max(4000),
});

const needsYouInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    question: z.string().min(1).max(4000),
  })
  .strict();

const repositoryDeliverInputSchema = z
  .object({ idempotencyKey: z.string().min(1).max(200).optional() })
  .strict();

export const WT_REPOSITORY_DELIVER_TOOL: DynamicTool = {
  name: WT_REPOSITORY_DELIVER_TOOL_NAME,
  description:
    "Publish the current clean local commit to the Start-authorized WT-generated branch after tests. Never merge, write the default branch, create a release, or deploy.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: {
        type: "string",
        description: "Optional replay key. Omit to use the current BB turn identity.",
      },
    },
    additionalProperties: false,
  },
};

export const WT_CHECKPOINT_REPORT_TOOL: DynamicTool = {
  name: WT_CHECKPOINT_REPORT_TOOL_NAME,
  description:
    "Report a cheap checkpoint after material progress. Neither this nor a result finishes Work. Do not include actor, goal, workspace, or thread identifiers.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: {
        type: "string",
        description: "Caller-chosen idempotency key for this checkpoint.",
      },
      progress: {
        type: "string",
        description: "What has been accomplished so far.",
      },
      nextAction: {
        type: "string",
        description: "What should happen next.",
      },
      headRevision: {
        type: "integer",
        minimum: 0,
        description: "Optional kernel head revision observed at this checkpoint.",
      },
      resourceGeneration: {
        type: "string",
        description: "Optional sha256 hex of the Goal filespace generation set.",
      },
    },
    required: ["idempotencyKey", "progress", "nextAction"],
    additionalProperties: false,
  },
};

export const WT_RESULT_REPORT_TOOL: DynamicTool = {
  name: WT_RESULT_REPORT_TOOL_NAME,
  description:
    "Report the Primary synthesis for this Work. This does not finish Work or mark a Goal met. Do not include actor, goal, workspace, or thread identifiers.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: {
        type: "string",
        description: "Caller-chosen idempotency key for this result.",
      },
      progress: {
        type: "string",
        description: "What has been accomplished.",
      },
      nextAction: {
        type: "string",
        description: "What the human should do next.",
      },
      summary: {
        type: "string",
        description: "Primary synthesis of the work.",
      },
      headRevision: {
        type: "integer",
        minimum: 0,
        description: "Optional kernel head revision observed at this result.",
      },
      resourceGeneration: {
        type: "string",
        description: "Optional sha256 hex of the Goal filespace generation set.",
      },
    },
    required: ["idempotencyKey", "progress", "nextAction", "summary"],
    additionalProperties: false,
  },
};

export const WT_NEEDS_YOU_REPORT_TOOL: DynamicTool = {
  name: WT_NEEDS_YOU_REPORT_TOOL_NAME,
  description:
    "Use only when progress cannot continue without a human decision or input. Call once and stop. This does not finish Work or mark a Goal met. Do not include actor, goal, workspace, or thread identifiers.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: {
        type: "string",
        description: "Caller-chosen idempotency key for this needs-you report.",
      },
      question: {
        type: "string",
        description: "The human decision or input required to continue.",
      },
    },
    required: ["idempotencyKey", "question"],
    additionalProperties: false,
  },
};

export function workTogetherSettlementToolsForThread(
  db: DbQueryConnection,
  threadId: string,
): DynamicTool[] {
  if (!getWorkTogetherCellTools()) return [];
  if (!getWorkTogetherThreadContext(db, threadId)) return [];
  const tools = [
    WT_CHECKPOINT_REPORT_TOOL,
    WT_RESULT_REPORT_TOOL,
    WT_NEEDS_YOU_REPORT_TOOL,
  ];
  if (getThread(db, threadId)?.originKind === null) {
    tools.push(WT_REPOSITORY_DELIVER_TOOL);
  }
  return tools;
}

function textResponse(success: boolean, text: string): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

async function postSettlement(
  path: string,
  threadId: string,
  body: Record<string, unknown>,
  failMessage: string,
): Promise<ToolCallResponse> {
  const cellTools = getWorkTogetherCellTools();
  if (!cellTools) {
    return textResponse(false, "Work Together cell tools are not configured");
  }
  const url = `${cellTools.baseUrl.replace(/\/$/u, "")}${path}`;
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
        bbThreadId: threadId,
        ...body,
      }),
    });
  } catch {
    return textResponse(false, failMessage);
  }
  if (!response.ok) {
    return textResponse(false, failMessage);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return textResponse(false, failMessage);
  }
  return textResponse(true, JSON.stringify(payload));
}

export async function handleWtCheckpointReportToolCall(args: {
  threadId: string;
  input: unknown;
}): Promise<ToolCallResponse> {
  const parsed = checkpointInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return textResponse(false, "Invalid checkpoint report input");
  }
  return postSettlement(
    "/cell-tools/v1/checkpoint",
    args.threadId,
    parsed.data,
    "Checkpoint report failed",
  );
}

export async function handleWtResultReportToolCall(args: {
  threadId: string;
  input: unknown;
}): Promise<ToolCallResponse> {
  const parsed = resultInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return textResponse(false, "Invalid result report input");
  }
  return postSettlement(
    "/cell-tools/v1/result",
    args.threadId,
    parsed.data,
    "Result report failed",
  );
}

export async function handleWtNeedsYouReportToolCall(args: {
  threadId: string;
  input: unknown;
}): Promise<ToolCallResponse> {
  const parsed = needsYouInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return textResponse(false, "Invalid needs-you report input");
  }
  return postSettlement(
    "/cell-tools/v1/needs-you",
    args.threadId,
    parsed.data,
    "Needs-you report failed",
  );
}

export async function handleWtRepositoryDeliverToolCall(args: {
  projectId: string;
  threadId: string;
  turnId: string;
  input: unknown;
}): Promise<ToolCallResponse> {
  const parsed = repositoryDeliverInputSchema.safeParse(args.input ?? {});
  if (!parsed.success) return textResponse(false, "Invalid repository delivery input");
  const cellTools = getWorkTogetherCellTools();
  if (!cellTools) return textResponse(false, "Work Together cell tools are not configured");
  const idempotencyKey =
    parsed.data.idempotencyKey ?? `repository-deliver:${args.threadId}:${args.turnId}`;
  try {
    const response = await (cellTools.fetch ?? fetch)(
      `${cellTools.baseUrl.replace(/\/$/u, "")}/cell-tools/v1/repository/deliver`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + cellTools.token,
          "content-type": "application/json",
          "x-bb-project-id": args.projectId,
          "x-bb-thread-id": args.threadId,
        },
        body: JSON.stringify({ idempotencyKey }),
      },
    );
    const payload = await response.json().catch(() => undefined);
    if (!response.ok || payload === undefined) {
      const code =
        payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : "repository_delivery_unavailable";
      return textResponse(false, `Repository delivery failed: ${code}`);
    }
    return textResponse(true, JSON.stringify(payload));
  } catch {
    return textResponse(false, "Repository delivery failed: repository_delivery_unavailable");
  }
}
