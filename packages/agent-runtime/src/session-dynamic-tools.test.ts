import { describe, expect, it } from "vitest";
import {
  missingSelectedDynamicToolNames,
  reconcileSelectedDynamicTools,
  StaleProviderSessionCatalogError,
  staleProviderSessionCatalogMessage,
} from "./session-dynamic-tools.js";

const PRE_FILESPACE = [
  "update_environment_directory",
  "goal_document_propose",
  "workstream_completeness",
  "room_result_publish",
  "room_subagent_spawn",
] as const;

const FILESPACE = ["filespace_list", "filespace_get", "filespace_put"] as const;

describe("missingSelectedDynamicToolNames", () => {
  it("returns selected names that are absent from the hosted catalog", () => {
    expect(
      missingSelectedDynamicToolNames({
        hostedToolNames: PRE_FILESPACE,
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual([...FILESPACE]);
  });

  it("returns nothing when the hosted catalog already has the selected set", () => {
    expect(
      missingSelectedDynamicToolNames({
        hostedToolNames: [...PRE_FILESPACE, ...FILESPACE],
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual([]);
  });

  it("ignores extra hosted tools that are no longer selected", () => {
    expect(
      missingSelectedDynamicToolNames({
        hostedToolNames: [...PRE_FILESPACE, ...FILESPACE],
        selectedToolNames: PRE_FILESPACE,
      }),
    ).toEqual([]);
  });

  it("dedupes missing names", () => {
    expect(
      missingSelectedDynamicToolNames({
        hostedToolNames: [],
        selectedToolNames: ["filespace_list", "filespace_list"],
      }),
    ).toEqual(["filespace_list"]);
  });
});

describe("reconcileSelectedDynamicTools", () => {
  it("keeps a live session whose catalog already has the selected set", () => {
    expect(
      reconcileSelectedDynamicTools({
        hasActiveTurn: false,
        hasOpenBackgroundWork: false,
        hostedToolNames: [...PRE_FILESPACE, ...FILESPACE],
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual({ action: "keep" });
  });

  it("reconstructs an idle session when the selected set has grown", () => {
    expect(
      reconcileSelectedDynamicTools({
        hasActiveTurn: false,
        hasOpenBackgroundWork: false,
        hostedToolNames: PRE_FILESPACE,
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual({
      action: "reconstruct",
      missing: [...FILESPACE],
    });
  });

  it("fails closed while a turn is active", () => {
    expect(
      reconcileSelectedDynamicTools({
        hasActiveTurn: true,
        hasOpenBackgroundWork: false,
        hostedToolNames: PRE_FILESPACE,
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual({
      action: "fail",
      missing: [...FILESPACE],
      reason: "active-turn",
    });
  });

  it("fails closed while background work is still open", () => {
    expect(
      reconcileSelectedDynamicTools({
        hasActiveTurn: false,
        hasOpenBackgroundWork: true,
        hostedToolNames: PRE_FILESPACE,
        selectedToolNames: [...PRE_FILESPACE, ...FILESPACE],
      }),
    ).toEqual({
      action: "fail",
      missing: [...FILESPACE],
      reason: "open-background-work",
    });
  });
});

describe("StaleProviderSessionCatalogError", () => {
  it("names the missing tools and the reconstruct boundary", () => {
    const error = new StaleProviderSessionCatalogError({
      missing: FILESPACE,
    });
    expect(error.code).toBe("stale_provider_session_catalog");
    expect(error.message).toBe(
      staleProviderSessionCatalogMessage({ missing: FILESPACE }),
    );
    expect(error.message).toContain("filespace_list, filespace_get, filespace_put");
    expect(error.message).toContain("resume after daemon");
  });

  it("says why reconstruct is unsafe", () => {
    expect(
      staleProviderSessionCatalogMessage({
        missing: ["filespace_list"],
        reason: "active-turn",
      }),
    ).toContain("while a turn is active");
    expect(
      staleProviderSessionCatalogMessage({
        missing: ["filespace_list"],
        reason: "open-background-work",
      }),
    ).toContain("while background work is still open");
  });
});
