const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SECRET_MIN_UTF8_BYTES = 32;

export const COORDINATOR_ORIGIN_ENV = "BB_WORK_TOGETHER_COORDINATOR_ORIGIN";
export const CELL_TOOL_SECRET_ENV = "BB_WORK_TOGETHER_CELL_TOOL_SECRET";

export type CellToolConfig = {
  coordinatorOrigin: string;
  secret: string;
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isDnsHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u
    .test(hostname);
}

export function parseCoordinatorUrl(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Coordinator URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Coordinator URL must be a valid URL");
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error(
      "Coordinator URL must be an origin with no userinfo, path, query, or fragment",
    );
  }
  if (url.protocol === "https:") {
    if (!isDnsHostname(url.hostname)) {
      throw new Error("HTTPS coordinator URL must use a DNS hostname");
    }
    return url.origin;
  }
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error("HTTP coordinator URL must use loopback");
    }
    if (url.port === "") {
      throw new Error("HTTP loopback coordinator URL requires an explicit port");
    }
    return url.origin;
  }
  throw new Error("Coordinator URL must be https or loopback http");
}

function readEnvValue(
  env: NodeJS.Dict<string>,
  name: string,
): string | undefined {
  const value = env[name];
  return typeof value === "string" ? value : undefined;
}

export function loadCellToolConfig(
  env: NodeJS.Dict<string> = process.env,
): CellToolConfig {
  const rawOrigin = readEnvValue(env, COORDINATOR_ORIGIN_ENV);
  if (rawOrigin === undefined || rawOrigin.trim() === "") {
    throw new Error("Work Together coordinator origin is not configured");
  }

  let coordinatorOrigin: string;
  try {
    coordinatorOrigin = parseCoordinatorUrl(rawOrigin);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Work Together coordinator origin is invalid",
    );
  }

  const secret = readEnvValue(env, CELL_TOOL_SECRET_ENV);
  if (secret === undefined || secret.length === 0) {
    throw new Error("Work Together cell tool secret is not configured");
  }
  if (utf8ByteLength(secret) < SECRET_MIN_UTF8_BYTES) {
    throw new Error("Work Together cell tool secret must be at least 32 bytes");
  }

  return { coordinatorOrigin, secret };
}
