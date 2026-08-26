import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

import {
  cellToolUrl,
  coordinatorRejection,
  errorResult,
  isRecord,
  postCellToolJson,
  textResult,
} from "./http.js";

export const WORKSTREAM_COMPLETENESS_TOOL = "workstream_completeness";
export const WORKSTREAM_COMPLETENESS_SKILL = "workstream-completeness";

const CELL_TOOL_PATH = "/cell-tools/v1/workstream-completeness";

export type WorkstreamCompletenessRequestBodyV1 = {
  threadId: string;
  projectId: string;
};

export function buildWorkstreamCompletenessRequest(input: {
  threadId: string;
  projectId: string;
}): WorkstreamCompletenessRequestBodyV1 {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
  };
}

export function cellToolWorkstreamCompletenessUrl(
  coordinatorOrigin: string,
): string {
  return cellToolUrl(coordinatorOrigin, CELL_TOOL_PATH);
}

export async function postWorkstreamCompleteness(input: {
  coordinatorOrigin: string;
  secret: string;
  body: WorkstreamCompletenessRequestBodyV1;
  signal: AbortSignal;
}): Promise<PluginAgentToolResult> {
  const posted = await postCellToolJson({
    url: cellToolWorkstreamCompletenessUrl(input.coordinatorOrigin),
    secret: input.secret,
    body: input.body,
    signal: input.signal,
  });
  if (!posted.ok) return posted.result;

  if (posted.status === 200) {
    const judgement = readJudgement(posted.payload);
    if (judgement === null) {
      return errorResult(
        "Work Together returned completeness without a judgement.",
      );
    }
    return textResult(formatJudgement(judgement));
  }

  return errorResult(
    coordinatorRejection(posted.status, posted.payload, "completeness"),
  );
}

type JudgementV1 = {
  apply: false;
  verdict: "ready" | "blocked";
  missing: Array<{ code: string; detail: string }>;
  contradictions: Array<{ code: string; detail: string }>;
  proposedNext: string;
  grading: "charter" | "toward_and_goal_only";
};

function readJudgement(payload: unknown): JudgementV1 | null {
  if (!isRecord(payload)) return null;
  if (!isRecord(payload.data)) return null;
  const record = payload.data;
  if (record.apply !== false) return null;
  if (record.verdict !== "ready" && record.verdict !== "blocked") return null;
  if (record.grading !== "charter" && record.grading !== "toward_and_goal_only") {
    return null;
  }
  if (typeof record.proposedNext !== "string" || record.proposedNext.trim() === "") {
    return null;
  }
  const missing = readFindings(record.missing);
  const contradictions = readFindings(record.contradictions);
  if (missing === null || contradictions === null) return null;
  return {
    apply: false,
    verdict: record.verdict,
    missing,
    contradictions,
    proposedNext: record.proposedNext,
    grading: record.grading,
  };
}

function readFindings(
  value: unknown,
): Array<{ code: string; detail: string }> | null {
  if (!Array.isArray(value)) return null;
  const findings: Array<{ code: string; detail: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const code = item.code;
    const detail = item.detail;
    if (typeof code !== "string" || typeof detail !== "string") return null;
    findings.push({ code, detail });
  }
  return findings;
}

function formatJudgement(judgement: JudgementV1): string {
  const missing = judgement.missing.length === 0
    ? "none"
    : judgement.missing.map((item) => `${item.code}: ${item.detail}`).join("; ");
  const contradictions = judgement.contradictions.length === 0
    ? "none"
    : judgement.contradictions
      .map((item) => `${item.code}: ${item.detail}`)
      .join("; ");
  return [
    `Workstream completeness: ${judgement.verdict} (apply=false, grading=${judgement.grading}).`,
    `missing=${missing}`,
    `contradictions=${contradictions}`,
    `proposedNext=${judgement.proposedNext}`,
  ].join(" ");
}
