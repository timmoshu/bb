import { describe, expect, it } from "vitest";

import type {
  ThreadTimelineResponse,
  TimelineApprovalWorkRow,
  TimelineCommandWorkRow,
  TimelineDelegationWorkRow,
  TimelineQuestionWorkRow,
  TimelineSystemRow,
  TimelineToolWorkRow,
  TimelineTurnRow,
  TimelineUserConversationRow,
  TimelineWorkRow,
  TimelineWorkflowWorkRow,
} from "@bb/server-contract";

import {
  projectWorkTogetherRoomTimeline,
  type ProjectWorkTogetherRoomTimelineInput,
} from "../../src/room-distribution/work-together-room-timeline-projection.js";
import { RoomDistributionUnavailableError } from "../../src/room-distribution/room-distribution-port.js";

const BINDING_ID = "bbndg_test_binding_00001";
const PRIVATE_THREAD_ID = "thr_private_test_001";
const PUBLIC_STREAM_ID = "child_stream_001";
const ENVIRONMENT_ID = "env_private_test_001";
const PROJECT_ID = "prj_private_test_001";

function timeline(
  overrides: Partial<ThreadTimelineResponse> = {},
): ThreadTimelineResponse {
  return {
    rows: [],
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
    maxSeq: 0,
    ...overrides,
  };
}

function input(
  overrides: Partial<ProjectWorkTogetherRoomTimelineInput> = {},
): ProjectWorkTogetherRoomTimelineInput {
  return {
    bindingId: BINDING_ID,
    privateThreadId: PRIVATE_THREAD_ID,
    publicStreamId: PUBLIC_STREAM_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    threadStatus: "idle",
    privateActiveTurnId: null,
    timeline: timeline(),
    ...overrides,
  };
}

function rowBase(id: string, sequence = 1) {
  return {
    id,
    threadId: PRIVATE_THREAD_ID,
    turnId: "turn_private_001",
    sourceSeqStart: sequence,
    sourceSeqEnd: sequence,
    startedAt: 1_000 + sequence,
    createdAt: 1_000 + sequence,
  };
}

function command(
  id: string,
  sequence = 1,
  status: TimelineCommandWorkRow["status"] = "completed",
): TimelineCommandWorkRow {
  return {
    ...rowBase(id, sequence),
    kind: "work",
    workKind: "command",
    status,
    callId: "call_private_sentinel",
    command: "secret command sentinel",
    cwd: "/secret/cwd/sentinel",
    source: "secret source sentinel",
    output: "secret output sentinel",
    exitCode: status === "completed" ? 0 : null,
    completedAt: status === "pending" ? null : 2_000 + sequence,
    approvalStatus: null,
    activityIntents: [],
  };
}

function tool(
  id: string,
  toolName: string,
  sequence = 1,
  extras: Partial<
    Pick<TimelineToolWorkRow, "toolArgs" | "statusLabels" | "output">
  > = {},
): TimelineToolWorkRow {
  return {
    ...rowBase(id, sequence),
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: "call_private_sentinel",
    toolName,
    toolArgs: extras.toolArgs ?? {
      query: "secret query sentinel",
      path: "/secret/path/sentinel",
    },
    ...(extras.statusLabels ? { statusLabels: extras.statusLabels } : {}),
    output: extras.output ?? "secret output sentinel",
    completedAt: 2_000 + sequence,
    approvalStatus: null,
    activityIntents: [],
  };
}

function delegation(
  id: string,
  toolName: string,
  sequence = 1,
): TimelineDelegationWorkRow {
  return {
    ...rowBase(id, sequence),
    kind: "work",
    workKind: "delegation",
    status: "completed",
    callId: "call_private_sentinel",
    toolName,
    subagentType: "private subagent type sentinel",
    description: "private description sentinel",
    output: "secret output sentinel",
    completedAt: 2_000 + sequence,
    childRows: [userMessage("private delegated child", "child", sequence + 50)],
  };
}

