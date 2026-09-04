import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSandboxLaunchError } from "./sandbox-launch.js";
import {
  findBbPackageRoot,
  resolveAcpMcpHelperRuntime,
  rewriteNodeExecArgvForSandbox,
} from "./mcp-helper-runtime.js";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP helper runtime", () => {
  it("rewrites bare --import tsx to an absolute loader path", () => {
    const rewritten = rewriteNodeExecArgvForSandbox([
      "--conditions=source",
      "--import",
      "tsx",
    ]);
    expect(rewritten.args[0]).toBe("--conditions=source");
    expect(rewritten.args[1]).toBe("--import");
    expect(rewritten.args[2]?.startsWith("/")).toBe(true);
    expect(rewritten.args[2]?.includes("tsx")).toBe(true);
    expect(rewritten.loaderPaths).toHaveLength(1);
  });

  it("finds the BB package root from the ACP bridge module", () => {
    const bridge = fileURLToPath(new URL("./bridge/bridge.ts", import.meta.url));
    const root = findBbPackageRoot(bridge);
    expect(root.endsWith("wt-delivery-authority")).toBe(true);
    expect(root.endsWith("provider-bridge-acp")).toBe(false);
  });

  it("builds a helper invocation with node, absolute tsx, and the package root", () => {
    const helper = resolveAcpMcpHelperRuntime({
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      bridgeModulePath: fileURLToPath(new URL("./bridge/bridge.ts", import.meta.url)),
    });
    expect(helper.command).toBe(process.execPath);
    expect(helper.args.at(-1)).toBe("--mcp-stdio");
    expect(helper.args.some((arg) => arg === "tsx")).toBe(false);
    expect(helper.args.some((arg) => arg.includes("tsx") && arg.startsWith("/"))).toBe(
      true,
    );
    expect(helper.roBinds).toContain(process.execPath);
    expect(helper.roBinds.some((bind) => bind.endsWith("wt-delivery-authority"))).toBe(
      true,
    );
    expect(helper.roBinds.every((bind) => bind !== process.env.HOME)).toBe(true);
  });

  it("fails closed when the node executable is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-mcp-missing-"));
    scratch.push(dir);
    expect(() =>
      resolveAcpMcpHelperRuntime({
        execPath: join(dir, "no-such-node"),
        execArgv: [],
        bridgeModulePath: fileURLToPath(new URL("./bridge/bridge.ts", import.meta.url)),
      }),
    ).toThrow(AcpSandboxLaunchError);
  });

  it("uses packageRootHint when the bundled bridge sits outside the release", () => {
    const outside = mkdtempSync(join(tmpdir(), "wt-mcp-bundled-"));
    const release = mkdtempSync(join(tmpdir(), "wt-mcp-release-"));
    scratch.push(outside, release);
    const bridge = join(outside, "bridge.js");
    writeFileSync(bridge, "export {}\n");
    writeFileSync(join(release, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    mkdirSync(join(release, "packages", "provider-bridge-acp"), { recursive: true });
    expect(() =>
      resolveAcpMcpHelperRuntime({
        execPath: process.execPath,
        execArgv: [],
        bridgeModulePath: bridge,
      }),
    ).toThrow(/cannot locate the BB package root/);
    const helper = resolveAcpMcpHelperRuntime({
      execPath: process.execPath,
      execArgv: [],
      bridgeModulePath: bridge,
      packageRootHint: release,
    });
    expect(helper.roBinds).toContain(realpathSync(release));
    expect(helper.args).toContain(realpathSync(bridge));
  });

  it("fails closed on a malformed or too-broad packageRootHint", () => {
    const outside = mkdtempSync(join(tmpdir(), "wt-mcp-hint-"));
    scratch.push(outside);
    const bridge = join(outside, "bridge.js");
    writeFileSync(bridge, "export {}\n");
    expect(() =>
      resolveAcpMcpHelperRuntime({
        execPath: process.execPath,
        execArgv: [],
        bridgeModulePath: bridge,
        packageRootHint: outside,
      }),
    ).toThrow(/not a BB release root/);
    expect(() =>
      resolveAcpMcpHelperRuntime({
        execPath: process.execPath,
        execArgv: [],
        bridgeModulePath: bridge,
        packageRootHint: "/",
      }),
    ).toThrow(/too-broad/);
    expect(() =>
      resolveAcpMcpHelperRuntime({
        execPath: process.execPath,
        execArgv: [],
        bridgeModulePath: bridge,
        packageRootHint: homedir(),
      }),
    ).toThrow(/too-broad/);
  });
});
