import { describe, expect, it } from "vitest";

import { ROOM_DELEGATE_SKILL } from "./room-delegate.js";
import {
  PORTABLE_SKILLS,
  selectedVespynRuntimeContribution,
  VESPYN_RUNTIME_SKILLS,
  VESPYN_RUNTIME_TOOLS,
} from "./selection.js";

describe("Vespyn runtime tool and skill selection", () => {
  it("selects exactly four tools and ten skills for standard projects", () => {
    const selected = selectedVespynRuntimeContribution("standard");
    expect(selected.tools).toEqual([
      "goal_document_propose",
      "workstream_completeness",
      "room_result_publish",
      "room_subagent_spawn",
    ]);
    expect(selected.tools).toEqual([...VESPYN_RUNTIME_TOOLS]);
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
    ]);
    expect(selected.skills).toEqual([...VESPYN_RUNTIME_SKILLS]);
    expect(selected.skills).toHaveLength(10);
    expect(selected.tools).toHaveLength(4);
    expect(selected.skills.slice(0, 6)).toEqual([...PORTABLE_SKILLS]);
    expect(selected.skills).toContain(ROOM_DELEGATE_SKILL);
    expect(selected.instructions).toEqual(expect.any(String));
  });

  it("contributes nothing to personal projects", () => {
    expect(selectedVespynRuntimeContribution("personal")).toEqual({
      tools: [],
      skills: [],
    });
  });
});
