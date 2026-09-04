import { spawn, spawnSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpAgentConnection } from "./bridge/agent-connection.js";
import { resolveAcpMcpHelperRuntime } from "./mcp-helper-runtime.js";
import { planAcpAgentLaunch } from "./sandbox-launch.js";

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

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")}`);
  }
  return result.stdout;
}

function runPlan(plan: ReturnType<typeof planAcpAgentLaunch>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runPlanAsync(
  plan: ReturnType<typeof planAcpAgentLaunch>,
  timeoutMs = 25_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runPlanAsync timed out: ${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function listen401(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="git"');
    res.end("auth required");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("listen failed");
  }
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const PROBE = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const report = {
  home: process.env.HOME,
  sshAuthSock: process.env.SSH_AUTH_SOCK ?? null,
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  gitAskpass: process.env.GIT_ASKPASS ?? null,
  dockerHost: process.env.DOCKER_HOST ?? null,
  xai: process.env.XAI_API_KEY ?? null,
  author: process.env.GIT_AUTHOR_NAME ?? null,
  sshExists: fs.existsSync(process.env.HOME + "/.ssh/id_test"),
  ghExists: fs.existsSync(process.env.HOME + "/.config/gh/hosts.yml"),
  credsExists: fs.existsSync(process.env.HOME + "/.git-credentials"),
  dockerSock: fs.existsSync("/run/docker.sock"),
  sibling: null,
  wrote: null,
  gitStatus: null,
};
try {
  report.sibling = fs.readFileSync(process.argv[2], "utf8");
} catch {
  report.sibling = "ENOENT";
}
fs.writeFileSync("inside.txt", "from-sandbox\\n");
report.wrote = fs.readFileSync("inside.txt", "utf8");
report.gitStatus = spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).stdout;
fs.writeFileSync("probe-out.json", JSON.stringify(report));
`;

describe("ACP none bwrap enforcement", { timeout: 30_000 }, () => {
  it("is available on this host", () => {
    const version = spawnSync("/usr/bin/bwrap", ["--version"], {
      encoding: "utf8",
    });
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/bubblewrap/);
  });

  it("allows cwd writes, git, and XAI while hiding host identity", () => {
    const root = scratchDir("wt-bwrap-room-");
    const hostHome = join(root, "home");
    const cwd = join(hostHome, "work", "room");
    const sibling = join(hostHome, "work", "other", "secret.txt");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    mkdirSync(join(hostHome, ".config", "gh"), { recursive: true });
    mkdirSync(join(hostHome, "work", "other"), { recursive: true });
    writeFileSync(join(hostHome, ".ssh", "id_test"), "SECRET_SSH");
    writeFileSync(join(hostHome, ".config", "gh", "hosts.yml"), "SECRET_GH");
    writeFileSync(join(hostHome, ".git-credentials"), "SECRET_CREDS");
    writeFileSync(sibling, "SIBLING_SECRET");
    git(cwd, ["init"]);
    writeFileSync(join(cwd, "seed"), "seed\n");
    git(cwd, ["add", "seed"]);
    git(cwd, ["commit", "-m", "seed"]);
    writeFileSync(join(cwd, "probe.cjs"), PROBE);

    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      args: [join(cwd, "probe.cjs"), sibling],
      cwd,
      executionEnvironmentCwd: cwd,
      env: {
        PATH: process.env.PATH,
        HOME: hostHome,
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
        GH_TOKEN: "must-not-leak",
        GITHUB_TOKEN: "must-not-leak-either",
        GIT_ASKPASS: "/usr/bin/false",
        DOCKER_HOST: "unix:///run/docker.sock",
        XAI_API_KEY: "xai-sandbox",
      },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome,
    });
    const ran = runPlan(plan);
    expect(ran.status, ran.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(cwd, "probe-out.json"), "utf8"),
    ) as {
      sshAuthSock: string | null;
      ghToken: string | null;
      githubToken: string | null;
      gitAskpass: string | null;
      dockerHost: string | null;
      xai: string | null;
      author: string | null;
      sshExists: boolean;
      ghExists: boolean;
      credsExists: boolean;
      dockerSock: boolean;
      sibling: string;
      wrote: string;
      gitStatus: string;
    };
    expect(report.wrote).toBe("from-sandbox\n");
    expect(readFileSync(join(cwd, "inside.txt"), "utf8")).toBe(
      "from-sandbox\n",
    );
    expect(report.xai).toBe("xai-sandbox");
    expect(report.author).toBe("WT Room Agent");
    expect(report.sshAuthSock).toBeNull();
    expect(report.ghToken).toBeNull();
    expect(report.githubToken).toBeNull();
    expect(report.gitAskpass).toBeNull();
    expect(report.dockerHost).toBeNull();
    expect(report.sshExists).toBe(false);
    expect(report.ghExists).toBe(false);
    expect(report.credsExists).toBe(false);
    expect(report.dockerSock).toBe(false);
    expect(report.sibling).toBe("ENOENT");
    expect(report.gitStatus).toContain("inside.txt");
  });

  it("commits locally and fails authenticated git push variants", async () => {
    const remote = await listen401();
    try {
      const root = scratchDir("wt-bwrap-push-");
      const hostHome = join(root, "home");
      const cwd = join(hostHome, "work", "room");
      mkdirSync(cwd, { recursive: true });
      git(cwd, ["init"]);
      writeFileSync(join(cwd, "seed"), "seed\n");
      git(cwd, ["add", "seed"]);
      git(cwd, ["commit", "-m", "seed"]);
      git(cwd, ["remote", "add", "origin", remote.url]);
      writeFileSync(
        join(cwd, "push.cjs"),
        `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 4000 });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}
