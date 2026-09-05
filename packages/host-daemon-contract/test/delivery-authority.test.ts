import { describe, expect, it } from "vitest";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandSchema,
} from "../src/index.js";

const BRIDGE_LAUNCH = {
  pluginId: "provider-pi",
  source: {
    kind: "artifact" as const,
    digest: "a".repeat(64),
    byteLength: 4096,
  },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full" as const],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none" as const,
  },
};

function startCommand(options: Record<string, unknown>) {
  return {
    type: "thread.start" as const,
    bridgeLaunch: BRIDGE_LAUNCH,
    environmentId: "env_123",
    threadId: "thr_123",
    workspaceContext: {
      workspacePath: "/tmp/workspace",
      workspaceProvisionType: "unmanaged" as const,
    },
    projectId: "proj_123",
    providerId: "codex",
    requestId: "creq_23456789ab",
    input: [{ type: "text" as const, text: "hello", mentions: [] }],
    options,
    instructions: "Be concise.",
    dynamicTools: [],
    injectedSkillSources: [],
    instructionMode: "append" as const,
  };
}

const fullOptions = {
  model: "gpt-5",
  serviceTier: "default" as const,
  reasoningLevel: "medium" as const,
  providerOptions: {},
  permissionMode: "full" as const,
  permissionScope: "full" as const,
  approvalReviewer: null,
  permissionEscalation: null,
};

describe("deliveryAuthority on protocol 181", () => {
  it("is 181", () => {
    expect(HOST_DAEMON_PROTOCOL_VERSION).toBe(181);
  });

  it("requires none or git and reconstructs the exact value", () => {
    for (const deliveryAuthority of ["none", "git"] as const) {
      const parsed = hostDaemonCommandSchema.parse(
        startCommand({
          ...fullOptions,
          deliveryAuthority,
          ...(deliveryAuthority === "none"
            ? { executionCwd: "/tmp/work-cwd" }
            : {}),
        }),
      );
      expect(parsed.type).toBe("thread.start");
      if (parsed.type !== "thread.start")
        throw new Error("expected thread.start");
      expect(parsed.options.deliveryAuthority).toBe(deliveryAuthority);
      const roundTrip = hostDaemonCommandSchema.parse(
        JSON.parse(JSON.stringify(parsed)),
      );
      expect(roundTrip.type).toBe("thread.start");
      if (roundTrip.type !== "thread.start")
        throw new Error("expected thread.start");
      expect(roundTrip.options.deliveryAuthority).toBe(deliveryAuthority);
      expect(roundTrip.options.executionCwd).toBe(
        deliveryAuthority === "none" ? "/tmp/work-cwd" : undefined,
      );
    }
  });

  it("rejects missing and unknown authority instead of granting git", () => {
    expect(
      hostDaemonCommandSchema.safeParse(startCommand(fullOptions)).success,
    ).toBe(false);
    expect(
      hostDaemonCommandSchema.safeParse(
        startCommand({ ...fullOptions, deliveryAuthority: "ssh" }),
      ).success,
    ).toBe(false);
  });

  it("rejects none without an execution cwd and git with a forged cwd", () => {
    expect(
      hostDaemonCommandSchema.safeParse(
        startCommand({ ...fullOptions, deliveryAuthority: "none" }),
      ).success,
    ).toBe(false);
    expect(
      hostDaemonCommandSchema.safeParse(
        startCommand({
          ...fullOptions,
          deliveryAuthority: "git",
          executionCwd: "/forged",
        }),
      ).success,
    ).toBe(false);
  });
});
