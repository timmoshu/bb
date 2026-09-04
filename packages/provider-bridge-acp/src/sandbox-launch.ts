import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { DeliveryAuthority } from "@bb/domain";
import {
  AcpSandboxLaunchError,
  acpSandboxAncestorDirectories,
  acpSandboxBaseArgs,
  canonicalAcpSandboxDirectory,
  isInsideAcpSandboxRoot,
} from "./sandbox-kernel.js";

export { AcpSandboxLaunchError } from "./sandbox-kernel.js";

export const ACP_SANDBOX_BWRAP_PATH = "/usr/bin/bwrap";

const GIT_AUTHOR_NAME = "WT Room Agent";
const GIT_AUTHOR_EMAIL = "wt-room@local.invalid";

const REMOVED_ENV_KEYS = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDFLARE_API_TOKEN",
  "VERCEL_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "HEROKU_API_KEY",
  "DIGITALOCEAN_ACCESS_TOKEN",
  "FLY_API_TOKEN",
  "FLY_ACCESS_TOKEN",
  "DOCKER_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_AUTH_CONFIG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "GNUPGHOME",
]);

const REMOVED_ENV_PREFIXES = [
  "AWS_",
  "AZURE_",
  "GCLOUD_",
  "GOOGLE_",
  "NPM_CONFIG_",
];

const EMBEDDED_CREDENTIAL_URL = /(?:https?|git):\/\/[^/\s:]+:[^/\s@]+@/i;
const EMBEDDED_TOKEN_URL = /(?:https?|git):\/\/(?!git@)[^/\s@]+@/i;

export interface AcpAgentLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  bwrap: boolean;
  rwBinds: string[];
  roBinds: string[];
  binds: string[];
}

export interface PlanAcpAgentLaunchInput {
  deliveryAuthority: DeliveryAuthority;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  hostHome?: string;
  bwrapPath?: string;
  platform?: NodeJS.Platform;
  runtimeRoBinds?: readonly string[];
  executionEnvironmentCwd?: string;
  workTogetherWorkCwdRoot?: string;
  cwdBindSource?: string;
}

function definedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function resolveAgentExecutable(
  command: string,
  env: Record<string, string>,
): string {
  if (command.includes("/") || isAbsolute(command)) {
    const resolved = resolve(command);
    if (!existsSync(resolved)) {
      throw new AcpSandboxLaunchError(
        `ACP sandbox cannot resolve agent executable: ${command}`,
      );
    }
    return realpathSync(resolved);
  }
  const pathEntries = (env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    if (existsSync(candidate)) {
      const stats = statSync(candidate);
      if (stats.isFile()) return realpathSync(candidate);
    }
  }
  throw new AcpSandboxLaunchError(
    `ACP sandbox cannot resolve agent executable on PATH: ${command}`,
  );
}

function readGitdirPointer(cwd: string, contents: string): string {
  const match = /^gitdir:\s*(.+)\s*$/m.exec(contents);
  if (!match || match[1] === undefined) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox rejected an unreadable gitdir pointer in ${join(cwd, ".git")}`,
    );
  }
  const raw = match[1].trim();
  const resolved = isAbsolute(raw) ? normalize(raw) : resolve(cwd, raw);
  if (resolved.includes("\0")) {
    throw new AcpSandboxLaunchError("ACP sandbox rejected a gitdir pointer");
  }
  return resolved;
}

function readCommonDir(gitDir: string): string {
  const commondirPath = join(gitDir, "commondir");
  if (!existsSync(commondirPath)) return gitDir;
  const raw = readFileSync(commondirPath, "utf8").trim();
  if (raw.length === 0) return gitDir;
  return isAbsolute(raw) ? normalize(raw) : resolve(gitDir, raw);
}

function assertSafeGitDirectory(label: string, path: string): string {
  if (!isAbsolute(path)) {
    throw new AcpSandboxLaunchError(`ACP sandbox rejected a relative ${label}`);
  }
  if (!existsSync(path)) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox ${label} does not exist: ${path}`,
    );
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox rejected a symlinked ${label}: ${path}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox ${label} is not a directory: ${path}`,
    );
  }
  const real = realpathSync(path);
  if (real === "/" || real === "/etc" || real === "/root") {
    throw new AcpSandboxLaunchError(`ACP sandbox rejected ${label} at ${real}`);
  }
  return real;
}

function assertNoEmbeddedCredentials(configPath: string): void {
  if (!existsSync(configPath)) return;
  const text = readFileSync(configPath, "utf8");
  if (EMBEDDED_CREDENTIAL_URL.test(text) || EMBEDDED_TOKEN_URL.test(text)) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox refused to expose embedded git credentials in ${configPath}`,
    );
  }
}

function gitBindPaths(cwd: string): string[] {
  const gitPath = join(cwd, ".git");
  if (!existsSync(gitPath)) return [];
  const gitStat = lstatSync(gitPath);
  let gitDir: string;
  if (gitStat.isDirectory()) {
    gitDir = gitPath;
  } else if (gitStat.isFile()) {
    gitDir = readGitdirPointer(cwd, readFileSync(gitPath, "utf8"));
  } else {
    throw new AcpSandboxLaunchError(
      "ACP sandbox rejected an unusual .git path",
    );
  }
  const resolvedGitDir = assertSafeGitDirectory("git-dir", gitDir);
  const commonDir = assertSafeGitDirectory(
    "git-common-dir",
    readCommonDir(resolvedGitDir),
  );
  assertNoEmbeddedCredentials(join(resolvedGitDir, "config"));
  assertNoEmbeddedCredentials(join(commonDir, "config"));
  return [...new Set([resolvedGitDir, commonDir])];
}

