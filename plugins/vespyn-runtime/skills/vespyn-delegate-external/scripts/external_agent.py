#!/usr/bin/env python3
"""Route a bounded task to Grok Build, Cursor Agent, or Pi-backed Novita."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None


PROVIDERS = ("grok", "cursor", "novita")
# A returncode-0 dispatch whose stdout is shorter than this is treated as a
# non-delivery, not a success: the worker prompt mandates a report, so anything
# this small means nothing usable came back (e.g. findings that went to an
# out-of-band artifact instead of stdout). Keeps the ledger honest.
EMPTY_OUTPUT_MIN_CHARS = 40
ALLOWED_MODELS = {
    "grok": {"grok-4.6"},
    "cursor": {"auto", "cursor-grok-4.5-high"},
    "novita": {"deepseek/deepseek-v4-flash"},
}
QUOTA_RE = re.compile(
    r"(?:usage|rate|spend|credit|token)\s*(?:limit|quota|exceeded|exhausted)|"
    r"too many requests|insufficient (?:credits|quota)|billing limit|capacity exhausted",
    re.IGNORECASE,
)
AUTH_RE = re.compile(
    r"not (?:logged in|authenticated)|authentication (?:failed|required)|"
    r"unauthorized|sign in|login required|invalid[_ -]?api[_ -]?key",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ProviderConfig:
    enabled: bool = True
    weight: float = 1.0
    model: str | None = None
    reasoning_effort: str | None = None
    thinking_level: str | None = None
    max_turns: int = 80


@dataclass(frozen=True)
class RouterConfig:
    priority: tuple[str, ...] = PROVIDERS
    cooldown_seconds: int = 1800
    quota_cooldown_seconds: int = 14400
    providers: dict[str, ProviderConfig] | None = None


def config_home() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    return Path(base).expanduser() if base else Path.home() / ".config"


def state_home() -> Path:
    base = os.environ.get("XDG_STATE_HOME")
    return Path(base).expanduser() if base else Path.home() / ".local" / "state"


def config_path() -> Path:
    override = os.environ.get("DELEGATE_EXTERNAL_CONFIG")
    return Path(override).expanduser() if override else config_home() / "delegate-external" / "config.toml"


def state_path() -> Path:
    override = os.environ.get("DELEGATE_EXTERNAL_STATE")
    return Path(override).expanduser() if override else state_home() / "delegate-external" / "state.json"


def dispatch_log_path() -> Path:
    override = os.environ.get("DELEGATE_EXTERNAL_LOG")
    return Path(override).expanduser() if override else state_home() / "delegate-external" / "dispatches.jsonl"


def novita_env_path() -> Path:
    return config_home() / "delegate-external" / "novita.env"


def load_local_credentials() -> None:
    """Load the supported local credential file without executing shell code."""
    path = novita_env_path()
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, raw_value = line.partition("=")
        if name.strip() != "NOVITA_API_KEY" or not separator:
            continue
        try:
            values = shlex.split(raw_value.strip(), comments=True)
        except ValueError:
            continue
        if len(values) == 1:
            os.environ.setdefault("NOVITA_API_KEY", values[0])


def log_dispatch(record: dict[str, Any]) -> None:
    """Append one JSONL row per dispatch. Best-effort: never fail a dispatch on a log error."""
    path = dispatch_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, sort_keys=True)
        with path.open("a", encoding="utf-8") as handle:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.write(line + "\n")
    except OSError:
        pass


def read_dispatches(limit: int | None = None) -> list[dict[str, Any]]:
    path = dispatch_log_path()
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        return []
    return rows[-limit:] if limit else rows


def recent_stats(rows: list[dict[str, Any]], provider: str, now: int, window_seconds: int) -> dict[str, Any]:
    """Windowed health derived from the dispatch log — the recent failure rate the
    cumulative counters can't express."""
    recent = [r for r in rows if r.get("provider") == provider and int(r.get("ts", 0)) >= now - window_seconds]
    n = len(recent)
    fails = sum(1 for r in recent if not r.get("success"))
    durations = [float(r.get("duration_s", 0)) for r in recent if r.get("success")]
    return {
        "window_n": n,
        "window_failures": fails,
        "window_failure_rate": (fails / n) if n else 0.0,
        "median_success_duration_s": (sorted(durations)[len(durations) // 2] if durations else 0.0),
    }


def default_provider_state() -> dict[str, Any]:
    return {
        "attempts": 0,
        "successes": 0,
        "failures": 0,
        # consecutive_failures is the live health signal: it resets to 0 on any
        # success, so it answers "is this provider broken right now" without
        # discarding the cumulative attempts/successes/failures history.
        "consecutive_failures": 0,
        "last_attempt_at": 0,
        "last_success_at": 0,
        "blocked_until": 0,
        "last_error": "",
    }


def load_config() -> RouterConfig:
    providers = {
        "grok": ProviderConfig(model="grok-4.6", reasoning_effort="high"),
        "cursor": ProviderConfig(model="auto"),
        "novita": ProviderConfig(model="deepseek/deepseek-v4-flash", thinking_level="high"),
    }
    path = config_path()
    if not path.exists():
        return RouterConfig(providers=providers)
    if tomllib is None:
        raise RuntimeError("Python 3.11+ is required to read router configuration")
    with path.open("rb") as handle:
        raw = tomllib.load(handle)
    router_raw = raw.get("router", {})
    priority = tuple(name for name in router_raw.get("priority", PROVIDERS) if name in PROVIDERS)
    priority += tuple(name for name in PROVIDERS if name not in priority)
    provider_raw = raw.get("providers", {})
    for name in PROVIDERS:
        values = provider_raw.get(name, {})
        defaults = providers[name]
        weight = float(values.get("weight", 1.0))
        if weight <= 0:
            raise ValueError(f"providers.{name}.weight must be greater than zero")
        model = values.get("model", defaults.model) or None
        reasoning_effort = values.get("reasoning_effort", defaults.reasoning_effort) or None
        thinking_level = values.get("thinking_level", defaults.thinking_level) or None
        providers[name] = ProviderConfig(
            enabled=bool(values.get("enabled", True)),
            weight=weight,
            model=str(model) if model else None,
            reasoning_effort=str(reasoning_effort) if reasoning_effort else None,
            thinking_level=str(thinking_level) if thinking_level else None,
            max_turns=max(1, int(values.get("max_turns", 80))),
        )
    return RouterConfig(
        priority=priority,
        cooldown_seconds=max(0, int(router_raw.get("cooldown_seconds", 1800))),
        quota_cooldown_seconds=max(0, int(router_raw.get("quota_cooldown_seconds", 14400))),
        providers=providers,
    )


class StateStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock_path = path.with_suffix(".lock")

    def _load_unlocked(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
            except (OSError, json.JSONDecodeError):
                raw = {}
        else:
            raw = {}
        raw.setdefault("version", 1)
        raw.setdefault("providers", {})
        for name in PROVIDERS:
            existing = raw["providers"].setdefault(name, {})
            for key, value in default_provider_state().items():
                existing.setdefault(key, value)
        return raw

    def read(self) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+") as lock:
            if fcntl:
                fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
            return self._load_unlocked()

    def update(self, provider: str, mutator: Any) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+") as lock:
            if fcntl:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            state = self._load_unlocked()
            mutator(state["providers"][provider])
            temp = self.path.with_suffix(f".tmp.{os.getpid()}")
            temp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
            temp.replace(self.path)
            return state


def executable_for(provider: str) -> str | None:
    if provider == "grok":
        return shutil.which("grok")
    if provider == "novita":
        return shutil.which("pi")
    return shutil.which("agent") or shutil.which("cursor-agent")


def auth_configured(provider: str) -> bool:
    """Return whether the provider's non-interactive credential is present."""
    if provider == "novita":
        return bool(os.environ.get("NOVITA_API_KEY"))
    return True


def unavailable_reason(provider: str) -> str:
    if not executable_for(provider):
        return "executable unavailable"
    if not auth_configured(provider):
        return "NOVITA_API_KEY is not set"
    return "disabled or unavailable"


def available_providers(config: RouterConfig, state: dict[str, Any], now: int) -> list[str]:
    assert config.providers is not None
    result = []
    for name in config.priority:
        provider_config = config.providers[name]
        provider_state = state["providers"][name]
        if (
            provider_config.enabled
            and executable_for(name)
            and auth_configured(name)
            and int(provider_state["blocked_until"]) <= now
        ):
            result.append(name)
    return result


def choose_provider(config: RouterConfig, state: dict[str, Any], requested: str) -> list[str]:
    assert config.providers is not None
    now = int(time.time())
    candidates = available_providers(config, state, now)
    if requested != "auto":
        provider_config = config.providers[requested]
        if not provider_config.enabled or not executable_for(requested) or not auth_configured(requested):
            raise RuntimeError(f"requested provider '{requested}' is {unavailable_reason(requested)}")
        return [requested]
    priority_index = {name: index for index, name in enumerate(config.priority)}
    candidates.sort(
        key=lambda name: (
            int(state["providers"][name]["attempts"]) / config.providers[name].weight,
            priority_index[name],
        )
    )
    return candidates


def worker_prompt(prompt: str, mode: str, allow_nested: bool) -> str:
    mode_rule = (
        "READ-ONLY MODE. Do not modify files or external state. Specifically: do not install, "
        "build, rebuild, or compile anything (no npm/pnpm/yarn install, no node-gyp or native "
        "rebuilds, no test runs that mutate the tree), and do not touch node_modules, lockfiles, "
        "build artifacts, or caches. Investigate by reading and static analysis only, then report."
        if mode == "read"
        else "You may edit files inside the scoped working directory to complete the task."
    )
    nested_rule = (
        "You may use your own subagents only for genuinely independent work."
        if allow_nested
        else "Do not spawn nested subagents."
    )
    return f"""You are an external execution worker delegated by Codex.

{mode_rule}
{nested_rule}
Follow all repository instructions. Preserve pre-existing user changes. Stay within the task scope. Do not commit, push, publish, delete data, access secrets, or modify external systems unless the task explicitly authorizes the exact action. Run relevant verification when possible. End with a concise report of work performed, files changed, checks run, and blockers.

TASK
{prompt.strip()}
"""


def build_command(
    provider: str,
    executable: str,
    cwd: Path,
    prompt: str,
    mode: str,
    provider_config: ProviderConfig,
    model_override: str | None,
    allow_nested: bool,
) -> list[str]:
    model = model_override or provider_config.model
    if model and model not in ALLOWED_MODELS[provider]:
        allowed = ", ".join(sorted(ALLOWED_MODELS[provider]))
        raise ValueError(f"unsupported {provider} model '{model}'; allowed: {allowed}")
    if provider == "cursor":
        command = [
            executable,
            "--print",
            "--output-format",
            "text",
            "--trust",
            "--workspace",
            str(cwd),
        ]
        if mode == "read":
            # Use ask (Q&A, read-only) not plan: plan mode diverts findings into a
            # plan artifact that never reaches stdout, so reviews came back empty.
            # ask answers to stdout and stays read-only.
            command.extend(["--mode", "ask"])
        else:
            command.append("--force")
        if model:
            command.extend(["--model", model])
        command.append(prompt)
        return command

    if provider == "novita":
        command = [
            executable,
            "--print",
            "--mode",
            "text",
            "--provider",
            "novita",
            "--model",
            model or "deepseek/deepseek-v4-flash",
            "--thinking",
            provider_config.thinking_level or "high",
            "--no-session",
            "--approve",
            "--tools",
            "read,grep,find,ls" if mode == "read" else "read,bash,edit,write,grep,find,ls",
            prompt,
        ]
        return command

    command = [
        executable,
        "--single",
        prompt,
        "--output-format",
        "plain",
        "--cwd",
        str(cwd),
        "--max-turns",
        str(provider_config.max_turns),
    ]
    if not allow_nested:
        command.append("--no-subagents")
    if mode == "read":
        command.extend(["--permission-mode", "plan"])
    else:
        command.extend(["--no-plan", "--permission-mode", "bypassPermissions", "--always-approve"])
    if model:
        command.extend(["--model", model])
    if provider_config.reasoning_effort:
        command.extend(["--reasoning-effort", provider_config.reasoning_effort])
    return command


def record_attempt(store: StateStore, provider: str) -> None:
    now = int(time.time())

    def mutate(provider_state: dict[str, Any]) -> None:
        provider_state["attempts"] = int(provider_state["attempts"]) + 1
        provider_state["last_attempt_at"] = now

    store.update(provider, mutate)


def record_result(
    store: StateStore,
    config: RouterConfig,
    provider: str,
    success: bool,
    output: str,
    empty: bool = False,
) -> None:
    now = int(time.time())
    quota_limited = bool(QUOTA_RE.search(output))
    auth_failed = bool(AUTH_RE.search(output))

    def mutate(provider_state: dict[str, Any]) -> None:
        if success:
            provider_state["successes"] = int(provider_state["successes"]) + 1
            provider_state["consecutive_failures"] = 0
            provider_state["last_success_at"] = now
            provider_state["blocked_until"] = 0
            provider_state["last_error"] = ""
            return
        provider_state["failures"] = int(provider_state["failures"]) + 1
        provider_state["consecutive_failures"] = int(provider_state.get("consecutive_failures", 0)) + 1
        cooldown = config.quota_cooldown_seconds if quota_limited else config.cooldown_seconds
        if auth_failed:
            cooldown = max(cooldown, 300)
        provider_state["blocked_until"] = now + cooldown
        if empty:
            provider_state["last_error"] = "exit 0 but empty/degenerate output (worker delivered nothing usable to stdout)"
        else:
            provider_state["last_error"] = " ".join(output.strip().split())[-400:]

    store.update(provider, mutate)


def run_process(command: list[str], cwd: Path, timeout: int, provider: str | None = None) -> tuple[int, str]:
    environment = os.environ.copy()
    if provider == "novita":
        # Keep Pi's local safety extensions in place while making this non-interactive
        # worker explicitly autonomous. Those extensions still block publication and
        # protected-path mutations.
        environment["PI_AUTONOMOUS"] = "1"
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, output or ""
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        return 124, (output or "") + f"\nExternal worker timed out after {timeout} seconds."


def run_task(args: argparse.Namespace) -> int:
    cwd = Path(args.cwd).expanduser().resolve()
    if not cwd.is_dir():
        raise ValueError(f"working directory does not exist: {cwd}")
    if bool(args.prompt) == bool(args.prompt_file):
        raise ValueError("provide exactly one of --prompt or --prompt-file")
    prompt = args.prompt if args.prompt else Path(args.prompt_file).expanduser().read_text()
    if not prompt.strip():
        raise ValueError("prompt cannot be empty")

    config = load_config()
    store = StateStore(state_path())
    state = store.read()
    candidates = choose_provider(config, state, args.provider)
    if not candidates:
        raise RuntimeError("no enabled external provider is installed and out of cooldown")
    if args.provider != "auto":
        candidates = candidates[:1]
    elif args.mode == "write":
        candidates = candidates[:1]
    # Read/review auto-routing is balanced by weight and dispatch count (via
    # choose_provider), same as writes: cursor reads deliver again in --mode ask,
    # so there is no grok-first bias. The lower-dispatch provider is tried first,
    # with the other kept as read-only fallback.

    wrapped_prompt = worker_prompt(prompt, args.mode, args.allow_nested)
    assert config.providers is not None
    failures: list[str] = []
    for provider in candidates:
        executable = executable_for(provider)
        if not executable:
            continue
        record_attempt(store, provider)
        print(f"delegate-external: provider={provider} mode={args.mode} cwd={cwd}", file=sys.stderr)
        command = build_command(
            provider,
            executable,
            cwd,
            wrapped_prompt,
            args.mode,
            config.providers[provider],
            args.model,
            args.allow_nested,
        )
        started = time.time()
        returncode, output = run_process(command, cwd, args.timeout, provider)
        duration = round(time.time() - started, 3)
        delivered = len(output.strip()) >= EMPTY_OUTPUT_MIN_CHARS
        empty_output = returncode == 0 and not delivered
        success = returncode == 0 and delivered
        record_result(store, config, provider, success, output, empty=empty_output)
        log_dispatch(
            {
                "ts": int(started),
                "iso": human_time(int(started)),
                "provider": provider,
                "requested": args.provider,
                "mode": args.mode,
                "cwd": str(cwd),
                "model": args.model or config.providers[provider].model,
                "duration_s": duration,
                "returncode": returncode,
                "success": success,
                "empty_output": empty_output,
                "timed_out": returncode == 124,
                "quota_limited": bool(QUOTA_RE.search(output)),
                "auth_failed": bool(AUTH_RE.search(output)),
                "prompt_chars": len(prompt),
                "output_chars": len(output),
                "error_tail": (
                    "" if success else "empty output" if empty_output
                    else " ".join(output.strip().split())[-300:]
                ),
            }
        )
        if output:
            print(output.rstrip())
        if success:
            return 0
        failures.append(
            f"{provider} returned empty output" if empty_output else f"{provider} exited {returncode}"
        )
        if args.mode == "read" and provider != candidates[-1]:
            print(f"delegate-external: {failures[-1]}; trying next provider", file=sys.stderr)

    raise RuntimeError("; ".join(failures) or "external provider failed without output")


def human_time(timestamp: int) -> str:
    if timestamp <= 0:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(timestamp))


RECENT_WINDOW_SECONDS = 24 * 3600


def print_status(as_json: bool) -> int:
    config = load_config()
    state = StateStore(state_path()).read()
    dispatches = read_dispatches()
    now = int(time.time())
    assert config.providers is not None
    rows = {}
    for name in PROVIDERS:
        provider_state = state["providers"][name]
        recent = recent_stats(dispatches, name, now, RECENT_WINDOW_SECONDS)
        rows[name] = {
            "executable": executable_for(name),
            "enabled": config.providers[name].enabled,
            "weight": config.providers[name].weight,
            "model": config.providers[name].model,
            "reasoning_effort": config.providers[name].reasoning_effort,
            "thinking_level": config.providers[name].thinking_level,
            "attempts": provider_state["attempts"],
            "successes": provider_state["successes"],
            "failures": provider_state["failures"],
            "consecutive_failures": provider_state.get("consecutive_failures", 0),
            "last_success_at": provider_state["last_success_at"],
            "blocked_until": provider_state["blocked_until"],
            "recent_24h": recent,
            "available_now": bool(
                executable_for(name)
                and config.providers[name].enabled
                and auth_configured(name)
                and int(provider_state["blocked_until"]) <= now
            ),
        }
    if as_json:
        print(json.dumps({"config": str(config_path()), "state": str(state_path()),
                          "log": str(dispatch_log_path()), "providers": rows}, indent=2))
        return 0
    print("Provider  Ready  Weight  Attempts  Success  Failure  ConsecFail  24h(n/fail/rate)  MedDur")
    for name in PROVIDERS:
        row = rows[name]
        r = row["recent_24h"]
        recent_col = f"{r['window_n']}/{r['window_failures']}/{r['window_failure_rate']:.0%}"
        print(
            f"{name:<9} {str(row['available_now']):<6} {row['weight']:<7g} "
            f"{row['attempts']:<9} {row['successes']:<8} {row['failures']:<8} "
            f"{row['consecutive_failures']:<11} {recent_col:<17} {r['median_success_duration_s']:.0f}s"
        )
        if int(row["blocked_until"]) > now:
            print(f"          cooldown until {human_time(int(row['blocked_until']))}")
    print(f"Config: {config_path()}")
    print(f"State:  {state_path()}")
    print(f"Log:    {dispatch_log_path()}  ({len(dispatches)} dispatches)")
    print("Quota:  no stable remaining-quota CLI; auto uses weights, dispatch history, and cooldowns")
    return 0


def print_log(limit: int) -> int:
    rows = read_dispatches(limit)
    if not rows:
        print(f"delegate-external: no dispatches logged yet ({dispatch_log_path()})")
        return 0
    print("Time                  Provider  Mode   Dur     RC  Task cwd")
    for r in rows:
        flag = "ok " if r.get("success") else "FAIL"
        tags = "".join(t for t, on in (("Q", r.get("quota_limited")), ("A", r.get("auth_failed")),
                                        ("T", r.get("timed_out"))) if on)
        print(
            f"{r.get('iso','-'):<21} {r.get('provider','-'):<9} {r.get('mode','-'):<6} "
            f"{float(r.get('duration_s',0)):>6.0f}s {int(r.get('returncode',0)):>3} "
            f"{flag}{(' '+tags) if tags else ''}  {r.get('cwd','')}"
        )
    return 0


def reset_counters(provider: str | None) -> int:
    """Manually zero the cumulative counters (attempts/successes/failures/consecutive) and
    clear cooldown. Does not touch the dispatch log, which stays the immutable history."""
    store = StateStore(state_path())
    targets = [provider] if provider and provider != "all" else list(PROVIDERS)

    def mutate(provider_state: dict[str, Any]) -> None:
        for key in ("attempts", "successes", "failures", "consecutive_failures", "blocked_until"):
            provider_state[key] = 0
        provider_state["last_error"] = ""

    for name in targets:
        store.update(name, mutate)
    print(f"delegate-external: reset counters for {', '.join(targets)} (dispatch log preserved)")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="show provider and router status")
    parser.add_argument("--json", action="store_true", help="emit status as JSON")
    parser.add_argument("--log", nargs="?", type=int, const=20, metavar="N",
                        help="show the last N dispatches from the log (default 20)")
    parser.add_argument("--reset", nargs="?", const="all", choices=("all",) + PROVIDERS,
                        help="zero the cumulative counters for a provider (or all); keeps the dispatch log")
    parser.add_argument("--provider", choices=("auto",) + PROVIDERS, default="auto")
    parser.add_argument("--mode", choices=("read", "write"), default="read")
    parser.add_argument("--cwd", default=os.getcwd())
    prompt_group = parser.add_mutually_exclusive_group()
    prompt_group.add_argument("--prompt")
    prompt_group.add_argument("--prompt-file")
    parser.add_argument("--model", help="override the configured provider model")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--allow-nested", action="store_true")
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    maintenance = args.status or args.log is not None or args.reset is not None
    if not maintenance and not (args.prompt or args.prompt_file):
        parser.error("a prompt is required unless --status/--log/--reset is used")
    return args


def main() -> int:
    try:
        load_local_credentials()
        args = parse_args()
        if args.reset is not None:
            return reset_counters(args.reset)
        if args.log is not None:
            return print_log(args.log)
        if args.status:
            return print_status(args.json)
        return run_task(args)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"delegate-external: error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
