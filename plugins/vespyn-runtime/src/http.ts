import { randomInt } from "node:crypto";

import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

const CROCKFORD = "23456789abcdefghijkmnpqrstuvwxyz";
const REQUEST_ID_PREFIX = "creq_";
const REQUEST_ID_BODY_LENGTH = 10;

export const CELL_TOOL_CONTRACT_VERSION = "1";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mintCellToolRequestId(): string {
  let body = "";
  for (let index = 0; index < REQUEST_ID_BODY_LENGTH; index += 1) {
    body += CROCKFORD[randomInt(CROCKFORD.length)]!;
  }
  return `${REQUEST_ID_PREFIX}${body}`;
}

export function cellToolUrl(coordinatorOrigin: string, path: string): string {
  const url = `${coordinatorOrigin}${path}`;
  if (/[?&](?:secret|token)=/u.test(url)) {
    throw new Error("Coordinator URL must not carry a query token");
  }
  return url;
}

export function cellToolHeaders(secret: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-wt-cell-tool-secret": secret,
    "x-wt-cell-tool-contract-version": CELL_TOOL_CONTRACT_VERSION,
  };
}

export type CellToolPostSuccess = {
  ok: true;
  status: number;
  payload: unknown;
};

export type CellToolPostFailure = {
  ok: false;
  result: PluginAgentToolResult;
};

export async function postCellToolJson(input: {
  url: string;
  secret: string;
  body: unknown;
  signal: AbortSignal;
}): Promise<CellToolPostSuccess | CellToolPostFailure> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers: cellToolHeaders(input.secret),
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch {
    return {
      ok: false,
      result: {
        isError: true,
        content: [{ type: "text", text: "Could not reach Work Together." }],
      },
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: true, status: response.status, payload };
}

export function readCoordinatorErrorDetail(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return null;
}

export function coordinatorRejection(
  status: number,
  payload: unknown,
  action: string,
): string {
  const detail = readCoordinatorErrorDetail(payload);
  if (detail !== null) {
    return `Work Together rejected ${action} (${status}: ${detail}).`;
  }
  return `Work Together rejected ${action} (${status}).`;
}

export function textResult(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): PluginAgentToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
