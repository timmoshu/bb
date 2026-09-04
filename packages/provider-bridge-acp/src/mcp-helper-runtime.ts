import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpSandboxLaunchError } from "./sandbox-launch.js";

export interface ResolveAcpMcpHelperRuntimeInput {
  execPath: string;
  execArgv: readonly string[];
  bridgeModulePath: string;
  resolveSpecifier?: (specifier: string) => string;
  hostHome?: string;
}

export interface AcpMcpHelperRuntime {
  command: string;
  args: string[];
  roBinds: string[];
}

function assertExistingFile(label: string, path: string): string {
  if (!existsSync(path)) {
    throw new AcpSandboxLaunchError(`ACP sandbox ${label} is missing: ${path}`);
  }
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new AcpSandboxLaunchError(`ACP sandbox ${label} is not a file: ${path}`);
  }
  return realpathSync(path);
}

function toFilesystemPath(specifier: string): string {
  if (specifier.startsWith("file:")) {
    return fileURLToPath(specifier);
  }
  return specifier;
}

function defaultResolveSpecifier(specifier: string): string {
  return import.meta.resolve(specifier, pathToFileURL(import.meta.filename).href);
}

function absolutizeImportSpecifier(
  specifier: string,
  resolveSpecifier: (specifier: string) => string,
): string {
  const asPath = toFilesystemPath(specifier);
  if (isAbsolute(asPath) && existsSync(asPath)) {
    return realpathSync(asPath);
  }
  let resolved: string;
  try {
    resolved = resolveSpecifier(specifier);
  } catch (error) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox cannot resolve MCP loader ${specifier}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const path = toFilesystemPath(resolved);
  if (!isAbsolute(path)) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox MCP loader did not resolve to an absolute path: ${specifier}`,
    );
  }
  return assertExistingFile("MCP loader", path);
}

export function rewriteNodeExecArgvForSandbox(
  execArgv: readonly string[],
  resolveSpecifier: (specifier: string) => string = defaultResolveSpecifier,
): { args: string[]; loaderPaths: string[] } {
  const args: string[] = [];
  const loaderPaths: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (arg === undefined) continue;
    if (arg === "--import" || arg === "--loader" || arg === "--experimental-loader") {
      const specifier = execArgv[index + 1];
      if (specifier === undefined) {
        throw new AcpSandboxLaunchError(
          `ACP sandbox MCP helper is missing a value for ${arg}`,
        );
      }
      const absolute = absolutizeImportSpecifier(specifier, resolveSpecifier);
      args.push(arg, absolute);
      loaderPaths.push(absolute);
      index += 1;
      continue;
    }
    const importPrefix = arg.startsWith("--import=")
      ? "--import="
      : arg.startsWith("--loader=")
        ? "--loader="
        : arg.startsWith("--experimental-loader=")
          ? "--experimental-loader="
          : null;
    if (importPrefix) {
      const specifier = arg.slice(importPrefix.length);
      const absolute = absolutizeImportSpecifier(specifier, resolveSpecifier);
      args.push(`${importPrefix}${absolute}`);
      loaderPaths.push(absolute);
      continue;
    }
    args.push(arg);
  }
  return { args, loaderPaths };
}

function hasBbReleaseMarkers(dir: string): boolean {
  return (
    existsSync(join(dir, "pnpm-workspace.yaml")) &&
    existsSync(join(dir, "packages", "provider-bridge-acp"))
  );
}

function assertNotTooBroadPackageRoot(dir: string, hostHome: string): void {
  if (dir === "/" || dir === "/home" || dir === hostHome) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox refused to bind a too-broad MCP runtime root: ${dir}`,
    );
  }
}

function tryAscendToBbPackageRoot(startFile: string, hostHome: string): string | undefined {
  let dir = dirname(realpathSync(startFile));
  for (;;) {
    if (hasBbReleaseMarkers(dir)) {
      const real = realpathSync(dir);
      assertNotTooBroadPackageRoot(real, hostHome);
      return real;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function findBbPackageRoot(startFile: string, hostHome = homedir()): string {
  const file = assertExistingFile("MCP runtime file", startFile);
  const found = tryAscendToBbPackageRoot(file, hostHome);
  if (found === undefined) {
    throw new AcpSandboxLaunchError(
      "ACP sandbox cannot locate the BB package root for the MCP helper",
    );
  }
  return found;
}

function resolveBbPackageRoot(
  loaderPaths: readonly string[],
  bridgeModulePath: string,
  hostHome: string,
): string {
  for (const start of [...loaderPaths, bridgeModulePath]) {
    const found = tryAscendToBbPackageRoot(start, hostHome);
    if (found !== undefined) return found;
  }
  throw new AcpSandboxLaunchError(
    "ACP sandbox cannot locate the BB package root for the MCP helper",
  );
}

export function resolveAcpMcpHelperRuntime(
  input: ResolveAcpMcpHelperRuntimeInput,
): AcpMcpHelperRuntime {
  const command = assertExistingFile("MCP node executable", input.execPath);
  const resolveSpecifier = input.resolveSpecifier ?? defaultResolveSpecifier;
  const rewritten = rewriteNodeExecArgvForSandbox(input.execArgv, resolveSpecifier);
  const bridgeModulePath = assertExistingFile(
    "MCP bridge module",
    input.bridgeModulePath,
  );
  const hostHome = resolve(input.hostHome ?? homedir());
  const packageRoot = resolveBbPackageRoot(
    rewritten.loaderPaths,
    bridgeModulePath,
    hostHome,
  );
  const roBinds = new Set<string>([command, packageRoot, ...rewritten.loaderPaths]);
  if (roBinds.has(hostHome)) {
    throw new AcpSandboxLaunchError("ACP sandbox refused to bind all of HOME read-only");
  }
  return {
    command,
    args: [...rewritten.args, bridgeModulePath, "--mcp-stdio"],
    roBinds: [...roBinds].sort(),
  };
}
