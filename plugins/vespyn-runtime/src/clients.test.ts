import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

import { CELL_TOOL_CONTRACT_VERSION } from "./http.js";
import {
  buildProposeRequest,
  cellToolProposeUrl,
  postGoalDocumentPropose,
} from "./goal-document-propose.js";
import {
  buildRoomResultPublishRequest,
  postRoomResultPublish,
} from "./room-result-publish.js";
import {
  buildRoomSubagentSpawnRequest,
  postRoomSubagentSpawn,
} from "./room-subagent-spawn.js";
import {
  buildWorkstreamCompletenessRequest,
  postWorkstreamCompleteness,
} from "./workstream-completeness.js";

const SECRET = "s".repeat(32);
const openServers: Array<{ close(): void }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    server.close();
  }));
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  openServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

function jsonOnEnd(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
  captured: { headers: IncomingMessage["headers"]; body: string; url: string },
): void {
  captured.headers = req.headers;
  captured.url = req.url ?? "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    captured.body += chunk;
  });
  req.on("end", () => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
}

function expectCellToolHeaders(
  headers: IncomingMessage["headers"],
  secret: string,
): void {
  expect(headers["x-wt-cell-tool-secret"]).toBe(secret);
  expect(headers["x-wt-cell-tool-contract-version"]).toBe(
    CELL_TOOL_CONTRACT_VERSION,
  );
  expect(headers["content-type"]).toMatch(/^application\/json\b/);
}

function expectNoSecrets(
  result: unknown,
  secret: string,
  origin: string,
): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(origin);
}

function structuredResult(result: PluginAgentToolResult): {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
} {
  expect(typeof result).toBe("object");
  if (typeof result === "string") {
    throw new Error("expected structured tool result");
  }
  return result;
}

describe("cell tool URL construction", () => {
  it("rejects query tokens on the constructed propose URL", () => {
    expect(() => cellToolProposeUrl("https://work.vespyn.com?token=x")).toThrow(
      /query token/,
    );
  });
});

describe("goal_document_propose request + HTTP", () => {
  it("mints a creq_ request id and posts headers + body", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 202, {
        result: { disposition: "goal-document-proposed", resultingVersion: 7 },
      }, captured);
    });

    const body = buildProposeRequest({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
      expectedGoalDocumentVersion: 3,
      title: "Shaped Goal",
      outcome: "Draft outcome",
      openConditionTexts: ["First open"],
    });
    expect(body.requestId).toMatch(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);

    const result = structuredResult(await postGoalDocumentPropose({
      coordinatorOrigin: origin,
      secret: SECRET,
      body,
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{
      type: "text",
      text: "Goal document proposed. resultingVersion=7",
    }]);
    expect(captured.url).toBe("/cell-tools/v1/goal-document-propose");
    expectCellToolHeaders(captured.headers, SECRET);
    expect(JSON.parse(captured.body)).toEqual(body);
    expectNoSecrets(result, SECRET, origin);
  });
});

describe("room_result_publish request + HTTP", () => {
  it("mints a creq_ request id and posts headers + body without nextActions", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 202, {
        result: {
          disposition: "room-result-published",
          resultId: "dddddddd-eeee-4fff-8000-111111111111",
          resultRevision: 3,
        },
      }, captured);
    });

    const body = buildRoomResultPublishRequest({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
      summary: "Isolated scratch result summary",
    });
    expect(body.requestId).toMatch(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);
    expect(body).not.toHaveProperty("nextActions");

    const result = structuredResult(await postRoomResultPublish({
      coordinatorOrigin: origin,
      secret: SECRET,
      body,
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{
      type: "text",
      text:
        "Room result published. resultId=dddddddd-eeee-4fff-8000-111111111111 resultRevision=3",
    }]);
    expect(captured.url).toBe("/cell-tools/v1/room-result-publish");
    expectCellToolHeaders(captured.headers, SECRET);
    expect(JSON.parse(captured.body)).toEqual(body);
    expectNoSecrets(result, SECRET, origin);
  });

  it("includes nextActions in the posted body when provided", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 202, {
        result: {
          disposition: "room-result-published",
          resultId: "dddddddd-eeee-4fff-8000-111111111111",
          resultRevision: 4,
        },
      }, captured);
    });

    const body = buildRoomResultPublishRequest({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
      summary: "Done with a follow-up",
      nextActions: [{ text: "Ask the human to Ack" }],
    });

    const result = structuredResult(await postRoomResultPublish({
      coordinatorOrigin: origin,
      secret: SECRET,
      body,
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expectCellToolHeaders(captured.headers, SECRET);
    expect(JSON.parse(captured.body)).toEqual(body);
    expect(JSON.parse(captured.body).nextActions).toEqual([
      { text: "Ask the human to Ack" },
    ]);
  });
});

describe("workstream_completeness request + HTTP", () => {
  it("posts thread and project and returns apply:false judgement text", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 200, {
        data: {
          schemaVersion: 1,
          apply: false,
          verdict: "ready",
          missing: [],
          contradictions: [],
          proposedNext:
            "Ask the human to Ack the result. Do not write Done or mark the objective met.",
          grading: "charter",
        },
      }, captured);
    });

    const body = buildWorkstreamCompletenessRequest({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
    });
    expect(body).toEqual({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
    });

    const result = structuredResult(await postWorkstreamCompleteness({
      coordinatorOrigin: origin,
      secret: SECRET,
      body,
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(String(result.content[0]?.text)).toContain("apply=false");
    expect(String(result.content[0]?.text)).toContain("ready");
    expect(captured.url).toBe("/cell-tools/v1/workstream-completeness");
    expectCellToolHeaders(captured.headers, SECRET);
    expect(JSON.parse(captured.body)).toEqual(body);
    expectNoSecrets(result, SECRET, origin);
  });
});

describe("room_subagent_spawn request + HTTP", () => {
  it("mints a creq_ request id and posts headers + body", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 201, {
        result: {
          disposition: "room-subagent-spawned",
          childThreadId: "thr_childxxxx",
        },
      }, captured);
    });

    const body = buildRoomSubagentSpawnRequest({
      threadId: "thr_23456789ab",
      projectId: "proj_standard1",
      prompt: "Investigate the failing test and report back.",
    });
    expect(body.requestId).toMatch(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);

    const result = structuredResult(await postRoomSubagentSpawn({
      coordinatorOrigin: origin,
      secret: SECRET,
      body,
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{
      type: "text",
      text: "Subagent spawned. childThreadId=thr_childxxxx",
    }]);
    expect(captured.url).toBe("/cell-tools/v1/room-subagent-spawn");
    expectCellToolHeaders(captured.headers, SECRET);
    expect(JSON.parse(captured.body)).toEqual(body);
    expectNoSecrets(result, SECRET, origin);
  });

  it("accepts 202 with the same spawn receipt", async () => {
    const captured = { headers: {} as IncomingMessage["headers"], body: "", url: "" };
    const origin = await listen((req, res) => {
      jsonOnEnd(req, res, 202, {
        result: {
          disposition: "room-subagent-spawned",
          childThreadId: "thr_accepted2",
        },
      }, captured);
    });

    const result = structuredResult(await postRoomSubagentSpawn({
      coordinatorOrigin: origin,
      secret: SECRET,
      body: buildRoomSubagentSpawnRequest({
        threadId: "thr_23456789ab",
        projectId: "proj_standard1",
        prompt: "Follow up.",
      }),
      signal: new AbortController().signal,
    }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{
      type: "text",
      text: "Subagent spawned. childThreadId=thr_accepted2",
    }]);
    expectCellToolHeaders(captured.headers, SECRET);
  });
});
