import { describe, expect, it } from "vitest";

import { FILESPACE_SKILL } from "./filespace.js";
import { ROOM_DELEGATE_SKILL } from "./room-delegate.js";
import {
  PORTABLE_SKILLS,
  selectedVespynRuntimeContribution,
  VESPYN_RUNTIME_SKILLS,
  VESPYN_RUNTIME_TOOLS,
} from "./selection.js";

describe("Vespyn runtime tool and skill selection", () => {
  it("selects the bundled tools and skills for standard projects", () => {
    const selected = selectedVespynRuntimeContribution("standard");
    expect(selected.tools).toEqual([...VESPYN_RUNTIME_TOOLS]);
    expect(selected.skills).toEqual([...VESPYN_RUNTIME_SKILLS]);
    expect(selected.tools).toContain("filespace_put");
    expect(selected.skills).toContain(FILESPACE_SKILL);
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
