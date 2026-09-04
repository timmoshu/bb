import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSandboxLaunchError, planAcpAgentLaunch } from "./sandbox-launch.js";

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relativePath, body] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

describe("planAcpAgentLaunch", () => {
  it("passes git sessions through unchanged", () => {
    const env = {
      PATH: "/usr/bin",
      GH_TOKEN: "host-token",
      HOME: "/home/host",
    };
    const plan = planAcpAgentLaunch({
      deliveryAuthority: "git",
      command: "grok",
      args: ["acp"],
      cwd: "/tmp/workspace",
      env,
    });
    expect(plan).toEqual({
      command: "grok",
      args: ["acp"],
      cwd: "/tmp/workspace",
      env,
      bwrap: false,
      rwBinds: [],
      roBinds: [],
      binds: [],
    });
  });

  it("enforces managed-root authority and uses a pinned cwd bind source", () => {
    const root = scratchDir("wt-sandbox-authority-");
    const hostHome = join(root, "home");
    const environmentCwd = join(hostHome, "environment");
    const managedRoot = join(hostHome, "state", "work-cwds");
    const cwd = join(managedRoot, "work-1");
    mkdirSync(environmentCwd, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      args: ["-e", "0"],
      cwd,
      executionEnvironmentCwd: environmentCwd,
      workTogetherWorkCwdRoot: managedRoot,
      cwdBindSource: "/proc/self/fd/3",
      env: { PATH: process.env.PATH },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome,
    });
    expect(plan.cwd).toBe("/");
    expect(plan.rwBinds).toEqual([cwd]);
    expect(
      plan.args.some(
        (arg, index) =>
          arg === "--bind" &&
          plan.args[index + 1] === "/proc/self/fd/3" &&
          plan.args[index + 2] === cwd,
      ),
    ).toBe(true);
    const outside = join(hostHome, "outside");
    mkdirSync(outside);
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd: outside,
        executionEnvironmentCwd: environmentCwd,
        workTogetherWorkCwdRoot: managedRoot,
        env: { PATH: process.env.PATH },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome,
      }),
    ).toThrow("ACP sandbox rejected execution cwd");
    for (const forbidden of ["/", hostHome]) {
      expect(() =>
        planAcpAgentLaunch({
          deliveryAuthority: "none",
          command: process.execPath,
          args: ["-e", "0"],
          cwd: forbidden,
          executionEnvironmentCwd: forbidden,
          env: { PATH: process.env.PATH },
          bwrapPath: "/usr/bin/bwrap",
          platform: "linux",
          hostHome,
        }),
      ).toThrow("ACP sandbox rejected execution cwd");
    }
  });

  it("fails closed when bwrap is missing or not a file", () => {
    const cwd = scratchDir("wt-sandbox-cwd-");
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: "/usr/bin" },
        bwrapPath: join(cwd, "missing-bwrap"),
        platform: "linux",
        hostHome: cwd,
      }),
    ).toThrow(AcpSandboxLaunchError);

    writeFileSync(join(cwd, "not-bwrap-dir"), "");
    mkdirSync(join(cwd, "bwrap-dir"));
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: "/usr/bin" },
        bwrapPath: join(cwd, "bwrap-dir"),
        platform: "linux",
        hostHome: cwd,
      }),
    ).toThrow(/not a file/);
  });

  it("fails closed off linux", () => {
    const cwd = scratchDir("wt-sandbox-darwin-");
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: [],
        cwd,
        executionEnvironmentCwd: cwd,
        env: {},
        platform: "darwin",
        hostHome: cwd,
      }),
    ).toThrow(/Linux bwrap/);
  });

  it("builds a none launch that masks home, strips credentials, and keeps XAI", () => {
    const root = scratchDir("wt-sandbox-plan-");
    const hostHome = join(root, "home");
    const cwd = join(hostHome, "work", "room");
    mkdirSync(cwd, { recursive: true });
    writeTree(hostHome, {
      ".ssh/id_test": "SECRET_SSH",
      ".config/gh/hosts.yml": "SECRET_GH",
      ".git-credentials": "SECRET_CREDS",
    });
    const grokBin = join(hostHome, ".grok", "bin", "grok");
    mkdirSync(dirname(grokBin), { recursive: true });
    writeFileSync(grokBin, "#!/bin/sh\n");
    chmodSync(grokBin, 0o755);

    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: grokBin,
      args: ["acp"],
      cwd,
      executionEnvironmentCwd: cwd,
      env: {
        PATH: "/usr/bin",
        HOME: hostHome,
        SSH_AUTH_SOCK: "/run/ssh-agent.sock",
        GH_TOKEN: "secret-gh",
        GITHUB_TOKEN: "secret-github",
        GIT_ASKPASS: "/usr/bin/askpass",
        AWS_SECRET_ACCESS_KEY: "aws",
        DOCKER_HOST: "unix:///run/docker.sock",
        XAI_API_KEY: "xai-live",
        LANG: "C",
      },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome,
    });

    expect(plan.bwrap).toBe(true);
    expect(plan.command).toBe("/usr/bin/bwrap");
    expect(plan.args.slice(0, 11)).toEqual([
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
    ]);
    expect(plan.args).toContain("--tmpfs");
    expect(plan.args).toContain(hostHome);
    expect(plan.args).toContain("/tmp");
    expect(plan.args).toContain("/run");
    expect(plan.binds).toContain(cwd);
    expect(plan.binds).toContain(join(hostHome, ".grok"));
    expect(plan.rwBinds).toContain(cwd);
    expect(plan.rwBinds).toContain(join(hostHome, ".grok"));
    expect(
      plan.args.slice(
        plan.args.indexOf("--chdir"),
        plan.args.indexOf("--chdir") + 2,
      ),
    ).toEqual(["--chdir", cwd]);
    expect(plan.roBinds).not.toContain(join(hostHome, ".grok"));
    expect(plan.binds).not.toContain(join(hostHome, ".ssh"));
    expect(plan.binds).not.toContain(join(hostHome, ".config"));
    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.env.GITHUB_TOKEN).toBeUndefined();
    expect(plan.env.GIT_ASKPASS).toBeUndefined();
    expect(plan.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(plan.env.DOCKER_HOST).toBeUndefined();
    expect(plan.env.XAI_API_KEY).toBe("xai-live");
    expect(plan.env.HOME).toBe(hostHome);
    expect(plan.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(plan.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(plan.env.GIT_AUTHOR_NAME).toBe("WT Room Agent");
    expect(plan.env.GIT_AUTHOR_EMAIL).toBe("wt-room@local.invalid");
    const dash = plan.args.lastIndexOf("--");
    expect(plan.args.slice(dash)).toEqual(["--", grokBin, "acp"]);
  });

  it("binds linked worktree git-dir and common-dir without the sibling checkout", () => {
    const root = scratchDir("wt-sandbox-worktree-");
    const hostHome = join(root, "home");
    const main = join(hostHome, "src", "main");
    const room = join(hostHome, "worktrees", "room");
    mkdirSync(main, { recursive: true });
    git(main, ["init"]);
    writeFileSync(join(main, "README"), "main\n");
    git(main, ["add", "README"]);
    git(main, ["commit", "-m", "init"]);
    mkdirSync(dirname(room), { recursive: true });
    git(main, ["worktree", "add", room]);

    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      args: ["-e", "0"],
      cwd: room,
      executionEnvironmentCwd: room,
      env: { PATH: process.env.PATH },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome,
    });

    expect(plan.binds).toContain(room);
    expect(plan.binds.some((bind) => bind.includes(`${main}/.git`))).toBe(true);
    expect(plan.binds).not.toContain(main);
  });

  it("rejects embedded credential remotes instead of exposing them", () => {
    const cwd = scratchDir("wt-sandbox-creds-");
    git(cwd, ["init"]);
    writeFileSync(join(cwd, "file"), "x\n");
    git(cwd, ["add", "file"]);
    git(cwd, ["commit", "-m", "init"]);
    git(cwd, [
      "remote",
      "add",
      "origin",
      "https://user:token@github.com/example/repo.git",
    ]);
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: process.env.PATH },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome: dirname(cwd),
      }),
    ).toThrow(/embedded git credentials/);
  });

  it("ro-binds MCP runtime paths separately from cwd and fails if they are missing", () => {
    const root = scratchDir("wt-sandbox-runtime-");
    const hostHome = join(root, "home");
    const cwd = join(hostHome, "room");
    const runtime = join(root, "release");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "bridge.js"), "export {}\n");
    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      args: ["-e", "0"],
      cwd,
      executionEnvironmentCwd: cwd,
      env: { PATH: process.env.PATH },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome,
      runtimeRoBinds: [runtime],
    });
    expect(plan.roBinds).toContain(runtime);
    expect(plan.rwBinds).toContain(cwd);
    expect(plan.rwBinds).not.toContain(runtime);
    expect(
      plan.args.some(
        (arg, index) =>
          arg === "--ro-bind" &&
          plan.args[index + 1] === runtime &&
          plan.args[index + 2] === runtime,
      ),
    ).toBe(true);
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: process.env.PATH },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome,
        runtimeRoBinds: [join(root, "missing-release")],
      }),
    ).toThrow(/MCP runtime path is missing/);
  });

  it("rejects a symlinked cwd component before spawn", () => {
    const root = scratchDir("wt-sandbox-symlink-");
    const real = join(root, "real");
    const linked = join(root, "linked");
    mkdirSync(join(real, "work"), { recursive: true });
    symlinkSync(real, linked);
    expect(() =>
      planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: ["-e", "0"],
        cwd: join(linked, "work"),
        env: { PATH: process.env.PATH },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome: root,
      }),
    ).toThrow("ACP sandbox rejected execution cwd");
  });
});
