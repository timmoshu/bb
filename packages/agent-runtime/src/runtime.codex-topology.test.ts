import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DynamicTool, ThreadEvent } from "@bb/domain";
import { createAgentRuntime } from "./runtime.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
  fullRuntimeOptions,
  waitForRuntimeState,
  waitForThreadAgentMessageText,
  withBridgeLaunch,
  type LaunchBoundAgentRuntime,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";
import type {
  AgentRuntime,
  AgentRuntimeBridgeLaunch,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
} from "./types.js";

const codexBridgeModulePath = fileURLToPath(
  new URL(
    "../../../plugins/provider-codex/src/bridge/bridge.ts",
    import.meta.url,
  ),
);
const fakeAppServerPath = fileURLToPath(
  new URL(
    "../../../plugins/provider-codex/src/bridge/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);

interface CodexTopologyRuntime {
  events: ThreadEvent[];
  runtime: LaunchBoundAgentRuntime;
  spawned(): number;
  exited(): number;
  bridges(): number;
  childPids(): number[];
  bridgeExits: { expected: boolean }[];
  launch(digest: string): AgentRuntimeBridgeLaunch;
}

describe("codex process topology", () => {
  let workspaceDir: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-topology-"));
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function createCodexTopologyRuntime(
    args: {
      fakeScript?: Record<string, unknown>;
      extraEnv?: Record<string, string>;
      onToolCall?: AgentRuntimeOptions["onToolCall"];
      threadCreationTimeoutMs?: number;
    } = {},
  ): CodexTopologyRuntime {
    const processLogPath = join(workspaceDir, "app-server-processes.log");
    const scriptPath = join(workspaceDir, "fake-codex-script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        processLogPath,
        archiveStatePath: join(workspaceDir, "fake-codex-archived.json"),
        ...args.fakeScript,
      }),
    );
    const events: ThreadEvent[] = [];
    const bridgeExits: { expected: boolean }[] = [];
    const record = createScriptedEchoRequestRecord();
    const launch = (digest: string): AgentRuntimeBridgeLaunch =>
      createScriptedEchoLaunch({
        pluginId: "provider-codex",
        digest,
        modulePath: codexBridgeModulePath,
      });
    const runtime = withBridgeLaunch(
      createAgentRuntime({
        workspacePath: workspaceDir,
        workTogetherWorkCwdRoot: workspaceDir,
        env: {
          ...record.env,
          ...args.extraEnv,
          BB_CODEX_BRIDGE_APP_SERVER_COMMAND: process.execPath,
          BB_CODEX_BRIDGE_APP_SERVER_ARGS: JSON.stringify([
            fakeAppServerPath,
            scriptPath,
          ]),
        },
        onEvent: (event) => events.push(event),
        onProcessExit: (info) => bridgeExits.push({ expected: info.expected }),
        onToolCall:
          args.onToolCall ??
          (async () => ({ contentItems: [], success: true })),
        ...(args.threadCreationTimeoutMs === undefined
          ? {}
          : {
              threadCreation: {
                requestTimeoutMs: args.threadCreationTimeoutMs,
              },
            }),
      }),
      launch("codex-v1"),
    );
    runtimes.push(runtime);
    const readLog = (): string[] => {
      try {
        return readFileSync(processLogPath, "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    };
    const spawnLines = (): string[] =>
      readLog().filter((line) => line.startsWith("spawn:"));
    return {
      events,
      runtime,
      childPids: () => spawnLines().map((line) => Number(line.split(":")[1])),
      spawned: () => spawnLines().length,
      exited: () => readLog().filter((line) => line.startsWith("exit:")).length,
      bridges: () =>
        new Set(spawnLines().map((line) => line.split(":")[2])).size,
      bridgeExits,
      launch,
    };
  }

  function hosted(runtime: AgentRuntime): string[] {
    return ["t1", "t2", "t3", "t4"].filter((threadId) =>
      runtime.hasThread(threadId),
    );
  }

  function requestMethods(): string[] {
    try {
      return readFileSync(join(workspaceDir, "app-server-requests.log"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async function startCodexThread(
    runtime: LaunchBoundAgentRuntime,
    threadId: string,
    bridgeLaunch?: AgentRuntimeBridgeLaunch,
    options: AgentRuntimeExecutionOptions = fullRuntimeOptions,
    dynamicTools?: DynamicTool[],
  ): Promise<string> {
    const { providerThreadId } = await runtime.startThread({
      ...(bridgeLaunch === undefined ? {} : { bridgeLaunch }),
      environmentId: "env-1",
      projectId: "p1",
      providerId: "codex",
      threadId,
      options,
      ...(dynamicTools === undefined ? {} : { dynamicTools }),
    });
    return providerThreadId;
  }

  it("sandboxes none-authority Codex in the admitted Work cwd without ambient host identity", async () => {
    const workCwd = join(workspaceDir, "work");
    mkdirSync(workCwd);
    const siblingPath = join(workspaceDir, "host-secret");
    writeFileSync(siblingPath, "secret");
    const remotePath = join(workspaceDir, "remote.git");
    execFileSync("/usr/bin/git", ["init", "--bare", remotePath]);
    execFileSync("/usr/bin/git", ["init", workCwd]);
    execFileSync("/usr/bin/git", ["remote", "add", "origin", remotePath], {
      cwd: workCwd,
    });
    const probePath = join(workCwd, "sandbox-probe.json");
    const codexHome = join(workspaceDir, "codex-source");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const toolCalls: string[] = [];
    const toolNames = [
      "wt_checkpoint_report",
      "wt_result_report",
      "wt_needs_you_report",
      "wt_repository_deliver",
    ];
    const topology = createCodexTopologyRuntime({
      extraEnv: {
        CODEX_HOME: codexHome,
        GH_TOKEN: "must-not-pass",
        SSH_AUTH_SOCK: "/tmp/must-not-pass.sock",
        AWS_ACCESS_KEY_ID: "must-not-pass",
        DOCKER_HOST: "unix:///tmp/must-not-pass.sock",
        DATABASE_URL: "must-not-pass",
        CI_JOB_TOKEN: "must-not-pass",
        HTTPS_PROXY: "http://user:password@proxy.invalid",
      },
      fakeScript: {
        processLogPath: join(workCwd, "process.log"),
        sandboxProbe: {
          outputPath: probePath,
          siblingPath,
          envKeys: [
            "GH_TOKEN",
            "SSH_AUTH_SOCK",
            "AWS_ACCESS_KEY_ID",
            "DOCKER_HOST",
            "DATABASE_URL",
            "CI_JOB_TOKEN",
            "HTTPS_PROXY",
          ],
        },
        turns: [
          [
            {
              method: "turn/started",
              params: {
                threadId: "fixture",
                turn: { id: "turn-tools", status: "inProgress" },
              },
            },
            ...toolNames.map((tool, index) => ({
              kind: "request",
              method: "item/tool/call",
              params: {
                threadId: "fixture",
                turnId: "turn-tools",
                callId: `call-${index}`,
                tool,
                arguments: {},
              },
            })),
            {
              method: "turn/completed",
              params: {
                threadId: "fixture",
                turn: { id: "turn-tools", status: "completed" },
              },
            },
          ],
        ],
      },
      onToolCall: async (request) => {
        toolCalls.push(request.tool);
        return {
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        };
      },
    });
    const options = {
      ...fullRuntimeOptions,
      permissionMode: "accept-edits" as const,
      permissionScope: "workspace" as const,
      approvalReviewer: "user" as const,
      permissionEscalation: "deny" as const,
      deliveryAuthority: "none" as const,
      executionCwd: workCwd,
    };
    await startCodexThread(
      topology.runtime,
      "t1",
      undefined,
      options,
      toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      })),
    );
    expect(JSON.parse(readFileSync(probePath, "utf8"))).toMatchObject({
      cwd: workCwd,
      home: "/run/bb-codex-home",
      codexHome: "/run/bb-codex-auth",
      codexHomeEntries: ["auth.json"],
      siblingVisible: false,
      localAddExit: 0,
      localCommitExit: 0,
      remotePushExit: 128,
      ambientIdentity: {
        GH_TOKEN: null,
        SSH_AUTH_SOCK: null,
        AWS_ACCESS_KEY_ID: null,
        DOCKER_HOST: null,
        DATABASE_URL: null,
        CI_JOB_TOKEN: null,
        HTTPS_PROXY: null,
      },
    });
    expect(readFileSync(join(workCwd, "sandbox-local.txt"), "utf8")).toBe(
      "local commit works\n",
    );
    await topology.runtime.runTurn({
      clientRequestId: "creq_23456789ab",
      threadId: "t1",
      input: [promptTextInput({ text: "exercise WT tools" })],
      options,
    });
    await waitForRuntimeState({
      label: "sandboxed Codex routed WT dynamic tools",
      predicate: () => toolCalls.length === toolNames.length,
      timeoutMs: 5_000,
    });
    expect(toolCalls).toEqual(toolNames);
  });

  it("runs N codex threads on one bridge process with one app-server child each, and reaps the children on stop, archive, and bridge retirement", async () => {
    const topology = createCodexTopologyRuntime();
    const { runtime, events } = topology;

    await startCodexThread(runtime, "t1");
    await startCodexThread(runtime, "t2");
    await startCodexThread(runtime, "t3");

    expect(runtime.listRunningProviders()).toEqual(["codex"]);
    expect(hosted(runtime)).toEqual(["t1", "t2", "t3"]);
    expect(topology.spawned()).toBe(3);
    expect(topology.bridges()).toBe(1);
    expect(topology.exited()).toBe(0);

    await runtime.runTurn({
      clientRequestId: "creq_cdxtpgy222",
      threadId: "t2",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });
    await waitForThreadAgentMessageText({
      events,
      providerId: "codex",
      runtime,
      text: "hello from codex turn",
      threadId: "t2",
    });
    expect(topology.spawned()).toBe(3);

    await runtime.stopThread({ threadId: "t1" });
    await waitForRuntimeState({
      label: "t1's app-server child exited",
      predicate: () => topology.exited() === 1,
      timeoutMs: 5_000,
    });
    expect(runtime.listRunningProviders()).toEqual(["codex"]);
    expect(hosted(runtime)).toEqual(["t2", "t3"]);

    const session2 = runtime.getProviderSession("t2");
    if (!session2) throw new Error("expected a codex session for t2");
    await runtime.archiveThread({
      providerId: "codex",
      providerThreadId: session2.providerThreadId,
      threadId: "t2",
    });
    await waitForRuntimeState({
      label: "t2's app-server child exited",
      predicate: () => topology.exited() === 2,
      timeoutMs: 5_000,
    });
    expect(runtime.listRunningProviders()).toEqual(["codex"]);
    expect(hosted(runtime)).toEqual(["t3"]);
    expect(topology.spawned()).toBe(3);

    const v2 = topology.launch("codex-v2");
    await startCodexThread(runtime, "t4", v2);
    expect(topology.spawned()).toBe(4);
    expect(topology.bridges()).toBe(2);
    expect(topology.exited()).toBe(2);
    expect(topology.bridgeExits).toEqual([]);

    await runtime.stopThread({ threadId: "t3" });
    await waitForRuntimeState({
      label: "the superseded bridge and t3's child exited",
      predicate: () =>
        topology.exited() === 3 && topology.bridgeExits.length === 1,
      timeoutMs: 10_000,
    });
    expect(topology.bridgeExits).toEqual([{ expected: true }]);
    expect(hosted(runtime)).toEqual(["t4"]);
    expect(topology.spawned()).toBe(4);

    await runtime.unarchiveThread({
      providerId: "codex",
      providerThreadId: session2.providerThreadId,
      threadId: "t2",
      bridgeLaunch: v2,
    });
    await runtime.resumeThread({
      bridgeLaunch: v2,
      environmentId: "env-1",
      projectId: "p1",
      providerId: "codex",
      providerThreadId: session2.providerThreadId,
      threadId: "t2",
      options: fullRuntimeOptions,
    });
    expect(hosted(runtime)).toEqual(["t2", "t4"]);
    await waitForRuntimeState({
      label: "the maintenance child was reaped",
      predicate: () => topology.exited() === 4,
      timeoutMs: 5_000,
    });
    expect(topology.spawned()).toBe(6);
    expect(topology.bridges()).toBe(2);
    expect(topology.bridgeExits).toHaveLength(1);
  }, 60_000);

  it("interrupt-stop settles the turn on the wire and then releases the thread's child", async () => {
    const topology = createCodexTopologyRuntime();
    const { runtime, events } = topology;
    await startCodexThread(runtime, "t1");
    await runtime.runTurn({
      clientRequestId: "creq_cdxtpgy223",
      threadId: "t1",
      input: [promptTextInput({ text: "/wait-for-interrupt" })],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "the held turn started",
      predicate: () => runtime.getActiveTurnId("t1") !== null,
      runtime,
      timeoutMs: 5_000,
    });
    expect(topology.spawned()).toBe(1);

    await runtime.stopThread({ threadId: "t1" });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "interrupted",
      }),
    );
    expect(runtime.hasThread("t1")).toBe(false);
    await waitForRuntimeState({
      label: "t1's app-server child exited after the interrupt-stop",
      predicate: () => topology.exited() === 1,
      timeoutMs: 5_000,
    });
    expect(runtime.listRunningProviders()).toEqual(["codex"]);
    expect(topology.bridgeExits).toEqual([]);
  }, 30_000);

  it("releases the thread on the bridge when a construction times out on the runtime's side", async () => {
    const topology = createCodexTopologyRuntime({
      fakeScript: { startDelayMs: 800 },
      threadCreationTimeoutMs: 200,
    });
    const { runtime } = topology;
    await expect(startCodexThread(runtime, "t1")).rejects.toThrow(/timed out/i);
    expect(runtime.hasThread("t1")).toBe(false);
    await waitForRuntimeState({
      label: "the late-constructed child was released",
      predicate: () => topology.spawned() === 1 && topology.exited() === 1,
      timeoutMs: 10_000,
    });
    expect(runtime.listRunningProviders()).toEqual(["codex"]);
  }, 30_000);

  it("sweeps every app-server child when the bridge dies unexpectedly", async () => {
    const topology = createCodexTopologyRuntime();
    const { runtime } = topology;
    await startCodexThread(runtime, "t1");
    await startCodexThread(runtime, "t2");
    expect(topology.spawned()).toBe(2);
    const [child1, child2] = topology.childPids();
    if (child1 === undefined || child2 === undefined) {
      throw new Error("expected two app-server children");
    }
    const bridgePid = Number(
      readFileSync(join(workspaceDir, "app-server-processes.log"), "utf8")
        .split("\n")[0]
        ?.split(":")[2],
    );

    process.kill(bridgePid, "SIGKILL");
    await waitForRuntimeState({
      label: "the runtime reported the unexpected bridge exit",
      predicate: () => topology.bridgeExits.length === 1,
      timeoutMs: 10_000,
    });
    expect(topology.bridgeExits).toEqual([{ expected: false }]);
    await waitForRuntimeState({
      label: "both app-server children exited",
      predicate: () => !isAlive(child1) && !isAlive(child2),
      timeoutMs: 10_000,
    });
    expect(runtime.hasThread("t1")).toBe(false);
    expect(runtime.hasThread("t2")).toBe(false);
  }, 30_000);

  it("starts a fresh none-authority session after an exact missing-rollout resume and sends Reply once", async () => {
    const codexHome = join(workspaceDir, "codex-source");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const toolNames = [
      "wt_checkpoint_report",
      "wt_result_report",
      "wt_needs_you_report",
      "wt_repository_deliver",
    ];
    const toolCalls: string[] = [];
    const createTopology = (): CodexTopologyRuntime =>
      createCodexTopologyRuntime({
        extraEnv: { CODEX_HOME: codexHome },
        fakeScript: {
          requestLogPath: join(workspaceDir, "app-server-requests.log"),
          resumeErrorMessage: "no rollout found for thread id {threadId}",
          turns: [
            [
              {
                method: "turn/started",
                params: {
                  threadId: "fixture",
                  turn: { id: "turn-reply", status: "inProgress" },
                },
              },
              ...toolNames.map((tool, index) => ({
                kind: "request",
                method: "item/tool/call",
                params: {
                  threadId: "fixture",
                  turnId: "turn-reply",
                  callId: `reply-call-${index}`,
                  tool,
                  arguments: {},
                },
              })),
              {
                method: "turn/completed",
                params: {
                  threadId: "fixture",
                  turn: { id: "turn-reply", status: "completed" },
                },
              },
            ],
          ],
        },
        onToolCall: async (request) => {
          toolCalls.push(request.tool);
          return {
            contentItems: [{ type: "inputText", text: "ok" }],
            success: true,
          };
        },
      });
    let topology = createTopology();
    const options = {
      ...fullRuntimeOptions,
      deliveryAuthority: "none" as const,
      executionCwd: workspaceDir,
    };
    const dynamicTools = toolNames.map((name) => ({
      name,
      description: name,
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
    }));
    const originalProviderThreadId = await startCodexThread(
      topology.runtime,
      "t1",
      undefined,
      options,
      dynamicTools,
    );
    await topology.runtime.shutdown();
    topology = createTopology();
    const replacement = await topology.runtime.resumeThread({
      bridgeLaunch: topology.launch("codex-v2"),
      environmentId: "env-1",
      projectId: "p1",
      providerId: "codex",
      providerThreadId: originalProviderThreadId,
      threadId: "t1",
      options,
      dynamicTools,
    });
    expect(replacement.providerThreadId).not.toBe(originalProviderThreadId);
    await topology.runtime.runTurn({
      clientRequestId: "creq_23456789ac",
      threadId: "t1",
      input: [promptTextInput({ text: "Reply" })],
      options,
    });
    await waitForRuntimeState({
      label: "the replacement session routed all WT tools",
      predicate: () => toolCalls.length === toolNames.length,
      timeoutMs: 5_000,
    });
    expect(toolCalls).toEqual(toolNames);
    expect(
      requestMethods().filter((method) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      requestMethods().filter((method) => method === "thread/start"),
    ).toHaveLength(2);
    expect(
      requestMethods().filter((method) => method === "turn/start"),
    ).toHaveLength(1);
  }, 30_000);

  it("does not start a fresh session for other resume failures", async () => {
    const codexHome = join(workspaceDir, "codex-source");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const createTopology = (): CodexTopologyRuntime =>
      createCodexTopologyRuntime({
        extraEnv: { CODEX_HOME: codexHome },
        fakeScript: {
          requestLogPath: join(workspaceDir, "app-server-requests.log"),
          resumeErrorMessage: "permission denied",
        },
      });
    let topology = createTopology();
    const options = {
      ...fullRuntimeOptions,
      deliveryAuthority: "none" as const,
      executionCwd: workspaceDir,
    };
    const originalProviderThreadId = await startCodexThread(
      topology.runtime,
      "t1",
      undefined,
      options,
    );
    await topology.runtime.shutdown();
    topology = createTopology();
    await expect(
      topology.runtime.resumeThread({
        bridgeLaunch: topology.launch("codex-v2"),
        environmentId: "env-1",
        projectId: "p1",
        providerId: "codex",
        providerThreadId: originalProviderThreadId,
        threadId: "t1",
        options,
      }),
    ).rejects.toThrow("permission denied");
    expect(
      requestMethods().filter((method) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      requestMethods().filter((method) => method === "thread/start"),
    ).toHaveLength(1);
    expect(requestMethods()).not.toContain("turn/start");
  }, 30_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
