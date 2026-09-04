import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";

interface ResolveProviderDefaultModelArgs {
  cwd?: string;
  hostId: string;
  providerId: string;
}

export async function resolveProviderDefaultModel(
  deps: LoggedWorkSessionDeps,
  args: ResolveProviderDefaultModelArgs,
): Promise<string> {
  const catalog = await resolveSystemProviderModels(deps, {
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    hostId: args.hostId,
    providerId: args.providerId,
  });
  if (catalog.modelLoadError !== null) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${args.providerId} models to resolve its default.`,
      { details: catalog.modelLoadError, retryable: true },
    );
  }
  const model =
    catalog.models.find((candidate) => candidate.isDefault)?.model ??
    catalog.models[0]?.model;
  if (model === undefined) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `The ${args.providerId} model catalog is empty, so no default model can be resolved.`,
      true,
    );
  }
  return model;
}
