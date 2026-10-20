#!/usr/bin/env python3
"""Guard for the AI-DLC approval gate: the developer reads the stage's documents in a page before being asked.

The order, for the session that opens a gate:

 1. The engine's `aidlc engine orchestrate report --stage S --result awaiting-approval|revised` opens the gate.
    This hook notices it (PostToolUse Bash) and tells the assistant to publish the stage's documents:
    `scripts/gate_bundle.py` builds the rows, one ArtifactData batch writes them into the developer's
    "AI-DLC approval gates" artifact.
 2. This hook notices the write of a `gates` row for the stage (PostToolUse ArtifactData).
 3. Until that has happened, the Approval question (header `Approval`, options such as Approve) and the
    approved or rejected report are refused (PreToolUse). The page's link `<artifact url>#<gate id>` goes
    to the developer in a message of its own before the question: the question is refused until a message
    of the assistant in the session's transcript (the `transcript_path` of the hook input) carries that
    link, and a question that carries the link itself is refused, so the dialog stays readable.
 4. A write that sets `status: "decided"`, or carries `decision` or `notes`, on a `gates` row is refused: those
    belong to the developer, who writes them in the page.
 5. When the developer answers Request Changes, the assistant is told to read the notes they left in the page.

The state lives in ~/.claude/approval-gates/<session>.json (APPROVAL_GATES_DIR overrides the folder) and is
changed by this hook only. The developer clears it by typing /approval-gates:release.

Fires on PreToolUse (refuses with exit code 2 and the reason on stderr), PostToolUse (records, tells the
assistant what to do) and UserPromptSubmit (the release command). It does nothing outside an AI-DLC project
(no `aidlc/spaces` under $CLAUDE_PROJECT_DIR, else the working directory), does nothing on stdin it cannot
read, and never fails a PostToolUse or UserPromptSubmit call. A PreToolUse call that is known to be guarded
and cannot be checked is refused. Standard library only.
"""

import contextlib
import datetime
import json
import os
import re
import shlex
import sys
import tempfile
import time

try:
    import fcntl
except ImportError:  # no advisory locks on this platform: the unique temp file below still keeps writes whole
    fcntl = None

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STALE_DAYS = 14  # another session's state file untouched for this long is removed when a state is saved
GATE_LABELS = {"approve", "approve plan", "accept as-is"}
CLOSING = {"approved", "rejected", "accepted"}
OPENING = {"awaiting-approval", "revised"}
RELEASE_PROMPT = re.compile(r"^\s*/(?:(approval-gates):)?release\b")
OPS = re.compile(r"^[();<>|&]+$")
RELEASE_HINT = "(Blocked by the approval-gates plugin. The developer can release it by typing /approval-gates:release.)"


class Refusal(Exception):
    pass


# ---------------------------------------------------------------- state

def state_dir():
    return os.environ.get("APPROVAL_GATES_DIR") or os.path.join(os.path.expanduser("~"), ".claude", "approval-gates")


def state_path(event):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(event.get("session_id") or "default"))
    return os.path.join(state_dir(), sid + ".json")


def blank():
    return {"pending": None, "published": {}, "updated": time.time()}


def normalize(data):
    state = blank()
    if isinstance(data, dict):
        if isinstance(data.get("pending"), dict):
            state["pending"] = data["pending"]
        if isinstance(data.get("published"), dict):
            state["published"] = {k: v for k, v in data["published"].items() if isinstance(v, dict)}
        if isinstance(data.get("updated"), (int, float)):
            state["updated"] = data["updated"]
    return state


def load(event):
    """The session's state; a fresh one when there is none. A state that cannot be read refuses."""
    try:
        with open(state_path(event), encoding="utf-8") as f:
            return normalize(json.load(f))
    except FileNotFoundError:
        return blank()
    except (OSError, ValueError) as exc:
        raise Refusal(f"the approval-gates state of this session cannot be read ({exc}).") from None


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


def drop(event):
    for path in (state_path(event), state_path(event) + ".lock"):
        with contextlib.suppress(OSError):
            os.remove(path)


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