function workflow(
  id: string,
  sequence: number,
  status: TimelineWorkflowWorkRow["status"] = "pending",
): TimelineWorkflowWorkRow {
  return {
    ...rowBase(id, sequence),
    kind: "work",
    workKind: "workflow",
    status,
    itemId: "item_private_sentinel",
    taskType: "private task type sentinel",
    workflowName: "private workflow name sentinel",
    description: "private workflow description sentinel",
    taskStatus: status === "pending" ? "running" : "completed",
    workflow: null,
    usage: null,
    summary: "private workflow summary sentinel",
    error: "private workflow error sentinel",
    completedAt: status === "pending" ? null : 2_000 + sequence,
  };
}

function userMessage(
  id: string,
  text = "Hello",
  sequence = 1,
): TimelineUserConversationRow {
  return {
    ...rowBase(id, sequence),
    kind: "conversation",
    role: "user",
    text,
    attachments: {
      webImages: 1,
      localImages: 1,
      localFiles: 1,
      imageUrls: ["https://secret.invalid/image"],
      localImagePaths: ["/secret/image"],
      localFilePaths: ["/secret/file"],
    },
    initiator: "user",
    senderThreadId: "thr_sender_private_sentinel",
    actor: {
      principalId: "principal_private_sentinel",
      principalKind: "human",
      displayName: "Alice",
    },
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    mentions: [],
  };
}

function question(
  overrides: Partial<TimelineQuestionWorkRow> = {},
): TimelineQuestionWorkRow {
  return {
    ...rowBase("question_private_001"),
    kind: "work",
    workKind: "question",
    status: "pending",
    interactionId: "pint_23456789ab",
    lifecycle: "pending",
    questions: [
      {
        id: "choice",
        prompt: "Choose one",
        shortLabel: "Choice",
        multiSelect: false,
        options: [
          {
            value: "first",
            label: "First",
            description: "The first option",
          },
        ],
        allowFreeText: false,
      },
    ],
    answers: null,
    statusReason: "private status reason sentinel",
    ...overrides,
  };
}

function approval(
  overrides: Partial<TimelineApprovalWorkRow> = {},
): TimelineApprovalWorkRow {
  return {
    ...rowBase("approval_private_001"),
    kind: "work",
    workKind: "approval",
    status: "pending",
    approvalKind: "permission-grant",
    lifecycle: "pending",
    interactionId: "pint_23456789ac",
    target: { itemId: "private item sentinel", toolName: "private tool" },
    grantScope: null,
    statusReason: "private reason sentinel",
    ...overrides,
  } as TimelineApprovalWorkRow;
}

function systemRow(
  id: string,
  systemKind: TimelineSystemRow["systemKind"],
  sequence: number,
  extras: Record<string, unknown> = {},
): TimelineSystemRow {
  return {
    ...rowBase(id, sequence),
    kind: "system",
    systemKind,
    title: "private title sentinel",
    detail: "private detail sentinel",
    ...extras,
  } as TimelineSystemRow;
}

function activityFixture(
  workKind: Exclude<TimelineWorkRow["workKind"], "approval" | "question">,
  sequence: number,
): TimelineWorkRow {
  if (workKind === "command") return command(`activity_${sequence}`, sequence);
  if (workKind === "workflow") {
    return workflow(`activity_${sequence}`, sequence, "completed");
  }
  if (workKind === "tool") {
    return tool(`activity_${sequence}`, "Read", sequence);
  }
  if (workKind === "delegation") {
    return delegation(`activity_${sequence}`, "Agent", sequence);
  }
  return {
    ...rowBase(`activity_${sequence}`, sequence),
    kind: "work",
    workKind,
    status: "completed",
    completedAt: 2_000 + sequence,
    callId: "private call sentinel",
    output: "private output sentinel",
    childRows: [userMessage("private delegated child")],
  } as unknown as TimelineWorkRow;
}