fs.writeFileSync("next.txt", "next\\n");
const add = run("git", ["add", "next.txt"]);
const commit = run("git", ["commit", "-m", "sandbox"]);
const pushes = [
  run("git", ["push", "origin", "HEAD"]),
  run("git", ["push", "--no-verify", "origin", "HEAD"]),
  run("git", ["-c", "core.hooksPath=/tmp", "push", "origin", "HEAD"]),
  run("/usr/bin/git", ["push", "origin", "HEAD"]),
];
const gh = run("gh", ["pr", "create"]);
fs.writeFileSync("push-out.json", JSON.stringify({ add, commit, pushes, gh }));
`,
      );
      const plan = planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: [join(cwd, "push.cjs")],
        cwd,
        executionEnvironmentCwd: cwd,
        env: {
          PATH: process.env.PATH,
          HOME: hostHome,
          GH_TOKEN: "host-gh",
          GITHUB_TOKEN: "host-github",
          GIT_TERMINAL_PROMPT: "0",
        },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome,
      });
      const ran = runPlan(plan);
      expect(ran.status, ran.stderr).toBe(0);
      const out = JSON.parse(
        readFileSync(join(cwd, "push-out.json"), "utf8"),
      ) as {
        add: { status: number };
        commit: { status: number };
        pushes: Array<{ status: number | null }>;
        gh: { status: number | null };
      };
      expect(out.add.status).toBe(0);
      expect(out.commit.status).toBe(0);
      expect(readFileSync(join(cwd, "next.txt"), "utf8")).toBe("next\n");
      expect(git(cwd, ["log", "-1", "--pretty=%s"]).trim()).toBe("sandbox");
      expect(out.pushes.every((push) => push.status !== 0)).toBe(true);
      expect(out.gh.status).not.toBe(0);
    } finally {
      await remote.close();
    }
  }, 30_000);

  it("fails createAcpAgentConnection before spawn when none sandbox cannot launch", () => {
    expect(() =>
      createAcpAgentConnection({
        command: process.execPath,
        args: ["-e", "0"],
        cwd: "/no/such/wt-sandbox-cwd",
        env: { PATH: process.env.PATH },
        deliveryAuthority: "none",
        recordThreadId: null,
        onNotification() {},
        onRequest() {},
        onExit() {},
      }),
    ).toThrow("ACP sandbox rejected execution cwd");
  });

  it("spawns a none session through bwrap and a git session without wrapping", async () => {
    const cwd = scratchDir("wt-bwrap-conn-");
    const noneExit = await new Promise<{ code: number | null }>((resolve) => {
      createAcpAgentConnection({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: process.env.PATH },
        deliveryAuthority: "none",
        recordThreadId: null,
        onNotification() {},
        onRequest() {},
        onExit: (info) => resolve({ code: info.code }),
      });
    });
    expect(noneExit.code).toBe(0);

    const gitPlan = planAcpAgentLaunch({
      deliveryAuthority: "git",
      command: process.execPath,
      args: ["-e", "0"],
      cwd,
      executionEnvironmentCwd: cwd,
      env: { PATH: process.env.PATH },
    });
    expect(gitPlan.command).toBe(process.execPath);
    expect(gitPlan.bwrap).toBe(false);
  });

  it("masks the live host HOME inside the child and does not read host secrets", () => {
    const cwd = scratchDir("wt-bwrap-livehome-");
    writeFileSync(
      join(cwd, "live.cjs"),
      `