function sanitizeNoneEnv(
  env: Record<string, string | undefined>,
  hostHome: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(definedEnv(env))) {
    if (REMOVED_ENV_KEYS.has(key)) continue;
    if (REMOVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    next[key] = value;
  }
  next.HOME = hostHome;
  next.GIT_TERMINAL_PROMPT = "0";
  next.GIT_CONFIG_NOSYSTEM = "1";
  next.GIT_CONFIG_GLOBAL = "/dev/null";
  next.GIT_AUTHOR_NAME = GIT_AUTHOR_NAME;
  next.GIT_AUTHOR_EMAIL = GIT_AUTHOR_EMAIL;
  next.GIT_COMMITTER_NAME = GIT_AUTHOR_NAME;
  next.GIT_COMMITTER_EMAIL = GIT_AUTHOR_EMAIL;
  const apiKey = env.XAI_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    next.XAI_API_KEY = apiKey;
  }
  return next;
}

export function planAcpAgentLaunch(
  input: PlanAcpAgentLaunchInput,
): AcpAgentLaunchPlan {
  const cwd = resolve(input.cwd);
  if (input.deliveryAuthority === "git") {
    return {
      command: input.command,
      args: [...input.args],
      cwd,
      env: { ...input.env },
      bwrap: false,
      rwBinds: [],
      roBinds: [],
      binds: [],
    };
  }

  const platform = input.platform ?? process.platform;
  if (platform !== "linux") {
    throw new AcpSandboxLaunchError(
      "ACP sandbox requires Linux bwrap for deliveryAuthority none",
    );
  }
  const bwrapPath = input.bwrapPath ?? ACP_SANDBOX_BWRAP_PATH;
  if (!existsSync(bwrapPath) || !statSync(bwrapPath).isFile()) {
    throw new AcpSandboxLaunchError(
      `ACP sandbox helper missing or not a file: ${bwrapPath}`,
    );
  }
  const hostHome = resolve(input.hostHome ?? homedir());
  canonicalAcpSandboxDirectory(cwd, hostHome);
  if (input.executionEnvironmentCwd === undefined) {
    throw new AcpSandboxLaunchError("ACP sandbox rejected execution cwd");
  }
  const environmentCwd = canonicalAcpSandboxDirectory(
    input.executionEnvironmentCwd,
    hostHome,
  );
  const managedExecution = cwd !== environmentCwd;
  if (managedExecution) {
    if (input.workTogetherWorkCwdRoot === undefined) {
      throw new AcpSandboxLaunchError("ACP sandbox rejected execution cwd");
    }
    const managedRoot = canonicalAcpSandboxDirectory(
      input.workTogetherWorkCwdRoot,
      hostHome,
    );
    if (!isInsideAcpSandboxRoot(managedRoot, cwd) || managedRoot === cwd) {
      throw new AcpSandboxLaunchError("ACP sandbox rejected execution cwd");
    }
  }
  const env = sanitizeNoneEnv(input.env, hostHome);
  const executable = resolveAgentExecutable(input.command, env);
  const grokHome = join(hostHome, ".grok");
  const rwBinds = new Set<string>([
    cwd,
    ...(managedExecution ? [] : gitBindPaths(cwd)),
  ]);
  if (existsSync(grokHome) && isInsideAcpSandboxRoot(grokHome, executable)) {
    rwBinds.add(grokHome);
  }
  const roBinds = new Set<string>();
  if (
    isInsideAcpSandboxRoot(hostHome, executable) ||
    isInsideAcpSandboxRoot("/tmp", executable)
  ) {
    roBinds.add(executable);
  }
  for (const path of input.runtimeRoBinds ?? []) {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
      throw new AcpSandboxLaunchError(
        `ACP sandbox MCP runtime path is missing: ${resolved}`,
      );
    }
    if (resolved === hostHome || resolved === "/" || resolved === "/home") {
      throw new AcpSandboxLaunchError(
        `ACP sandbox refused a too-broad MCP runtime bind: ${resolved}`,
      );
    }
    roBinds.add(realpathSync(resolved));
  }
  for (const path of rwBinds) {
    roBinds.delete(path);
  }

  const maskedRoots = [...new Set([hostHome, "/tmp", "/run"])].map((root) =>
    resolve(root),
  );
  const dirs = new Set<string>();
  for (const bind of [...rwBinds, ...roBinds]) {
    for (const dir of acpSandboxAncestorDirectories(bind, maskedRoots)) {
      dirs.add(dir);
    }
  }

  const bwrapArgs = acpSandboxBaseArgs(maskedRoots);
  for (const dir of [...dirs].sort(
    (left, right) => left.length - right.length,
  )) {
    bwrapArgs.push("--dir", dir);
  }
  for (const bind of [...roBinds].sort()) {
    bwrapArgs.push("--ro-bind", bind, bind);
  }
  for (const bind of [...rwBinds].sort()) {
    bwrapArgs.push(
      "--bind",
      bind === cwd ? (input.cwdBindSource ?? bind) : bind,
      bind,
    );
  }
  bwrapArgs.push("--chdir", cwd, "--", executable, ...input.args);

  const rwBindList = [...rwBinds].sort();
  const roBindList = [...roBinds].sort();
  return {
    command: bwrapPath,
    args: bwrapArgs,
    cwd: sep,
    env,
    bwrap: true,
    rwBinds: rwBindList,
    roBinds: roBindList,
    binds: [...new Set([...rwBindList, ...roBindList])].sort(),
  };
}
