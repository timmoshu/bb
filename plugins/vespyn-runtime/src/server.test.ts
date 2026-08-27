import type {
  BbPluginApi,
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  CELL_TOOL_SECRET_ENV,
  COORDINATOR_ORIGIN_ENV,
} from "./config.js";
import plugin from "./server.js";
import {
  VESPYN_RUNTIME_SKILLS,
  VESPYN_RUNTIME_TOOLS,
} from "./selection.js";

const SECRET = "s".repeat(32);
const ORIGIN = "https://work.vespyn.com";

const originalOrigin = process.env[COORDINATOR_ORIGIN_ENV];
const originalSecret = process.env[CELL_TOOL_SECRET_ENV];

afterEach(() => {
  if (originalOrigin === undefined) delete process.env[COORDINATOR_ORIGIN_ENV];
  else process.env[COORDINATOR_ORIGIN_ENV] = originalOrigin;
  if (originalSecret === undefined) delete process.env[CELL_TOOL_SECRET_ENV];
  else process.env[CELL_TOOL_SECRET_ENV] = originalSecret;
});

type RegisteredTool = {
  name: string;
  execute: (
    input: unknown,
    context: PluginAgentToolContext,
  ) => unknown;
};

function installPlugin(): {
  tools: RegisteredTool[];
  configure:
    | ((context: PluginAgentConfigurationContext) => PluginAgentConfiguration)
    | undefined;
  settingsDefined: boolean;
} {
  const tools: RegisteredTool[] = [];
  let configure:
    | ((context: PluginAgentConfigurationContext) => PluginAgentConfiguration)
    | undefined;
  let settingsDefined = false;
  plugin({
    settings: {
      define() {
        settingsDefined = true;
        throw new Error("settings.define must not be called");
      },
    },
    agents: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      configure(
        next: (context: PluginAgentConfigurationContext) => PluginAgentConfiguration,
      ) {
        configure = next;
      },
    },
  } as unknown as BbPluginApi);
  return { tools, configure, settingsDefined };
}

function configurationContext(
  kind: "standard" | "personal",
): PluginAgentConfigurationContext {
  return {
    thread: {
      id: "thr-test",
      title: null,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "proj-test",
      kind,
      name: "bb",
      gitRemoteUrl: null,
    },
    environment: {
      id: "env-test",
      name: null,
      path: null,
      workspaceProvisionType: "unmanaged",
      branchName: null,
    },
    host: { id: "host-test", name: "local" },
    provider: { id: "codex", model: "test-model" },
    origin: { kind: null, pluginId: null },
  };
}

describe("vespyn runtime plugin factory", () => {
  it("throws a sanitized error at factory load when env is invalid", () => {
    const origin = "https://user:hunter2@evil.example.com";
    const secret = "too-short";
    process.env[COORDINATOR_ORIGIN_ENV] = origin;
    process.env[CELL_TOOL_SECRET_ENV] = secret;
    let caught: unknown;
    try {
      installPlugin();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
    expect(error.message).not.toContain(origin);
    expect(serialized).not.toContain(origin);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain(secret);
  });

  it("registers the cell tools and does not define settings", () => {
    process.env[COORDINATOR_ORIGIN_ENV] = ORIGIN;
    process.env[CELL_TOOL_SECRET_ENV] = SECRET;
    const { tools, configure, settingsDefined } = installPlugin();
    expect(settingsDefined).toBe(false);
    expect(tools.map((tool) => tool.name)).toEqual([...VESPYN_RUNTIME_TOOLS]);
    expect(configure).toBeTypeOf("function");
  });

  it("configures tools and skills only for standard projects", () => {
    process.env[COORDINATOR_ORIGIN_ENV] = ORIGIN;
    process.env[CELL_TOOL_SECRET_ENV] = SECRET;
    const { configure } = installPlugin();
    expect(configure).toBeTypeOf("function");
    expect(configure?.(configurationContext("standard"))).toMatchObject({
      tools: [...VESPYN_RUNTIME_TOOLS],
      skills: [...VESPYN_RUNTIME_SKILLS],
    });
    expect(configure?.(configurationContext("personal"))).toEqual({
      tools: [],
      skills: [],
    });
  });
});
