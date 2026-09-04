import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCodexHome } from "../codex-home.js";
import {
  CodexSandboxLaunchError,
  canonicalCodexSandboxDirectory,
  codexSandboxAncestorDirectories,
  codexSandboxBaseArgs,
  isInsideCodexSandboxRoot,
} from "./sandbox-kernel.js";

export { CodexSandboxLaunchError } from "./sandbox-kernel.js";

type CodexDeliveryAuthority = "git" | "none";

export const CODEX_SANDBOX_BWRAP_PATH = "/usr/bin/bwrap";
const SANDBOX_HOME = "/run/bb-codex-home";
const SANDBOX_CODEX_HOME = "/run/bb-codex-auth";
const SANDBOX_CODEX_AUTH = `${SANDBOX_CODEX_HOME}/auth.json`;
const GIT_AUTHOR_NAME = "WT Room Agent";
const GIT_AUTHOR_EMAIL = "wt-room@local.invalid";

const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);
const EMBEDDED_CREDENTIAL_URL = /(?:https?|git):\/\/[^/\s:]+:[^/\s@]+@/i;
const EMBEDDED_TOKEN_URL = /(?:https?|git):\/\/(?!git@)[^/\s@]+@/i;
const DANGEROUS_GIT_CONFIG =
  /^\s*\[(?:credential|http|url|include|includeIf|protocol)\b|^\s*(?:helper|extraHeader|insteadOf|sshCommand|askPass|hooksPath|gitProxy|fsmonitor|receivepack|uploadpack)\s*=/im;

export interface CodexAppServerLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  bwrap: boolean;
  inheritedAuthFd?: number;
  cleanup(): void;
}

export interface PlanCodexAppServerLaunchInput {
  deliveryAuthority: CodexDeliveryAuthority;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  executionEnvironmentCwd?: string;
  workTogetherWorkCwdRoot?: string;
  hostHome?: string;
  bwrapPath?: string;
  platform?: NodeJS.Platform;
  cwdBindSource?: string;
  cwdValidationSource?: string;
  allowProcessExecPath?: boolean;
}

function lstatIfPresent(target: string) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function resolveExecutable(
  command: string,
  env: Record<string, string | undefined>,
): string {
  if (command.includes("/") || isAbsolute(command)) {
    const target = resolve(command);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new CodexSandboxLaunchError(
        "Codex sandbox cannot resolve app-server executable",
      );
    }
    return realpathSync(target);
  }
  for (const entry of (env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(entry, command);
    if (existsSync(candidate) && statSync(candidate).isFile())
      return realpathSync(candidate);
  }
  throw new CodexSandboxLaunchError(
    "Codex sandbox cannot resolve app-server executable",
  );
}

function codexExecutableClosure(
  executable: string,
  hostHome: string,
  allowProcessExecPath: boolean,
): string | null {
  if (executable === realpathSync(process.execPath)) {
    if (!allowProcessExecPath) {
      throw new CodexSandboxLaunchError(
        "Codex sandbox cannot admit executable closure",
      );
    }
    return executable;
  }
  if (!isInsideCodexSandboxRoot(hostHome, executable)) {
    throw new CodexSandboxLaunchError(
      "Codex sandbox cannot admit executable closure",
    );
  }
  const standaloneReleases = join(
    hostHome,
    ".codex",
    "packages",
    "standalone",
    "releases",
  );
  if (isInsideCodexSandboxRoot(standaloneReleases, executable)) {
    const release = relative(standaloneReleases, executable).split(sep)[0];
    if (!release)
      throw new CodexSandboxLaunchError("Codex sandbox rejected executable");
    const root = join(standaloneReleases, release);
    if (!statSync(root).isDirectory() || realpathSync(root) !== root) {
      throw new CodexSandboxLaunchError(
        "Codex sandbox rejected executable closure",
      );
    }
    return root;
  }
  let current = dirname(executable);
  while (current !== hostHome && isInsideCodexSandboxRoot(hostHome, current)) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (
          JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }
        ).name;
        if (name === "@openai/codex") return realpathSync(current);
      } catch {
        throw new CodexSandboxLaunchError(
          "Codex sandbox rejected executable manifest",
        );
      }
    }
    current = dirname(current);
  }
  throw new CodexSandboxLaunchError(
    "Codex sandbox cannot admit executable closure",
  );
}

function assertSafeLocalGit(cwd: string): void {
  const dotGit = join(cwd, ".git");
  const info = lstatIfPresent(dotGit);
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CodexSandboxLaunchError(
      "Codex sandbox requires Git metadata inside the admitted cwd",
    );
  }
  const configPath = join(dotGit, "config");
  if (lstatIfPresent(join(dotGit, "commondir")) !== undefined) {
    throw new CodexSandboxLaunchError(
      "Codex sandbox rejected external common Git metadata",
    );
  }
  const hooksPath = join(dotGit, "hooks");
  const hooks = lstatIfPresent(hooksPath);
  if (hooks !== undefined) {
    if (!hooks.isDirectory() || hooks.isSymbolicLink()) {
      throw new CodexSandboxLaunchError("Codex sandbox rejected Git hooks");
    }
    for (const name of readdirSync(hooksPath)) {
      if (name.endsWith(".sample")) continue;
      if (lstatIfPresent(join(hooksPath, name)) !== undefined) {
        throw new CodexSandboxLaunchError(
          "Codex sandbox rejected active Git hooks",
        );
      }
    }
  }
  const configInfo = lstatIfPresent(configPath);
  if (configInfo === undefined) return;
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) {
    throw new CodexSandboxLaunchError("Codex sandbox rejected Git config");
  }
  const value = readFileSync(configPath, "utf8");
  if (
    EMBEDDED_CREDENTIAL_URL.test(value) ||
    EMBEDDED_TOKEN_URL.test(value) ||
    DANGEROUS_GIT_CONFIG.test(value)
  ) {
    throw new CodexSandboxLaunchError(
      "Codex sandbox rejected credential-capable Git config",
    );
  }
}

