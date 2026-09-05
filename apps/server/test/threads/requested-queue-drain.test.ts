import {
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  markWorkTogetherCoordinationThread,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageGroupBoundary,
} from "@bb/db";
import type { QueuedMessageWaitingOn } from "@bb/domain";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  requestQueuedMessageDispatch,
  runQueuedMessageDispatch,
  type QueuedMessageDispatchWake,
} from "../../src/services/threads/queued-message-dispatch.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function runTimeWake(harness: TestAppHarness, now: number): Promise<void> {
  return runQueuedMessageDispatch(harness.deps, { kind: "time-reached", now });
}

function runPluginWake(harness: TestAppHarness): Promise<void> {
  return runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
}

function requestPluginWake(harness: TestAppHarness): void {
  requestQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });
}

type GuardedWakeKind =
  | "host-connected"
  | "idle-recovery"
  | "interaction-settled"
  | "orphaned-plugin-recovery"
  | "plugin-recheck"
  | "plugin-unregistered"
  | "provisioning-ended"
  | "time-reached"
  | "turn-started"
  | "workspace-ready";

function guardedWake(
  kind: GuardedWakeKind,
  threadId: string,
  hostId: string,
): QueuedMessageDispatchWake {
  switch (kind) {
    case "host-connected":
      return { kind, hostId };
    case "interaction-settled":
    case "provisioning-ended":
    case "turn-started":
    case "workspace-ready":
      return { kind, threadId };
    case "plugin-unregistered":
      return { kind, pluginId: "guarded-wake" };
    case "orphaned-plugin-recovery":
      return { kind, plugins: { isPluginLoaded: () => false } };
    case "plugin-recheck":
      return { kind };
    case "idle-recovery":
    case "time-reached":
      return { kind, now: Date.now() };
  }
}

