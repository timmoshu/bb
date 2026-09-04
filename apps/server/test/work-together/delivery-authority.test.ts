import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listQueuedThreadCommands, waitForQueuedCommand } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const COORD_PATH = "/api/work-together/v1/coordination-threads/goal-delivery";

function envelope(payload: string) {
  const decoded = Buffer.from(payload, "utf8");
  return {
    requestId: "req-delivery-1",
    digest: createHash("sha256").update(decoded).digest("hex"),
    bytes: decoded.toString("base64"),
  };
}

describe("work-together deliveryAuthority tagging", () => {
  it("puts none on coordination thread.start and git on ordinary thread.start", async () => {
    await withTestHarness({ workTogetherIntegrationToken: TOKEN }, async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-wt-delivery" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/wt-delivery-authority",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/wt-delivery-authority",
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
          title: "Delivery authority",
        }),
      });
      expect([200, 201]).toContain(created.status);
      const threadId = ((await created.json()) as { thread: { id: string } }).thread
        .id;
      const applied = envelope("applied-envelope");
      const put = await harness.app.request(
        `/api/work-together/v1/threads/${threadId}/context`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(applied),
        },
      );
      expect(put.status).toBe(200);

      const sent = await harness.app.request(`/api/v1/threads/${threadId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "text", text: "Start coordination" }],
          mode: "start",
          model: "gpt-5",
        }),
      });
      expect(sent.status).toBeLessThan(500);
      const queued = await waitForQueuedCommand(
        harness,
        (row) =>
          row.command.type === "thread.start" &&
          "threadId" in row.command &&
          row.command.threadId === threadId,
      );
      expect(queued.command.type).toBe("thread.start");
      if (queued.command.type !== "thread.start") {
        throw new Error("expected thread.start");
      }
      expect(queued.command.options.deliveryAuthority).toBe("none");
      expect(queued.command.options.permissionEscalation).not.toBe(undefined);

      const ordinary = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Ordinary",
      });
      const ordinarySend = await harness.app.request(
        `/api/v1/threads/${ordinary.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Start ordinary" }],
            mode: "start",
            model: "gpt-5",
          }),
        },
      );
      expect(ordinarySend.status).toBeLessThan(500);
      const ordinaryQueued = await waitForQueuedCommand(
        harness,
        (row) =>
          row.command.type === "thread.start" &&
          "threadId" in row.command &&
          row.command.threadId === ordinary.id,
      );
      expect(ordinaryQueued.command.type).toBe("thread.start");
      if (ordinaryQueued.command.type !== "thread.start") {
        throw new Error("expected thread.start");
      }
      expect(ordinaryQueued.command.options.deliveryAuthority).toBe("git");
      expect(
        listQueuedThreadCommands(harness, "thread.start", threadId)[0]?.type,
      ).toBe("thread.start");
    });
  });
});
