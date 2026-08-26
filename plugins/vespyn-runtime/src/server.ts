import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { loadCellToolConfig } from "./config.js";
import {
  buildProposeRequest,
  postGoalDocumentPropose,
} from "./goal-document-propose.js";
import {
  buildRoomResultPublishRequest,
  postRoomResultPublish,
} from "./room-result-publish.js";
import {
  buildRoomSubagentSpawnRequest,
  postRoomSubagentSpawn,
} from "./room-subagent-spawn.js";
import { selectedVespynRuntimeContribution } from "./selection.js";
import {
  buildWorkstreamCompletenessRequest,
  postWorkstreamCompleteness,
} from "./workstream-completeness.js";

const proposeParameters = z.object({
  expectedGoalDocumentVersion: z.number().int().positive(),
  title: z.string(),
  outcome: z.string(),
  openConditionTexts: z.array(z.string()),
});

const roomResultParameters = z.object({
  summary: z.string(),
  nextActions: z.array(z.object({ text: z.string() })).optional(),
});

const roomSubagentSpawnParameters = z.object({
  prompt: z.string(),
});

const workstreamCompletenessParameters = z.object({});

export default function plugin(bb: BbPluginApi) {
  const config = loadCellToolConfig();

  bb.agents.registerTool({
    name: "goal_document_propose",
    description:
      "Propose a Goal document draft patch through Work Together: title, outcome, and open success-condition texts. Pass the Goal snapshot documentVersion. Does not activate the Goal.",
    instructions:
      "Use the Room Goal snapshot. Pass that snapshot's documentVersion as expectedGoalDocumentVersion. Do not activate or drop the Goal. This is a draft patch, not chat JSON.",
    experimental_statusLabels: {
      pending: "Proposing Goal draft",
      completed: "Proposed Goal draft",
    },
    parameters: proposeParameters,
    async execute(input, context) {
      const body = buildProposeRequest({
        threadId: context.threadId,
        projectId: context.projectId,
        expectedGoalDocumentVersion: input.expectedGoalDocumentVersion,
        title: input.title,
        outcome: input.outcome,
        openConditionTexts: input.openConditionTexts,
      });
      return postGoalDocumentPropose({
        coordinatorOrigin: config.coordinatorOrigin,
        secret: config.secret,
        body,
        signal: context.signal,
      });
    },
  });

  bb.agents.registerTool({
    name: "workstream_completeness",
    description:
      "Grade this Room's workstream against its charter, toward-objective, and current result. Propose-only. Does not write Done and does not mark Goal conditions met.",
    instructions:
      "Call workstream_completeness before room_result_publish, when claiming the work is done, or when a human asks whether we are done. Do not call it every turn. Never write Done or mark the objective met.",
    experimental_statusLabels: {
      pending: "Judging workstream completeness",
      completed: "Judged workstream completeness",
    },
    parameters: workstreamCompletenessParameters,
    async execute(_input, context) {
      const body = buildWorkstreamCompletenessRequest({
        threadId: context.threadId,
        projectId: context.projectId,
      });
      return postWorkstreamCompleteness({
        coordinatorOrigin: config.coordinatorOrigin,
        secret: config.secret,
        body,
        signal: context.signal,
      });
    },
  });

  bb.agents.registerTool({
    name: "room_result_publish",
    description:
      "Publish one typed Workstream result for this Room through Work Together. The board shows it for human Acknowledge. Does not mark Goal conditions met. Does not publish Git.",
    instructions:
      "When this Room's work is done, call room_result_publish with a bounded summary. Do not paste the result as chat JSON. Do not mark Goal conditions met. Include nextActions only when you actually recommend follow-ups.",
    experimental_statusLabels: {
      pending: "Publishing Room result",
      completed: "Published Room result",
    },
    parameters: roomResultParameters,
    async execute(input, context) {
      const body = buildRoomResultPublishRequest({
        threadId: context.threadId,
        projectId: context.projectId,
        summary: input.summary,
        ...(input.nextActions !== undefined
          ? { nextActions: input.nextActions }
          : {}),
      });
      return postRoomResultPublish({
        coordinatorOrigin: config.coordinatorOrigin,
        secret: config.secret,
        body,
        signal: context.signal,
      });
    },
  });

  bb.agents.registerTool({
    name: "room_subagent_spawn",
    description:
      "Spawn a BB child thread in this Room's project and environment through Work Together. The board projects the child as a Subagent. Does not create a new environment.",
    instructions:
      "When this Room's work should be decomposed, call room_subagent_spawn with a clear prompt. Do not use bb thread spawn or native spawn_subagent. Report the returned childThreadId.",
    experimental_statusLabels: {
      pending: "Spawning Subagent",
      completed: "Spawned Subagent",
    },
    parameters: roomSubagentSpawnParameters,
    async execute(input, context) {
      const body = buildRoomSubagentSpawnRequest({
        threadId: context.threadId,
        projectId: context.projectId,
        prompt: input.prompt,
      });
      return postRoomSubagentSpawn({
        coordinatorOrigin: config.coordinatorOrigin,
        secret: config.secret,
        body,
        signal: context.signal,
      });
    },
  });

  bb.agents.configure((context) =>
    selectedVespynRuntimeContribution(context.project.kind),
  );
}