describe("Work Together Room timeline projection", () => {
  it("returns the exact empty root and derives only generic working state", () => {
    expect(projectWorkTogetherRoomTimeline(input())).toEqual({
      rows: [],
      working: false,
      activeTurnId: null,
    });
    expect(
      projectWorkTogetherRoomTimeline(input({ threadStatus: "starting" }))
        .working,
    ).toBe(true);
    expect(
      projectWorkTogetherRoomTimeline(
        input({
          timeline: timeline({
            activeThinking: {
              id: "thinking_private",
              text: "private thinking sentinel",
              startedAt: 1,
              updatedAt: 2,
            },
          }),
        }),
      ).working,
    ).toBe(true);
  });

  it("hashes stable row and active-turn identities per Room stream", () => {
    const source = userMessage("message_private_001");
    const first = projectWorkTogetherRoomTimeline(
      input({
        privateActiveTurnId: "turn_private_active",
        timeline: timeline({ rows: [source] }),
      }),
    );
    const replay = projectWorkTogetherRoomTimeline(
      input({
        privateActiveTurnId: "turn_private_active",
        timeline: timeline({ rows: [source] }),
      }),
    );
    const child = projectWorkTogetherRoomTimeline(
      input({
        publicStreamId: "child_stream_002",
        privateActiveTurnId: "turn_private_active",
        timeline: timeline({ rows: [source] }),
      }),
    );

    expect(first).toEqual(replay);
    expect(first.rows[0]?.id).toMatch(/^roomrow_[A-Za-z0-9_-]{43}$/u);
    expect(first.activeTurnId).toMatch(/^turn_[A-Za-z0-9_-]{43}$/u);
    expect(child.rows[0]?.id).not.toBe(first.rows[0]?.id);
    expect(child.activeTurnId).not.toBe(first.activeTurnId);
    expect(JSON.stringify(first)).not.toContain("turn_private_active");
  });

  it("maps every activity kind and status to exact generic public fields", () => {
    const kinds = [
      ["command", "command", "Command"],
      ["tool", "tool", "Tool"],
      ["file-change", "file_change", "File change"],
      ["web-search", "web_search", "Web search"],
      ["web-fetch", "web_fetch", "Web fetch"],
      ["image-view", "image_view", "Image review"],
      ["delegation", "delegation", "Delegated work"],
      ["workflow", "workflow", "Workflow"],
    ] as const;
    const rows = kinds.map(([sourceKind], index) =>
      activityFixture(sourceKind, index + 1),
    );
    rows.push(command("pending_activity", 20, "pending"));
    rows.push(command("error_activity", 21, "error"));
    rows.push(command("interrupted_activity", 22, "interrupted"));

    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows }) }),
    );
    expect(result.rows).toHaveLength(11);
    for (const [index, [sourceKind, publicKind, label]] of kinds.entries()) {
      expect(result.rows[index]).toMatchObject({
        kind: "activity",
        activityKind: publicKind,
        status: "completed",
        label,
      });
      if (sourceKind === "tool") {
        expect(result.rows[index]).toMatchObject({ toolName: "Read" });
      } else if (sourceKind === "delegation") {
        expect(result.rows[index]).toMatchObject({ toolName: "Agent" });
      } else {
        expect(result.rows[index]).not.toHaveProperty("toolName");
      }
    }
    expect(result.rows.slice(-3)).toMatchObject([
      { status: "running", completedAt: null },
      { status: "error" },
      { status: "interrupted" },
    ]);
    const wire = JSON.stringify(result);
    for (const sentinel of [
      "secret command sentinel",
      "/secret/cwd/sentinel",
      "secret output sentinel",
      "secret query sentinel",
      "/secret/path/sentinel",
      "private delegated child",
      "private workflow summary sentinel",
      "private workflow error sentinel",
    ]) {
      expect(wire).not.toContain(sentinel);
    }
  });

  it("projects the private toolName on tool and delegation activity rows", () => {
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [
            tool("wt_completeness", "workstream_completeness", 1),
            tool("wt_goal_propose", "goal_document_propose", 2),
            tool("wt_result_publish", "room_result_publish", 3),
            tool("wt_subagent_spawn", "room_subagent_spawn", 4),
            tool("mcp_tool", "docs:lookup", 5),
            tool("shell_tool", "Bash", 6),
            tool(
              "labeled_tool",
              "workstream_completeness",
              7,
              {
                statusLabels: {
                  pending: "Judging workstream completeness",
                  completed: "Judged workstream completeness",
                },
              },
            ),
            command("shell_command", 8),
            question({ id: "ask_user_question" }),
          ],
        }),
      }),
    );

    expect(result.rows).toMatchObject([
      { activityKind: "tool", label: "Tool", toolName: "workstream_completeness" },
      { activityKind: "tool", label: "Tool", toolName: "goal_document_propose" },
      { activityKind: "tool", label: "Tool", toolName: "room_result_publish" },
      { activityKind: "tool", label: "Tool", toolName: "room_subagent_spawn" },
      { activityKind: "tool", label: "Tool", toolName: "docs:lookup" },
      { activityKind: "tool", label: "Tool", toolName: "Bash" },
      { activityKind: "tool", label: "Tool", toolName: "workstream_completeness" },
      { activityKind: "command", label: "Command" },
      { kind: "work", workKind: "question" },
    ]);
    expect(result.rows[7]).not.toHaveProperty("toolName");
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("secret query sentinel");
    expect(wire).not.toContain("/secret/path/sentinel");
    expect(wire).not.toContain("secret output sentinel");
    expect(wire).not.toContain("secret command sentinel");
    expect(wire).not.toContain("Judging workstream completeness");
    expect(wire).not.toContain("Judged workstream completeness");
    expect(wire).not.toContain("statusLabels");
    expect(wire).not.toContain("toolArgs");
  });

  it("omits toolName when the private identifier is blank, oversized, or identity-bearing", () => {
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [
            tool("blank_name", "   ", 1),
            tool("control_name", "Read\u0000", 2),
            tool("oversized_name", "x".repeat(257), 3),
            tool("private_thread_name", PRIVATE_THREAD_ID, 4),
            tool("nfc_name", "e\u0301", 5),
          ],
        }),
      }),
    );

    expect(result.rows[0]).not.toHaveProperty("toolName");
    expect(result.rows[1]).not.toHaveProperty("toolName");
    expect(result.rows[2]).not.toHaveProperty("toolName");
    expect(result.rows[3]).not.toHaveProperty("toolName");
    expect(result.rows[4]).toMatchObject({ toolName: "é" });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_THREAD_ID);
  });

  it("projects visible conversation copy through scalar identity scrubbing", () => {
    const source = userMessage(
      "message_private_002",
      `${PRIVATE_THREAD_ID} ${ENVIRONMENT_ID} ${PROJECT_ID}`,
    );
    source.actor.displayName = `${PRIVATE_THREAD_ID} owner`;
    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows: [source] }) }),
    );

    expect(result.rows[0]).toMatchObject({
      kind: "conversation",
      role: "user",
      text: `${PUBLIC_STREAM_ID} ${BINDING_ID}:environment ${BINDING_ID}:project`,
      actor: {
        participantId: expect.stringMatching(/^participant_/u),
        kind: "human",
        displayName: `${PUBLIC_STREAM_ID} owner`,
      },
    });
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("principal_private_sentinel");
    expect(wire).not.toContain("https://secret.invalid/image");
    expect(wire).not.toContain("thr_sender_private_sentinel");
  });

  it("degrades invalid message copy and actor names without exposing prefixes", () => {
    const invalidMessage = userMessage("invalid_message", `secret\u0000tail`);
    const invalidActor = userMessage("invalid_actor", "still visible", 2);
    invalidActor.actor.displayName = "x".repeat(401);
    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows: [invalidMessage, invalidActor] }) }),
    );

    expect(result.rows[0]).toMatchObject({
      kind: "notice",
      noticeKind: "message_unavailable",
      label: "A message is unavailable",
    });
    expect(result.rows[1]).toMatchObject({
      kind: "conversation",
      text: "still visible",
      actor: { displayName: "Participant" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("allows multiline controls, normalizes NFC, and measures bytes after scrubbing", () => {
    const accepted = userMessage(
      "accepted_controls",
      "tab\tline\ncarriage\re\u0301",
    );
    const expandsAfterScrub = userMessage(
      "post_scrub_bound",
      "p".repeat(32_769),
      2,
    );
    expandsAfterScrub.threadId = "p";

    const acceptedResult = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows: [accepted] }) }),
    );
    const boundedResult = projectWorkTogetherRoomTimeline(
      input({
        privateThreadId: "p",
        publicStreamId: "é",
        timeline: timeline({ rows: [expandsAfterScrub] }),
      }),
    );

    expect(acceptedResult.rows[0]).toMatchObject({
      kind: "conversation",
      text: "tab\tline\ncarriage\ré",
    });
    expect(boundedResult.rows[0]).toMatchObject({
      kind: "notice",
      noticeKind: "message_unavailable",
      label: "A message is unavailable",
    });
  });

  it("retains only bounded actionable question and approval fields", () => {
    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows: [question(), approval()] }) }),
    );

    expect(result.rows).toEqual([
      {
        kind: "work",
        workKind: "question",
        id: expect.stringMatching(/^roomrow_[A-Za-z0-9_-]{43}$/u),
        interactionId: "pint_23456789ab",
        status: "pending",
        lifecycle: "pending",
        createdAt: 1_001,
        questions: [
          {
            id: "choice",
            prompt: "Choose one",
            shortLabel: "Choice",
            multiSelect: false,
            options: [
              {
                value: "first",
                label: "First",
                description: "The first option",
              },
            ],
            allowFreeText: false,
          },
        ],
      },
      {
        kind: "work",
        workKind: "approval",
        id: expect.stringMatching(/^roomrow_[A-Za-z0-9_-]{43}$/u),
        interactionId: "pint_23456789ac",
        status: "pending",
        lifecycle: "pending",
        createdAt: 1_001,
        label: "Approve this request?",
        decisions: ["allow_once", "deny"],
      },
    ]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("private status reason sentinel");
    expect(wire).not.toContain("private item sentinel");
    expect(wire).not.toContain("private tool");
  });

  it("scrubs visible question copy but never rewrites correlation fields", () => {
    const scrubbed = question({
      id: "scrubbed_question",
      questions: [
        {
          id: "choice",
          prompt: `${PRIVATE_THREAD_ID} ${ENVIRONMENT_ID} ${PROJECT_ID}`,
          shortLabel: `${PRIVATE_THREAD_ID} label`,
          multiSelect: false,
          options: [
            {
              value: "first",
              label: `${ENVIRONMENT_ID} label`,
              description: `${PROJECT_ID} description`,
            },
          ],
          allowFreeText: false,
        },
      ],
    });
    const privateCorrelation = question({
      id: "private_correlation",
      questions: [
        {
          id: PRIVATE_THREAD_ID,
          prompt: "Choose",
          multiSelect: false,
          options: [{ value: "first", label: "First" }],
          allowFreeText: false,
        },
      ],
    });
    const nonNfcCorrelation = question({
      id: "non_nfc_correlation",
      questions: [
        {
          id: "e\u0301",
          prompt: "Choose",
          multiSelect: false,
          options: [{ value: "first", label: "First" }],
          allowFreeText: false,
        },
      ],
    });
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [scrubbed, privateCorrelation, nonNfcCorrelation],
        }),
      }),
    );

    expect(result.rows[0]).toMatchObject({
      kind: "work",
      questions: [
        {
          prompt: `${PUBLIC_STREAM_ID} ${BINDING_ID}:environment ${BINDING_ID}:project`,
          shortLabel: `${PUBLIC_STREAM_ID} label`,
          options: [
            {
              value: "first",
              label: `${BINDING_ID}:environment label`,
              description: `${BINDING_ID}:project description`,
            },
          ],
        },
      ],
    });
    expect(result.rows.slice(1)).toEqual([
      expect.objectContaining({ noticeKind: "interaction_unavailable" }),
      expect.objectContaining({ noticeKind: "interaction_unavailable" }),
    ]);
  });

  it("maps resolving interactions and omits every terminal lifecycle", () => {
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [
            question({ id: "question_resolving", lifecycle: "resolving" }),
            question({ id: "question_answered", lifecycle: "answered" }),
            question({ id: "question_interrupted", lifecycle: "interrupted" }),
            approval({ id: "approval_resolving", lifecycle: "resolving" }),
            approval({ id: "approval_granted", lifecycle: "granted" }),
            approval({ id: "approval_denied", lifecycle: "denied" }),
            approval({ id: "approval_interrupted", lifecycle: "interrupted" }),
            approval({
              id: "legacy_denied",
              approvalKind: "file-edit",
              lifecycle: "denied",
              interactionId: "legacy_call_id",
            }),
          ],
        }),
      }),
    );

    expect(result.rows).toMatchObject([
      { kind: "work", workKind: "question", lifecycle: "resolving" },
      { kind: "work", workKind: "approval", lifecycle: "resolving" },
    ]);
  });

  it("omits terminal and legacy interactions and degrades invalid actionable ones", () => {
    const legacyApproval = approval({
      id: "legacy_approval",
      approvalKind: "file-edit",
      lifecycle: "waiting",
      interactionId: "private_call_id",
    });
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [
            question({ id: "answered", lifecycle: "answered" }),
            approval({ id: "granted", lifecycle: "granted" }),
            legacyApproval,
            question({
              id: "invalid_correlation",
              interactionId: "private_interaction_id",
            }),
            question({
              id: "invalid_copy",
              questions: [
                {
                  id: "choice",
                  prompt: "x".repeat(2_049),
                  multiSelect: false,
                  options: [{ value: "first", label: "First" }],
                  allowFreeText: false,
                },
              ],
            }),
          ],
        }),
      }),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual([
      expect.objectContaining({
        kind: "notice",
        noticeKind: "interaction_unavailable",
        label: "A response is unavailable",
      }),
      expect.objectContaining({
        kind: "notice",
        noticeKind: "interaction_unavailable",
        label: "A response is unavailable",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private_interaction_id");
  });

  it("maps only allowlisted system notices", () => {
    const rows: TimelineSystemRow[] = [
      systemRow("error", "error", 1),
      systemRow("reconnect", "reconnect", 2),
      systemRow("interrupt", "operation", 3, {
        operationKind: "thread-interrupted",
      }),
      systemRow("debug", "debug", 4),
      systemRow("other_operation", "operation", 5, {
        operationKind: "generic",
      }),
    ];
    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows }) }),
    );

    expect(result.rows).toMatchObject([
      { kind: "notice", noticeKind: "error", label: "Work failed" },
      {
        kind: "notice",
        noticeKind: "reconnecting",
        label: "Reconnecting…",
      },
      {
        kind: "notice",
        noticeKind: "interrupted",
        label: "Work interrupted",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private title sentinel");
    expect(JSON.stringify(result)).not.toContain("private detail sentinel");
  });

  it("flattens one turn level and merges active tails by private row identity", () => {
    const durableWorkflow = workflow("shared_workflow", 3, "completed");
    const turn: TimelineTurnRow = {
      ...rowBase("private_turn_row", 3),
      kind: "turn",
      turnId: "turn_private_001",
      status: "completed",
      summaryCount: 1,
      completedAt: 2_003,
      children: [durableWorkflow],
    };
    const activeDuplicate = workflow("shared_workflow", 3, "pending");
    const activeOnly = workflow("active_only", 2, "pending");
    const result = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({
          rows: [userMessage("first", "first", 1), turn],
          activeWorkflows: [activeDuplicate, activeOnly],
          activeBackgroundCommands: [activeOnly],
        }),
      }),
    );

    expect(result.rows).toMatchObject([
      { kind: "conversation", text: "first" },
      { kind: "activity", activityKind: "workflow", status: "running" },
      { kind: "activity", activityKind: "workflow", status: "completed" },
    ]);
    expect(result.working).toBe(true);
    const activeId = projectWorkTogetherRoomTimeline(
      input({
        timeline: timeline({ activeWorkflows: [activeDuplicate] }),
      }),
    ).rows[0]?.id;
    expect(result.rows[2]?.id).toBe(activeId);
    expect(JSON.stringify(result)).not.toContain("private_turn_row");
  });

  it("never emits forbidden source keys from the closed DTO union", () => {
    const result = projectWorkTogetherRoomTimeline(
      input({
        privateActiveTurnId: "active_turn_private_sentinel",
        timeline: timeline({
          rows: [
            userMessage("message_private_sentinel"),
            command("command_private_sentinel", 2),
            tool("tool_private_sentinel", "workstream_completeness", 3),
            question(),
            approval(),
            systemRow("system_private_sentinel", "error", 6),
          ],
        }),
      }),
    );
    const forbiddenKeys = [
      "children",
      "childRows",
      "threadId",
      "turnId",
      "callId",
      "itemId",
      "sourceSeqStart",
      "sourceSeqEnd",
      "principalId",
      "principalKind",
      "senderThreadId",
      "turnRequest",
      "attachments",
      "mentions",
      "initiator",
      "systemMessageKind",
      "systemMessageSubject",
      "systemKind",
      "operationKind",
      "parentChange",
      "title",
      "detail",
      "reason",
      "approvalKind",
      "taskType",
      "taskStatus",
      "workflowName",
      "workflow",
      "error",
      "command",
      "cwd",
      "source",
      "output",
      "exitCode",
      "approvalStatus",
      "activityIntents",
      "toolArgs",
      "statusLabels",
      "change",
      "path",
      "movePath",
      "diff",
      "diffStats",
      "stdout",
      "stderr",
      "queries",
      "url",
      "pattern",
      "subagentType",
      "usage",
      "summary",
      "answers",
      "grantScope",
      "statusReason",
      "target",
      "activePromptMode",
      "activeThinking",
      "activeWorkflows",
      "activeBackgroundCommands",
      "pendingTodos",
      "goal",
      "modelFallback",
      "contextWindowUsage",
      "timelinePage",
      "maxSeq",
      "delta",
    ];
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const isActivity =
        "kind" in value && (value as { kind?: unknown }).kind === "activity";
      for (const [key, child] of Object.entries(value)) {
        if (key === "toolName") {
          expect(isActivity).toBe(true);
          continue;
        }
        expect(forbiddenKeys).not.toContain(key);
        visit(child);
      }
    };
    visit(result);
    expect(result.rows).toMatchObject([
      { kind: "conversation" },
      { kind: "activity", activityKind: "command" },
      {
        kind: "activity",
        activityKind: "tool",
        toolName: "workstream_completeness",
      },
      { kind: "work", workKind: "question" },
      { kind: "work", workKind: "approval" },
      { kind: "notice" },
    ]);
    expect(result.rows[1]).not.toHaveProperty("toolName");
    expect(result.rows[4]).not.toHaveProperty("toolName");
    expect(JSON.stringify(result)).not.toContain("private tool");
  });

  it("keeps the newest 512 activities and inserts one stable omission notice", () => {
    const rows = Array.from({ length: 520 }, (_, index) =>
      command(`command_${index}`, index),
    );
    rows[0].createdAt = 9_000;
    const result = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows }) }),
    );
    const firstKept = projectWorkTogetherRoomTimeline(
      input({ timeline: timeline({ rows: [command("command_8", 8)] }) }),
    );

    expect(result.rows).toHaveLength(513);
    expect(result.rows[0]).toMatchObject({
      kind: "notice",
      noticeKind: "activity_truncated",
      label: "Earlier activity omitted",
      createdAt: 9_000,
    });
    expect(result.rows[1]?.id).toBe(firstKept.rows[0]?.id);
    expect(result.rows.filter((row) => row.kind === "activity")).toHaveLength(
      512,
    );
  });

  it("fails closed on total-row, payload-byte, and malformed-source bounds", () => {
    const tooManyRows = Array.from({ length: 769 }, (_, index) =>
      userMessage(`message_${index}`, "x", index),
    );
    const tooManyBytes = Array.from({ length: 32 }, (_, index) =>
      userMessage(`large_message_${index}`, "x".repeat(65_536), index),
    );
    const malformed = userMessage("malformed");
    malformed.sourceSeqEnd = -1;
    const nonFinite = command("non_finite");
    nonFinite.completedAt = Number.NaN;

    expect(() =>
      projectWorkTogetherRoomTimeline(
        input({ timeline: timeline({ rows: tooManyRows }) }),
      ),
    ).toThrow(RoomDistributionUnavailableError);
    expect(() =>
      projectWorkTogetherRoomTimeline(
        input({ timeline: timeline({ rows: tooManyBytes }) }),
      ),
    ).toThrow(RoomDistributionUnavailableError);
    expect(() =>
      projectWorkTogetherRoomTimeline(
        input({ timeline: timeline({ rows: [malformed] }) }),
      ),
    ).toThrow(RoomDistributionUnavailableError);
    expect(() =>
      projectWorkTogetherRoomTimeline(
        input({ timeline: timeline({ rows: [nonFinite] }) }),
      ),
    ).toThrow(RoomDistributionUnavailableError);
  });
});
