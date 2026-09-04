import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { workTogetherThreadContexts } from "../schema.js";

export type WorkTogetherThreadContextRow =
  typeof workTogetherThreadContexts.$inferSelect;

export function getWorkTogetherThreadContext(
  db: DbQueryConnection,
  threadId: string,
): WorkTogetherThreadContextRow | undefined {
  return db
    .select()
    .from(workTogetherThreadContexts)
    .where(eq(workTogetherThreadContexts.threadId, threadId))
    .get();
}

export function markWorkTogetherCoordinationThread(
  db: DbConnection,
  threadId: string,
): WorkTogetherThreadContextRow {
  const existing = getWorkTogetherThreadContext(db, threadId);
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const row: WorkTogetherThreadContextRow = {
    threadId,
    requestId: null,
    digest: null,
    executionCwd: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workTogetherThreadContexts).values(row).run();
  return row;
}

export function applyWorkTogetherThreadContext(
  db: DbConnection,
  args: {
    threadId: string;
    requestId: string;
    digest: string;
    executionCwd: string;
  },
): WorkTogetherThreadContextRow {
  const now = Date.now();
  const existing = getWorkTogetherThreadContext(db, args.threadId);
  if (
    existing?.digest !== null &&
    existing?.digest !== undefined
  ) {
    if (
      existing.requestId === args.requestId &&
      existing.digest === args.digest &&
      existing.executionCwd === args.executionCwd
    ) {
      return existing;
    }
    throw new Error("work_together_thread_context_conflict");
  }
  if (!existing) {
    const row: WorkTogetherThreadContextRow = {
      threadId: args.threadId,
      requestId: args.requestId,
      digest: args.digest,
      executionCwd: args.executionCwd,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(workTogetherThreadContexts).values(row).run();
    return row;
  }
  db.update(workTogetherThreadContexts)
    .set({
      requestId: args.requestId,
      digest: args.digest,
      executionCwd: args.executionCwd,
      updatedAt: now,
    })
    .where(eq(workTogetherThreadContexts.threadId, args.threadId))
    .run();
  const updated = getWorkTogetherThreadContext(db, args.threadId);
  if (!updated) {
    throw new Error("work_together_thread_context_missing");
  }
  return updated;
}

export function copyWorkTogetherThreadContext(
  db: DbConnection,
  args: { sourceThreadId: string; targetThreadId: string },
): WorkTogetherThreadContextRow | undefined {
  const source = getWorkTogetherThreadContext(db, args.sourceThreadId);
  if (!source) return undefined;
  const now = Date.now();
  const row: WorkTogetherThreadContextRow = {
    threadId: args.targetThreadId,
    requestId: source.requestId,
    digest: source.digest,
    executionCwd: source.executionCwd,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workTogetherThreadContexts).values(row).run();
  return row;
}