def project_dir(event):
    """The AI-DLC project the session works in. The working directory wins over CLAUDE_PROJECT_DIR when both hold a
    project: in a git worktree CLAUDE_PROJECT_DIR is the main checkout, whose per-clone pointers (aidlc/active-space,
    intents/active-intent, .aidlc-engine/) are not the worktree's. Of the folders that hold a project, the first whose
    active intent resolves is it; else the first one; else CLAUDE_PROJECT_DIR or the working directory as given."""
    given = [event.get("cwd"), os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd()]
    found = []
    for folder in given:
        project = up_to_project(folder)
        if project and project not in found:
            found.append(project)
    for project in found:
        if intent_root(project)[1]:
            return project
    return found[0] if found else (os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd())


def first_line(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    return line.strip()
    except OSError:
        pass
    return ""


def intent_root(project):
    """(intent name, record folder) of the active intent, or (None, None)."""
    space = first_line(os.path.join(project, "aidlc", "active-space"))
    if not space:
        return None, None
    intents = os.path.join(project, "aidlc", "spaces", space, "intents")
    intent = first_line(os.path.join(intents, "active-intent"))
    return (intent, os.path.join(intents, intent)) if intent else (None, None)


def current_stage(project):
    """(stage, unit) the engine is at: the active directive's `stage` and `unit`, else the `Current Stage` line of
    aidlc-state.md. None when neither can be read."""
    _intent, root = intent_root(project)
    if not root:
        return None
    try:
        with open(os.path.join(root, ".aidlc-engine", "active-directive.json"), encoding="utf-8") as f:
            directive = json.load(f)
        stage = directive.get("stage")
        if isinstance(stage, str) and stage.strip():
            unit = directive.get("unit")
            return stage.strip(), (unit.strip() if isinstance(unit, str) and unit.strip() else None)
    except (OSError, ValueError, AttributeError):
        pass
    try:
        with open(os.path.join(root, "aidlc-state.md"), encoding="utf-8") as f:
            found = re.search(r"^\s*-\s*\*\*Current Stage\*\*:[ \t]*([a-z0-9][a-z0-9-]*)", f.read(), re.M)
        if found:
            return found.group(1), None
    except OSError:
        pass
    return None


def make_key(stage, unit):
    return stage + (("/" + unit) if unit else "")


# ---------------------------------------------------------------- tool calls

def questions_of(tool_input):
    qs = (tool_input or {}).get("questions")
    return [q for q in qs if isinstance(q, dict)] if isinstance(qs, list) else []


def norm(text):
    return re.sub(r"\s+", " ", str(text)).strip().strip('"').lower()


def labels(question):
    return {norm(o.get("label", "")) for o in question.get("options") or [] if isinstance(o, dict)}


def answers_of(response):
    """{question: answer} from an AskUserQuestion tool response (`answers`, or the text form)."""
    if isinstance(response, dict):
        ans = response.get("answers")
        if isinstance(ans, dict):
            return {str(q): (", ".join(map(str, a)) if isinstance(a, list) else str(a)) for q, a in ans.items()}
    text = flat(response)
    return {m.group(1): m.group(2) for m in re.finditer(r'"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"', text)}


def flat(response):
    if isinstance(response, str):
        return response
    if isinstance(response, list):
        return "\n".join(flat(r) for r in response)
    if isinstance(response, dict):
        if isinstance(response.get("text"), str):
            return response["text"]
        return json.dumps(response, ensure_ascii=False)
    return ""


def writes_of(tool_input):
    """[(op, collection, doc_id, data or None, url)] for an ArtifactData write call."""
    action = (tool_input or {}).get("action")
    url = (tool_input or {}).get("url", "")
    if action == "batch":
        return [(w.get("op"), w.get("collection", ""), w.get("doc_id", ""), payload(w), url)
                for w in tool_input.get("writes") or [] if isinstance(w, dict)]
    if action in ("set", "update", "delete", "str_replace"):
        data = payload(tool_input)
        if action == "str_replace":
            data = {tool_input.get("field", ""): tool_input.get("new_str", "")}
        return [(action, tool_input.get("collection", ""), tool_input.get("doc_id", ""), data, url)]
    return []


def payload(w):
    if isinstance(w.get("data"), dict):
        return w["data"]
    path = w.get("file_path")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return None  # unreadable: the caller treats an unknown payload as unsafe
    return {}


def failed(response):
    """True when a tool response says the call did not succeed."""
    if isinstance(response, dict):
        return bool(response.get("is_error") or response.get("error"))
    return isinstance(response, str) and response.lstrip().lower().startswith("error")


# ---------------------------------------------------------------- engine commands

def option_map(tokens):
    """{'stage': 'x', 'result': 'y'} from `--stage x --result y` and `--stage=x` tokens."""
    found, i = {}, 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--") and len(tok) > 2:
            if "=" in tok:
                name, _, value = tok[2:].partition("=")
                found[name] = value
            elif i + 1 < len(tokens) and not tokens[i + 1].startswith("--"):
                found[tok[2:]] = tokens[i + 1]
                i += 1
        i += 1
    return found


def from_tokens(seg):
    """The engine calls one simple command makes: [{'kind': 'report'|'decision', ...}]."""
    calls = []
    for i in range(1, len(seg) - 2):
        if not os.path.basename(seg[i - 1]).startswith("aidlc"):
            continue
        triple = seg[i:i + 3]
        opts = option_map(seg[i + 3:])
        if triple == ["engine", "orchestrate", "report"]:
            calls.append({"kind": "report", "stage": opts.get("stage"), "result": opts.get("result"),
                          "unit": opts.get("unit")})
        elif triple == ["engine", "log", "decision"]:
            calls.append({"kind": "decision", "stage": opts.get("stage"), "checkpoint": opts.get("checkpoint"),
                          "unit": opts.get("unit")})
    return calls


def tokens_of(line):
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def regex_calls(command):
    """The fallback when shlex cannot parse the command."""
    def grab(name, text):
        found = re.search(r"--" + name + r"[= ]\s*[\"']?([\w.-]+)", text)
        return found.group(1) if found else None

    calls = []
    for m in re.finditer(r"aidlc\S*\s+engine\s+(orchestrate\s+report|log\s+decision)\b([^;&|\n]*)", command):
        rest = m.group(2)
        if m.group(1).startswith("orchestrate"):
            calls.append({"kind": "report", "stage": grab("stage", rest), "result": grab("result", rest),
                          "unit": grab("unit", rest)})
        else:
            calls.append({"kind": "decision", "stage": grab("stage", rest), "checkpoint": grab("checkpoint", rest),
                          "unit": grab("unit", rest)})
    return calls


def engine_calls(command):
    """The `aidlc engine orchestrate report` and `aidlc engine log decision` calls in a shell command line,
    parsed with shlex and split on `&&`, `;`, `|` and newlines (no other shell structure is followed)."""
    if "aidlc" not in command:
        return []
    calls = []
    try:
        for line in command.splitlines():
            seg = []
            for tok in tokens_of(line) + [";"]:
                if OPS.match(tok):
                    calls.extend(from_tokens(seg))
                    seg = []
                else:
                    seg.append(tok)
    except ValueError:
        return regex_calls(command)
    return calls


# ---------------------------------------------------------------- gates

def names_pull_request(text):
    if re.search(r"/pull/\d+", text):
        return True
    text = re.sub(r"https?://\S+", " ", text)
    return bool(re.search(r"(?<![\w/.#&-])#\d+(?![\w-])|[\w.-]+/[\w.-]+#\d+(?![\w-])", text))


def is_gate(question):
    """An AI-DLC Approval question: header Approval, an approving option, and no pull request named in it."""
    if norm(question.get("header", "")) != "approval" or not labels(question) & GATE_LABELS:
        return False
    return not names_pull_request(str(question.get("question", "")))


def publish_instruction(stage, unit):
    script = os.path.join(PLUGIN_ROOT, "scripts", "gate_bundle.py")
    cmd = f'python3 "{script}" --stage {stage}' + (f" --unit {unit}" if unit else "")
    return (f"run `{cmd} --why <first|revision> --summary-file <a file holding your summary> --out <a scratch folder>`, "
            "write the rows of its writes.json with one ArtifactData batch, and give the developer the link "
            "`<artifact url>#<gate id>` in a message of its own before the question (never inside the question)")


def target_of(state, project, call_stage=None, call_unit=None):
    """(stage, unit, opened_at or None) the gate in hand is about."""
    pending = state["pending"]
    if call_stage:
        unit = call_unit
        if pending and pending.get("stage") == call_stage and not unit:
            unit = pending.get("unit")
        else:
            cur = current_stage(project)
            if not unit and cur and cur[0] == call_stage:
                unit = cur[1]
        stage = call_stage
    elif pending:
        stage, unit = pending.get("stage"), pending.get("unit")
    else:
        cur = current_stage(project)
        if not cur:
            return None, None, None
        stage, unit = cur
    opened = None
    if pending and pending.get("stage") == stage and (pending.get("unit") or None) == (unit or None):
        opened = pending.get("opened_at")
    return stage, unit, opened


def require_published(state, stage, unit, opened):
    """The record of this stage's gate page, or a Refusal when it was not published since the gate opened. A row
    recorded by its id alone (the stage was unknown when it was written) counts when its id names this stage."""
    pub = state["published"].get(make_key(stage, unit))
    if not pub:
        pub = next((p for p in state["published"].values() if id_matches(p.get("id"), None, stage, unit)), None)
    if not pub or (isinstance(opened, (int, float)) and pub.get("at", 0) < opened):
        raise Refusal("The developer reads the stage's documents in the AI-DLC approval gates page before being "
                      f"asked. Publish them first: {publish_instruction(stage, unit)}.")
    return pub


def check_gate_rows(tool_input):
    """The developer's fields of a gate row are written by the page only."""
    for op, collection, doc_id, data, _url in writes_of(tool_input):
        if collection != "gates" or op == "delete":
            continue
        if data is None:
            raise Refusal(f"The write to gates/{doc_id} cannot be read, so it cannot be checked. Write the row "
                          "from the file gate_bundle.py made, or with data given inline.")
        if str(data.get("status", "")).lower() == "decided" or "decision" in data or "notes" in data:
            raise Refusal(f"gates/{doc_id}: `status: \"decided\"`, `decision` and `notes` are written by the "
                          "developer in the page. Never write them, and never update a row you wrote.")


def link_of(pub):
    """The link the developer gets: `<artifact url>#<gate id>`, the `#<gate id>` alone when the url is unknown."""
    url = str(pub.get("url", "")).strip()
    return f"{url}#{pub.get('id', '')}"


def epoch_of(stamp):
    try:
        return datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def link_sent(event, pub):
    """(True, _) when a message of the assistant in this session's transcript carries the page's link; else
    (False, counts) of the assistant's text, thinking and tool_use blocks written since the page was published.
    Tool results, the developer's prompts and subagent transcripts do not count. An unreadable transcript refuses."""
    gate_id, needle, since = str(pub.get("id", "")), link_of(pub), pub.get("at")
    path = event.get("transcript_path")
    if not path or not gate_id:
        raise Refusal("the session transcript is not given, so whether the developer got the page's link cannot "
                      "be checked.")
    counts = {"text": 0, "thinking": 0, "tool_use": 0}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"assistant"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
                    continue
                content = (entry.get("message") or {}).get("content") if isinstance(entry.get("message"), dict) else None
                blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
                stamp = epoch_of(entry.get("timestamp"))
                recent = isinstance(since, (int, float)) and stamp is not None and stamp >= since
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and needle in str(block.get("text", "")):
                        return True, counts
                    if recent and block.get("type") in counts:
                        counts[block["type"]] += 1
    except OSError as exc:
        raise Refusal(f"the session transcript cannot be read ({exc}), so whether the developer got the page's "
                      "link cannot be checked.") from None
    return False, counts


def guard_question(event, state, project, questions):
    for q in questions:
        stage, unit, opened = target_of(state, project)
        if not stage:
            continue
        pub = require_published(state, stage, unit, opened)
        text = str(q.get("question", ""))
        url = str(pub.get("url", "")).strip()
        if (url and url in text) or re.search(r"claude\.ai/artifact/|#[0-9]{6}-[a-z0-9.-]+-\d{8}T\d{4}\b", text, re.I):
            raise Refusal("The page's link goes to the developer in a message of its own, before the question; the "
                          "question text carries no link. Send the link "
                          f"{link_of(pub)} as a message, then ask the engine's question as it is.")
        sent, counts = link_sent(event, pub)
        if not sent:
            raise Refusal("The developer gets the page's link before the question, and no message of yours carries "
                          f"it yet. Since gates/{pub.get('id', '')} was published, your transcript holds "
                          f"{counts['thinking']} thinking, {counts['tool_use']} tool-call and {counts['text']} text "
                          "block(s), none with the link. Thinking is not output and a tool call is not a message: "
                          f"write `**Read:** {link_of(pub)}` as the text of your message, then ask the engine's "
                          "question as it is, with no link in it.")


def guard_report(state, project, call):
    stage, unit, opened = target_of(state, project, call.get("stage") or (current_stage(project) or (None,))[0],
                                    call.get("unit"))
    if stage:
        require_published(state, stage, unit, opened)


def pre(event, project):
    tool, ti = event.get("tool_name"), event.get("tool_input") or {}
    if tool == "ArtifactData":
        check_gate_rows(ti)
        return
    if tool == "AskUserQuestion":
        gates = [q for q in questions_of(ti) if is_gate(q)]
        if gates:
            guard_question(event, load(event), project, gates)
        return
    if tool == "Bash":
        closing = [c for c in engine_calls(ti.get("command", "")) if c["kind"] == "report" and c["result"] in CLOSING]
        if closing:
            state = load(event)
            for call in closing:
                guard_report(state, project, call)


def guarded_pre(event, project):
    tool = event.get("tool_name")
    if tool not in ("ArtifactData", "AskUserQuestion", "Bash"):
        return
    try:
        pre(event, project)
    except Refusal:
        raise
    except Exception as exc:  # a guarded call that cannot be checked is refused
        if tool == "Bash" and "aidlc" not in str((event.get("tool_input") or {}).get("command", "")):
            return
        raise Refusal(f"The approval gate could not be checked ({type(exc).__name__}: {exc}).") from None


# ---------------------------------------------------------------- recording

def say(event_name, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event_name, "additionalContext": "approval-gates: " + text}}))