function sanitizeEnv(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_ENV_KEYS.has(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: SANDBOX_HOME,
    CODEX_HOME: SANDBOX_CODEX_HOME,
    TMPDIR: "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
  };
}

function openCodexAuth(
  hostHome: string,
  env: Record<string, string | undefined>,
): number {
  const sourceHome = resolveCodexHome(hostHome, env);
  const sourceAuth = join(sourceHome, "auth.json");
  let fd: number | undefined;
  try {
    fd = openSync(sourceAuth, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (
      !fstatSync(fd).isFile() ||
      realpathSync(`/proc/self/fd/${fd}`) !== sourceAuth
    )
      throw new Error("invalid");
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new CodexSandboxLaunchError(
      "Codex sandbox requires a regular auth.json",
    );
  }
}

export function planCodexAppServerLaunch(
  input: PlanCodexAppServerLaunchInput,
): CodexAppServerLaunchPlan {
  if (input.deliveryAuthority === "git") {
    return {
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      env: { ...input.env },
      bwrap: false,
      cleanup() {},
    };
  }
  if ((input.platform ?? process.platform) !== "linux") {
    throw new CodexSandboxLaunchError("Codex sandbox requires Linux bwrap");
  }
  const bwrapPath = input.bwrapPath ?? CODEX_SANDBOX_BWRAP_PATH;
  if (!existsSync(bwrapPath) || !statSync(bwrapPath).isFile()) {
    throw new CodexSandboxLaunchError("Codex sandbox helper is unavailable");
  }
  const hostHome = resolve(input.hostHome ?? homedir());
  const cwd = canonicalCodexSandboxDirectory(input.cwd, hostHome);
  if (input.executionEnvironmentCwd === undefined) {
    throw new CodexSandboxLaunchError("Codex sandbox rejected execution cwd");
  }
  const environmentCwd = canonicalCodexSandboxDirectory(
    input.executionEnvironmentCwd,
    hostHome,
  );
  if (cwd !== environmentCwd) {
    if (input.workTogetherWorkCwdRoot === undefined) {
      throw new CodexSandboxLaunchError("Codex sandbox rejected execution cwd");
    }
    const managedRoot = canonicalCodexSandboxDirectory(
      input.workTogetherWorkCwdRoot,
      hostHome,
    );
    if (cwd === managedRoot || !isInsideCodexSandboxRoot(managedRoot, cwd)) {
      throw new CodexSandboxLaunchError("Codex sandbox rejected execution cwd");
    }
  }

  const executable = resolveExecutable(input.command, input.env);
  const executableClosure = codexExecutableClosure(
    executable,
    hostHome,
    input.allowProcessExecPath === true,
  );
  assertSafeLocalGit(input.cwdValidationSource ?? cwd);
  const authFd = openCodexAuth(hostHome, input.env);
  try {
    const maskedRoots = [hostHome, "/tmp", "/run"].map((root) => resolve(root));
    const rwBinds = new Set([cwd]);
    const roBinds = new Set<string>();
    if (executableClosure !== null) roBinds.add(executableClosure);
    for (const arg of input.args) {
      if (!isAbsolute(arg) || !existsSync(arg)) continue;
      const real = realpathSync(arg);
      if (maskedRoots.some((root) => isInsideCodexSandboxRoot(root, real))) {
        roBinds.add(real);
      }
    }
    for (const item of rwBinds) roBinds.delete(item);
    const dirs = new Set([SANDBOX_HOME, SANDBOX_CODEX_HOME]);
    for (const item of [...rwBinds, ...roBinds]) {
      for (const dir of codexSandboxAncestorDirectories(item, maskedRoots)) {
        dirs.add(dir);
      }
    }
    const args = codexSandboxBaseArgs(maskedRoots);
    for (const dir of [...dirs].sort((a, b) => a.length - b.length))
      args.push("--dir", dir);
    for (const item of [...roBinds].sort()) args.push("--ro-bind", item, item);
    for (const item of [...rwBinds].sort()) {
      args.push(
        "--bind",
        item === cwd ? (input.cwdBindSource ?? item) : item,
        item,
      );
    }
    args.push("--file", "4", SANDBOX_CODEX_AUTH);
    args.push("--chdir", cwd, "--", executable, ...input.args);
    return {
      command: bwrapPath,
      args,
      cwd: sep,
      env: sanitizeEnv(input.env),
      bwrap: true,
      inheritedAuthFd: authFd,
      cleanup() {
        closeSync(authFd);
      },
    };
  } catch (error) {
    closeSync(authFd);
    throw error;
  }
}
