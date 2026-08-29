/**
 * Live provider sessions are not hot-mutated. When configure() grows the
 * selected tool set after the session was constructed, the next new turn
 * either reconstructs via thread/resume or fails closed — never silently
 * omits the selected tools and lets the agent invent a fallback.
 */

export const STALE_PROVIDER_SESSION_CATALOG_CODE =
  "stale_provider_session_catalog" as const;

export type StaleProviderSessionCatalogReason =
  | "active-turn"
  | "open-background-work";

export type SelectedDynamicToolReconcile =
  | { action: "keep" }
  | { action: "reconstruct"; missing: string[] }
  | {
      action: "fail";
      missing: string[];
      reason: StaleProviderSessionCatalogReason;
    };

export class StaleProviderSessionCatalogError extends Error {
  readonly code = STALE_PROVIDER_SESSION_CATALOG_CODE;

  constructor(args: {
    missing: readonly string[];
    reason?: StaleProviderSessionCatalogReason;
  }) {
    super(staleProviderSessionCatalogMessage(args));
    this.name = "StaleProviderSessionCatalogError";
  }
}

export function missingSelectedDynamicToolNames(args: {
  hostedToolNames: readonly string[];
  selectedToolNames: readonly string[];
}): string[] {
  const hosted = new Set(args.hostedToolNames);
  const missing: string[] = [];
  for (const name of args.selectedToolNames) {
    if (!hosted.has(name) && !missing.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

export function reconcileSelectedDynamicTools(args: {
  hasActiveTurn: boolean;
  hasOpenBackgroundWork: boolean;
  hostedToolNames: readonly string[];
  selectedToolNames: readonly string[];
}): SelectedDynamicToolReconcile {
  const missing = missingSelectedDynamicToolNames({
    hostedToolNames: args.hostedToolNames,
    selectedToolNames: args.selectedToolNames,
  });
  if (missing.length === 0) {
    return { action: "keep" };
  }
  if (args.hasActiveTurn) {
    return { action: "fail", missing, reason: "active-turn" };
  }
  if (args.hasOpenBackgroundWork) {
    return { action: "fail", missing, reason: "open-background-work" };
  }
  return { action: "reconstruct", missing };
}

export function staleProviderSessionCatalogMessage(args: {
  missing: readonly string[];
  reason?: StaleProviderSessionCatalogReason;
}): string {
  const tools = args.missing.join(", ");
  const suffix =
    args.reason === "active-turn"
      ? " It cannot be reconstructed while a turn is active."
      : args.reason === "open-background-work"
        ? " It cannot be reconstructed while background work is still open."
        : " Reconstruct the session (new thread start, or resume after daemon / provider / environment restart) before this turn.";
  return `Provider session catalog is stale: selected tools ${tools} are not on the live session.${suffix}`;
}
