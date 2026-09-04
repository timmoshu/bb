import {
  deliveryAuthoritySchema,
  promptModeSchema,
  reasoningLevelSchema,
  runtimePermissionPolicySchema,
  serviceTierSchema,
} from "@bb/domain";
import { z } from "zod";

export const bridgeExecutionOptionsSchema = z
  .object({
    model: z.string().min(1).optional(),
    serviceTier: serviceTierSchema.optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    promptMode: promptModeSchema.optional(),
    instructions: z.string().optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    deliveryAuthority: deliveryAuthoritySchema,
    executionCwd: z.string().min(1).optional(),
    executionEnvironmentCwd: z.string().min(1).optional(),
    workTogetherWorkCwdRoot: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.deliveryAuthority === "none" &&
      (value.executionCwd === undefined ||
        value.executionEnvironmentCwd === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionCwd"],
        message: "executionCwd is required",
      });
    }
    if (
      value.deliveryAuthority === "git" &&
      (value.executionCwd !== undefined ||
        value.executionEnvironmentCwd !== undefined ||
        value.workTogetherWorkCwdRoot !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionCwd"],
        message: "Work Together cwd authority is forbidden",
      });
    }
  })
  .and(runtimePermissionPolicySchema);

export type BridgeExecutionOptions = z.infer<
  typeof bridgeExecutionOptionsSchema
>;
