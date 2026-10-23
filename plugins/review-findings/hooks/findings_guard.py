#!/usr/bin/env python3
"""Guard for the order in which review findings reach the developer.

Whenever findings reach the session, the developer decides what happens to them before anything else
does: the agent shows a short summary and asks one question (header "Findings"; options Fix, Accept,
Open in form), and the hook refuses everything else until that question is answered.

Sources
  * An AI-DLC stage review: the review brief printed at an approval gate (PostToolUse of
    `aidlc engine review-brief review --stage S`). Open findings are the rows with Status New or
    Unresolved; Critical and Major block. Applies only in a project with `aidlc/spaces`.
  * A code review: the `ReportFindings` tool (PostToolUse). Anywhere; CONFIRMED findings block.

What it enforces (PreToolUse, exit code 2 and the reason on stderr)
  * While findings are pending and unanswered: no other question, no approval gate, no edit
    (code review), no `git commit|push` (code review), no `aidlc engine orchestrate report --result
    approved|rejected`.
  * The triage question itself is checked: Accept is offered only when no finding blocks.
  * Answer Open in form: the gate (and the report) waits until the form reads status done.
  * Answer Fix: a rejected report must name every open finding id in `--reason`.
  * An agent never writes status done on a findings form.
  * The review brief is printed unpiped and in full: a Bash call that pipes `aidlc engine review-brief`
    (`| head`, `| tail`, `| grep`, …) or redirects its output is refused, and a brief whose table lists
    open findings without their `> R-NN Finding:` lines (a cut-off output) is not recorded as findings:
    the state stays "cut off" and refuses the questions, the gate and the reports until a complete brief
    has been printed.

What it records (PostToolUse), from what the harness reports: the triage answer, the form the
agent wrote, a read that shows the form done, the engine's approved/rejected report. UserPromptSubmit
`/review-findings:release` clears the state. State: ~/.claude/review-findings/<session>.json
(REVIEW_FINDINGS_DIR). Fails open on malformed input, outside the sources above, and on any error in
PostToolUse/UserPromptSubmit. Standard library only.
"""

import contextlib
import importlib.util
import json
import os
import re
import shlex
import sys
import tempfile
import time

try:
    import fcntl