const fs = require("node:fs");
const home = process.env.HOME;
const report = {
  ssh: fs.existsSync(home + "/.ssh"),
  gh: fs.existsSync(home + "/.config/gh/hosts.yml"),
  grokUnbound: fs.existsSync(home + "/.grok/bin/grok"),
};
fs.writeFileSync("live-out.json", JSON.stringify(report));
`,
    );
    const plan = planAcpAgentLaunch({
      deliveryAuthority: "none",
      command: process.execPath,
      args: [join(cwd, "live.cjs")],
      cwd,
      executionEnvironmentCwd: cwd,
      env: { PATH: process.env.PATH, HOME: homedir() },
      bwrapPath: "/usr/bin/bwrap",
      platform: "linux",
      hostHome: homedir(),
    });
    expect(plan.args.includes("--tmpfs") && plan.args.includes(homedir())).toBe(
      true,
    );
    const ran = runPlan(plan);
    expect(ran.status, ran.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(cwd, "live-out.json"), "utf8"),
    ) as {
      ssh: boolean;
      gh: boolean;
      grokUnbound: boolean;
    };
    expect(report.ssh).toBe(false);
    expect(report.gh).toBe(false);
    expect(report.grokUnbound).toBe(false);
  });

  it("launches the MCP helper inside none bwrap and calls a dynamic tool over 127.0.0.1", async () => {
    const token = "s2b-token";
    const tcpLines: unknown[] = [];
    const toolServer = createNetServer((socket: Socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let parsed: { kind?: string; token?: string; tool?: string };
        try {
          parsed = JSON.parse(buffer.slice(0, newline)) as typeof parsed;
        } catch (error) {
          tcpLines.push({ parseError: String(error), raw: buffer });
          socket.end(`${JSON.stringify({ ok: false, error: "parse" })}\n`);
          return;
        }
        tcpLines.push(parsed);
        if (parsed.token !== token) {
          socket.end(`${JSON.stringify({ ok: false, error: "bad token" })}\n`);
          return;
        }
        if (parsed.kind === "initialized") {
          socket.end(
            `${JSON.stringify({ ok: true, content: "", images: [] })}\n`,
          );
          return;
        }
        if (parsed.kind === "toolCall" && parsed.tool === "checkpoint") {
          socket.end(
            `${JSON.stringify({
              ok: true,
              content: "pong",
              contentBlocks: [{ type: "text", text: "pong" }],
              images: [],
            })}\n`,
          );
          return;
        }
        socket.end(`${JSON.stringify({ ok: false, error: "unexpected" })}\n`);
      });
    });
    await new Promise<void>((resolve) =>
      toolServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = toolServer.address();
      if (!address || typeof address === "string") {
        throw new Error("tool bridge did not bind");
      }
      const helper = resolveAcpMcpHelperRuntime({
        execPath: process.execPath,
        execArgv: ["--conditions=source", "--import", "tsx"],
        bridgeModulePath: fileURLToPath(
          new URL("./bridge/bridge.ts", import.meta.url),
        ),
      });
      const root = scratchDir("wt-bwrap-mcp-");
      const hostHome = join(root, "home");
      const cwd = join(hostHome, "room");
      mkdirSync(join(hostHome, ".ssh"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(hostHome, ".ssh", "id_test"), "HOST_SECRET_MARKER\n");
      writeFileSync(
        join(cwd, "helper.json"),
        JSON.stringify({
          command: helper.command,
          args: helper.args,
          env: {
            BB_ACP_DYNAMIC_TOOL_HOST: "127.0.0.1",
            BB_ACP_DYNAMIC_TOOL_PORT: String(address.port),
            BB_ACP_DYNAMIC_TOOL_TOKEN: token,
            BB_ACP_DYNAMIC_TOOL_THREAD_ID: "thread-s2b",
            BB_ACP_DYNAMIC_TOOLS: JSON.stringify([
              {
                name: "checkpoint",
                description: "Record a checkpoint.",
                inputSchema: { type: "object", properties: {} },
              },
            ]),
          },
        }),
      );
      writeFileSync(
        join(cwd, "launch-mcp.cjs"),
        `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const helper = JSON.parse(fs.readFileSync("helper.json", "utf8"));
