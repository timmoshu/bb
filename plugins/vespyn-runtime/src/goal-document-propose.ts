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

export const GOAL_DOCUMENT_PROPOSE_TOOL = "goal_document_propose";
export const GOAL_DOCUMENT_PROPOSE_SKILL = "goal-document-propose";

const CELL_TOOL_PATH = "/cell-tools/v1/goal-document-propose";

export type ProposeRequestBodyV1 = {
  threadId: string;
  projectId: string;
  requestId: string;
  expectedGoalDocumentVersion: number;
  patch: {
    title: string;
    outcome: string;
    openConditionTexts: string[];
  };
};

export function mintProposeRequestId(): string {
  return mintCellToolRequestId();
}

export function buildProposeRequest(input: {
  threadId: string;
  projectId: string;
  expectedGoalDocumentVersion: number;
  title: string;
  outcome: string;
  openConditionTexts: string[];
}): ProposeRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    requestId: mintProposeRequestId(),
    expectedGoalDocumentVersion: input.expectedGoalDocumentVersion,
    patch: {
      title: input.title,
      outcome: input.outcome,
      openConditionTexts: input.openConditionTexts,
    },
  };
}

export function cellToolProposeUrl(coordinatorOrigin: string): string {
  return cellToolUrl(coordinatorOrigin, CELL_TOOL_PATH);
}

export async function postGoalDocumentPropose(input: {
  coordinatorOrigin: string;
  secret: string;
  body: ProposeRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  const posted = await postCellToolJson({
    url: cellToolProposeUrl(input.coordinatorOrigin),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;

  if (posted.status === 202) {
    const resultingVersion = readResultingVersion(posted.payload);
    if (resultingVersion === null) {
      return errorResult(
        "Work Together accepted the propose without a version.",
      );
    }
    return textResult(
      `Goal document proposed. resultingVersion=${resultingVersion}`,
    );
  }

  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "the propose"),
  );
}

function readResultingVersion(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  if (!isRecord(payload.result)) return null;
  const version = payload.result.resultingVersion;
  return typeof version === "number" && Number.isSafeInteger(version)
    ? version
    : null;
}
