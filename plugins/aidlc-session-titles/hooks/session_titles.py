#!/usr/bin/env python3
"""Keeps an AI-DLC session's title in step with the work it is on.

The title, separated by an em dash:

  - working on a Construction Unit:  `<unit> — <stage>`    e.g. `u4-day-navigation — Functional Design`
  - any other AI-DLC work:           `<phase> — <stage>`   e.g. `Inception — Requirements Analysis`

What the session is on is read from the project, never from the assistant: the intent this session is bound to
(aidlc/.aidlc-sessions/<session>.binding.json), else the space's active-intent cursor, else its one live intent; the
stage from the state file's `Unit Stage`, else the engine's active directive when it is newer than the state file,
else `Current Stage`; the Unit from this checkout's claim (aidlc/.aidlc-unit-scope.json), else the directive's unit,
else `Active Unit`, and only on a per-Unit stage. Stage and phase names come from the project's stage graph
(.claude/tools/data/stage-graph.json), else the slug title-cased.

A session counts as an AI-DLC session once it shows it runs the workflow: an `aidlc` engine, unit or claim command
in Bash, an `aidlc*` skill, a prompt starting with `/aidlc`, or a binding file of its own. Other sessions in the
same repository are left alone.

How the title is set:

  1. UserPromptSubmit and SessionStart return it as `hookSpecificOutput.sessionTitle`, which the harness applies.
  2. In the desktop app the title can also change mid-turn, when a stage or a Unit claim moves on: PostToolUse
     tells the assistant, once per new title, to call `mcp__ccd_session_mgmt__set_session_title` with
     `session_id: "self"`. The call is recorded when it succeeds; a declined call is not asked for again.
  3. Stop refuses the end of the turn once per title while the desktop title is still behind.

The state lives in ~/.claude/aidlc-session-titles/<session>.json (AIDLC_SESSION_TITLES_DIR overrides the folder).
The hook does nothing outside an AI-DLC project, in a subagent, or on stdin it cannot read, and never fails the
call it sits beside. Standard library only.
"""

import contextlib
import json
import os
import re
import sys
import tempfile
import time

try:
    import fcntl
except ImportError:  # no advisory locks on this platform: the unique temp file below still keeps writes whole
    fcntl = None

STALE_DAYS = 14  # another session's state file untouched for this long is removed when a state is saved
SEPARATOR = " — "
RENAME_TOOL = "mcp__ccd_session_mgmt__set_session_title"
# The stages that run once per Unit; on any other the title names the phase.
PER_UNIT_STAGES = ("functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
UNIT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SPACE_NAME = re.compile(r"^[a-z][a-z0-9-]*$")
PHASE_HEADING = re.compile(r"^#{2,4}\s+([A-Z][A-Z ]*?)\s+PHASE\s*$")
STAGE_ROW = re.compile(r"^- \[[^\n]\]\s+([a-z0-9][a-z0-9-]*)\s+(?:—|–|--|-)\s+(?:EXECUTE|SKIP)\b")
# `aidlc engine …`, `aidlc unit …`, `aidlc --claim …`, also through a path or wrapper (`./aidlc`, `aidlc.js`).
ENGINE_CALL = re.compile(r"(?:^|[\s;&|(/])aidlc[\w.-]*\s+(?:engine|unit|--claim)\b")
AIDLC_PROMPT = re.compile(r"^\s*/aidlc[\w:-]*\b")


# ---------------------------------------------------------------- state

def state_dir():
    return os.environ.get("AIDLC_SESSION_TITLES_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude", "aidlc-session-titles")


def state_path(event):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(event.get("session_id") or "default"))
    return os.path.join(state_dir(), sid + ".json")


def blank():
    """`aidlc`: the session runs the workflow. `emitted`: the title last handed to the harness. `applied`: the title
    the desktop app last confirmed. `asked`, `declined`, `blocked`: the title the assistant was last told to set,
    refused, or was stopped for."""
    return {"aidlc": False, "emitted": None, "applied": None, "asked": None, "declined": None, "blocked": None,
            "updated": time.time()}


