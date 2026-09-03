import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleWtCheckpointReportToolCall,
  handleWtNeedsYouReportToolCall,
  handleWtResultReportToolCall,
  WT_CHECKPOINT_REPORT_TOOL,
  WT_CHECKPOINT_REPORT_TOOL_NAME,
  WT_NEEDS_YOU_REPORT_TOOL,
  WT_NEEDS_YOU_REPORT_TOOL_NAME,
  WT_RESULT_REPORT_TOOL,
  WT_RESULT_REPORT_TOOL_NAME,
  workTogetherSettlementToolsForThread,
} from "../../src/services/work-together-settlement-tools.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const CELL_TOKEN = "wt-cell-tool-secret-32chars-ok!!";
const COORD_PATH = "/api/work-together/v1/coordination-threads/goal-settle";

function assertDescriptorClean(descriptor: string) {
  expect(descriptor).not.toContain(CELL_TOKEN);
  expect(descriptor).not.toContain("actorId");
  expect(descriptor).not.toContain("goalId");
  expect(descriptor).not.toContain("workspaceId");
  expect(descriptor).not.toContain("bbThreadId");
}

describe("work-together settlement ACP tools", () => {
  it("lists checkpoint and result tools on coordination threads only without leaking token or identity", async () => {
    expect(WT_CHECKPOINT_REPORT_TOOL.name).toBe(WT_CHECKPOINT_REPORT_TOOL_NAME);
    expect(WT_RESULT_REPORT_TOOL.name).toBe(WT_RESULT_REPORT_TOOL_NAME);
    expect(WT_NEEDS_YOU_REPORT_TOOL.name).toBe(WT_NEEDS_YOU_REPORT_TOOL_NAME);
    assertDescriptorClean(JSON.stringify(WT_CHECKPOINT_REPORT_TOOL));
    assertDescriptorClean(JSON.stringify(WT_RESULT_REPORT_TOOL));
    assertDescriptorClean(JSON.stringify(WT_NEEDS_YOU_REPORT_TOOL));
    expect(WT_NEEDS_YOU_REPORT_TOOL.description).toContain("does not finish Work");

    await withTestHarness(
      {
        workTogetherIntegrationToken: TOKEN,
        wtCellTools: { baseUrl: "http://127.0.0.1:9", token: CELL_TOKEN },
      },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, { id: "host-settle" });
        const envPath = "/tmp/wt-s6-settlement";
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: envPath,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: envPath,
        });
        const created = await harness.app.request(COORD_PATH, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            projectId: project.id,
            environmentId: environment.id,
            title: "Settlement Goal",
          }),
        });
        expect(created.status).toBe(201);
        const threadId = ((await created.json()) as { thread: { id: string } }).thread
          .id;
        const names = workTogetherSettlementToolsForThread(
          harness.deps.db,
          threadId,
        ).map((tool) => tool.name);
        expect(names).toEqual([
          WT_CHECKPOINT_REPORT_TOOL_NAME,
          WT_RESULT_REPORT_TOOL_NAME,
          WT_NEEDS_YOU_REPORT_TOOL_NAME,
        ]);

        const ordinary = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        expect(
          workTogetherSettlementToolsForThread(harness.deps.db, ordinary.id),
        ).toEqual([]);
      },
    );
  });

  it("posts checkpoint and result without actorId and uses the cell token only on the HTTP call", async () => {
    const posts: Array<{ url: string; headers: unknown; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posts.push({ url, headers, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await withTestHarness(
      {
        workTogetherIntegrationToken: TOKEN,
        wtCellTools: {
          baseUrl: "http://127.0.0.1:9",
          token: CELL_TOKEN,
          fetch: fakeFetch,
        },
      },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, { id: "host-settle2" });
        const envPath = "/tmp/wt-s6-settlement-2";
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: envPath,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: envPath,
        });
        const created = await harness.app.request(COORD_PATH, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            projectId: project.id,
            environmentId: environment.id,
            title: "Settlement Goal",
          }),
        });
        expect(created.status).toBe(201);
        const threadId = ((await created.json()) as { thread: { id: string } }).thread
          .id;

        const forged = await handleWtCheckpointReportToolCall({
          threadId,
          input: {
            idempotencyKey: "cp-1",
            progress: "first pass",
            nextAction: "keep going",
            actorId: "forged",
          },
        });
        expect(forged.success).toBe(false);
        expect(posts).toHaveLength(0);

        const checkpoint = await handleWtCheckpointReportToolCall({
          threadId,
          input: {
            idempotencyKey: "cp-1",
            progress: "first pass",
            nextAction: "keep going",
            headRevision: 4,
            resourceGeneration: "ab".repeat(32),
          },
        });
        expect(checkpoint.success).toBe(true);
        expect(posts[0]?.url).toBe("http://127.0.0.1:9/cell-tools/v1/checkpoint");
        expect(posts[0]?.body).toEqual({
          bbThreadId: threadId,
          idempotencyKey: "cp-1",
          progress: "first pass",
          nextAction: "keep going",
          headRevision: 4,
          resourceGeneration: "ab".repeat(32),
        });
        expect(JSON.stringify(posts[0]?.body)).not.toContain("actorId");
        expect(
          new Headers(posts[0]?.headers as HeadersInit).get("authorization"),
        ).toBe(`Bearer ${CELL_TOKEN}`);

        const result = await handleWtResultReportToolCall({
          threadId,
          input: {
            idempotencyKey: "res-1",
            progress: "done enough",
            nextAction: "await human",
            summary: "Primary synthesis. Does not finish Work.",
          },
        });
        expect(result.success).toBe(true);
        expect(posts[1]?.url).toBe("http://127.0.0.1:9/cell-tools/v1/result");
        expect(posts[1]?.body).toEqual({
          bbThreadId: threadId,
          idempotencyKey: "res-1",
          progress: "done enough",
          nextAction: "await human",
          summary: "Primary synthesis. Does not finish Work.",
        });
        expect(JSON.stringify(posts[1]?.body)).not.toContain("actorId");

        const forgedNeeds = await handleWtNeedsYouReportToolCall({
          threadId,
          input: { idempotencyKey: "ny-1", question: "Which API?", actorId: "forged" },
        });
        expect(forgedNeeds.success).toBe(false);
        expect(posts).toHaveLength(2);

        const needsYou = await handleWtNeedsYouReportToolCall({
          threadId,
          input: { idempotencyKey: "ny-1", question: "Which API should we freeze?" },
        });
        expect(needsYou.success).toBe(true);
        expect(posts[2]?.url).toBe("http://127.0.0.1:9/cell-tools/v1/needs-you");
        expect(posts[2]?.body).toEqual({
          bbThreadId: threadId,
          idempotencyKey: "ny-1",
          question: "Which API should we freeze?",
        });
        expect(JSON.stringify(posts[2]?.body)).not.toContain("actorId");
        expect(
          new Headers(posts[2]?.headers as HeadersInit).get("authorization"),
        ).toBe(`Bearer ${CELL_TOKEN}`);
      },
    );
  });

  it("runtime instructions name needs-you stop semantics and keep checkpoint/result", () => {
    const runtime = readFileSync(
      new URL("../../src/services/threads/thread-runtime-config.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("`wt_checkpoint_report`");
    expect(runtime).toContain("`wt_result_report`");
    expect(runtime).toContain("`wt_needs_you_report` once and stop");
    expect(runtime).toContain("Do not keep looping checkpoint or result");
  });
});