def id_matches(doc_id, intent, stage, unit):
    start = re.escape(intent) + "-" if intent else r".+?-"
    middle = re.escape(stage) + (("-" + re.escape(unit)) if unit else "")
    return re.fullmatch(start + middle + r"-\d{8}[Tt]\d{4}", doc_id or "") is not None


def record_bash(event, project, state, tool_input):
    changed = False
    for call in engine_calls(tool_input.get("command", "")):
        stage = call.get("stage")
        cur = current_stage(project)
        if call["kind"] == "decision":
            if call.get("checkpoint") != "plan-approval":
                continue
            stage = stage or "code-generation"
            unit = call.get("unit") or (cur[1] if cur and cur[0] == stage else None)
            state["pending"] = {"stage": stage, "unit": unit, "opened_at": time.time(), "kind": "plan"}
            say("PostToolUse", f"the plan for {stage} is open for approval (Approve Plan). Before that question, "
                               f"publish its documents: {publish_instruction(stage, unit)}.")
            changed = True
            continue
        stage = stage or (cur[0] if cur else None)
        if not stage:
            continue
        unit = call.get("unit") or (cur[1] if cur and cur[0] == stage else None)
        if call["result"] in OPENING:
            state["pending"] = {"stage": stage, "unit": unit, "opened_at": time.time(), "kind": "gate"}
            say("PostToolUse", f"the gate for {stage}{(' (' + unit + ')') if unit else ''} is open. Before the Approval "
                               f"question, publish its documents: {publish_instruction(stage, unit)}.")
            changed = True
        elif call["result"] in CLOSING:
            pending = state["pending"]
            if pending and pending.get("stage") == stage and (not call.get("unit") or pending.get("unit") == call["unit"]):
                state["pending"] = None
                changed = True
    return changed


