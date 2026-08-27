import {
  getProject,
  getWorkTogetherRoomResourceReservationByEnvironment,
  type DbConnection,
} from "@bb/db";

export type WorkTogetherRoomThreadCreateScope = {
  readonly parentThreadId: string;
  readonly projectId: string;
  readonly environmentId: string;
};

/**
 * Read the three Room child-create facts from a public HTTP body.
 * Missing parent or a non-reuse environment fail closed. Extra environment
 * keys are ignored: create-thread validation strips them the same way.
 */
export function readWorkTogetherRoomThreadCreateScope(
  body: unknown,
): WorkTogetherRoomThreadCreateScope | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const parentThreadId = body.parentThreadId;
  const projectId = body.projectId;
  if (
    typeof parentThreadId !== "string" ||
    parentThreadId.length === 0 ||
    typeof projectId !== "string" ||
    projectId.length === 0
  ) {
    return null;
  }
  const environment = body.environment;
  if (!isPlainObject(environment)) {
    return null;
  }
  const environmentId = environment.environmentId;
  if (
    environment.type !== "reuse" ||
    typeof environmentId !== "string" ||
    environmentId.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    parentThreadId,
    projectId,
    environmentId,
  });
}

/**
 * True only when the body is a Room child spawn onto a current reservation
 * on this cell: parent is that Room's primary thread, environment is exact
 * reuse of the reserved environment, and projectId is the Room project.
 *
 * The reservation row is the scope source of truth. A missing project row
 * does not deny a matching spawn (provision may still be writing it). If the
 * project exists, it must be standard — the same closed kind other WT HTTP
 * operations require.
 */
export function isWorkTogetherRoomScopedThreadCreate(
  db: DbConnection,
  body: unknown,
): boolean {
  const scope = readWorkTogetherRoomThreadCreateScope(body);
  if (scope === null) {
    return false;
  }

  let reservation;
  try {
    reservation = getWorkTogetherRoomResourceReservationByEnvironment(db, {
      environmentId: scope.environmentId,
      projectId: scope.projectId,
    });
  } catch {
    return false;
  }
  if (
    reservation === null ||
    reservation.primaryThreadId !== scope.parentThreadId ||
    reservation.projectId !== scope.projectId ||
    reservation.environmentId !== scope.environmentId
  ) {
    return false;
  }

  const project = getProject(db, reservation.projectId);
  return project === null || project.kind === "standard";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
