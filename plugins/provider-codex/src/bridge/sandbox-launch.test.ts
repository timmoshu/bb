import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexSandboxLaunchError,
  planCodexAppServerLaunch,
} from "./sandbox-launch.js";
import {
  canonicalCodexSandboxDirectory,
  codexSandboxAncestorDirectories,
  codexSandboxBaseArgs,
  isInsideCodexSandboxRoot,
} from "./sandbox-kernel.js";

const roots: string[] = [];

function root(label: string): string {
  const value = mkdtempSync(join(tmpdir(), `bb-codex-${label}-`));
  roots.push(value);
  return value;
}

function authHome(parent: string): string {
  const value = join(parent, "codex-auth-source");
  mkdirSync(value);
  writeFileSync(join(value, "auth.json"), "{}", { mode: 0o600 });
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("Codex sandbox kernel", () => {
  it("canonicalizes no-symlink directories and rejects path-prefix escapes", () => {
    const parent = root("kernel");
    const hostHome = join(parent, "home");
    const work = join(hostHome, "work");
    const link = join(parent, "linked");
    mkdirSync(work, { recursive: true });
    symlinkSync(hostHome, link);

    expect(canonicalCodexSandboxDirectory(work, hostHome)).toBe(work);
    expect(isInsideCodexSandboxRoot(hostHome, work)).toBe(true);
    expect(isInsideCodexSandboxRoot(hostHome, `${hostHome}-escape`)).toBe(
      false,
    );
    expect(() =>
      canonicalCodexSandboxDirectory(join(link, "work"), hostHome),
    ).toThrow(CodexSandboxLaunchError);
  });

  it("builds masked ancestors and the provider-neutral bwrap base", () => {
    expect(
      codexSandboxAncestorDirectories("/home/test/a/b/file", ["/home/test"]),
    ).toEqual(["/home/test/a", "/home/test/a/b"]);
    expect(codexSandboxBaseArgs(["/home/test", "/tmp", "/run"])).toEqual([
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
      "--tmpfs",
      "/home/test",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
    ]);
  });
});

describe("Codex app-server sandbox launch", () => {
  it("leaves ordinary Git-authority app-server launch unchanged", () => {
    const plan = planCodexAppServerLaunch({
      deliveryAuthority: "git",
      command: "codex",
      args: ["app-server"],
      cwd: "/workspace",
      env: { HOME: "/home/test", GH_TOKEN: "ordinary-keeps-owner-policy" },
    });
    expect(plan).toMatchObject({
      command: "codex",
      args: ["app-server"],
      cwd: "/workspace",
      env: { HOME: "/home/test", GH_TOKEN: "ordinary-keeps-owner-policy" },
      bwrap: false,
    });
  });

  it("fails closed without exact managed cwd authority or regular auth.json", () => {
    const parent = root("invalid");
    const environment = join(parent, "environment");
    const managed = join(parent, "managed");
    const work = join(managed, "work");
    mkdirSync(environment);
    mkdirSync(work, { recursive: true });
    const base = {
      deliveryAuthority: "none" as const,
      command: process.execPath,
      allowProcessExecPath: true,
      args: [],
      cwd: work,
      env: { PATH: process.env.PATH, CODEX_HOME: join(parent, "missing-auth") },
      executionEnvironmentCwd: environment,
      platform: "linux" as const,
      bwrapPath: "/usr/bin/bwrap",
    };
    expect(() => planCodexAppServerLaunch(base)).toThrow(
      CodexSandboxLaunchError,
    );
    authHome(parent);
    expect(() =>
      planCodexAppServerLaunch({
        ...base,
        env: { ...base.env, CODEX_HOME: join(parent, "codex-auth-source") },
      }),
    ).toThrow("rejected execution cwd");
  });

  it("uses fd-pinned exact cwd, strips identity, and removes isolated auth root", () => {
    const parent = root("plan");
    const environment = join(parent, "environment");
    const managed = join(parent, "managed");
    const work = join(managed, "work");
    mkdirSync(environment);
    mkdirSync(work, { recursive: true });
    const sourceAuth = authHome(parent);
    const plan = planCodexAppServerLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      allowProcessExecPath: true,
      args: [],
      cwd: work,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: sourceAuth,
        GH_TOKEN: "hidden",
        OPENAI_API_KEY: "hidden",
        AWS_SECRET_ACCESS_KEY: "hidden",
        DOCKER_HOST: "hidden",
        DATABASE_URL: "hidden",
        CI_JOB_TOKEN: "hidden",
      },
      executionEnvironmentCwd: environment,
      workTogetherWorkCwdRoot: managed,
      cwdBindSource: "/proc/self/fd/3",
      platform: "linux",
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.bwrap).toBe(true);
    expect(plan.args).toContain("/proc/self/fd/3");
    expect(plan.args).toContain(work);
    expect(plan.env).toMatchObject({
      HOME: "/run/bb-codex-home",
      CODEX_HOME: "/run/bb-codex-auth",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.env.OPENAI_API_KEY).toBeUndefined();
    expect(plan.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(plan.env.DOCKER_HOST).toBeUndefined();
    expect(plan.env.DATABASE_URL).toBeUndefined();
    expect(plan.env.CI_JOB_TOKEN).toBeUndefined();
    expect(plan.args).toContain("--file");
    expect(plan.args).toContain("/run/bb-codex-auth/auth.json");
    expect(fstatSync(plan.inheritedAuthFd!).isFile()).toBe(true);
    const authFd = plan.inheritedAuthFd!;
    plan.cleanup();
    expect(() => fstatSync(authFd)).toThrow();
    expect(() =>
      planCodexAppServerLaunch({
        deliveryAuthority: "none",
        command: "/bin/sh",
        args: [],
        cwd: work,
        env: { PATH: process.env.PATH, CODEX_HOME: sourceAuth },
        executionEnvironmentCwd: environment,
        workTogetherWorkCwdRoot: managed,
        platform: "linux",
        bwrapPath: "/usr/bin/bwrap",
      }),
    ).toThrow("cannot admit executable closure");
  });

  it("rejects external Git metadata and credential-capable local config", () => {
    const parent = root("git-config");
    const environment = join(parent, "environment");
    const managed = join(parent, "managed");
    const work = join(managed, "work");
    mkdirSync(environment);
    mkdirSync(work, { recursive: true });
    const input = {
      deliveryAuthority: "none" as const,
      command: process.execPath,
      allowProcessExecPath: true,
      args: [],
      cwd: work,
      env: { PATH: process.env.PATH, CODEX_HOME: authHome(parent) },
      executionEnvironmentCwd: environment,
      workTogetherWorkCwdRoot: managed,
      platform: "linux" as const,
      bwrapPath: "/usr/bin/bwrap",
    };
    symlinkSync(join(parent, "missing-git"), join(work, ".git"));
    expect(() => planCodexAppServerLaunch(input)).toThrow(
      "requires Git metadata inside the admitted cwd",
    );
    rmSync(join(work, ".git"));
    writeFileSync(join(work, ".git"), "gitdir: /home/test/.ssh\n");
    expect(() => planCodexAppServerLaunch(input)).toThrow(
      "requires Git metadata inside the admitted cwd",
    );
    rmSync(join(work, ".git"));
    mkdirSync(join(work, ".git"));
    writeFileSync(
      join(work, ".git", "config"),
      '[credential]\n\thelper = "!printf password=secret"\n',
    );
    expect(() => planCodexAppServerLaunch(input)).toThrow(
      "credential-capable Git config",
    );
    writeFileSync(
      join(work, ".git", "config"),
      "[core]\n\taskPass = /tmp/helper\n",
    );
    expect(() => planCodexAppServerLaunch(input)).toThrow(
      "credential-capable Git config",
    );
    writeFileSync(join(work, ".git", "config"), "[core]\n\tbare = false\n");
    symlinkSync("missing-commondir", join(work, ".git", "commondir"));
    expect(() => planCodexAppServerLaunch(input)).toThrow(
      "external common Git metadata",
    );
    rmSync(join(work, ".git", "commondir"));
    mkdirSync(join(work, ".git", "hooks"));
    writeFileSync(join(work, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    expect(() => planCodexAppServerLaunch(input)).toThrow("active Git hooks");
  });

  it("admits one validated standalone Codex release closure under masked home", () => {
    const parent = root("standalone");
    const managed = join(parent, "managed");
    const work = join(managed, "work");
    const environment = join(parent, "environment");
    const release = join(
      parent,
      ".codex",
      "packages",
      "standalone",
      "releases",
      "test-release",
    );
    const executable = join(release, "bin", "codex");
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(environment);
    writeFileSync(executable, "fixture");
    writeFileSync(join(parent, ".codex", "auth.json"), "{}");
    const plan = planCodexAppServerLaunch({
      deliveryAuthority: "none",
      command: executable,
      args: ["app-server"],
      cwd: work,
      env: { PATH: "/usr/bin", CODEX_HOME: join(parent, ".codex") },
      executionEnvironmentCwd: environment,
      workTogetherWorkCwdRoot: managed,
      hostHome: parent,
      platform: "linux",
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.args).toContain(release);
    expect(
      plan.args.some(
        (arg, index) =>
          arg === "--ro-bind" &&
          plan.args[index + 1] === join(parent, ".codex"),
      ),
    ).toBe(false);
    plan.cleanup();
  });
});
