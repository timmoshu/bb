import { describe, expect, it } from "vitest";

import { selectedVespynRuntimeContribution } from "./selection.js";

describe("Vespyn runtime tool and skill selection", () => {
  it("selects the bundled tools and skills for standard projects", () => {
    const selected = selectedVespynRuntimeContribution("standard");
    expect(selected.tools).toEqual([
      "goal_document_propose",
      "workstream_completeness",
      "room_result_publish",
      "room_subagent_spawn",
      "filespace_list",
      "filespace_get",
      "filespace_put",
    ]);
    expect(selected.skills).toEqual([
      "vespyn-dev-pipeline",
      "vespyn-review-and-clean",
      "vespyn-codebase-design",
      "vespyn-domain-modeling",
      "vespyn-delegate-external",
      "vespyn-fresh-session-kickoff",
      "goal-document-propose",
      "workstream-completeness",
      "room-result-publish",
      "room-delegate",
      "filespace",
    ]);
    expect(selected.instructions).toEqual(expect.any(String));
  });

  it("contributes nothing to personal projects", () => {
    expect(selectedVespynRuntimeContribution("personal")).toEqual({
      tools: [],
      skills: [],
    });
  });
});
