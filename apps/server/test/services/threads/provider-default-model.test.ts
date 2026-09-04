import { describe, expect, it } from "vitest";
import { resolveProviderDefaultModel } from "../../../src/services/threads/provider-default-model.js";
import { availableModelFixture } from "../../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../../helpers/host-rpc.js";
import { seedHostSession } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

describe("provider default model resolution", () => {
  it("uses only the current provider catalog and ignores selected-only models", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provider-default-model",
      });
      const responder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelsByProviderId: {
          codex: {
            models: [availableModelFixture({ model: "current-model" })],
            selectedOnlyModels: [
              availableModelFixture({
                model: "retired-selected-model",
                isDefault: true,
              }),
            ],
          },
        },
      });

      await expect(
        resolveProviderDefaultModel(harness.deps, {
          hostId: host.id,
          providerId: "codex",
        }),
      ).resolves.toBe("current-model");
      expect(
        responder.requests.filter(
          (request) => request.command.type === "provider.list_models",
        ),
      ).toHaveLength(1);
    });
  });
});
