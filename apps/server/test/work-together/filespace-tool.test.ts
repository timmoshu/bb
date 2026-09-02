import { createHash } from "node:crypto";
import { getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  handleWtFilespacePublishToolCall,
  WT_FILESPACE_PUBLISH_TOOL,
  WT_FILESPACE_PUBLISH_TOOL_NAME,
  workTogetherFilespaceToolForThread,
} from "../../src/services/work-together-filespace-tool.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const CELL_TOKEN = "wt-cell-tool-secret-32chars-ok!!";
const COORD_PATH = "/api/work-together/v1/coordination-threads/goal-fs";

describe("work-together filespace ACP tool", () => {
  it("lists wt_filespace_publish on coordination threads without leaking token or identity fields", async () => {
    const descriptor = JSON.stringify(WT_FILESPACE_PUBLISH_TOOL);
    expect(descriptor).toContain(WT_FILESPACE_PUBLISH_TOOL_NAME);
    expect(descriptor).not.toContain(CELL_TOKEN);
    expect(descriptor).not.toContain("actorId");
    expect(descriptor).not.toContain("goalId");
    expect(descriptor).not.toContain("workspaceId");
    expect(descriptor).not.toContain("bbThreadId");

    await withTestHarness(
      {
        workTogetherIntegrationToken: TOKEN,
        wtCellTools: { baseUrl: "http://127.0.0.1:9", token: CELL_TOKEN },
      },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, { id: "host-fs" });
        const envPath = "/tmp/wt-s5-filespace";
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
            title: "Filespace Goal",
          }),
        });
        expect(created.status).toBe(201);
        const threadId = ((await created.json()) as { thread: { id: string } }).thread
          .id;
        expect(
          workTogetherFilespaceToolForThread(harness.deps.db, threadId)?.name,
        ).toBe(WT_FILESPACE_PUBLISH_TOOL_NAME);

        const ordinary = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        expect(
          workTogetherFilespaceToolForThread(harness.deps.db, ordinary.id),
        ).toBeUndefined();
      },
    );
  });

  it("posts filespace put without actorId and uses the cell token only on the HTTP call", async () => {
    const posts: Array<{ url: string; headers: unknown; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posts.push({ url, headers, body });
      return new Response(
        JSON.stringify({
          path: "notes/a.txt",
          generation: 1,
          digest: "a".repeat(64),
          size: 4,
        }),
        { status: 200 },
      );
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
        const { host } = seedHostSession(harness.deps, { id: "host-fs2" });
        const envPath = "/tmp/wt-s5-filespace-2";
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
            title: "Filespace Goal",
          }),
        });
        expect(created.status).toBe(201);
        const threadId = ((await created.json()) as { thread: { id: string } }).thread
          .id;
        expect(getThread(harness.deps.db, threadId)?.id).toBe(threadId);

        const digest = createHash("sha256").update("hi").digest("hex");
        const forged = await handleWtFilespacePublishToolCall({
          threadId,
          input: {
            path: "notes/a.txt",
            expectedGeneration: 0,
            digest,
            text: "hi",
            idempotencyKey: "k1",
            actorId: "forged",
          },
        });
        expect(forged.success).toBe(false);
        expect(posts).toHaveLength(0);

        const ok = await handleWtFilespacePublishToolCall({
          threadId,
          input: {
            path: "notes/a.txt",
            expectedGeneration: 0,
            digest,
            text: "hi",
            idempotencyKey: "k1",
          },
        });
        expect(ok.success).toBe(true);
        expect(posts).toHaveLength(1);
        expect(posts[0]?.url).toBe(
          "http://127.0.0.1:9/cell-tools/v1/filespace/put",
        );
        expect(posts[0]?.body).toEqual({
          bbThreadId: threadId,
          path: "notes/a.txt",
          expectedGeneration: 0,
          digest,
          text: "hi",
          idempotencyKey: "k1",
        });
        expect(JSON.stringify(posts[0]?.body)).not.toContain("actorId");
        const headerBag = new Headers(posts[0]?.headers as HeadersInit);
        expect(headerBag.get("authorization")).toBe(`Bearer ${CELL_TOKEN}`);
        expect(JSON.stringify(WT_FILESPACE_PUBLISH_TOOL)).not.toContain(
          CELL_TOKEN,
        );
      },
    );
  });
});