const env = { ...process.env, ...helper.env };
const child = spawn(helper.command, helper.args, { env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\\n");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "s2b", version: "0" } },
});
const deadline = Date.now() + 20000;
const waitFor = (needle) => new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (stdout.includes(needle)) {
      clearInterval(timer);
      resolve(undefined);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error("timeout waiting for " + needle + " stderr=" + stderr + " stdout=" + stdout));
    }
  }, 50);
});
waitFor('"serverInfo"').then(() => new Promise((resolve) => setTimeout(resolve, 250))).then(() => {
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "checkpoint", arguments: {} },
  });
  return waitFor('"pong"');
}).then(() => {
  let ssh = "ENOENT";
  try { ssh = fs.readFileSync(process.env.HOME + "/.ssh/id_test", "utf8"); } catch (error) {
    ssh = error.code || "ENOENT";
  }
  fs.writeFileSync("mcp-out.json", JSON.stringify({ stdout, stderr, ssh }));
  child.kill();
  process.exit(0);
}).catch((error) => {
  fs.writeFileSync("mcp-out.json", JSON.stringify({ error: String(error), stdout, stderr }));
  child.kill();
  process.exit(1);
});
`,
      );
      const plan = planAcpAgentLaunch({
        deliveryAuthority: "none",
        command: process.execPath,
        args: [join(cwd, "launch-mcp.cjs")],
        cwd,
        executionEnvironmentCwd: cwd,
        env: { PATH: process.env.PATH, HOME: hostHome },
        bwrapPath: "/usr/bin/bwrap",
        platform: "linux",
        hostHome,
        runtimeRoBinds: helper.roBinds,
      });
      expect(
        plan.roBinds.some((bind) => bind.endsWith("wt-delivery-authority")),
      ).toBe(true);
      const ran = await runPlanAsync(plan);
      const outPath = join(cwd, "mcp-out.json");
      const dumped = existsSync(outPath)
        ? readFileSync(outPath, "utf8")
        : "missing mcp-out.json";
      expect(
        ran.status,
        `${ran.stderr}\n${ran.stdout}\n${dumped}\ntcp=${JSON.stringify(tcpLines)}`,
      ).toBe(0);
      const out = JSON.parse(
        readFileSync(join(cwd, "mcp-out.json"), "utf8"),
      ) as {
        stdout: string;
        ssh: string;
      };
      expect(out.stdout).toContain("pong");
      expect(out.stdout).toContain("bb-bridge");
      expect(out.ssh).not.toContain("HOST_SECRET_MARKER");
    } finally {
      await new Promise<void>((resolve, reject) =>
        toolServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
