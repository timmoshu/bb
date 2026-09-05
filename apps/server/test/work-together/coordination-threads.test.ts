import { loadServerConfig } from "@bb/config/server";
import {
  createThread,
  getThread,
  listEvents,
  listStoredThreadPromptHistoryRows,
  listThreads,
  markThreadDeleted,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import {
  coordinationThreadIdForBindingKey,
  workTogetherCoordinationExecution,
} from "../../src/routes/work-together-coordination.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const TOKEN = "wt-integration-token-32chars-ok!";
const PATH = "/api/work-together/v1/coordination-threads/goal-a";

describe("work-together coordination thread route", () => {
  it("is absent without a token, rejects short tokens, and requires bearer plus a strict body", async () => {
    await withTestHarness(async (harness) => {
      const missingRoute = await harness.app.request(PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "proj_x",
          environmentId: "env_x",
          title: "Goal A",
        }),
      });
      expect(missingRoute.status).toBe(404);

      expect(() =>
        createApp(harness.deps, { workTogetherIntegrationToken: "too-short" }),
      ).toThrow();
    });

    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const body = {
          projectId: "proj_x",
          environmentId: "env_x",
          title: "Goal A",
        };
        const missing = await harness.app.request(PATH, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(missing.status).toBe(401);
        const missingJson = (await missing.json()) as {
          code?: string;
          message?: string;
        };
        expect(missingJson.code).toBe("unauthorized");
        expect(JSON.stringify(missingJson)).not.toContain(TOKEN);

        const bad = await harness.app.request(PATH, {
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

        const extra = await harness.app.request(PATH, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...body,
            threadId: "thr_forgedid1",
            status: "idle",
          }),
        });
        expect(extra.status).toBe(400);
      },
    );
  });

  it("registers PUT when createApp receives the token from server config", async () => {
    const serverConfig = loadServerConfig({
      env: {
        BB_DATA_DIR: "/tmp/bb-wt-coord-env",
        BB_SERVER_PORT: "4444",
        BB_HOST_DAEMON_PORT: "5555",
        BB_WORK_TOGETHER_INTEGRATION_TOKEN: TOKEN,
      },
    });
    expect(serverConfig.BB_WORK_TOGETHER_INTEGRATION_TOKEN).toBe(TOKEN);
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const missing = await harness.app.request(PATH, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: "proj_x",
            environmentId: "env_x",
            title: "Goal A",
          }),
        });
        expect(missing.status).toBe(401);
      },
    );
  });

  it("rolls back coordination thread creation when its marker cannot be stored", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-marker-rollback",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-marker-rollback",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-marker-rollback",
        });
        harness.db.$client.exec(`
          CREATE TRIGGER reject_wt_marker
          BEFORE INSERT ON work_together_thread_contexts
          BEGIN
            SELECT RAISE(ABORT, 'reject marker');
          END;
        `);
        const notifyProject = vi.spyOn(harness.hub, "notifyProject");
        const notifyThread = vi.spyOn(harness.hub, "notifyThread");

        const response = await harness.app.request(
          "/api/work-together/v1/coordination-threads/goal-marker-rollback",
          {
            method: "PUT",
            headers: {
              authorization: "Bearer " + TOKEN,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: project.id,
              environmentId: environment.id,
              title: "Marker rollback",
            }),
          },
        );

        expect(response.status).toBe(500);
        expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(
          0,
        );
        expect(notifyProject).not.toHaveBeenCalled();
        expect(notifyThread).not.toHaveBeenCalled();
      },
    );
  });

  it("creates one idle root thread and returns the same row on retry without starting a provider", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-coordination",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-coordination",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-coordination",
        });
        const put = (title: string) =>
          harness.app.request(PATH, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: project.id,
              environmentId: environment.id,
              title,
            }),
          });

        const created = await put("Goal A");
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as {
          created: boolean;
          thread: {
            id: string;
            status: string;
            projectId: string;
            environmentId: string | null;
            providerId: string;
          };
        };
        expect(createdBody.created).toBe(true);
        expect(createdBody.thread.projectId).toBe(project.id);
        expect(createdBody.thread.environmentId).toBe(environment.id);
        expect(createdBody.thread.providerId).toBe("acp-grok");
        const threadId = createdBody.thread.id;
        expect(threadId.startsWith("thr_")).toBe(true);

        const idle = await waitForThreadStatus(harness.db, threadId, "idle");
        expect(idle.parentThreadId).toBeNull();
        expect(idle.sourceThreadId).toBeNull();
        expect(idle.originKind).toBeNull();
        expect(
          listEvents(harness.db, { threadId }).some(
            (event) => event.type === "client/turn/requested",
          ),
        ).toBe(false);
        expect(
          listStoredThreadPromptHistoryRows(harness.db, {
            threadId,
            limit: 20,
          }),
        ).toHaveLength(0);
        expect(
          listQueuedThreadCommands(harness, "thread.start", threadId),
        ).toHaveLength(0);

        const retry = await put("Goal A retitled");
        expect(retry.status).toBe(200);
        const retryBody = (await retry.json()) as {
          created: boolean;
          thread: { id: string; title: string | null };
        };
        expect(retryBody.created).toBe(false);
        expect(retryBody.thread.id).toBe(threadId);
        expect(getThread(harness.db, threadId)?.providerId).toBe("acp-grok");
        expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(
          1,
        );
        expect(getThread(harness.db, threadId)?.updatedAt).toBe(idle.updatedAt);

        const sent = await harness.app.request(
          `/api/v1/threads/${threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "First later message" }],
              mode: "start",
              model: "gpt-5",
            }),
          },
        );
        expect(sent.status).toBe(409);
        expect(((await sent.json()) as { code?: string }).code).toBe(
          "context_not_applied",
        );
        expect(
          listQueuedThreadCommands(harness, "thread.start", threadId),
        ).toHaveLength(0);

        const concurrentPath =
          "/api/work-together/v1/coordination-threads/goal-concurrent";
        const concurrentBody = JSON.stringify({
          projectId: project.id,
          environmentId: environment.id,
          title: "Goal concurrent",
        });
        const concurrentHeaders = {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        };
        const [firstConcurrent, secondConcurrent] = await Promise.all([
          harness.app.request(concurrentPath, {
            method: "PUT",
            headers: concurrentHeaders,
            body: concurrentBody,
          }),
          harness.app.request(concurrentPath, {
            method: "PUT",
            headers: concurrentHeaders,
            body: concurrentBody,
          }),
        ]);
        const concurrentStatuses = [
          firstConcurrent.status,
          secondConcurrent.status,
        ].sort();
        expect(concurrentStatuses).toEqual([200, 201]);
        const concurrentBodies = [
          (await firstConcurrent.json()) as {
            created: boolean;
            thread: { id: string };
          },
          (await secondConcurrent.json()) as {
            created: boolean;
            thread: { id: string };
          },
        ];
        expect(
          new Set(concurrentBodies.map((body) => body.thread.id)).size,
        ).toBe(1);
        const concurrentId = concurrentBodies[0]!.thread.id;
        expect(concurrentId).not.toBe(threadId);
        expect(concurrentBodies.filter((body) => body.created)).toHaveLength(1);
        expect(
          listThreads(harness.db, { projectId: project.id }).filter(
            (thread) => thread.id === concurrentId,
          ),
        ).toHaveLength(1);
        expect(
          listEvents(harness.db, { threadId: concurrentId }).some(
            (event) => event.type === "client/turn/requested",
          ),
        ).toBe(false);
        expect(
          listQueuedThreadCommands(harness, "thread.start", concurrentId),
        ).toHaveLength(0);
      },
    );
  });

  it("uses configured provider/model for new threads and never retargets replay", async () => {
    await withTestHarness(
      {
        workTogetherIntegrationToken: TOKEN,
        workTogetherCoordinationProviderId: "codex",
        workTogetherCoordinationModel: "gpt-5.6-sol",
      },
      async (harness) => {
        expect(workTogetherCoordinationExecution(harness.config)).toEqual({
          providerId: "codex",
          model: "gpt-5.6-sol",
        });
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-wt-provider",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-provider",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-provider",
        });
        upsertProjectExecutionDefaults(harness.deps.db, {
          projectId: project.id,
          providerId: "acp-grok",
          model: "grok-4.6",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelsByProviderId: {
            codex: {
              models: [
                availableModelFixture({
                  model: "gpt-5.6-sol",
                  isDefault: true,
                }),
              ],
              selectedOnlyModels: [],
            },
          },
        });
        const request = () =>
          harness.app.request(
            "/api/work-together/v1/coordination-threads/provider-config",
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                projectId: project.id,
                environmentId: environment.id,
                title: "Provider config",
              }),
            },
          );
        const created = await request();
        expect(created.status).toBe(201);
        const id = ((await created.json()) as { thread: { id: string } }).thread
          .id;
        expect(getThread(harness.db, id)?.providerId).toBe("codex");
        expect(getThread(harness.db, id)?.modelOverride).toBeNull();
        expect(
          (
            await buildExecutionOptions(
              harness.deps,
              {},
              {
                hostId: host.id,
                threadId: id,
              },
            )
          ).model,
        ).toBe("gpt-5.6-sol");
        harness.config.workTogetherCoordinationProviderId = "acp-grok";
        harness.config.workTogetherCoordinationModel = "grok-4.6";
        expect((await request()).status).toBe(200);
        expect(getThread(harness.db, id)?.providerId).toBe("codex");
        expect(getThread(harness.db, id)?.modelOverride).toBeNull();
      },
    );
  });

  it("fails safely when the configured provider is unavailable", async () => {
    await withTestHarness(
      {
        workTogetherIntegrationToken: TOKEN,
        workTogetherCoordinationProviderId: "missing-provider",
        workTogetherCoordinationModel: "model-x",
      },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-missing-provider",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-missing-provider",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-missing-provider",
        });
        const response = await harness.app.request(
          "/api/work-together/v1/coordination-threads/missing-provider",
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectId: project.id,
              environmentId: environment.id,
              title: "Unavailable provider",
            }),
          },
        );
        expect(response.status).toBe(409);
        expect((await response.json()) as unknown).toEqual({
          code: "coordination_provider_unavailable",
          message: "Coordination provider unavailable",
        });
      },
    );
  });

  it("same binding key conflicts return 409 and leave the existing row unchanged", async () => {
    await withTestHarness(
      { workTogetherIntegrationToken: TOKEN },
      async (harness) => {
        const { host } = seedHostSession(harness.deps, {
          id: "host-wt-coordination-conflict",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/wt-coordination-conflict",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-coordination-conflict",
        });
        const { project: otherProject } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          name: "Other Project",
          path: "/tmp/wt-coordination-other",
        });
        const otherEnvironment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: otherProject.id,
          path: "/tmp/wt-coordination-other",
        });
        const siblingEnvironment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/wt-coordination-sibling",
        });
        const put = (
          bindingKey: string,
          projectId: string,
          environmentId: string,
        ) =>
          harness.app.request(
            `/api/work-together/v1/coordination-threads/${bindingKey}`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                projectId,
                environmentId,
                title: "Conflict probe",
              }),
            },
          );

        const created = await put("bind-project", project.id, environment.id);
        expect(created.status).toBe(201);
        const createdId = ((await created.json()) as { thread: { id: string } })
          .thread.id;
        const beforeProject = getThread(harness.db, createdId);
        const otherProjectConflict = await put(
          "bind-project",
          otherProject.id,
          otherEnvironment.id,
        );
        expect(otherProjectConflict.status).toBe(409);
        expect(
          ((await otherProjectConflict.json()) as { code?: string }).code,
        ).toBe("coordination_binding_conflict");
        expect(getThread(harness.db, createdId)).toEqual(beforeProject);

        const envCreated = await put("bind-env", project.id, environment.id);
        expect(envCreated.status).toBe(201);
        const envId = ((await envCreated.json()) as { thread: { id: string } })
          .thread.id;
        const beforeEnv = getThread(harness.db, envId);
        const envConflict = await put(
          "bind-env",
          project.id,
          siblingEnvironment.id,
        );
        expect(envConflict.status).toBe(409);
        expect(getThread(harness.db, envId)).toEqual(beforeEnv);

        const deletedCreated = await put(
          "bind-deleted",
          project.id,
          environment.id,
        );
        expect(deletedCreated.status).toBe(201);
        const deletedId = (
          (await deletedCreated.json()) as { thread: { id: string } }
        ).thread.id;
        markThreadDeleted(harness.db, harness.hub, { threadId: deletedId });
        const beforeDeleted = getThread(harness.db, deletedId);
        const deletedConflict = await put(
          "bind-deleted",
          project.id,
          environment.id,
        );
        expect(deletedConflict.status).toBe(409);
        expect(getThread(harness.db, deletedId)).toEqual(beforeDeleted);
        expect(
          listThreads(harness.db, { projectId: project.id }).filter(
            (thread) => thread.id === deletedId,
          ),
        ).toHaveLength(0);

        const sourceParent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          title: "Source parent",
        });
        const sourceId = coordinationThreadIdForBindingKey("bind-source");
        createThread(harness.db, harness.hub, {
          id: sourceId,
          projectId: project.id,
          environmentId: environment.id,
          providerId: "codex",
          originKind: "fork",
          sourceThreadId: sourceParent.id,
          status: "idle",
        });
        const beforeSource = getThread(harness.db, sourceId);
        const sourceConflict = await put(
          "bind-source",
          project.id,
          environment.id,
        );
        expect(sourceConflict.status).toBe(409);
        expect(getThread(harness.db, sourceId)).toEqual(beforeSource);

        const parent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          title: "Hierarchy parent",
        });
        const childId = coordinationThreadIdForBindingKey("bind-child");
        createThread(harness.db, harness.hub, {
          id: childId,
          projectId: project.id,
          environmentId: environment.id,
          providerId: "codex",
          parentThreadId: parent.id,
          status: "idle",
        });
        const beforeChild = getThread(harness.db, childId);
        const childConflict = await put(
          "bind-child",
          project.id,
          environment.id,
        );
        expect(childConflict.status).toBe(409);
        expect(getThread(harness.db, childId)).toEqual(beforeChild);
      },
    );
  });
});

async function waitForThreadStatus(
  db: Parameters<typeof getThread>[0],
  threadId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const thread = getThread(db, threadId);
    if (thread?.status === status) {
      return thread;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`thread ${threadId} did not reach ${status}`);
}