except ImportError:  # no advisory locks: the unique temp file below still keeps writes whole
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.realpath(os.path.join(HERE, "..", "scripts"))
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
GATE_LABELS = {"approve", "approve plan", "accept as-is"}
# `#12` names a pull request; the `#261006-demo-…` of a form link and a URL's `#fragment` do not.
PULL_REQUEST = re.compile(r"(?<![\w/.#-])#\d+(?![\w-])|/pull/\d+")
FORM_ID = re.compile(r"(?:-findings-|^code-review-)\d{8}t\d{4}$", re.I)
RELEASE_PROMPT = re.compile(r"^\s*/review-findings:release\b")
RESULTS_DONE = {"approved", "rejected", "accepted"}
LAUNCHERS = {"env", "exec", "nohup", "time", "command", "nice", "sudo"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
RELEASE = "(Blocked by the review-findings plugin. The developer can release it by typing /review-findings:release.)"


class Refusal(Exception):
    pass


def library():
    spec = importlib.util.spec_from_file_location("findings", os.path.join(SCRIPTS, "findings.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


F = library()


# ---------------------------------------------------------------- state

def state_dir():
    return os.environ.get("REVIEW_FINDINGS_DIR") or os.path.join(os.path.expanduser("~"), ".claude", "review-findings")


def state_path(event):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(event.get("session_id") or "default"))
    return os.path.join(state_dir(), sid + ".json")


def findings_path(event):
    """The pending findings as a findings document, for `findings.py summary|question|board --findings`."""
    return state_path(event)[:-len(".json")] + ".findings"


def load(event):
    """The session's state, None when there is none; a state that cannot be read refuses."""
    try:
        with open(state_path(event), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise Refusal(f"the findings state of this session cannot be read ({exc})") from None
    return data if isinstance(data, dict) else None


def save(event, state):
    """Write the state whole: a temp file of its own, then an atomic replace."""
    os.makedirs(state_dir(), exist_ok=True)
    path = state_path(event)
    fd, tmp = tempfile.mkstemp(dir=state_dir(), prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


@contextlib.contextmanager
def state_lock(event):
    """One hook at a time reads, changes and writes a session's state. Best effort."""
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
    for path in (state_path(event), findings_path(event), state_path(event) + ".lock"):
        with contextlib.suppress(OSError):
            os.remove(path)


def pending_of(state):
    pend = (state or {}).get("pending")
    return pend if isinstance(pend, dict) else None


def project_dir(event):
    return os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()


def aidlc_project(event):
    return os.path.isdir(os.path.join(project_dir(event), "aidlc", "spaces"))


# ---------------------------------------------------------------- helpers copied from the pr-review flow guard

def questions_of(tool_input):
    qs = (tool_input or {}).get("questions")
    return [q for q in qs if isinstance(q, dict)] if isinstance(qs, list) else []


def norm(text):
    return re.sub(r"\s+", " ", str(text)).strip().strip('"').lower()


def labels(question):
    return {norm(o.get("label", "")) for o in question.get("options") or [] if isinstance(o, dict)}


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


def answers_of(response):
    """{question: answer} from an AskUserQuestion tool response (`answers`, or the text form)."""
    if isinstance(response, dict):
        ans = response.get("answers")
        if isinstance(ans, dict):
            return {str(q): (", ".join(map(str, a)) if isinstance(a, list) else str(a)) for q, a in ans.items()}
    text = flat(response)
    return {m.group(1): m.group(2) for m in re.finditer(r'"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"', text)}


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


def writes_of(tool_input):
    """[(op, collection, doc_id, data or None, url)] for an ArtifactData write call."""
    action = (tool_input or {}).get("action")
    url = (tool_input or {}).get("url", "")
    if action == "batch":
        return [(w.get("op"), w.get("collection", ""), w.get("doc_id", ""), payload(w), url)
                for w in tool_input.get("writes") or [] if isinstance(w, dict)]
    if action in ("set", "update", "delete"):
        return [(action, tool_input.get("collection", ""), tool_input.get("doc_id", ""), payload(tool_input), url)]
    return []


def bash_output(resp):
    if isinstance(resp, dict):
        return "\n".join(str(resp.get(k) or "") for k in ("stdout", "output"))
    return resp if isinstance(resp, str) else ""


def say(event_name, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event_name, "additionalContext": "review-findings: " + text}}))


def refuse(why):
    print(why + "\n" + RELEASE, file=sys.stderr)
    return 2


# ---------------------------------------------------------------- shell commands

def commands(command):
    """The simple commands of a shell command line as token lists, also inside `bash -c '…'`.
    Raises ValueError when the line cannot be split."""
    lex = shlex.shlex(str(command).replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    out, current = [], []
    for tok in list(lex) + [";"]:
        if tok and set(tok) <= set("&|;()"):
            if current:
                out.append(current)
            current = []
        else:
            current.append(tok)
    for seg in list(out):
        seg = strip_prefix(seg)
        if seg and os.path.basename(seg[0]) in SHELLS and "-c" in seg[1:-1]:
            out += commands(seg[seg.index("-c") + 1])
    return out


def strip_prefix(seg):
    """The command itself: without env assignments and launchers (`env`, `sudo`, `nohup`, …) in front."""
    while seg and (os.path.basename(seg[0]) in LAUNCHERS or re.fullmatch(r"[A-Za-z_]\w*=.*", seg[0], re.S)):
        seg = seg[1:]
        while seg and seg[0].startswith("-") and seg[0] != "-":
            seg = seg[1:]
    return seg


def aidlc_words(seg, words):
    """True when an `aidlc` command carries the words in order (`aidlc engine orchestrate report`)."""
    seg = strip_prefix(seg)
    at = next((i for i, tok in enumerate(seg) if os.path.basename(tok) == "aidlc"), None)
    if at is None:
        return False
    k = 0
    for tok in seg[at + 1:]:
        if k < len(words) and tok == words[k]:
            k += 1
    return k == len(words)


def option(seg, name):
    for i, tok in enumerate(seg):
        if tok == name and i + 1 < len(seg):
            return seg[i + 1]
        if tok.startswith(name + "="):
            return tok[len(name) + 1:]
    return ""


def git_subcommand(seg):
    seg = strip_prefix(seg)
    if not seg or os.path.basename(seg[0]) != "git":
        return ""
    i = 1
    while i < len(seg) and seg[i].startswith("-"):
        i += 2 if seg[i] in GIT_VALUE_OPTIONS else 1
    return seg[i] if i < len(seg) else ""


def reports_of(command):
    """[{stage, unit, result, reason}] for each `aidlc engine orchestrate report` in a command line."""
    try:
        segs = commands(command)
    except ValueError:  # an unbalanced quote: read the raw text rather than let the call through
        if not re.search(r"orchestrate\s+report\b", command):
            return []
        def raw(name):
            found = re.search(rf"--{name}[ =]+[\"']?([^\s\"']+)", command)
            return found.group(1) if found else ""
        reason = re.search(r"--reason[ =]+(.*)$", command, re.S)
        return [{"stage": raw("stage"), "unit": raw("unit"), "result": raw("result").lower(),
                 "reason": reason.group(1) if reason else ""}]
    return [{"stage": option(seg, "--stage"), "unit": option(seg, "--unit"), "result": option(seg, "--result").lower(),
             "reason": option(seg, "--reason")}
            for seg in segs if aidlc_words(seg, ["engine", "orchestrate", "report"])]


def briefs_of(command):
    """[{stage, unit}] for each `aidlc engine review-brief` in a command line."""
    try:
        segs = commands(command)
    except ValueError:
        return []
    return [{"stage": option(seg, "--stage"), "unit": option(seg, "--unit")}
            for seg in segs if aidlc_words(seg, ["engine", "review-brief"])]


def cut_briefs(command):
    """True when a `aidlc engine review-brief` in the command line has its output piped to another command or
    redirected to a file, so the hook (and the agent) would see only part of it, or none."""
    return any(cut_segments(command))


def cut_segments(command):
    lex = shlex.shlex(str(command).replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    try:
        tokens = list(lex) + [";"]
    except ValueError:  # an unbalanced quote: read the raw text
        return [bool(re.search(r"review-brief\b[^;&\n]*\|(?!\|)", str(command)))]
    out, seg = [], []
    for tok in tokens:
        if tok and set(tok) <= set("&|;()"):
            seg_ = strip_prefix(seg)
            if aidlc_words(seg_, ["engine", "review-brief"]):
                redirected = any(t in (">", ">>", ">|", "&>", "&>>") and not (i and seg[i - 1] == "2")
                                 for i, t in enumerate(seg))
                out.append(tok in ("|", "|&") or redirected)
            elif seg_ and os.path.basename(seg_[0]) in SHELLS and "-c" in seg_[1:-1]:
                out += cut_segments(seg_[seg_.index("-c") + 1])
            seg = []
        else:
            seg.append(tok)
    return out


def git_writes(command):
    try:
        return any(git_subcommand(seg) in ("commit", "push") for seg in commands(command))
    except ValueError:
        return bool(re.search(r"\bgit\b.*\b(?:commit|push)\b", command))


def names_id(text, fid):
    return re.search(r"(?<![A-Za-z0-9-])" + re.escape(fid) + r"(?![0-9])", text or "") is not None


# ---------------------------------------------------------------- classification

def is_triage(question):
    return norm(question.get("header", "")) == "findings" and {"fix", "open in form"} <= labels(question)


def is_gate(question):
    return (norm(question.get("header", "")) == "approval" and bool(labels(question) & GATE_LABELS)
            and not PULL_REQUEST.search(str(question.get("question", ""))))


def same_stage(pend, stage, unit):
    """True when a report is for the stage of the pending AI-DLC review."""
    if pend.get("source") != "aidlc":
        return False
    if pend.get("stage") and stage and pend["stage"] != stage:
        return False
    return not (pend.get("unit") and unit and pend["unit"] != unit)


def form_link(pend):
    form = pend.get("form") or {}
    return f"{form['url'].rstrip('/')}#{form['id']}" if form.get("url") else form.get("id", "")


def form_wait(pend):
    """Why the gate waits for the form, or None."""
    if pend.get("answer") != "form":
        return None
    form = pend.get("form")
    if not form:
        return ("The developer chose Open in form, so the findings are sorted in a form before the gate. Write the "
                "board with `findings.py board` and ask the form check (\"Look at the form and pick one from above: "
                "<artifact url>#<form id>\", header Form).")
    return None if form.get("done") else "Answer the form to continue: " + form_link(pend)


def blocked(pend):
    """True while a code review's edits and commits wait: unanswered, or the form not done."""
    return not pend.get("asked") or form_wait(pend) is not None


def form_id_of(collection, doc_id):
    """The findings form a write belongs to (`forms/<id>` or `forms/<id>/questions/<qid>`), or ""."""
    if collection == "forms":
        form_id = doc_id
    elif str(collection).startswith("forms/"):
        form_id = collection.split("/")[1]
    else:
        return ""
    return form_id if FORM_ID.search(form_id or "") else ""


def sets_done(tool_input):
    """True when an ArtifactData write would mark a findings form done, or cannot be read to prove it does not."""
    for op, collection, doc_id, data, _ in writes_of(tool_input):
        if op != "delete" and form_id_of(collection, doc_id):
            if data is None or str(data.get("status", "")).lower() == "done":
                return True
    return False


# ---------------------------------------------------------------- PreToolUse

def guarded(tool, ti, command):
    """True for a call the guard may refuse; a call it cannot classify is let through."""
    try:
        if tool == "AskUserQuestion":
            return bool(questions_of(ti))
        if tool in EDIT_TOOLS:
            return True
        if tool == "Bash":
            return bool(reports_of(command) or git_writes(command))
        if tool == "ArtifactData":
            return any(form_id_of(w[1], w[2]) for w in writes_of(ti))
    except Exception:  # noqa: BLE001
        return False
    return False


def pre(event):
    tool, ti = event.get("tool_name"), event.get("tool_input") or {}
    command = ti.get("command", "") if tool == "Bash" else ""
    if tool == "Bash" and "review-brief" in command and aidlc_project(event):
        try:
            if cut_briefs(command):
                return refuse("The review brief must be printed unpiped and in full: this call pipes or redirects "
                              "`aidlc engine review-brief`, which cuts its per-finding detail off. Run the command "
                              "again as the only command, without `|` (head, tail, grep, …) or `>`.")
        except Exception:  # noqa: BLE001
            pass
    if not guarded(tool, ti, command):
        return 0
    try:
        state = load(event)
    except Refusal as why:
        return refuse(f"{why}, so this call cannot be checked.")
    pend = pending_of(state)
    if pend is None:
        return 0
    try:
        guard(event, tool, ti, command, pend)
    except Refusal as why:
        return refuse(str(why))
    return 0


def cut_off_text(pend):
    ids = ", ".join((pend.get("truncated") or {}).get("ids") or [])
    return (f"{F.CUT_OFF}. The brief listed open findings without their detail ({ids or 'no rows readable'}), so "
            "nothing is recorded: no question, no approval gate and no approved/rejected report goes on until a "
            "complete brief has been printed.")


def guard(event, tool, ti, command, pend):
    if pend.get("truncated"):
        if tool in ("AskUserQuestion", "ArtifactData") or any(
                rep["result"] in RESULTS_DONE and same_stage(pend, rep["stage"], rep["unit"])
                for rep in reports_of(command)):
            raise Refusal(cut_off_text(pend))
        return
    total, blocking = len(pend.get("findings") or []), pend.get("blocking", 0)
    if tool == "AskUserQuestion":
        qs = questions_of(ti)
        for q in qs:
            if is_triage(q):
                if blocking and "accept" in labels(q):
                    raise Refusal("Accept is offered only when no finding is blocking. "
                                  f"{blocking} of the {total} open findings block: ask with Fix and Open in form only.")
                if not blocking and "accept" not in labels(q):
                    raise Refusal("No finding is blocking, so the triage question offers Accept too: "
                                  "Fix, Accept, Open in form (in that order).")
        if not pend.get("asked"):
            if not all(is_triage(q) for q in qs):
                raise Refusal(
                    f"{total} review finding(s) are open and the developer has not been asked what to do with them. "
                    "Show the summary of the findings, then ask one AskUserQuestion, header \"Findings\", question "
                    f"\"{F.question_text(total, blocking)}\", options Fix"
                    f"{'' if blocking else ', Accept'}, Open in form. Nothing else comes before it.")
            return
        why = form_wait(pend)
        if why and any(is_gate(q) for q in qs):
            raise Refusal(why)
        return
    if tool in EDIT_TOOLS:
        if pend.get("source") == "code-review" and blocked(pend) and inside_project(event, ti):
            raise Refusal(blocked_text(pend))
        return
    if tool == "ArtifactData":
        if sets_done(ti):
            raise Refusal("A findings form is marked done only by the developer pressing Done in the page; an agent "
                          "never writes status done (and a write whose data cannot be read is refused).")
        return
    if git_writes(command) and pend.get("source") == "code-review" and blocked(pend):
        raise Refusal(blocked_text(pend))
    for rep in reports_of(command):
        if rep["result"] in RESULTS_DONE and same_stage(pend, rep["stage"], rep["unit"]):
            report_guard(pend, rep)


def inside_project(event, ti):
    """True unless the edit's path is outside the project (a scratch file cannot change the reviewed code)."""
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    if not path:
        return True
    root = os.path.realpath(project_dir(event))
    target = os.path.realpath(os.path.join(event.get("cwd") or root, os.path.expanduser(path)))
    return target == root or target.startswith(root + os.sep)


def blocked_text(pend):
    if not pend.get("asked"):
        return ("The code review reported findings and the developer has not been asked what to do with them. Ask "
                "first (Fix / Accept / Open in form); edits and commits wait for the answer.")
    return form_wait(pend) or ""


def report_guard(pend, rep):
    ids = [f["id"] for f in pend.get("findings") or []]
    if not pend.get("asked"):
        raise Refusal("The developer has not been asked what to do with the open review findings "
                      f"({', '.join(ids)}). Ask the Findings question first.")
    why = form_wait(pend)
    if why:
        raise Refusal(why)
    if rep["result"] != "rejected":
        return
    if pend.get("answer") == "fix":
        missing = [i for i in ids if not names_id(rep["reason"], i)]
        if missing:
            raise Refusal("The developer chose Fix, so the rejected report's --reason names every open finding with "
                          "its required action. Missing: " + ", ".join(missing) + ".")
    elif pend.get("answer") == "form" and ids and not any(names_id(rep["reason"], i) for i in ids):
        raise Refusal("The rejected report's --reason names the findings the developer sorted into Fix in the form "
                      "(by id, with the required action). It names none of: " + ", ".join(ids) + ".")


# ---------------------------------------------------------------- PostToolUse

def relevant(event):
    """True when the finished call can start, change or end the pending findings (so a call that cannot
    leaves no lock file behind in every project)."""
    tool, ti = event.get("tool_name"), event.get("tool_input") or {}
    name = str(tool or "")
    if name == "ReportFindings" or name.endswith("__ReportFindings"):
        return True
    if tool == "Bash":
        command = str(ti.get("command", ""))
        return "review-brief" in command or "orchestrate" in command
    return tool in ("AskUserQuestion", "ArtifactData") and os.path.exists(state_path(event))


def post(event):
    if not relevant(event):
        return 0
    with state_lock(event):
        try:
            state = load(event)
        except Refusal:
            state = None  # an unreadable state is rebuilt from the call that follows
        state = state or {}
        try:
            note = record(event, state)
        except Exception as exc:  # a marker that cannot be recorded stays unrecorded
            say("PostToolUse", f"the step could not be recorded ({exc!r}).")
            return 0
        if pending_of(state):
            save(event, state)
        else:
            drop(event)
        if note:
            say("PostToolUse", note)
    return 0


def record(event, state):
    """Record what the finished call proves; returns text for the agent, or None."""
    tool, ti, resp = event.get("tool_name"), event.get("tool_input") or {}, event.get("tool_response")
    name = str(tool or "")
    if name == "ReportFindings" or name.endswith("__ReportFindings"):
        return on_report(event, state, ti)
    if tool == "Bash":
        return on_bash(event, state, ti, resp)
    if tool == "AskUserQuestion":
        return on_answers(state, ti, resp)
    if tool == "ArtifactData":
        return on_data(state, ti, resp)
    return None


def signature(pend):
    return [(f["id"], f.get("where"), f.get("finding")) for f in pend.get("findings") or []]


def adopt(event, state, doc):
    """Make the document's findings the pending ones; an unchanged set keeps its answer."""
    open_ = doc["findings"]
    pend = {"source": doc["source"], "stage": doc.get("stage", ""), "unit": doc.get("unit", ""),
            "stage_name": doc.get("stage_name", ""), "artifact": doc.get("artifact", ""), "findings": open_,
            "blocking": sum(1 for f in open_ if f.get("blocking")), "open": len(open_), "at": time.time(),
            "asked": False, "answer": None, "form": None}
    old = pending_of(state)
    if old and old.get("source") == pend["source"] and old.get("stage") == pend["stage"] \
            and old.get("unit") == pend["unit"] and signature(old) == signature(pend):
        for key in ("asked", "answer", "form"):
            pend[key] = old.get(key)
    state["pending"] = pend
    os.makedirs(state_dir(), exist_ok=True)
    with open(findings_path(event), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    return pend


def instruction(event, doc, pend):
    total, blocking = pend["open"], pend["blocking"]
    options = "Fix, Open in form" if blocking else "Fix, Accept, Open in form"
    label = "code review" if doc["source"] == "code-review" else (doc.get("stage_name") or doc.get("stage") or "review")
    return (
        f"{total} finding(s) of the {label} are open ({blocking} blocking). Show this summary in chat, then ask "
        f"with AskUserQuestion, header \"Findings\": \"{F.question_text(total, blocking)}\" with the options "
        f"{options} (in that order{'' if blocking else '; Accept is offered because nothing blocks'}). Nothing "
        "else comes before that question: the hook refuses every other question, the approval gate and the "
        f"approved/rejected report (code review: edits and commits) until it is answered. The findings are saved in "
        f"{findings_path(event)} (`python3 {os.path.join(SCRIPTS, 'findings.py')} question|summary|board "
        f"--findings <that file>`).\n\n" + F.summary(doc))


def on_report(event, state, ti):
    doc = F.parse_report({"findings": ti.get("findings")}) if isinstance(ti.get("findings"), list) else None
    if not doc or not doc["findings"]:
        if (pending_of(state) or {}).get("source") == "code-review":
            state["pending"] = None
        return None
    return instruction(event, doc, adopt(event, state, doc))


def on_bash(event, state, ti, resp):
    command = ti.get("command", "")
    if not aidlc_project(event):
        return None
    for rep in reports_of(command):
        pend = pending_of(state)
        if pend and rep["result"] in RESULTS_DONE and same_stage(pend, rep["stage"], rep["unit"]):
            state["pending"] = None
            return None
    text = bash_output(resp)
    for brief in briefs_of(command):
        if "**Stage:**" not in text and "| ID |" not in text:
            continue
        doc = F.parse_brief(text, brief["stage"])
        doc["unit"] = brief["unit"]
        pend = pending_of(state)
        if not doc["findings"]:
            if pend and same_stage(pend, doc["stage"], doc["unit"]):
                state["pending"] = None
            return None
        if F.unfilled(doc):
            return cut_off(event, state, doc, brief)
        return instruction(event, doc, adopt(event, state, doc))
    return None


def cut_off(event, state, doc, brief):
    """A brief whose open findings have no detail lines was cut off (piped through head/tail/grep): record
    that, not the findings, so the next step is refused until a complete brief arrives."""
    old = pending_of(state)
    if old and not old.get("truncated") and same_stage(old, doc["stage"], doc["unit"]):
        return ("this output of the review brief is cut off and was ignored; the findings recorded before stand. "
                + F.CUT_OFF + ".")
    open_ = doc["findings"]
    state["pending"] = {"source": "aidlc", "stage": doc.get("stage", ""), "unit": doc.get("unit", ""),
                        "stage_name": doc.get("stage_name", ""), "artifact": doc.get("artifact", ""),
                        "findings": open_, "blocking": sum(1 for f in open_ if f.get("blocking")), "open": len(open_),
                        "at": time.time(), "asked": False, "answer": None, "form": None,
                        "truncated": {"ids": F.unfilled(doc)}}
    with contextlib.suppress(OSError):
        os.remove(findings_path(event))
    return cut_off_text(state["pending"]) + " Do not show a findings summary from it."


def choice_of(answer):
    return {"fix": "fix", "accept": "accept", "open in form": "form"}.get(norm(answer))


def on_answers(state, ti, resp):
    pend = pending_of(state)
    if pend is None or pend.get("truncated"):
        return None
    answers = answers_of(resp)
    asked = questions_of(ti)
    notes = []
    for q in asked:
        triage, gate = is_triage(q), is_gate(q)
        if not (triage or gate):
            continue
        if not answers:
            if triage:
                notes.append("the answer could not be read from the question's result, so no step is recorded. Ask "
                             "the question again.")
            continue
        answer = next((a for k, a in answers.items() if norm(k) == norm(q.get("question", ""))), None)
        if answer is None:
            continue
        if triage:
            notes.append(on_triage(state, pend, answer))
        elif pend.get("asked"):
            notes.append(on_gate_answer(pend, answer))
    return " ".join(n for n in notes if n) or None


def ids_text(pend):
    return ", ".join(f["id"] for f in pend.get("findings") or [])


def on_triage(state, pend, answer):
    choice = choice_of(answer)
    if choice is None:
        return (f"the answer \"{str(answer).strip()[:120]}\" is not one of the options, so nothing is decided yet. "
                "Ask in chat what the developer wants for the findings, or ask the Findings question again; until "
                "it is answered, every other step stays refused.")
    if choice == "accept" and pend.get("blocking"):
        return "Accept is not allowed while a finding is blocking, so nothing is decided. Ask the question again."
    code = pend.get("source") == "code-review"
    pend["asked"], pend["answer"] = True, choice
    if code and choice in ("fix", "accept"):
        state["pending"] = None
    if choice == "fix":
        if code:
            return ("the developer chose Fix. Apply the fixes now (the --fix flow), then say what changed, finding by "
                    "finding.")
        return (f"the developer chose Fix for {ids_text(pend)}. Present the gate as the protocol requires (the "
                "awaiting-approval report may already be done); do NOT edit the reviewed documents before the gate, "
                "the engine's review-freeze refuses it. Say in the completion message that Request Changes carries "
                "these findings. When the developer picks Request Changes, the --reason names every one of them "
                f"({ids_text(pend)}) with its required action; the hook refuses a rejected report that misses an id.")
    if choice == "accept":
        if code:
            return "the developer chose Accept. List the findings as accepted in chat and go on; no fix."
        return ("the developer chose Accept. Present the gate; on Approve the engine records every open finding as "
                "Accepted risk by itself. Say in the completion message that these findings are carried as accepted.")
    where = "the question-forms artifact (AI-DLC question forms)"
    return (f"the developer chose Open in form. Write a BOARD form in {where}: run `python3 "
            f"{os.path.join(SCRIPTS, 'findings.py')} board --findings <the saved findings file> --out <scratch dir>` "
            "and write the resulting writes.json with one ArtifactData batch, then ask the form check (header Form, "
            "\"Look at the form and pick one from above: <artifact url>#<form id>\", options Saved in the form / "
            "Something is wrong in the form). The gate"
            + ("" if not code else " and every edit or commit")
            + " waits until forms/<id> reads status done (read it with ArtifactData get or query; you never write "
            "done). Then show one line per card with its box and note (\"Summary of your answers\")"
            + ("." if code else " before the gate."))


def on_gate_answer(pend, answer):
    a = norm(answer)
    ids = ids_text(pend)
    if "request changes" in a:
        if pend.get("answer") == "fix":
            return f"Request Changes after Fix: name every finding in --reason with its required action: {ids}."
        if pend.get("answer") == "form":
            return (f"Request Changes after the form: read forms/{(pend.get('form') or {}).get('id', '<id>')} (ArtifactData "
                    f"get); name every card in the Fix box by id with its required action in --reason (open ids: {ids}), "
                    "and add --reject-finding \"<review artifact path>#R-NN=<note>\" for each card in Reject.")
        return "Request Changes: put the developer's feedback and the open finding ids (" + ids + ") in --reason."
    if a in GATE_LABELS:
        return ("the developer approved with open findings: the engine records them as Accepted risk. Carry on with "
                "the approved report as the protocol says.")
    return None


def on_data(state, ti, resp):
    pend = pending_of(state)
    if pend is None:
        return None
    url = (ti.get("url") or "").rstrip("/")
    for op, collection, doc_id, _data, _ in writes_of(ti):
        if op in ("set", "update") and collection == "forms" and form_id_of(collection, doc_id):
            form = pend.get("form")
            if form and form.get("id") == doc_id:
                form["done"] = False  # a changed form is open again
            else:
                pend["form"] = {"id": doc_id, "url": url, "done": False}
    form = pend.get("form")
    if not form:
        return None
    text = flat(resp)
    action, listed = ti.get("action"), re.search(r'"id"\s*:\s*"' + re.escape(form["id"]) + r'"', text) is not None
    done = False
    if action == "get" and ti.get("collection") == "forms" and ti.get("doc_id") == form["id"]:
        done = re.search(r'"status"\s*:\s*"done"', text) is not None
    elif action == "query" and ti.get("collection") == "forms":
        where = (ti.get("query") or {}).get("where") or []
        done = listed and any(isinstance(c, list) and len(c) == 3 and c[0] == "status" and c[1] in ("eq", "==")
                              and c[2] == "done" for c in where)
    else:
        return None
    if not done:
        return f"the form {form_link(pend)} is not marked Done. Tell the developer to press Done in it, then read it again."
    form["done"] = True
    if pend.get("source") == "code-review":
        state["pending"] = None
        return (f"the form {form['id']} is done. Read its answers (answers[qid].k[0] is the card's box, note the "
                "developer's words): Fix cards are fixed now; Accept cards are listed as accepted in chat; Reject cards "
                "are listed with the note. Show one line per card first (\"Summary of your answers\").")
    return (f"the form {form['id']} is done. Read its answers (answers[qid].k[0] is the card's box, note the developer's "
            "words) and show one line per card with its box and note (\"Summary of your answers\"). Then present the "
            "gate. Request Changes carries the Fix cards (by id, with the required action) in --reason, and each Reject "
            "card as --reject-finding \"<review artifact path>#R-NN=<note>\"; Accept cards stay open and are recorded as "
            "accepted risks on Approve.")


# ---------------------------------------------------------------- UserPromptSubmit

def prompt(event):
    if RELEASE_PROMPT.match((event.get("prompt") or "").strip()):
        with state_lock(event):
            drop(event)
        say("UserPromptSubmit", "findings guard state cleared for this session.")
    return 0


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict):
        return 0
    name = event.get("hook_event_name")
    try:
        if name == "PreToolUse":
            return pre(event)
        if name == "PostToolUse":
            return post(event)
        if name == "UserPromptSubmit":
            return prompt(event)
    except Refusal as why:
        return refuse(str(why)) if name == "PreToolUse" else 0
    except Exception as exc:  # fail closed on a guarded call that reached the checks
        if name == "PreToolUse":
            return refuse(f"internal error ({exc!r}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
