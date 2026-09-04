import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class CodexSandboxLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSandboxLaunchError";
  }
}

export function isInsideCodexSandboxRoot(
  root: string,
  candidate: string,
): boolean {
  const part = relative(resolve(root), resolve(candidate));
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
}

export function canonicalCodexSandboxDirectory(
  candidate: string,
  hostHome: string,
): string {
  try {
    const target = resolve(candidate);
    if (target !== candidate || target === sep || target === hostHome) {
      throw new Error("forbidden");
    }
    let current: string = sep;
    for (const segment of target.slice(sep.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
        throw new Error("invalid");
      }
    }
    if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) {
      throw new Error("invalid");
    }
    return target;
  } catch {
    throw new CodexSandboxLaunchError("Codex sandbox rejected execution cwd");
  }
}

export function codexSandboxAncestorDirectories(
  target: string,
  maskedRoots: readonly string[],
): string[] {
  const parent = dirname(resolve(target));
  const directories: string[] = [];
  for (const root of maskedRoots.map((value) => resolve(value))) {
    if (!isInsideCodexSandboxRoot(root, parent)) continue;
    let current = parent;
    while (current !== root && current.startsWith(root + sep)) {
      directories.push(current);
      current = dirname(current);
    }
  }
  return [...new Set(directories)].sort(
    (left, right) => left.length - right.length,
  );
}

export function codexSandboxBaseArgs(maskedRoots: readonly string[]): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  for (const root of maskedRoots) args.push("--tmpfs", root);
  return args;
}
