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

export const ROOM_SUBAGENT_SPAWN_TOOL = "room_subagent_spawn";

const CELL_TOOL_PATH = "/cell-tools/v1/room-subagent-spawn";

export type RoomSubagentSpawnRequestBodyV1 = {
  threadId: string;
  projectId: string;
  requestId: string;
  prompt: string;
};

export function mintRoomSubagentSpawnRequestId(): string {
  return mintCellToolRequestId();
}

export function buildRoomSubagentSpawnRequest(input: {
  threadId: string;
  projectId: string;
  prompt: string;
}): RoomSubagentSpawnRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintRoomSubagentSpawnRequestId(),
    prompt: input.prompt,
  };
}

export function cellToolRoomSubagentSpawnUrl(coordinatorOrigin: string): string {
  return cellToolUrl(coordinatorOrigin, CELL_TOOL_PATH);
}

export async function postRoomSubagentSpawn(input: {
  coordinatorOrigin: string;
  secret: string;
  body: RoomSubagentSpawnRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  const posted = await postCellToolJson({
    url: cellToolRoomSubagentSpawnUrl(input.coordinatorOrigin),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;

  if (posted.status === 201 || posted.status === 202) {
    const childThreadId = readChildThreadId(posted.payload);
    if (childThreadId === null) {
      return errorResult(
        "Work Together accepted the Subagent spawn without a childThreadId.",
      );
    }
    return textResult(`Subagent spawned. childThreadId=${childThreadId}`);
  }

  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "the Subagent spawn"),
  );
}

function readChildThreadId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (!isRecord(payload.result)) return null;
  const record = payload.result;
  if (record.disposition !== "room-subagent-spawned") return null;
  if (
    typeof record.childThreadId !== "string"
    || record.childThreadId.trim() === ""
  ) {
    return null;
  }
  return record.childThreadId;
}