const WORKSPACE_PATH = "/tmp/requested-drain-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installHooks(registry: HookRegistry): void {
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function seedRunnableThread(
  harness: TestAppHarness,
  args: { hostId: string; status: "idle" | "active" },
) {
  const { host } = seedHostSession(harness.deps, { id: args.hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: args.status,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${args.hostId}`,
    threadId: thread.id,
  });
  if (args.status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      threadId: thread.id,
      turnId: `turn-${args.hostId}`,
      providerThreadId: `provider-${args.hostId}`,
    });
  }
  return { environment, project, thread };
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

async function stopThread(harness: TestAppHarness, threadId: string) {
  const response = harness.app.request(`/api/v1/threads/${threadId}/stop`, {
    method: "POST",
  });
  const stop = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );
  await reportQueuedCommandSuccess(harness, stop, {
    providerCheckpointId: null,
  });
  expect((await response).status).toBe(200);
}

describe("the requested queue drain", () => {
  it("does not mutate unapplied coordination rows for any queue wake", async () => {
    const cases: Array<{
      kind: GuardedWakeKind;
      waitingOn: QueuedMessageWaitingOn;
      sendAt?: number;
    }> = [
      {
        kind: "host-connected",
        waitingOn: { kind: "host-offline", hostName: "offline" },
      },
      { kind: "idle-recovery", waitingOn: { kind: "thread-busy" } },
      { kind: "interaction-settled", waitingOn: { kind: "interaction" } },
      {
        kind: "orphaned-plugin-recovery",
        waitingOn: {
          kind: "plugin",
          pluginId: "guarded-wake",
          reason: "waiting",
        },
      },
      {
        kind: "plugin-recheck",
        waitingOn: {
          kind: "plugin",
          pluginId: "guarded-wake",
          reason: "waiting",
        },
      },
      {
        kind: "plugin-unregistered",
        waitingOn: {
          kind: "plugin",
          pluginId: "guarded-wake",
          reason: "waiting",
        },
      },
      { kind: "provisioning-ended", waitingOn: { kind: "provisioning" } },
      {
        kind: "time-reached",
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1,
      },
      { kind: "turn-started", waitingOn: { kind: "turn-starting" } },
      { kind: "workspace-ready", waitingOn: { kind: "provisioning" } },
    ];

    for (const fixture of cases) {
      await withTestHarness(async (harness) => {
        const hostId = `host-wake-${fixture.kind}`;
        const { thread } = seedRunnableThread(harness, {
          hostId,
          status: "idle",
        });
        markWorkTogetherCoordinationThread(harness.db, thread.id);
        const queued = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput(`wait ${fixture.kind}`),
          waitingOn: fixture.waitingOn,
          ...(fixture.sendAt === undefined ? {} : { sendAt: fixture.sendAt }),
        });
        if (fixture.kind === "idle-recovery") {
          harness.db.$client
            .prepare(
              "UPDATE queued_thread_messages SET claimed_at = 1, claim_token = 'stale-claim', updated_at = 1 WHERE id = ?",
            )
            .run(queued.id);
        }
        const before = getQueuedThreadMessage(harness.db, queued.id);
        const turnRequestCount = turnRequests(harness, thread.id).length;

        await runQueuedMessageDispatch(
          harness.deps,
          guardedWake(fixture.kind, thread.id, hostId),
        ).catch((error: unknown) => {
          if (
            !(
              error instanceof Error &&
              "body" in error &&
              (error.body as { code?: string }).code === "context_not_applied"
            )
          ) {
            throw error;
          }
        });

        expect(getQueuedThreadMessage(harness.db, queued.id)).toEqual(before);
        expect(turnRequests(harness, thread.id)).toHaveLength(turnRequestCount);
      });
    }
  });

  it("rejects an unapplied coordination row before claiming it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-unapplied-coordination-drain",
        status: "idle",
      });
      markWorkTogetherCoordinationThread(harness.db, thread.id);
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("must wait for context"),
        waitingOn: { kind: "thread-busy" },
      });
      const turnRequestCount = turnRequests(harness, thread.id).length;

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, { threadId: thread.id }),
      ).rejects.toMatchObject({ body: { code: "context_not_applied" } });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([
        expect.objectContaining({ id: queued.id, failureReason: null }),
      ]);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnRequestCount);
    });
  });

  it("rolls back claimed system notice delivery when queue consumption fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-system-notice-consume-failure",
        status: "idle",
      });
      const queued = createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: thread.id,
        content: textInput("child completed"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        senderThreadId: null,
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "child-completed", subject: null },
      });
      expect(
        getQueuedThreadMessage(harness.db, queued.id)?.systemNotice,
      ).not.toBeNull();
      const turnRequestCount = turnRequests(harness, thread.id).length;
      harness.db.$client.exec(`
        CREATE TRIGGER reject_system_notice_consume
        BEFORE DELETE ON queued_thread_messages
        BEGIN
          SELECT RAISE(ABORT, 'reject consume');
        END;
      `);

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, { threadId: thread.id }),
      ).rejects.toThrow("reject consume");
      expect(turnRequests(harness, thread.id)).toHaveLength(turnRequestCount);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([queued.id]);
    });
  });

  it("rolls back reprovision admission when system notice consumption fails", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-system-notice-reprovision-failure",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/system-notice-reprovision-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/system-notice-reprovision-worktree",
        managed: true,
        status: "error",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      const queued = createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: thread.id,
        content: textInput("child completed during reprovision"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        senderThreadId: null,
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "child-completed", subject: null },
      });
      const eventCount = listEvents(harness.db, { threadId: thread.id }).length;
      harness.db.$client.exec(`
        CREATE TRIGGER reject_reprovision_notice_consume
        BEFORE DELETE ON queued_thread_messages
        BEGIN
          SELECT RAISE(ABORT, 'reject reprovision consume');
        END;
      `);

      await expect(
        sendNextQueuedMessageIfPresent(harness.deps, { threadId: thread.id }),
      ).rejects.toThrow("reject reprovision consume");
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCount,
      );
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([queued.id]);
    });
  });

  it("does not dispatch a scheduled group tail while its lead is postponed", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      let attempts = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "limiter",
            handler: () =>
              ++attempts === 1
                ? ({ action: "wait", reason: "At capacity" } as const)
                : { action: "proceed" },
          },
        ],
      });
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-scheduled-group",
        status: "idle",
      });
      const lead = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("lead"),
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 2_000,
      });
      const tail = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("tail"),
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1_000,
      });
      setQueuedThreadMessageGroupBoundary({
        db: harness.db,
        notifier: harness.deps.hub,
        threadId: thread.id,
        expectedGroupedPrefixQueuedMessageIds: [lead.id, tail.id],
        groupBoundaryQueuedMessageId: tail.id,
      });

      await runTimeWake(harness, Date.now());
      vi.advanceTimersByTime(1_001);
      await runTimeWake(harness, Date.now());

      expect(attempts).toBe(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(2);
    });
  });

  it("drains a group after its mixed plugin and timer waits clear", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      let released = false;
      let attempts = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "limiter",
            handler: () => {
              attempts += 1;
              return released
                ? ({ action: "proceed" } as const)
                : ({ action: "wait", reason: "At capacity" } as const);
            },
          },
        ],
      });
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-mixed-group",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("plugin-held lead"), mode: "auto" },
        thread,
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("scheduled tail"),
          mode: "auto",
          sendAt: Date.now() + 1_000,
        },
        thread,
      });
      const queued = listQueuedThreadMessages(harness.db, thread.id);
      setQueuedThreadMessageGroupBoundary({
        db: harness.db,
        notifier: harness.deps.hub,
        threadId: thread.id,
        expectedGroupedPrefixQueuedMessageIds: queued.map((row) => row.id),
        groupBoundaryQueuedMessageId: queued[1]!.id,
      });
      const turnsBefore = turnRequests(harness, thread.id).length;

      released = true;
      await runPluginWake(harness);

      expect(attempts).toBe(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(2);

      vi.advanceTimersByTime(1_000);
      await runTimeWake(harness, Date.now());

      expect(attempts).toBe(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore + 1);
    });
  });

  it.each(["plugin-first", "thread-first"] as const)(
    "drains a plugin and thread-busy group when %s clears",
    async (first) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers();
        let released = first === "plugin-first";
        let attempts = 0;
        installHooks({
          "message.dispatch": [
            {
              pluginId: "limiter",
              handler: () => {
                attempts += 1;
                return released
                  ? ({ action: "proceed" } as const)
                  : ({ action: "wait", reason: "At capacity" } as const);
              },
            },
          ],
        });
        const { thread } = seedRunnableThread(harness, {
          hostId: `host-plugin-thread-${first}`,
          status: "active",
        });
        const pluginHeld = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("plugin-held lead"),
          waitingOn: {
            kind: "plugin",
            pluginId: "limiter",
            reason: "At capacity",
          },
        });
        const threadBusy = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("thread-busy tail"),
          waitingOn: { kind: "thread-busy" },
        });
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.deps.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: [pluginHeld.id, threadBusy.id],
          groupBoundaryQueuedMessageId: threadBusy.id,
        });
        const turnsBefore = turnRequests(harness, thread.id).length;

        if (first === "plugin-first") {
          await runPluginWake(harness);
          expect(attempts).toBe(0);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
            2,
          );
        }

        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.succeeded" },
          threadId: thread.id,
        });
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });

        if (first === "thread-first") {
          expect(attempts).toBe(1);
          expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
            2,
          );
          await runQueuedMessageDispatch(harness.deps, {
            kind: "thread-ready",
            threadId: thread.id,
          });
          expect(attempts).toBe(1);
          released = true;
          vi.advanceTimersByTime(1_001);
          await runPluginWake(harness);
        }

        expect(attempts).toBe(first === "plugin-first" ? 1 : 2);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
        expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore + 1);
      });
    },
  );

  it("re-attempts a plugin-queued row once the hook lets it through", async () => {
    // The release path that replaced a plugin releasing its own wait: core
    // re-attempts, the hook re-decides, and a row that is still blocked simply
    // re-queues. No plugin has to work out which row deserves the freed slot.
    await withTestHarness(async (harness) => {
      let full = true;
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () =>
          full
            ? ({
                action: "wait",
                reason: "1 of 1 running on all hosts",
              } as const)
            : ({ action: "proceed" } as const),
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-freed-drain",
        status: "idle",
      });

      // Queued inline, so the re-queue pacing window never opens.
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("held work"), mode: "auto" },
        thread,
      });
      const turnsBefore = turnRequests(harness, thread.id).length;
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

      full = false;
      await runPluginWake(harness);

      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore + 1);
    });
  });

  it.each(["scheduled", "plugin"] as const)(
    "dispatches independently %s work after a manual stop",
    async (kind) => {
      await withTestHarness(async (harness) => {
        installHooks({
          "message.dispatch": [
            {
              pluginId: "limiter",
              handler: () => ({ action: "proceed" }) as const,
            },
          ],
        });
        const { thread } = seedRunnableThread(harness, {
          hostId: `host-stopped-${kind}`,
          status: "active",
        });
        seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput(`${kind} work`),
          waitingOn:
            kind === "scheduled"
              ? { kind: "time" }
              : { kind: "plugin", pluginId: "limiter", reason: "held" },
          sendAt: kind === "scheduled" ? Date.now() - 1_000 : null,
        });
        const turnsBefore = turnRequests(harness, thread.id).length;
        await stopThread(harness, thread.id);

        if (kind === "scheduled") {
          await runTimeWake(harness, Date.now());
        } else {
          await runPluginWake(harness);
        }

        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
        expect(turnRequests(harness, thread.id)).toHaveLength(turnsBefore + 1);
      });
    },
  );

  it.each(["scheduled", "plugin"] as const)(
    "does not dispatch a %s group containing a failed row",
    async (drain) => {
      await withTestHarness(async (harness) => {
        let attempts = 0;
        installHooks({
          "message.dispatch": [
            {
              pluginId: "limiter",
              handler: () => {
                attempts += 1;
                return { action: "wait", reason: "At capacity" } as const;
              },
            },
          ],
        });
        const { thread } = seedRunnableThread(harness, {
          hostId: `host-failed-${drain}-group`,
          status: "idle",
        });
        const waitingOn =
          drain === "scheduled"
            ? ({ kind: "time" } as const)
            : ({
                kind: "plugin",
                pluginId: "limiter",
                reason: "At capacity",
              } as const);
        const sendAt = drain === "scheduled" ? Date.now() - 1_000 : null;
        const lead = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("lead"),
          waitingOn,
          sendAt,
        });
        const failed = seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("failed"),
          waitingOn,
          sendAt,
        });
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.deps.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: [lead.id, failed.id],
          groupBoundaryQueuedMessageId: failed.id,
        });
        setQueuedThreadMessageFailureReason(harness.db, harness.deps.hub, {
          id: failed.id,
          threadId: thread.id,
          failureReason: "Terminal failure",
        });

        if (drain === "scheduled") await runTimeWake(harness, Date.now());
        else await runPluginWake(harness);

        expect(attempts).toBe(0);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(2);
      });
    },
  );

  it("leaves rows on core waits alone", async () => {
    // A `thread-busy` row is waiting on its own thread's turn ending, not on
    // somebody else's slot. Re-attempting it on every completion in the server
    // would be pure churn.
    await withTestHarness(async (harness) => {
      const seen: string[] = [];
      const registry: HookRegistry = { "message.dispatch": [] };
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-core-wait",
        status: "active",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: {
          input: textInput("after this turn"),
          mode: "queue-if-active",
        },
        thread,
      });
      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);

      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: (context) => {
          seen.push(context.thread.id);
          return { action: "proceed" } as const;
        },
      });
      installHooks(registry);
      await runPluginWake(harness);

      expect(seen).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it("honours the re-queue pacing so a plugin that stays full is not re-asked in a loop", async () => {
    await withTestHarness(async (harness) => {
      let passes = 0;
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () => {
          passes += 1;
          return { action: "wait", reason: "still full" } as const;
        },
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-freed-pacing",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("held work"), mode: "auto" },
        thread,
      });
      expect(passes).toBe(1);

      // The first drain re-queues, which starts the thread's cooldown; the
      // second finds it and does nothing, so a burst of completions costs one
      // hook pass per thread rather than one per completion.
      await runPluginWake(harness);
      expect(passes).toBe(2);
      await runPluginWake(harness);
      expect(passes).toBe(2);
    });
  });

  it("walks the queued rows in queue order", async () => {
    // A limit can be expressed over any grouping, so core cannot pick which
    // row deserves the freed slot — it re-offers them oldest first and lets the
    // hook decide. A full pool therefore drains in the order it filled.
    await withTestHarness(async (harness) => {
      let admit = false;
      const seen: string[] = [];
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: (context) => {
          seen.push(context.thread.id);
          return admit
            ? ({ action: "proceed" } as const)
            : ({ action: "wait", reason: "full" } as const);
        },
      });
      installHooks(registry);
      const first = seedRunnableThread(harness, {
        hostId: "host-order-first",
        status: "idle",
      }).thread;
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("first in"), mode: "auto" },
        thread: first,
      });
      const second = seedRunnableThread(harness, {
        hostId: "host-order-second",
        status: "idle",
      }).thread;
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("second in"), mode: "auto" },
        thread: second,
      });

      seen.length = 0;
      admit = true;
      await runPluginWake(harness);

      expect(seen).toEqual([first.id, second.id]);
      expect(listQueuedThreadMessages(harness.db, first.id)).toHaveLength(0);
      expect(listQueuedThreadMessages(harness.db, second.id)).toHaveLength(0);
    });
  });
});

describe("requesting a drain", () => {
  it("schedules one batch when unregistering a plugin releases multiple threads", async () => {
    await withTestHarness(async (harness) => {
      const threads = ["host-unregister-a", "host-unregister-b"].map(
        (hostId) =>
          seedRunnableThread(harness, { hostId, status: "idle" }).thread,
      );
      for (const thread of threads) {
        seedQueuedMessage(harness.deps, {
          content: textInput("released by plugin removal"),
          threadId: thread.id,
          waitingOn: {
            kind: "plugin",
            pluginId: "removed-plugin",
            reason: "Held for testing",
          },
        });
      }

      vi.useFakeTimers();
      try {
        requestQueuedMessageDispatch(harness.deps, {
          kind: "plugin-unregistered",
          pluginId: "removed-plugin",
        });
        expect(vi.getTimerCount()).toBe(1);
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }

      for (const thread of threads) {
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      }
    });
  });

  it("coalesces a burst of requests into one walk", async () => {
    // Five turns finishing together are five requests, and one walk of the
    // queue fills as many freed slots as the hook allows. Without the
    // coalescing flag each request would schedule its own walk over the same
    // rows. Asserted on the scheduled work itself: the re-queue pacing makes a
    // redundant walk invisible in the hook-pass count, which is exactly why it
    // must not be the thing under test here.
    await withTestHarness(async (harness) => {
      let passes = 0;
      const registry: HookRegistry = { "message.dispatch": [] };
      registry["message.dispatch"].push({
        pluginId: "limiter",
        handler: () => {
          passes += 1;
          return { action: "wait", reason: "full" } as const;
        },
      });
      installHooks(registry);
      const { thread } = seedRunnableThread(harness, {
        hostId: "host-burst",
        status: "idle",
      });
      await acceptThreadSendRequest(harness.deps, {
        payload: { input: textInput("held work"), mode: "auto" },
        thread,
      });
      expect(passes).toBe(1);

      vi.useFakeTimers();
      try {
        requestPluginWake(harness);
        requestPluginWake(harness);
        requestPluginWake(harness);
        expect(vi.getTimerCount()).toBe(1);
        // Let it run rather than dropping it: the pending flag clears when the
        // walk starts, and a walk that never starts would suppress every later
        // request in the process.
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
      expect(passes).toBe(2);

      // The flag cleared when that walk started, so the next burst is its own
      // walk — a thread freeing mid-walk is not silently dropped.
      vi.useFakeTimers();
      try {
        requestPluginWake(harness);
        expect(vi.getTimerCount()).toBe(1);
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("scopes coalescing to one server instance", async () => {
    await withTestHarness(async (first) => {
      await withTestHarness(async (second) => {
        vi.useFakeTimers();
        try {
          requestPluginWake(first);
          requestPluginWake(first);
          requestPluginWake(second);
          expect(vi.getTimerCount()).toBe(2);
          await vi.runAllTimersAsync();
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });
});

describe("queue recovery", () => {
  it("releases only waits held by missing plugins", async () => {
    await withTestHarness(async (harness) => {
      const missing = seedRunnableThread(harness, {
        hostId: "host-missing-plugin",
        status: "idle",
      }).thread;
      const loaded = seedRunnableThread(harness, {
        hostId: "host-loaded-plugin",
        status: "idle",
      }).thread;
      seedQueuedMessage(harness.deps, {
        content: textInput("missing plugin work"),
        threadId: missing.id,
        waitingOn: {
          kind: "plugin",
          pluginId: "missing",
          reason: "held",
        },
      });
      seedQueuedMessage(harness.deps, {
        content: textInput("loaded plugin work"),
        threadId: loaded.id,
        waitingOn: {
          kind: "plugin",
          pluginId: "loaded",
          reason: "held",
        },
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "orphaned-plugin-recovery",
        plugins: { isPluginLoaded: (pluginId) => pluginId === "loaded" },
      });

      expect(listQueuedThreadMessages(harness.db, missing.id)).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, loaded.id)).toHaveLength(1);
    });
  });
});