def load(event):
    state = blank()
    try:
        with open(state_path(event), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return state
    if isinstance(data, dict):
        state["aidlc"] = data.get("aidlc") is True
        for key in ("emitted", "applied", "asked", "declined", "blocked"):
            if isinstance(data.get(key), str):
                state[key] = data[key]
    return state


def save(event, state):
    """Write the state whole: a temp file of its own (parallel tool calls run parallel hooks), then an atomic replace."""
    folder = state_dir()
    os.makedirs(folder, exist_ok=True)
    path = state_path(event)
    state["updated"] = time.time()
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise
    sweep(folder, path)


def sweep(folder, keep):
    """Remove the state files of other sessions that nobody touched for STALE_DAYS."""
    limit = time.time() - STALE_DAYS * 86400
    with contextlib.suppress(OSError):
        for name in os.listdir(folder):
            full = os.path.join(folder, name)
            if full != keep and name.endswith((".json", ".lock")) and os.path.getmtime(full) < limit:
                os.remove(full)


@contextlib.contextmanager
def state_lock(event):
    """One hook at a time reads, changes and writes a session's state. Best effort: without the lock the call goes on."""
    handle = None
    if fcntl is not None:
        try:
            os.makedirs(state_dir(), exist_ok=True)
            handle = open(state_path(event) + ".lock", "w", encoding="utf-8")  # noqa: SIM115
            fcntl.flock(handle, fcntl.LOCK_EX)
        except OSError:
            handle = None
    try:
        yield
    finally:
        if handle is not None:
            handle.close()


# ---------------------------------------------------------------- the project

def has_project(folder):
    return bool(folder) and os.path.isdir(os.path.join(folder, "aidlc", "spaces"))


def up_to_project(folder):
    """The folder, or the nearest parent, that holds aidlc/spaces; None when none does."""
    folder = os.path.abspath(folder) if folder else ""
    while folder:
        if has_project(folder):
            return folder
        parent = os.path.dirname(folder)
        if parent == folder:
            break
        folder = parent
    return None


def projects(event):
    """The AI-DLC projects the session may work in, the working directory first: in a git worktree
    CLAUDE_PROJECT_DIR is the main checkout, whose per-clone pointers are not the worktree's."""
    found = []
    for folder in (event.get("cwd"), os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd()):
        project = up_to_project(folder)
        if project and project not in found:
            found.append(project)
    return found


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def read_json(path):
    text = read_text(path)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def first_line(path):
    for line in (read_text(path) or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def safe_session_id(raw):
    return bool(raw) and re.fullmatch(r"[A-Za-z0-9._-]{1,180}", raw) is not None and raw not in (".", "..")


def binding(project, session_id):
    """(space, intent) this session is bound to, else None."""
    if not safe_session_id(session_id):
        return None
    record = read_json(os.path.join(project, "aidlc", ".aidlc-sessions", session_id + ".binding.json"))
    if not isinstance(record, dict):
        return None
    space, intent = record.get("space"), record.get("intent")
    if not isinstance(space, str) or not SPACE_NAME.match(space) or not isinstance(intent, str) or "/" in intent:
        return None
    return space, intent


def state_file(project, space, intent):
    return os.path.join(project, "aidlc", "spaces", space, "intents", intent, "aidlc-state.md")


def is_archived(text):
    return re.search(r"^- \*\*Status\*\*:\s*Archived\s*$", text, re.M) is not None


def live_intent(project, space, intent):
    text = read_text(state_file(project, space, intent)) if intent and "/" not in intent else None
    return text is not None and not is_archived(text)


def selected_intent(project, session_id):
    """(space, intent) the session is on: its binding, else the active space's cursor, else its one live intent."""
    bound = binding(project, session_id)
    if bound and live_intent(project, *bound):
        return bound
    space = first_line(os.path.join(project, "aidlc", "active-space"))
    if not SPACE_NAME.match(space or "") or not os.path.isdir(os.path.join(project, "aidlc", "spaces", space)):
        space = "default"
    intents = os.path.join(project, "aidlc", "spaces", space, "intents")
    cursor = first_line(os.path.join(intents, "active-intent"))
    if live_intent(project, space, cursor):
        return space, cursor
    try:
        names = sorted(os.listdir(intents))
    except OSError:
        return None
    live = [name for name in names if live_intent(project, space, name)]
    return (space, live[0]) if len(live) == 1 else None


def field(text, name):
    found = re.search(r"^\s*-\s*\*\*" + re.escape(name) + r"\*\*:[ \t]*(\S[^\n]*?)?\s*$", text, re.M)
    return (found.group(1) or "").strip() if found else ""


def step(intent_dir, text):
    """(stage, unit or '') the session is shown at: `Unit Stage`, else the active directive when nothing has written
    the state since it was issued, else `Current Stage`."""
    unit_stage = field(text, "Unit Stage").split(" ")[0]
    if SLUG.match(unit_stage):
        return unit_stage, ""
    current = (field(text, "Current Stage").split(" ") or [""])[0]
    current = current if SLUG.match(current) else ""
    directive_path = os.path.join(intent_dir, ".aidlc-engine", "active-directive.json")
    directive_at, state_at = mtime(directive_path), mtime(os.path.join(intent_dir, "aidlc-state.md"))
    if directive_at is None or state_at is None or directive_at < state_at:
        return current, ""
    directive = read_json(directive_path)
    if not isinstance(directive, dict) or directive.get("delivery") == "superseded":
        return current, ""
    stage = directive.get("stage")
    if not isinstance(stage, str) or not SLUG.match(stage):
        return current, ""
    unit = directive.get("unit")
    return stage, (unit if isinstance(unit, str) and UNIT_NAME.match(unit) else "")


def claimed_unit(project, space, intent_uuid):
    """The Unit this checkout has claimed for the intent (the engine's scope file), '' when none."""
    scope = read_json(os.path.join(project, "aidlc", ".aidlc-unit-scope.json"))
    if not isinstance(scope, dict):
        return ""
    unit = scope.get("unit")
    if not isinstance(unit, str) or not UNIT_NAME.match(unit):
        return ""
    if isinstance(scope.get("space"), str) and scope["space"] != space:
        return ""
    if intent_uuid and isinstance(scope.get("intent_uuid"), str) and scope["intent_uuid"] != intent_uuid:
        return ""
    return unit


def intent_uuid(project, space, intent):
    rows = read_json(os.path.join(project, "aidlc", "spaces", space, "intents", "intents.json"))
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("uuid"), str):
            continue
        if row.get("dirName") == intent:
            return row["uuid"]
        if isinstance(row.get("slug"), str) and intent == row["slug"] + "-" + row["uuid"].replace("-", "")[-16:]:
            return row["uuid"]
    return ""


def stage_graph(project):
    """{slug: (name, phase)} from the project's stage graph; empty when there is none."""
    graph = read_json(os.path.join(project, ".claude", "tools", "data", "stage-graph.json"))
    out = {}
    for row in graph if isinstance(graph, list) else []:
        if isinstance(row, dict) and isinstance(row.get("slug"), str):
            name = row.get("name") if isinstance(row.get("name"), str) and row["name"].strip() else ""
            phase = row.get("phase") if isinstance(row.get("phase"), str) else ""
            out[row["slug"]] = (name.strip(), phase.strip())
    return out


def phase_in_state(text, stage):
    """The phase whose `### <NAME> PHASE` heading the stage's row sits under, '' when it is not listed."""
    phase = ""
    for line in text.splitlines():
        heading = PHASE_HEADING.match(line.strip())
        if heading:
            phase = heading.group(1)
            continue
        row = STAGE_ROW.match(line.strip())
        if row and row.group(1) == stage:
            return phase
    return ""


def titled(slug):
    return " ".join(word.capitalize() for word in re.split(r"[-_\s]+", slug) if word)


def expected_title(project, session_id):
    """The title the session should carry, or None when the project does not say what it is on."""
    selected = selected_intent(project, session_id)
    if not selected:
        return None
    space, intent = selected
    intent_dir = os.path.dirname(state_file(project, space, intent))
    text = read_text(state_file(project, space, intent)) or ""
    stage, directive_unit = step(intent_dir, text)
    if not stage:
        return None
    name, phase = stage_graph(project).get(stage, ("", ""))
    stage_name = name or titled(stage)
    if stage in PER_UNIT_STAGES:
        active = field(text, "Active Unit")
        unit = (claimed_unit(project, space, intent_uuid(project, space, intent)) or directive_unit
                or (active if UNIT_NAME.match(active) else ""))
        if unit:
            return unit + SEPARATOR + stage_name
    phase = phase or phase_in_state(text, stage)
    return (titled(phase) + SEPARATOR + stage_name) if phase else None


def title_for(event):
    for project in projects(event):
        title = expected_title(project, str(event.get("session_id") or ""))
        if title:
            return title
    return None


def bound_here(event):
    sid = str(event.get("session_id") or "")
    return any(binding(project, sid) for project in projects(event))


# ---------------------------------------------------------------- what shows the session runs AI-DLC

def shows_aidlc(event):
    tool, ti = event.get("tool_name"), event.get("tool_input") or {}
    if not isinstance(ti, dict):
        return False
    if tool == "Bash":
        return ENGINE_CALL.search(str(ti.get("command") or "")) is not None
    if tool == "Skill":
        return str(ti.get("skill") or "").split(":")[-1].startswith("aidlc")
    return False


def in_desktop():
    return os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop"


def failed(response, title):
    """The rename did not happen: an error result, or the developer declined it. The title is cut out of the text
    first, so a Unit called `u3-error-pages` does not read as a failure."""
    if isinstance(response, dict) and (response.get("isError") or response.get("is_error")):
        return True
    text = response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)
    text = text.replace(title, "").replace(json.dumps(title, ensure_ascii=False)[1:-1], "")
    return re.search(r"\b(declin|denied|refus|not approved|failed|error)", text, re.I) is not None


