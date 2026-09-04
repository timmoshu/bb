import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_signature_1";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  deliveryAuthority: "git",
} as const;

const autoAskSessionOptions = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
  deliveryAuthority: "git",
} as const;

const autoDenySessionOptions = {
  ...autoAskSessionOptions,
  permissionEscalation: "deny",
  deliveryAuthority: "git",
} as const;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-signature-ws-"));
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 991_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "signature-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("keeps the constructed session for a turn whose options carry no envVars", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions, envVars: { PATH: "/usr/bin:/bin" } },
  });
  const started = await harness.waitForResponse(1);
  const providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_signature2",
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: { ...sessionOptions },
  });
  const turn = await harness.waitForResponse(2);

  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

it("keeps an auto-reviewed session when only escalation intent changes", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: autoAskSessionOptions,
  });
  const started = await harness.waitForResponse(1);
  const providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_signature3",
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: autoDenySessionOptions,
  });
  const turn = await harness.waitForResponse(2);

  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

it("rebuilds a Git-authority child before applying none authority and a new cwd", async () => {
  const workCwd = join(workspaceDir, "work");
  const codexHome = join(workspaceDir, "codex-home");
  mkdirSync(workCwd);
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), "{}");
  vi.stubEnv("CODEX_HOME", codexHome);
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  const started = await harness.waitForResponse(1);
  const providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_23456789ac",
    input: [{ type: "text", text: "apply guarded cwd", mentions: [] }],
    options: {
      ...sessionOptions,
      deliveryAuthority: "none",
      executionCwd: workCwd,
      executionEnvironmentCwd: workspaceDir,
      workTogetherWorkCwdRoot: workspaceDir,
    },
  });
  const turn = await harness.waitForResponse(2);
  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toHaveLength(1);
}, 30_000);