def record_artifact(project, state, tool_input, response):
    if failed(response):
        return False
    intent, _root = intent_root(project)
    pending = state["pending"]
    candidates = []
    for cand in ((pending.get("stage"), pending.get("unit")) if pending else None, current_stage(project)):
        if cand and cand[0] and cand not in candidates:
            candidates.append(cand)
    changed = False
    for op, collection, doc_id, _data, url in writes_of(tool_input):
        if op not in ("set", "update") or collection != "gates":
            continue
        key = next((make_key(stage, unit) for stage, unit in candidates if id_matches(doc_id, intent, stage, unit)), None)
        if key is None and not candidates and re.fullmatch(r"\d{6}-[a-z0-9-]+-\d{8}[Tt]\d{4}", doc_id or ""):
            key = "id:" + doc_id  # no stage is known here: the row is kept by its id and matched by it later
        if key is None:
            continue
        pub = {"id": doc_id, "url": str(url or "").rstrip("/"), "at": time.time()}
        state["published"][key] = pub
        if not changed:
            say("PostToolUse", f"gates/{doc_id} is published. Send the developer the link `{link_of(pub)}` in "
                               "a message of its own (the `**Read:**` line of the completion message), then "
                               "ask the engine's Approval question with no link in it; the question is "
                               "refused until that message was sent.")
        changed = True
    return changed


