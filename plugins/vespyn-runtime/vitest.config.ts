import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    environment: "node",
    silent: "passed-only",
    name: "bb-plugin-vespyn-runtime",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
