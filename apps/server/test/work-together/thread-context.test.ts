import { createHash } from "node:crypto";
import {
  getEnvironment,
  getThread,
  getWorkTogetherThreadContext,
  listEvents,
  listStoredThreadPromptHistoryRows,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { assertCoordinationAcpCwd } from "../../src/services/work-together-thread-context.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const CONTEXT_PATH = (threadId: string) =>
  `/api/work-together/v1/threads/${threadId}/context`;
const COORD_PATH = "/api/work-together/v1/coordination-threads/goal-ctx";

function envelope(payload: string) {
  const decoded = Buffer.from(
    JSON.stringify({
      contractVersion: "wt.agent-operating-envelope@1",
      marker: payload,
      execution: { cwd: "/tmp" },
    }),
    "utf8",
  );
  return {
    requestId: "req-apply-1",
    digest: createHash("sha256").update(decoded).digest("hex"),
    bytes: decoded.toString("base64"),
    decoded,
  };
}

async function putCoordination(
  harness: TestAppHarness,
  args: { projectId: string; environmentId: string; title?: string },
) {
  return harness.app.request(COORD_PATH, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId: args.projectId,
      environmentId: args.environmentId,
      title: args.title ?? "Goal context",
    }),
  });
}

describe("work-together thread context apply", () => {
  it("is absent without a token, rejects short tokens, and requires bearer plus a strict body", async () => {
    await withTestHarness(async (harness) => {
      const missingRoute = await harness.app.request(
        CONTEXT_PATH("thr_missing1"),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope("x")),
        },
      );
      expect(missingRoute.status).toBe(404);

      expect(() =>
        createApp(harness.deps, { workTogetherIntegrationToken: "too-short" }),
      ).toThrow();
    });

    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const body = envelope("hello");
        const missing = await harness.app.request(
          CONTEXT_PATH("thr_missing1"),
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        expect(missing.status).toBe(401);
        const missingJson = (await missing.json()) as {
          code?: string;
          message?: string;
        };
        expect(missingJson.code).toBe("unauthorized");
        expect(JSON.stringify(missingJson)).not.toContain(TOKEN);

        const bad = await harness.app.request(CONTEXT_PATH("thr_missing1"), {
          method: "PUT",
          headers: {
            authorization: "Bearer not-the-token-and-long-enough-to-compare",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(bad.status).toBe(401);
        const badJson = (await bad.json()) as { code?: string };
        expect(badJson.code).toBe("unauthorized");
        expect(JSON.stringify(badJson)).not.toContain(TOKEN);

        const extra = await harness.app.request(CONTEXT_PATH("thr_missing1"), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, extra: true }),
        });
        expect(extra.status).toBe(400);
      },
    );
  });

  it("returns 404 for PUT on an unknown thread", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const body = envelope("unknown-thread");
        const response = await harness.app.request(
          CONTEXT_PATH("thr_doesnotexist1"),
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: body.requestId,
              digest: body.digest,
              bytes: body.bytes,
            }),
          },
        );
        expect(response.status).toBe(404);
      },
    );
  });

  it("accepts apply, GET omits bytes, replay is already_accepted, conflicts do not mutate", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-context",
        });
        const envPath = "/tmp";
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: envPath,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: envPath,
        });
        const created = await putCoordination(harness, {
          projectId: project.id,
          environmentId: environment.id,
        });
        expect(created.status).toBe(201);
        const threadId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
        const storedEnv = getEnvironment(harness.db, environment.id);
        expect(storedEnv?.path).toBe(envPath);
        expect(getThread(harness.db, threadId)?.environmentId).toBe(
          environment.id,
        );
        expect(() => assertCoordinationAcpCwd(envPath, "/other-cwd")).toThrow();
        expect(() => assertCoordinationAcpCwd(envPath, envPath)).not.toThrow();
        expect(() =>
          assertCoordinationAcpCwd(envPath, undefined),
        ).not.toThrow();

        const payload = JSON.stringify({
          contractVersion: "wt.agent-operating-envelope@1-probe",
          workId: "probe-work",
        });
        const first = envelope(payload);
        const put = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: first.requestId,
            digest: first.digest,
            bytes: first.bytes,
          }),
        });
        expect(put.status).toBe(200);
        const putBody = (await put.json()) as {
          outcome?: string;
          requestId?: string;
          digest?: string;
          bytes?: unknown;
        };
        expect(putBody.outcome).toBe("accepted");
        expect(putBody.requestId).toBe(first.requestId);
        expect(putBody.digest).toBe(first.digest);
        expect(putBody.bytes).toBeUndefined();
        expect(JSON.stringify(putBody)).not.toContain(TOKEN);
        const stored = getWorkTogetherThreadContext(harness.db, threadId);
        expect(stored?.digest).toBe(first.digest);
        expect(stored?.requestId).toBe(first.requestId);
        expect(stored?.executionCwd).toBe(envPath);

        const got = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(got.status).toBe(200);
        const gotBody = (await got.json()) as Record<string, unknown>;
        expect(gotBody).toEqual({
          requestId: first.requestId,
          digest: first.digest,
        });
        expect(JSON.stringify(gotBody)).not.toContain(first.bytes);
        expect(JSON.stringify(gotBody)).not.toContain(payload);

        const replay = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: first.requestId,
            digest: first.digest,
            bytes: first.bytes,
          }),
        });
        expect(replay.status).toBe(200);
        expect(((await replay.json()) as { outcome?: string }).outcome).toBe(
          "already_accepted",
        );
        expect(getWorkTogetherThreadContext(harness.db, threadId)).toEqual(
          stored,
        );

        const otherDigest = envelope(`${payload}-other`);
        const sameIdConflict = await harness.app.request(
          CONTEXT_PATH(threadId),
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: first.requestId,
              digest: otherDigest.digest,
              bytes: otherDigest.bytes,
            }),
          },
        );
        expect(sameIdConflict.status).toBe(409);
        expect(((await sameIdConflict.json()) as { code?: string }).code).toBe(
          "context_conflict",
        );
        expect(getWorkTogetherThreadContext(harness.db, threadId)?.digest).toBe(
          first.digest,
        );

        const secondId = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: "req-apply-2",
            digest: otherDigest.digest,
            bytes: otherDigest.bytes,
          }),
        });
        expect(secondId.status).toBe(409);
        expect(((await secondId.json()) as { code?: string }).code).toBe(
          "context_conflict",
        );
        expect(getWorkTogetherThreadContext(harness.db, threadId)?.digest).toBe(
          first.digest,
        );

        expect(
          listEvents(harness.db, { threadId }).some((event) =>
            JSON.stringify(event).includes(payload),
          ),
        ).toBe(false);
        expect(
          listStoredThreadPromptHistoryRows(harness.db, {
            threadId,
            limit: 20,
          }).some((row) => JSON.stringify(row).includes(payload)),
        ).toBe(false);
      },
    );
  });

  it("rejects digest mismatch and oversized bytes without storing a row", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-context-bad",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-thread-context-bad",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-thread-context-bad",
        });
        const created = await putCoordination(harness, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const threadId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
        const good = envelope("ok-bytes");
        const mismatch = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: "req-mismatch",
            digest: "a".repeat(64),
            bytes: good.bytes,
          }),
        });
        expect(mismatch.status).toBe(400);
        expect(
          getWorkTogetherThreadContext(harness.db, threadId)?.digest,
        ).toBeNull();

        const oversized = Buffer.alloc(65537, 1);
        const oversize = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: "req-oversize",
            digest: createHash("sha256").update(oversized).digest("hex"),
            bytes: oversized.toString("base64"),
          }),
        });
        expect(oversize.status).toBe(400);
        expect(
          getWorkTogetherThreadContext(harness.db, threadId)?.digest,
        ).toBeNull();
      },
    );
  });

  it("blocks coordination send before apply and allows send after apply without prepending envelope", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-context-send",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp",
        });
        const created = await putCoordination(harness, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const threadId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
        const before = await harness.app.request(
          `/api/v1/threads/${threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "Before apply" }],
              mode: "start",
              model: "gpt-5",
            }),
          },
        );
        expect(before.status).toBe(409);
        expect(((await before.json()) as { code?: string }).code).toBe(
          "context_not_applied",
        );
        expect(
          listStoredThreadPromptHistoryRows(harness.db, {
            threadId,
            limit: 20,
          }),
        ).toHaveLength(0);
        expect(
          listQueuedThreadCommands(harness, "thread.start", threadId),
        ).toHaveLength(0);

        const applied = envelope("applied-envelope");
        const put = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requestId: applied.requestId,
            digest: applied.digest,
            bytes: applied.bytes,
          }),
        });
        expect(put.status).toBe(200);

        const after = await harness.app.request(
          `/api/v1/threads/${threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "After apply" }],
              mode: "start",
              model: "gpt-5",
            }),
          },
        );
        const afterJson = (await after.json()) as { code?: string };
        expect(afterJson.code).not.toBe("context_not_applied");
        expect(
          listEvents(harness.db, { threadId }).some((event) =>
            JSON.stringify(event).includes("applied-envelope"),
          ),
        ).toBe(false);
      },
    );
  });

  it("does not require apply for ordinary non-coordination send", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-context-plain",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-thread-context-plain",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-thread-context-plain",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          title: "Ordinary",
        });
        const sent = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "Ordinary send" }],
              mode: "start",
              model: "gpt-5",
            }),
          },
        );
        const body = (await sent.json()) as { code?: string };
        expect(body.code).not.toBe("context_not_applied");
      },
    );
  });

  it("GET is 404 context_not_applied before apply", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-context-get",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-thread-context-get",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-thread-context-get",
        });
        const created = await putCoordination(harness, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const threadId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
        const missing = await harness.app.request(CONTEXT_PATH(threadId), {
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(missing.status).toBe(404);
        expect(((await missing.json()) as { code?: string }).code).toBe(
          "context_not_applied",
        );
      },
    );
  });
});
