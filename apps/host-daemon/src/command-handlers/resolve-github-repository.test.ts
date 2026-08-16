import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  githubNwoFromRemote,
  parseGithubFullName,
  resolveGithubRepository,
} from "./resolve-github-repository.js";

async function writeOrigin(repoPath: string, originUrl: string): Promise<void> {
  const gitDir = join(repoPath, ".git");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(gitDir, "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n`,
  );
}

describe("githubNwoFromRemote", () => {
  it("collapses GitHub SSH and HTTPS remotes to owner/repo", () => {
    expect(githubNwoFromRemote("git@github.com:Timmoshu/cc-sandbox.git")).toBe(
      "timmoshu/cc-sandbox",
    );
    expect(
      githubNwoFromRemote("https://github.com/timmoshu/cc-sandbox"),
    ).toBe("timmoshu/cc-sandbox");
    expect(
      githubNwoFromRemote("ssh://git@github.com/timmoshu/cc-sandbox.git"),
    ).toBe("timmoshu/cc-sandbox");
    expect(githubNwoFromRemote("https://gitlab.com/timmoshu/cc-sandbox")).toBe(
      null,
    );
  });
});

describe("resolveGithubRepository", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-resolve-gh-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an unresolved identity when the GitHub id cannot be named", async () => {
    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [],
      dataDir: join(root, "data"),
      home: join(root, "home"),
      resolveFullName: async () => null,
    });
    expect(result).toEqual({ identityResolved: false, repository: null });
  });

  it("matches a known BB project path for the cc-sandbox GitHub id", async () => {
    const sourcePath = join(root, "srv", "cc-sandbox");
    await writeOrigin(
      sourcePath,
      "https://github.com/timmoshu/cc-sandbox.git",
    );

    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [sourcePath],
      dataDir: join(root, "data"),
      home: join(root, "home"),
      resolveFullName: async () => parseGithubFullName("timmoshu/cc-sandbox"),
    });

    expect(result.identityResolved).toBe(true);
    expect(result.repository).toEqual({
      path: sourcePath,
      name: "cc-sandbox",
      originUrl: "https://github.com/timmoshu/cc-sandbox.git",
    });
  });

  it("prefers an existing dataDir checkout when known paths miss", async () => {
    const dataDir = join(root, "data");
    const checkout = join(dataDir, "checkouts", "cc-sandbox");
    await writeOrigin(checkout, "git@github.com:timmoshu/cc-sandbox.git");
    await writeOrigin(
      join(root, "other", "unrelated"),
      "https://github.com/example/other.git",
    );

    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [join(root, "missing")],
      dataDir,
      home: join(root, "home"),
      resolveFullName: async () => "timmoshu/cc-sandbox",
    });

    expect(result.repository?.path).toBe(checkout);
    expect(result.repository?.originUrl).toBe(
      "git@github.com:timmoshu/cc-sandbox.git",
    );
  });

  it("matches a home-directory checkout when earlier tiers miss", async () => {
    const home = join(root, "home");
    const discovered = join(home, "projects", "cc-sandbox");
    await writeOrigin(discovered, "https://github.com/timmoshu/cc-sandbox.git");

    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [],
      dataDir: join(root, "data"),
      home,
      env: { PATH: "/nonexistent" },
      resolveFullName: async () => "timmoshu/cc-sandbox",
    });

    expect(result).toEqual({
      identityResolved: true,
      repository: {
        path: discovered,
        name: "cc-sandbox",
        originUrl: "https://github.com/timmoshu/cc-sandbox.git",
      },
    });
  });

  it("picks the lexicographically smallest path when one tier has two matches", async () => {
    const alpha = join(root, "srv", "alpha");
    const beta = join(root, "srv", "beta");
    await writeOrigin(alpha, "https://github.com/timmoshu/cc-sandbox.git");
    await writeOrigin(beta, "https://github.com/timmoshu/cc-sandbox.git");

    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [beta, alpha],
      dataDir: join(root, "data"),
      home: join(root, "home"),
      resolveFullName: async () => "timmoshu/cc-sandbox",
    });

    expect(result.repository?.path).toBe(alpha);
  });

  it("confirms a miss when the host has no matching checkout", async () => {
    const result = await resolveGithubRepository({
      providerRepositoryId: "1268425814",
      knownPaths: [],
      dataDir: join(root, "data"),
      home: join(root, "home"),
      env: { PATH: "/nonexistent" },
      resolveFullName: async () => "timmoshu/cc-sandbox",
      discover: async () => ({ repos: [], truncated: false }),
    });
    expect(result).toEqual({ identityResolved: true, repository: null });
  });
});
