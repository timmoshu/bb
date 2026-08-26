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

export const ROOM_RESULT_PUBLISH_TOOL = "room_result_publish";
export const ROOM_RESULT_PUBLISH_SKILL = "room-result-publish";

const CELL_TOOL_PATH = "/cell-tools/v1/room-result-publish";

export type RoomResultPublishRequestBodyV1 = {
  threadId: string;
  projectId: string;
  requestId: string;
  summary: string;
  nextActions?: Array<{ text: string }>;
};

export function mintRoomResultRequestId(): string {
  return mintCellToolRequestId();
}

export function buildRoomResultPublishRequest(input: {
  threadId: string;
  projectId: string;
  summary: string;
  nextActions?: Array<{ text: string }>;
}): RoomResultPublishRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintRoomResultRequestId(),
    summary: input.summary,
    ...(input.nextActions !== undefined
      ? { nextActions: input.nextActions }
      : {}),
  };
}

export function cellToolRoomResultPublishUrl(coordinatorOrigin: string): string {
  return cellToolUrl(coordinatorOrigin, CELL_TOOL_PATH);
}

export async function postRoomResultPublish(input: {
  coordinatorOrigin: string;
  secret: string;
  body: RoomResultPublishRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  const posted = await postCellToolJson({
    url: cellToolRoomResultPublishUrl(input.coordinatorOrigin),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;

  if (posted.status === 202) {
    const published = readPublishedResult(posted.payload);
    if (published === null) {
      return errorResult(
        "Work Together accepted the result publish without a receipt.",
      );
    }
    return textResult(
      `Room result published. resultId=${published.resultId} resultRevision=${published.resultRevision}`,
    );
  }

  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "the result publish"),
  );
}

function readPublishedResult(payload: unknown): {
  resultId: string;
  resultRevision: number;
} | null {
  if (!isRecord(payload)) return null;
  if (!isRecord(payload.result)) return null;
  const record = payload.result;
  if (record.disposition !== "room-result-published") return null;
  if (typeof record.resultId !== "string" || record.resultId.trim() === "") {
    return null;
  }
  if (
    typeof record.resultRevision !== "number"
    || !Number.isSafeInteger(record.resultRevision)
  ) {
    return null;
  }
  return {
    resultId: record.resultId,
    resultRevision: record.resultRevision,
  };
}