# ---------------------------------------------------------------- output

def emit(event_name, title=None, context=None):
    out = {"hookEventName": event_name}
    if title:
        out["sessionTitle"] = title
    if context:
        out["additionalContext"] = "aidlc-session-titles: " + context
    print(json.dumps({"hookSpecificOutput": out}))


def rename_instruction(title):
    return (f'this AI-DLC session is now on "{title}". Rename it now: call {RENAME_TOOL} with '
            f'{{"session_id": "self", "title": "{title}"}}, then carry on. Do not mention the rename to the developer.')


# ---------------------------------------------------------------- events

def on_prompt(event, state):
    """UserPromptSubmit and SessionStart: hand the harness the title when it changed since last time."""
    changed = False
    if not state["aidlc"]:
        prompt = str(event.get("prompt") or "")
        if not (AIDLC_PROMPT.match(prompt) or bound_here(event)):
            return False
        state["aidlc"] = changed = True
    title = title_for(event)
    if not title or title == state["emitted"]:
        return changed
    state["emitted"] = title
    if not in_desktop():
        state["applied"] = title  # outside the desktop app the harness title is the only one
    emit(event["hook_event_name"], title=title)
    return True


def on_tool(event, state):
    tool = event.get("tool_name")
    if tool == RENAME_TOOL:
        ti = event.get("tool_input") or {}
        title = ti.get("title") if isinstance(ti, dict) and ti.get("session_id") == "self" else None
        if not isinstance(title, str):
            return False
        if event.get("hook_event_name") == "PostToolUseFailure" or failed(event.get("tool_response"), title):
            state["declined"] = title
        else:
            state["applied"] = title
        return True
    changed = False
    if not state["aidlc"] and (shows_aidlc(event) or bound_here(event)):
        state["aidlc"] = changed = True
    if not state["aidlc"] or not in_desktop():
        return changed
    title = title_for(event)
    if not title or title in (state["applied"], state["asked"], state["declined"]):
        return changed
    state["asked"] = title
    emit(event["hook_event_name"], context=rename_instruction(title))
    return True


def on_stop(event, state):
    """Refuse the end of the turn once per title while the desktop title is behind."""
    if not state["aidlc"] or not in_desktop() or event.get("stop_hook_active"):
        return False
    title = title_for(event)
    if not title or title in (state["applied"], state["declined"], state["blocked"]):
        return False
    state["blocked"] = title
    print(json.dumps({"decision": "block", "reason": "aidlc-session-titles: " + rename_instruction(title)}))
    return True


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict) or event.get("agent_id"):
        return 0  # a subagent cannot rename the session it runs in
    name = event.get("hook_event_name")
    handler = {"UserPromptSubmit": on_prompt, "SessionStart": on_prompt, "PostToolUse": on_tool,
               "PostToolUseFailure": on_tool, "Stop": on_stop}.get(name)
    if handler is None or not projects(event):
        return 0
    try:
        with state_lock(event):
            state = load(event)
            if handler(event, state):
                save(event, state)
    except Exception:  # never break the call this hook sits beside
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
