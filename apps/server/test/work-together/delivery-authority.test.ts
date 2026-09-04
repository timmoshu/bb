import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const COORD_PATH = "/api/work-together/v1/coordination-threads/goal-delivery";

function envelope(payload: string, cwd = "/tmp") {
  const decoded = Buffer.from(
    JSON.stringify({ marker: payload, execution: { cwd } }),
    "utf8",
  );
  return {
    requestId: "req-delivery-1",
    digest: createHash("sha256").update(decoded).digest("hex"),
    bytes: decoded.toString("base64"),
  };
}

describe("work-together deliveryAuthority tagging", () => {
  it("puts none on coordination thread.start and git on ordinary thread.start", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-delivery",
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
        const threadId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
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

        const sent = await harness.app.request(
          `/api/v1/threads/${threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "Start coordination" }],
              mode: "start",
              model: "gpt-5",
            }),
          },
        );
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
        expect(queued.command.options.executionCwd).toBe("/tmp");
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
        expect(ordinaryQueued.command.options.executionCwd).toBeUndefined();
        expect(
          listQueuedThreadCommands(harness, "thread.start", threadId)[0]?.type,
        ).toBe("thread.start");
      },
    );
  });

  it("carries a signed managed child cwd into thread.start", async () => {
    const managedRoot = await mkdtemp(
      path.join(tmpdir(), "bb-wt-managed-root-"),
    );
    const admitted = path.join(managedRoot, "workspace", "work");
    const environmentPath = await mkdtemp(
      path.join(tmpdir(), "bb-wt-environment-"),
    );
    await mkdir(admitted, { recursive: true });
    try {
      await withTestHarness(
        {
          workTogetherIntegrationToken: TOKEN,
          workTogetherWorkCwdRoot: managedRoot,
        },
        async (harness) => {
          const { host } = seedHostSession(harness.deps, {
            id: "host-wt-managed-cwd",
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
            path: environmentPath,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
            path: environmentPath,
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
              title: "Managed cwd",
            }),
          });
          const threadId = (
            (await created.json()) as { thread: { id: string } }
          ).thread.id;
          const context = envelope("managed", admitted);
          const applied = await harness.app.request(
            `/api/work-together/v1/threads/${threadId}/context`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(context),
            },
          );
          expect(applied.status).toBe(200);
          const replay = await harness.app.request(
            `/api/work-together/v1/threads/${threadId}/context`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(context),
            },
          );
          expect(replay.status).toBe(200);
          expect(((await replay.json()) as { outcome: string }).outcome).toBe(
            "already_accepted",
          );
          const different = path.join(managedRoot, "workspace", "other");
          await mkdir(different, { recursive: true });
          const conflict = await harness.app.request(
            `/api/work-together/v1/threads/${threadId}/context`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(envelope("managed", different)),
            },
          );
          expect(conflict.status).toBe(409);
          const sent = await harness.app.request(
            `/api/v1/threads/${threadId}/send`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                input: [{ type: "text", text: "Start" }],
                mode: "start",
                model: "gpt-5",
              }),
            },
          );
          expect(sent.status).toBeLessThan(500);
          const queued = await waitForQueuedCommand(
            harness,
            (row) =>
              row.command.type === "thread.start" &&
              "threadId" in row.command &&
              row.command.threadId === threadId,
          );
          expect(queued.command.type).toBe("thread.start");
          if (queued.command.type !== "thread.start")
            throw new Error("expected thread.start");
          expect(queued.command.workspaceContext.workspacePath).toBe(
            environmentPath,
          );
          expect(queued.command.options.executionCwd).toBe(admitted);

          const retarget = path.join(managedRoot, "workspace", "retarget");
          await mkdir(retarget, { recursive: true });
          const retargetCreated = await harness.app.request(
            "/api/work-together/v1/coordination-threads/goal-delivery-retarget",
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                projectId: project.id,
                environmentId: environment.id,
                title: "Retarget",
              }),
            },
          );
          const retargetThreadId = (
            (await retargetCreated.json()) as { thread: { id: string } }
          ).thread.id;
          const retargetContext = envelope("retarget", retarget);
          const retargetApplied = await harness.app.request(
            `/api/work-together/v1/threads/${retargetThreadId}/context`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(retargetContext),
            },
          );
          expect(retargetApplied.status).toBe(200);
          const moved = `${retarget}-moved`;
          await rename(retarget, moved);
          const outside = await mkdtemp(
            path.join(tmpdir(), "bb-wt-retarget-outside-"),
          );
          await symlink(outside, retarget);
          try {
            const rejected = await harness.app.request(
              `/api/v1/threads/${retargetThreadId}/send`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  input: [{ type: "text", text: "Start" }],
                  mode: "start",
                  model: "gpt-5",
                }),
              },
            );
            expect(rejected.status).toBe(409);
            const failure = JSON.stringify(await rejected.json());
            expect(failure).toContain("Coordination cwd unavailable");
            expect(failure).not.toContain(retarget);
            expect(
              listQueuedThreadCommands(
                harness,
                "thread.start",
                retargetThreadId,
              ),
            ).toHaveLength(0);
          } finally {
            await rm(outside, { recursive: true, force: true });
          }
        },
      );
    } finally {
      await rm(managedRoot, { recursive: true, force: true });
      await rm(environmentPath, { recursive: true, force: true });
    }
  });
});
