import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { getThread } from "@bb/db";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import type { ServerAppDeps } from "../types.js";
import { requireEnvironment } from "../services/lib/entity-lookup.js";
import { createThreadFromRequest } from "../services/threads/thread-create.js";
import { toThreadResponseFromThread } from "../services/threads/thread-runtime-display.js";

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
    const threadId = coordinationThreadIdForBindingKey(bindingKey);
    const existing = getThread(deps.db, threadId);
    if (existing) {
      throwIfIncompatibleExistingThread({
        environmentId: parsed.data.environmentId,
        projectId: parsed.data.projectId,
        thread: existing,
      });
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
          origin: "sdk",
          projectId: parsed.data.projectId,
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
    return context.json(
      {
        created: true,
        thread: toThreadResponseFromThread(deps, { thread }),
      },
      201,
    );
  });
}
