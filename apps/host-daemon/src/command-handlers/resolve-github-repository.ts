import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import type {
  ResolveGithubRepositoryResult,
  ResolvedGithubRepository,
} from "@bb/host-daemon-contract";
import { inspectProjectPath } from "./project.js";
import { discoverRepos, readOriginUrl } from "./discover-repos.js";

const execFileAsync = promisify(execFile);
const GITHUB_FULL_NAME = /^([^/\s]+)\/([^/\s]+)$/u;
const GITHUB_API_TIMEOUT_MS = 8_000;

export type ResolveGithubFullName = (
  providerRepositoryId: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | null>;

export interface ResolveGithubRepositoryArgs {
  providerRepositoryId: string;
  knownPaths: readonly string[];
  dataDir: string;
  /** Injectable for tests. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  resolveFullName?: ResolveGithubFullName;
  discover?: typeof discoverRepos;
}

const UNRESOLVED_IDENTITY = Object.freeze({
  identityResolved: false,
  repository: null,
});

const CONFIRMED_MISS = Object.freeze({
  identityResolved: true,
  repository: null,
});

/**
 * Collapse `git@github.com:o/r.git` and `https://github.com/o/r` to
 * `owner/repo` (lowercase). Non-GitHub remotes do not match a GitHub id.
 */
export function githubNwoFromRemote(url: string): string | null {
  const withoutGit = url.trim().replace(/\.git$/u, "").replace(/\/+$/u, "");
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/iu.exec(withoutGit);
  if (ssh?.[1] && ssh[2]) {
    return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  }
  const https =
    /^(?:https?:\/\/|ssh:\/\/git@)github\.com\/([^/]+)\/([^/]+)$/iu.exec(
      withoutGit,
    );
  if (https?.[1] && https[2]) {
    return `${https[1]}/${https[2]}`.toLowerCase();
  }
  return null;
}

export function parseGithubFullName(raw: string): string | null {
  const match = GITHUB_FULL_NAME.exec(raw.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

async function resolveFullNameViaGh(
  providerRepositoryId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `/repositories/${providerRepositoryId}`, "--jq", ".full_name"],
      { env, encoding: "utf8", timeout: GITHUB_API_TIMEOUT_MS },
    );
    return parseGithubFullName(stdout);
  } catch {
    return null;
  }
}

async function resolveFullNameViaApi(
  providerRepositoryId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repositories/${providerRepositoryId}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "bb-host-daemon",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("full_name" in body) ||
      typeof body.full_name !== "string"
    ) {
      return null;
    }
    return parseGithubFullName(body.full_name);
  } catch {
    return null;
  }
}

export async function defaultResolveGithubFullName(
  providerRepositoryId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return (
    (await resolveFullNameViaGh(providerRepositoryId, env)) ??
    (await resolveFullNameViaApi(providerRepositoryId))
  );
}

function usableAbsolutePath(value: string): string | null {
  if (
    !isAbsolute(value) ||
    value === "/" ||
    normalize(value) !== value ||
    value !== value.trim()
  ) {
    return null;
  }
  return value;
}

function uniqueAbsolutePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of paths) {
    const path = usableAbsolutePath(value);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

async function listExistingCheckoutPaths(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "checkouts");
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.map((name) => join(root, name)).sort();
}

async function repositoryAtPath(
  repoPath: string,
): Promise<ResolvedGithubRepository | null> {
  const fromConfig = await readOriginUrl(repoPath);
  if (fromConfig !== null) {
    return {
      path: repoPath,
      name: basename(repoPath),
      originUrl: fromConfig,
    };
  }
  try {
    const inspected = await inspectProjectPath(repoPath);
    if (inspected.gitRemoteUrl === null) return null;
    return {
      path: inspected.path,
      name: basename(inspected.path),
      originUrl: inspected.gitRemoteUrl,
    };
  } catch {
    return null;
  }
}

function pickLexicographicallyFirst(
  matches: ResolvedGithubRepository[],
): ResolvedGithubRepository | null {
  if (matches.length === 0) return null;
  matches.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return matches[0] ?? null;
}

async function firstMatchingRepository(
  paths: readonly string[],
  nwo: string,
): Promise<ResolvedGithubRepository | null> {
  const matches: ResolvedGithubRepository[] = [];
  for (const repoPath of paths) {
    const repository = await repositoryAtPath(repoPath);
    if (repository === null) continue;
    if (githubNwoFromRemote(repository.originUrl) !== nwo) continue;
    matches.push(repository);
  }
  return pickLexicographicallyFirst(matches);
}

/**
 * Map a numeric GitHub repository id to a checkout that already exists on
 * this host. Never invents a path: it only inspects known BB project paths,
 * existing `{dataDir}/checkouts/*` directories, then a home-directory walk.
 */
export async function resolveGithubRepository(
  args: ResolveGithubRepositoryArgs,
): Promise<ResolveGithubRepositoryResult> {
  const env = args.env ?? process.env;
  const resolveFullName = args.resolveFullName ?? defaultResolveGithubFullName;
  const nwo = await resolveFullName(args.providerRepositoryId, env);
  if (nwo === null) return UNRESOLVED_IDENTITY;

  const knownMatch = await firstMatchingRepository(
    uniqueAbsolutePaths(args.knownPaths),
    nwo,
  );
  if (knownMatch !== null) {
    return { identityResolved: true, repository: knownMatch };
  }

  const checkoutMatch = await firstMatchingRepository(
    await listExistingCheckoutPaths(args.dataDir),
    nwo,
  );
  if (checkoutMatch !== null) {
    return { identityResolved: true, repository: checkoutMatch };
  }

  const discovered = await (args.discover ?? discoverRepos)({
    maxDepth: 5,
    sinceDays: 3650,
    limit: 200,
    includeAgentHistory: false,
    home: args.home ?? homedir(),
    env,
  });
  const discoveredMatches = discovered.repos.flatMap((repo) => {
    if (repo.originUrl === null) return [];
    if (githubNwoFromRemote(repo.originUrl) !== nwo) return [];
    return [
      {
        path: repo.path,
        name: repo.name,
        originUrl: repo.originUrl,
      } satisfies ResolvedGithubRepository,
    ];
  });
  const discoveredMatch = pickLexicographicallyFirst(discoveredMatches);
  if (discoveredMatch !== null) {
    return { identityResolved: true, repository: discoveredMatch };
  }
  return CONFIRMED_MISS;
}
