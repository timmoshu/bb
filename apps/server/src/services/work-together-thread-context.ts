import {
  applyWorkTogetherThreadContext,
  getWorkTogetherThreadContext,
} from "@bb/db";
import { ApiError } from "../errors.js";
import type { DbQueryConnection } from "@bb/db";

export function assertCoordinationContextApplied(
  db: DbQueryConnection,
  threadId: string,
): void {
  const row = getWorkTogetherThreadContext(db, threadId);
  if (row !== undefined && row.digest === null) {
    throw new ApiError(409, "context_not_applied", "Context not applied");
  }
}

export function assertCoordinationAcpCwd(
  environmentPath: string,
  launchSpecCwd: string | undefined,
): void {
  if (launchSpecCwd !== undefined && launchSpecCwd !== environmentPath) {
    throw new ApiError(409, "coordination_cwd_conflict", "Coordination cwd conflict");
  }
}

export { applyWorkTogetherThreadContext, getWorkTogetherThreadContext };
