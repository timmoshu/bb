import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

import {
  cellToolUrl,
  coordinatorRejection,
  errorResult,
  isRecord,
  mintCellToolRequestId,
  postCellToolJson,
  textResult,
} from "./http.js";

export const FILESPACE_LIST_TOOL = "filespace_list";
export const FILESPACE_GET_TOOL = "filespace_get";
export const FILESPACE_PUT_TOOL = "filespace_put";
export const FILESPACE_SKILL = "filespace";

const CELL_TOOL_PATH = "/cell-tools/v1/filespace";

export type FilespaceRequestBodyV1 = {
  threadId: string;
  projectId: string;
  requestId: string;
  kind: "filespace.list" | "filespace.get" | "filespace.put";
  prefix?: string;
  path?: string;
  expectedGeneration?: number;
  text?: string;
  mediaType?: string;
};

export function buildFilespaceListRequest(input: {
  threadId: string;
  projectId: string;
  prefix?: string;
}): FilespaceRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintCellToolRequestId(),
    kind: "filespace.list",
    ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
  };
}

export function buildFilespaceGetRequest(input: {
  threadId: string;
  projectId: string;
  path: string;
}): FilespaceRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintCellToolRequestId(),
    kind: "filespace.get",
    path: input.path,
  };
}

export function buildFilespacePutRequest(input: {
  threadId: string;
  projectId: string;
  path: string;
  expectedGeneration: number;
  text: string;
  mediaType: string;
}): FilespaceRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintCellToolRequestId(),
    kind: "filespace.put",
    path: input.path,
    expectedGeneration: input.expectedGeneration,
    text: input.text,
    mediaType: input.mediaType,
  };
}

export function cellToolFilespaceUrl(coordinatorOrigin: string): string {
  return cellToolUrl(coordinatorOrigin, CELL_TOOL_PATH);
}

export async function postFilespace(input: {
  coordinatorOrigin: string;
  secret: string;
  body: FilespaceRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  if (
    input.body.kind === "filespace.put"
    && typeof input.body.path === "string"
    && (input.body.path === "." || input.body.path.startsWith("../"))
  ) {
    return errorResult("Refusing filespace.put of a git-root or parent path.");
  }
  const posted = await postCellToolJson({
    url: cellToolFilespaceUrl(input.coordinatorOrigin),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;
  if (posted.status === 200 || posted.status === 201) {
    return textResult(formatFilespacePayload(input.body.kind, posted.payload));
  }
  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "filespace"),
  );
}

function formatFilespacePayload(kind: string, payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return `Filespace ${kind} succeeded.`;
  }
  const data = payload.data;
  if (Array.isArray(data.objects)) {
    const paths = data.objects
      .filter(isRecord)
      .map((object) => object.path)
      .filter((path): path is string => typeof path === "string");
    return `Filespace list: ${paths.length === 0 ? "(empty)" : paths.join(", ")}`;
  }
  if (typeof data.path === "string") {
    const generation =
      typeof data.generation === "number" ? ` generation=${data.generation}` : "";
    const text = typeof data.text === "string" ? `\n${data.text}` : "";
    return `Filespace ${kind}: ${data.path}${generation}${text}`;
  }
  return `Filespace ${kind} succeeded.`;
}
