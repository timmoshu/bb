import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { getThread, markWorkTogetherCoordinationThread } from "@bb/db";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import type { ServerAppDeps } from "../types.js";
import { requireEnvironment } from "../services/lib/entity-lookup.js";
import { createThreadFromRequest } from "../services/threads/thread-create.js";
import { toThreadResponseFromThread } from "../services/threads/thread-runtime-display.js";
import {
  applyWorkTogetherThreadContext,
  assertCoordinationAcpCwd,
  getWorkTogetherThreadContext,
} from "../services/work-together-thread-context.js";

const MIN_TOKEN_LENGTH = 32;
const MAX_BINDING_KEY_LENGTH = 500;
const COORDINATION_THREAD_ID_NAMESPACE = "bb.work-together.coordination-thread";

const coordinationThreadBodySchema = z
  .object({
    projectId: z.string().min(1).max(200),
    environmentId: z.string().min(1).max(200),
    title: z.string().min(1).max(300),
  })
  .strict();

const threadContextBodySchema = z
  .object({
    requestId: z.string().min(1).max(200),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.string().min(1),
  })
  .strict();

export function assertWorkTogetherIntegrationToken(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error("work_together_integration_token_invalid");
  }
}

function authorizationMatches(expected: string, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(provided, wanted);
}

function requireBindingKey(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid request");
  }
  if (decoded.length === 0 || decoded.length > MAX_BINDING_KEY_LENGTH) {
    throw new ApiError(400, "invalid_request", "Invalid request");
  }
  return decoded;
}

export function coordinationThreadIdForBindingKey(bindingKey: string): string {
  const digest = createHash("sha256")
    .update(COORDINATION_THREAD_ID_NAMESPACE)
    .update("\0")
    .update(bindingKey)
    .digest();
  let suffix = "";
  for (let i = 0; i < GENERATED_ID_SUFFIX_LENGTH; i += 1) {
    suffix += GENERATED_ID_ALPHABET[digest[i]! % GENERATED_ID_ALPHABET.length]!;
  }
  return `thr_${suffix}`;
}

function existingThreadMatchesBinding(args: {
  environmentId: string;
  projectId: string;
  thread: NonNullable<ReturnType<typeof getThread>>;
}): boolean {
  const { thread } = args;
  return (
    thread.deletedAt === null &&
    thread.parentThreadId === null &&
    thread.sourceThreadId === null &&
    thread.originKind === null &&
    thread.projectId === args.projectId &&
    thread.environmentId === args.environmentId
  );
}

function throwIfIncompatibleExistingThread(args: {
  environmentId: string;
  projectId: string;
  thread: NonNullable<ReturnType<typeof getThread>>;
}): void {
  if (!existingThreadMatchesBinding(args)) {
    throw new ApiError(
      409,
      "coordination_binding_conflict",
      "Coordination binding conflict",
    );
  }
}

function decodeEnvelopeBytes(bytes: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(bytes, "base64");
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid request");
  }
  if (decoded.length < 1 || decoded.length > 65536) {
    throw new ApiError(400, "invalid_request", "Invalid request");
  }
  return decoded;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function registerWorkTogetherCoordinationRoutes(
  app: Hono,
  deps: ServerAppDeps,
  token: string,
): void {
  app.put("/api/work-together/v1/coordination-threads/:bindingKey", async (context) => {
    if (!authorizationMatches(token, context.req.header("authorization"))) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    const bindingKey = requireBindingKey(context.req.param("bindingKey"));
    const json: unknown = await context.req.json();
    const parsed = coordinationThreadBodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid request");
    }
    const environment = requireEnvironment(deps.db, parsed.data.environmentId);
    if (environment.projectId !== parsed.data.projectId) {
      throw new ApiError(409, "coordination_binding_conflict", "Coordination binding conflict");
    }
    if (environment.path) {
      assertCoordinationAcpCwd(environment.path, undefined);
    }
    const threadId = coordinationThreadIdForBindingKey(bindingKey);
    const existing = getThread(deps.db, threadId);
    if (existing) {
      throwIfIncompatibleExistingThread({
        environmentId: parsed.data.environmentId,
        projectId: parsed.data.projectId,
        thread: existing,
      });
      markWorkTogetherCoordinationThread(deps.db, existing.id);
      return context.json(
        {
          created: false,
          thread: toThreadResponseFromThread(deps, { thread: existing }),
        },
        200,
      );
    }
    let thread;
    try {
      thread = await createThreadFromRequest(
        deps,
        {
          environment: {
            type: "reuse",
            environmentId: parsed.data.environmentId,
          },
          input: [],
          model: "grok-4.6",
          origin: "sdk",
          projectId: parsed.data.projectId,
          providerId: "acp-grok",
          startedOnBehalfOf: null,
          title: parsed.data.title,
        },
        { threadId },
      );
    } catch (error) {
      const raced = getThread(deps.db, threadId);
      if (
        raced &&
        existingThreadMatchesBinding({
          environmentId: parsed.data.environmentId,
          projectId: parsed.data.projectId,
          thread: raced,
        })
      ) {
        markWorkTogetherCoordinationThread(deps.db, raced.id);
        return context.json(
          {
            created: false,
            thread: toThreadResponseFromThread(deps, { thread: raced }),
          },
          200,
        );
      }
      throw error;
    }
    markWorkTogetherCoordinationThread(deps.db, thread.id);
    return context.json(
      {
        created: true,
        thread: toThreadResponseFromThread(deps, { thread }),
      },
      201,
    );
  });

  app.put("/api/work-together/v1/threads/:threadId/context", async (context) => {
    if (!authorizationMatches(token, context.req.header("authorization"))) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    const json: unknown = await context.req.json();
    const parsed = threadContextBodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_request", "Invalid request");
    }
    const threadId = context.req.param("threadId");
    const thread = getThread(deps.db, threadId);
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    const decoded = decodeEnvelopeBytes(parsed.data.bytes);
    const computed = sha256Hex(decoded);
    if (computed !== parsed.data.digest) {
      throw new ApiError(400, "invalid_request", "Invalid request");
    }
    const existing = getWorkTogetherThreadContext(deps.db, threadId);
    if (existing?.digest !== null && existing?.digest !== undefined) {
      if (
        existing.requestId === parsed.data.requestId &&
        existing.digest === parsed.data.digest
      ) {
        return context.json(
          {
            outcome: "already_accepted",
            requestId: existing.requestId,
            digest: existing.digest,
          },
          200,
        );
      }
      throw new ApiError(409, "context_conflict", "Context conflict");
    }
    const applied = applyWorkTogetherThreadContext(deps.db, {
      threadId,
      requestId: parsed.data.requestId,
      digest: parsed.data.digest,
    });
    return context.json(
      {
        outcome: "accepted",
        requestId: applied.requestId,
        digest: applied.digest,
      },
      200,
    );
  });

  app.get("/api/work-together/v1/threads/:threadId/context", async (context) => {
    if (!authorizationMatches(token, context.req.header("authorization"))) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    const threadId = context.req.param("threadId");
    const thread = getThread(deps.db, threadId);
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    const existing = getWorkTogetherThreadContext(deps.db, threadId);
    if (
      existing === undefined ||
      existing.requestId === null ||
      existing.digest === null
    ) {
      throw new ApiError(404, "context_not_applied", "Context not applied");
    }
    return context.json(
      {
        requestId: existing.requestId,
        digest: existing.digest,
      },
      200,
    );
  });
}
