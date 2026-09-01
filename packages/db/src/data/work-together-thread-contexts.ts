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
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workTogetherThreadContexts).values(row).run();
  return row;
}

export function applyWorkTogetherThreadContext(
  db: DbConnection,
  args: { threadId: string; requestId: string; digest: string },
): WorkTogetherThreadContextRow {
  const now = Date.now();
  const existing = getWorkTogetherThreadContext(db, args.threadId);
  if (!existing) {
    const row: WorkTogetherThreadContextRow = {
      threadId: args.threadId,
      requestId: args.requestId,
      digest: args.digest,
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
