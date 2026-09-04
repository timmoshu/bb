import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ApiError } from "../errors.js";

const SAFE_ERROR = "Coordination cwd unavailable";

function fail(): never {
  throw new ApiError(409, "coordination_cwd_unavailable", SAFE_ERROR);
}

function canonicalDirectory(candidate: string): string {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) fail();
  const resolved = path.resolve(candidate);
  if (
    resolved !== candidate ||
    resolved === "/" ||
    resolved === path.resolve(homedir())
  )
    fail();
  let current = path.parse(resolved).root;
  for (const segment of resolved
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) fail();
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail();
  }
  const info = lstatSync(resolved);
  if (!info.isDirectory() || realpathSync(resolved) !== resolved) fail();
  return resolved;
}

function strictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function resolveConfiguredWorkTogetherCwdRoot(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return canonicalDirectory(value);
  } catch {
    throw new Error("BB_WT_WORK_CWD_ROOT_invalid");
  }
}

export function resolveWorkTogetherExecutionCwd(args: {
  candidate: string;
  environmentPath: string;
  managedRoot: string | undefined;
}): string {
  const candidate = canonicalDirectory(args.candidate);
  const environmentPath = canonicalDirectory(args.environmentPath);
  if (candidate === environmentPath) return candidate;
  if (args.managedRoot === undefined) fail();
  const managedRoot = canonicalDirectory(args.managedRoot);
  if (!strictlyInside(managedRoot, candidate)) fail();
  return candidate;
}
