import { describe, expect, it } from "vitest";

import {
  CELL_TOOL_SECRET_ENV,
  COORDINATOR_ORIGIN_ENV,
  loadCellToolConfig,
  parseCoordinatorUrl,
} from "./config.js";

const SECRET = "s".repeat(32);

function expectSanitizedThrow(
  run: () => unknown,
  leaked: string[],
): Error {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
  for (const value of leaked) {
    expect(serialized).not.toContain(value);
  }
  return error;
}

describe("Work Together coordinator URL policy", () => {
  it("accepts an HTTPS DNS origin", () => {
    expect(parseCoordinatorUrl("https://work.vespyn.com")).toBe(
      "https://work.vespyn.com",
    );
  });

  it("accepts loopback HTTP with an explicit port", () => {
    expect(parseCoordinatorUrl("http://127.0.0.1:4173")).toBe(
      "http://127.0.0.1:4173",
    );
  });

  it("rejects credentials, paths, queries, fragments, and non-loopback HTTP", () => {
    expect(() => parseCoordinatorUrl("https://user:pass@work.vespyn.com")).toThrow();
    expect(() => parseCoordinatorUrl("https://work.vespyn.com/cell-tools")).toThrow();
    expect(() => parseCoordinatorUrl("https://work.vespyn.com?secret=x")).toThrow();
    expect(() => parseCoordinatorUrl("https://work.vespyn.com#frag")).toThrow();
    expect(() => parseCoordinatorUrl("http://example.com:4173")).toThrow();
    expect(() => parseCoordinatorUrl("http://127.0.0.1")).toThrow();
    expect(() => parseCoordinatorUrl("https://127.0.0.1")).toThrow();
  });
});

describe("cell tool env validation", () => {
  it("loads a valid HTTPS origin and 32-byte secret", () => {
    expect(
      loadCellToolConfig({
        [COORDINATOR_ORIGIN_ENV]: "https://work.vespyn.com",
        [CELL_TOOL_SECRET_ENV]: SECRET,
      }),
    ).toEqual({
      coordinatorOrigin: "https://work.vespyn.com",
      secret: SECRET,
    });
  });

  it("accepts a 32-byte multi-byte secret and rejects a 31-byte secret", () => {
    const thirtyTwoBytes = "é".repeat(16);
    expect(new TextEncoder().encode(thirtyTwoBytes).byteLength).toBe(32);
    expect(
      loadCellToolConfig({
        [COORDINATOR_ORIGIN_ENV]: "https://work.vespyn.com",
        [CELL_TOOL_SECRET_ENV]: thirtyTwoBytes,
      }).secret,
    ).toBe(thirtyTwoBytes);

    const thirtyOneBytes = "a".repeat(31);
    expect(() =>
      loadCellToolConfig({
        [COORDINATOR_ORIGIN_ENV]: "https://work.vespyn.com",
        [CELL_TOOL_SECRET_ENV]: thirtyOneBytes,
      }),
    ).toThrow(/at least 32 bytes/);
  });

  it("throws a sanitized error when the origin is missing", () => {
    const error = expectSanitizedThrow(
      () =>
        loadCellToolConfig({
          [CELL_TOOL_SECRET_ENV]: SECRET,
        }),
      [SECRET],
    );
    expect(error.message).toMatch(/coordinator origin is not configured/);
  });

  it("throws a sanitized error when the origin contains credentials", () => {
    const origin = "https://user:hunter2@evil.example.com/leak?token=abc";
    const error = expectSanitizedThrow(
      () =>
        loadCellToolConfig({
          [COORDINATOR_ORIGIN_ENV]: origin,
          [CELL_TOOL_SECRET_ENV]: SECRET,
        }),
      [origin, "hunter2", "evil.example.com", "token=abc", SECRET],
    );
    expect(error.message).toMatch(/origin|Coordinator URL/i);
  });

  it("throws a sanitized error when the secret is missing", () => {
    const origin = "https://work.vespyn.com";
    const error = expectSanitizedThrow(
      () =>
        loadCellToolConfig({
          [COORDINATOR_ORIGIN_ENV]: origin,
        }),
      [origin],
    );
    expect(error.message).toMatch(/secret is not configured/);
  });

  it("throws a sanitized error when the secret is too short", () => {
    const origin = "https://work.vespyn.com";
    const secret = "short-secret-value-not-32";
    const error = expectSanitizedThrow(
      () =>
        loadCellToolConfig({
          [COORDINATOR_ORIGIN_ENV]: origin,
          [CELL_TOOL_SECRET_ENV]: secret,
        }),
      [origin, secret],
    );
    expect(error.message).toMatch(/at least 32 bytes/);
  });
});