def record_answers(project, state, tool_input, response):
    answers = answers_of(response)
    for q in questions_of(tool_input):
        if not is_gate(q):
            continue
        answer = next((a for k, a in answers.items() if norm(k) == norm(q.get("question", ""))), None)
        if answer is None or "request changes" not in norm(answer):
            continue
        stage, unit, _opened = target_of(state, project)
        pub = state["published"].get(make_key(stage, unit)) if stage else None
        where = f"gates/{pub['id']}" if pub and pub.get("id") else "the gate row of this stage"
        say("PostToolUse", f"the developer chose Request Changes. Read {where} with ArtifactData get and use the "
                           "notes they left in the page (decision.note, notes.<document>) in --reason, quoted, "
                           "together with what they typed in chat. The page's decision.k is a draft and never "
                           "replaces the chat answer.")


def post(event, project):
    tool, ti = event.get("tool_name"), event.get("tool_input") or {}
    if tool not in ("Bash", "ArtifactData", "AskUserQuestion"):
        return
    with state_lock(event):
        try:
            state = load(event)
        except Refusal:
            return
        if tool == "Bash":
            changed = record_bash(event, project, state, ti)
        elif tool == "ArtifactData":
            changed = record_artifact(project, state, ti, event.get("tool_response"))
        else:
            record_answers(project, state, ti, event.get("tool_response"))
            changed = False
        if changed:
            save(event, state)


def prompt(event):
    match = RELEASE_PROMPT.match(str(event.get("prompt") or ""))
    if not match:
        return
    existed = os.path.exists(state_path(event))
    if not match.group(1) and not existed:
        return  # a bare /release that is some other command's, with nothing of ours to clear
    with state_lock(event):
        drop(event)
    say("UserPromptSubmit", "guard state cleared for this session.")


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict):
        return 0
    name = event.get("hook_event_name")
    try:
        if name == "UserPromptSubmit":
            prompt(event)
            return 0
        project = project_dir(event)
        if not os.path.isdir(os.path.join(project, "aidlc", "spaces")):
            return 0
        if name == "PreToolUse":
            guarded_pre(event, project)
        elif name == "PostToolUse":
            post(event, project)
    except Refusal as why:
        print(f"{why} {RELEASE_HINT}", file=sys.stderr)
        return 2
    except Exception:  # never break the call the engine's own hooks sit beside
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
