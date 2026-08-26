---
name: vespyn-fresh-session-kickoff
description: Create a self-contained Markdown handoff in /tmp and return a thin one-line prompt for starting a fresh agent session. Use when the user asks to close out, prepare a fresh-session prompt, save a kickoff file, continue work in a new session, or reduce a long handoff to a one-liner.
---

# Fresh Session Kickoff

Create one repository-agnostic kickoff file whose contents are grounded in the current project and
conversation.

## Workflow

1. Inspect before writing:
   - detect the working directory and Git root, when present;
   - record the exact branch, HEAD revision, and dirty-worktree state;
   - read the project instructions and the plans/evidence directly relevant to the next work;
   - separate verified state from user actions that are planned but not yet confirmed.
2. Create `/tmp/fresh-session-kickoff-YYYYMMDDTHHMMSSZ.md` using the current UTC time.
   Never overwrite an existing kickoff; add a numeric suffix if the timestamp collides.
3. Keep the handoff self-contained and concise. Include:
   - the next-session opening instruction, including any concrete pending question, decision, or
     authorization gate;
   - goal and success criteria;
   - repository/root, exact revision, branch, and worktree state;
   - documents and evidence to read first;
   - completed, deployed, in-progress, and pending work;
   - preflight checks for user-owned or externally performed actions;
   - implementation contracts, scope boundaries, verification, rollout, and honest closure gates.
4. Detect the repository or project name for the document body only. Do not place a repository name
   in the filename or hardcode project-specific assumptions in this skill.
5. Preserve repository files. The skill writes only the new `/tmp` document unless the user
   explicitly requests another destination.
6. Exclude credentials, secrets, private content, raw evidence, source cursors, private locators,
   and unnecessary opaque identifiers. Mention their existence or required verification without
   reproducing them.
7. Do not claim that a pending user action occurred. Tell the fresh session how to verify it, and
   label the pending item accurately as a question, decision, or authorization.
8. After writing, respond with only one copyable line:
   - when an approval or authorization is pending: `Read <path> first and continue from that
handoff; obtain <specific approval> before <gated action>.`
   - when a concrete question or decision is pending: `Read <path> first; resolve <specific question
or decision> before <affected work>.`
   - otherwise: `Read <path> first and continue from that handoff.`

   Name the pending item in plain language. Never say only that there is a question, and never call
   an approval or authorization a question.

If no Git repository exists, use the working-directory name in the document and state that no Git
revision was available.
