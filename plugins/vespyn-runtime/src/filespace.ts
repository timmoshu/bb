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

type FilespaceRequestBaseV1 = {
  threadId: string;
  projectId: string;
  requestId: string;
};

export type FilespaceRequestBodyV1 =
  | (FilespaceRequestBaseV1 & {
      kind: "filespace.list";
      prefix?: string;
    })
  | (FilespaceRequestBaseV1 & {
      kind: "filespace.get";
      path: string;
    })
  | (FilespaceRequestBaseV1 & {
      kind: "filespace.put";
      path: string;
      expectedGeneration: number;
      text: string;
      mediaType: string;
    });

const MAX_LIST_OBJECTS = 500;
const MAX_LISTED_PATHS = 100;
const MAX_PATH_BYTES = 1_024;
const MAX_INLINE_TEXT_BYTES = 65_536;
const utf8 = new TextEncoder();

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

export async function postFilespace(input: {
  coordinatorOrigin: string;
  secret: string;
  body: FilespaceRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  if (
    input.body.kind === "filespace.put" &&
    hasUnsafeFilespacePath(input.body.path)
  ) {
    return errorResult("Refusing filespace.put of an invalid filespace path.");
  }
  const posted = await postCellToolJson({
    url: cellToolUrl(input.coordinatorOrigin, CELL_TOOL_PATH),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;
  if (
    posted.status === 200 ||
    (input.body.kind === "filespace.put" && posted.status === 201)
  ) {
    const formatted = formatFilespacePayload(input.body.kind, posted.payload);
    if (formatted === null) {
      return errorResult(
        `Work Together returned ${input.body.kind} without valid data.`,
      );
    }
    return textResult(formatted);
  }
  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "filespace"),
  );
}

function formatFilespacePayload(
  kind: FilespaceRequestBodyV1["kind"],
  payload: unknown,
): string | null {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  if (kind === "filespace.list") {
    if (
      !Array.isArray(data.objects) ||
      data.objects.length > MAX_LIST_OBJECTS
    ) {
      return null;
    }
    const paths: string[] = [];
    for (const object of data.objects) {
      if (!isRecord(object) || !validResponsePath(object.path)) return null;
      paths.push(object.path);
    }
    if (paths.length === 0) return "Filespace list: (empty)";
    const visible = paths.slice(0, MAX_LISTED_PATHS);
    const omitted = paths.length - visible.length;
    return `Filespace list: ${visible.join(", ")}${
      omitted === 0 ? "" : `, … ${omitted} more; narrow prefix to continue`
    }`;
  }
  if (
    !validResponsePath(data.path) ||
    typeof data.generation !== "number" ||
    !Number.isSafeInteger(data.generation) ||
    data.generation < 1 ||
    (data.text !== undefined &&
      (typeof data.text !== "string" ||
        utf8.encode(data.text).byteLength > MAX_INLINE_TEXT_BYTES))
  ) {
    return null;
  }
  const text = typeof data.text === "string" ? `\n${data.text}` : "";
  const action = kind === "filespace.get" ? "get" : "put";
  return `Filespace ${action}: ${data.path} generation=${data.generation}${text}`;
}

function validResponsePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8.encode(value).byteLength <= MAX_PATH_BYTES
  );
}

function hasUnsafeFilespacePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
