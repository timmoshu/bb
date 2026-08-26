import {
  GOAL_DOCUMENT_PROPOSE_SKILL,
  GOAL_DOCUMENT_PROPOSE_TOOL,
} from "./goal-document-propose.js";
import { ROOM_DELEGATE_SKILL } from "./room-delegate.js";
import {
  ROOM_RESULT_PUBLISH_SKILL,
  ROOM_RESULT_PUBLISH_TOOL,
} from "./room-result-publish.js";
import { ROOM_SUBAGENT_SPAWN_TOOL } from "./room-subagent-spawn.js";
import {
  WORKSTREAM_COMPLETENESS_SKILL,
  WORKSTREAM_COMPLETENESS_TOOL,
} from "./workstream-completeness.js";

export const PORTABLE_SKILLS = [
  "vespyn-dev-pipeline",
  "vespyn-review-and-clean",
  "vespyn-codebase-design",
  "vespyn-domain-modeling",
  "vespyn-delegate-external",
  "vespyn-fresh-session-kickoff",
] as const;

export const WORK_TOGETHER_TOOLS = [
  GOAL_DOCUMENT_PROPOSE_TOOL,
  WORKSTREAM_COMPLETENESS_TOOL,
  ROOM_RESULT_PUBLISH_TOOL,
  ROOM_SUBAGENT_SPAWN_TOOL,
] as const;

export const WORK_TOGETHER_SKILLS = [
  GOAL_DOCUMENT_PROPOSE_SKILL,
  WORKSTREAM_COMPLETENESS_SKILL,
  ROOM_RESULT_PUBLISH_SKILL,
  ROOM_DELEGATE_SKILL,
] as const;

export const VESPYN_RUNTIME_TOOLS = [...WORK_TOGETHER_TOOLS] as const;

export const VESPYN_RUNTIME_SKILLS = [
  ...PORTABLE_SKILLS,
  ...WORK_TOGETHER_SKILLS,
] as const;

export const STANDARD_PROJECT_INSTRUCTIONS =
  "Use the Vespyn toolkit workflows when their descriptions match the task. Keep deployment and host-operator actions outside this portable bundle. Work Together Goal propose is available for shaping via goal_document_propose using the Room Goal snapshot documentVersion. When this Room's work should be decomposed, call room_subagent_spawn (room-delegate skill); do not use bb thread spawn or native spawn_subagent. Before room_result_publish, when claiming done, or when a human asks whether we are done, call workstream_completeness; do not call it every turn; never write Done or mark Goal conditions met. When this Room's work is done, call room_result_publish with a bounded summary; do not paste the result as chat JSON; do not mark Goal conditions met; only include nextActions you actually recommend.";

export type VespynRuntimeSelection = {
  tools: string[];
  skills: string[];
  instructions?: string;
};

export function selectedVespynRuntimeContribution(
  projectKind: "standard" | "personal",
): VespynRuntimeSelection {
  if (projectKind !== "standard") {
    return { tools: [], skills: [] };
  }
  return {
    tools: [...VESPYN_RUNTIME_TOOLS],
    skills: [...VESPYN_RUNTIME_SKILLS],
    instructions: STANDARD_PROJECT_INSTRUCTIONS,
  };
}
