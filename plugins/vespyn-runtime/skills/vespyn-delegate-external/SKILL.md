---
name: vespyn-delegate-external
description: Delegate bounded codebase exploration, implementation, testing, review, or summarization work to the subscription-backed Grok Build, Cursor Agent, or Pi-backed Novita CLI while Codex retains planning, orchestration, judgment, and final verification. Use when the user asks to save Codex usage, use external-agent capacity, avoid Luna/Terra subagents, or when routine execution can be offloaded without losing essential decision context.
---

# Delegate External

Use Codex as the orchestrator and invoke Grok, Cursor, or the Pi-backed Novita worker as a subprocess. Do not call Codex's built-in subagent tools for work selected for this skill.

When the parent session itself runs on Grok, never recursively delegate back to Grok. Inspect router
status, choose Cursor when ready, otherwise choose Novita when ready, and report the blocker when
neither is available. Keep `auto` routing for non-Grok parents.

## Decide what to delegate

Delegate bounded execution with a concrete goal, scope, constraints, and verification command. Good candidates include codebase searches, routine implementation from an approved plan, targeted tests, mechanical refactors, and independent review.

Keep ambiguous product decisions, architecture, security-sensitive judgment, destructive operations, external publishing, and final acceptance in the Codex thread. Never delegate merely to avoid understanding the result.

Use read mode for exploration, review, planning, and diagnosis. Use write mode only when the user authorized changes and the working directory is an exact trusted workspace.

## Run a worker

Resolve this skill directory and run its router with Python:

```bash
python3 <skill-dir>/scripts/external_agent.py \
  --provider auto \
  --mode read \
  --cwd "$PWD" \
  --prompt "Map the authentication flow. Return files, symbols, risks, and unanswered questions."
```

For authorized implementation, change `--mode read` to `--mode write`. Prefer `--prompt-file` for long task packets. Use `--provider grok` or `--provider cursor` only when the user requests one or auto-routing is unsuitable. Add `--allow-nested` only when independent parallelism clearly helps and concurrent edits cannot conflict.

The router selects an installed, enabled provider by configured capacity weight and local dispatch count. It cools down failed or quota-limited providers and automatically tries another provider for read-only work. It does not automatically retry write work with a second provider because the first may have partially edited the workspace. The `novita` provider runs the installed `pi` coding agent against DeepSeek V4 Flash through Novita's OpenAI-compatible API; it is available when `NOVITA_API_KEY` is exported or when `~/.config/delegate-external/novita.env` contains a local `NOVITA_API_KEY=...` assignment.

Cursor read/review runs in `--mode ask` (Q&A, read-only), which returns the review on stdout. Do **not** use cursor `--mode plan` here: plan mode diverts findings into an out-of-band plan artifact the router's stdout capture never receives, so plan-mode reviews came back empty. Pi read/review runs with only read/search/list tools. As a safety net, any returncode-0 dispatch that returns almost no stdout is recorded as a **failure**, not a success, so the ledger and `--log` reflect non-delivery honestly. For `--mode read`, auto-routing is **balanced** by weight and dispatch count — the lower-dispatch provider is tried first, with another provider as the read-only fallback. Adjust the balance via provider `weight` in the config.

## Build the task packet

Include:

- the exact outcome and non-goals;
- the allowed files or subsystem;
- relevant decisions already made by Codex;
- repository instructions to follow;
- commands or behavior that prove completion;
- a request for a concise summary of changes, checks, and blockers.

Do not paste broad conversation history, secrets, or irrelevant artifacts. Tell the worker to preserve existing changes and avoid commits, pushes, publishing, or destructive actions unless the user's task explicitly authorizes the exact action.

## Review the result

Inspect the worker's output and the actual workspace diff. Run or independently verify the risk-proportionate checks. Correct weak work locally or issue a bounded follow-up through the router; do not accept the worker's self-report as proof.

## Inspect routing

```bash
python3 <skill-dir>/scripts/external_agent.py --status        # provider health: cumulative + 24h window + consecutive failures
python3 <skill-dir>/scripts/external_agent.py --log 20        # last 20 dispatches (time, provider, mode, duration, outcome, cwd)
python3 <skill-dir>/scripts/external_agent.py --reset [grok|cursor|novita|all]   # zero the cumulative counters (keeps the log)
```

Every dispatch appends one JSONL row to `~/.local/state/delegate-external/dispatches.jsonl` (the immutable history). `--status` reports two independent signals: the **cumulative** attempts/successes/failures (lifetime), and — derived from the dispatch log — a **24h window** (`n/failures/rate` + median success duration) plus `ConsecFail`, the consecutive-failure count that resets to zero on any success. Use `ConsecFail` and the 24h rate, not the cumulative failure total, to judge whether a provider is degraded right now. `--reset` zeroes the cumulative counters and clears cooldown for a fresh baseline; it never touches the dispatch log, so the windowed rate stays truthful.

Neither supported subscription CLI currently exposes a stable machine-readable remaining-quota command. Auto-routing therefore uses local dispatch history, provider failures, and optional capacity weights. Configure weights in `~/.config/delegate-external/config.toml`:

```toml
[router]
priority = ["grok", "cursor", "novita"]
cooldown_seconds = 1800
quota_cooldown_seconds = 14400

[providers.grok]
enabled = true
weight = 2.0
model = "grok-4.6"
reasoning_effort = "high"

[providers.cursor]
enabled = true
weight = 1.0
model = "auto" # alternatively: "cursor-grok-4.5-high"

[providers.novita]
enabled = true
weight = 1.0
model = "deepseek/deepseek-v4-flash"
thinking_level = "high"
```

A weight of `2.0` gives a provider roughly twice as many auto-routed dispatches as a provider at `1.0`. Update weights when subscription headroom changes. Explicit `--provider` selection always wins.

The installed model identifiers verified for this workflow are `grok-4.6` with `reasoning_effort = "high"` in Grok Build, either `auto` or `cursor-grok-4.5-high` in Cursor, and `deepseek/deepseek-v4-flash` with `thinking_level = "high"` in Pi via Novita. The router defaults to Grok 4.6 High, Cursor Auto, and Novita Think Max when the corresponding provider is configured and authenticated.

Keep Cursor restricted to `auto` or `cursor-grok-4.5-high`; do not spend this workflow's capacity on other Cursor models. Keep the Grok provider on `grok-4.6` at high reasoning. Keep Novita on the canonical `deepseek/deepseek-v4-flash` model ID; Novita's July 31, 2026 refresh is behind that stable ID. Use `--model` only together with an explicit `--provider`.

## Handle failures

If all providers are unavailable, authentication is missing, or write-mode execution fails, report the exact blocker. Do not silently fall back to a Codex subagent. Continue in the primary Codex thread only when the task is small or quality-critical; otherwise ask the user whether to use Codex capacity.
