#!/usr/bin/env python3
"""Guard for one AI-DLC stage per branch and pull request.

Fires on `aidlc engine orchestrate next` calls (also `orchestrate.ts next` and calls wrapped in
`bash -c '…'` or `eval '…'`). It reads the active intent's aidlc-state.md to find the stage that
`next` works on and refuses, with exit code 2 and the steps to take on stderr, when:
- the current branch is the main branch (or HEAD is detached);
- an Ideation or Inception stage runs on a branch other than `<dev>/<ticket>/<stage>`, where
  `<ticket>` is the intent's ticket key (the one on its first stage pull request, or, before
  there is one, on the current branch). Without a `ticket` pattern in the config the shape is
  `<dev>/<stage>` and no key is checked;
- the previous Ideation or Inception stage's pull request is still open, or none of its pull
  requests created since the intent started is merged (asked with `gh pr list`);
- a stage that has not started yet runs on a branch that does not contain `origin/<main branch>`;
- a Construction or Operation stage runs on a branch not shaped `<dev>/<ticket>/<name>`
  (`<dev>/<name>` without a ticket pattern);
- a fold branch `<dev>/<ticket>/<main stage>--folded--<stage>[,<stage>…]`, which carries several
  consecutive stages in one pull request (earlier stages reopened into the main stage, later
  stages run on its branch, or both), names its folded stages out of stage order or not
  consecutive with the main stage, or has no fold approval for that exact branch in the
  record's `stage-folds.json`;
- with `startCheck` on in the config: a Construction or Operation stage runs in an intent whose
  record has no `start-check.md`, whose `**Blockers:**` line is not `none`, or whose current text
  the developer has not confirmed in `start-check-approval.json`;
- an earlier completed stage has drifted: its artifacts, or the ones it read, changed after its
  approval without a new one, as `aidlc engine status` reports it under Validity (the engine
  itself only warns). The stage is reopened and approved again first.
The project's choices (branch prefixes, ticket pattern, main branch, start check, wording) come
from the optional `.stage-guard.json` at the git top level (`load_config`, and the README).
The confirmation is the developer's alone, typed as `/stage-guard:confirm-start-check` (README,
"Confirming a start check"). The fold approval is the developer's alone: on UserPromptSubmit, a prompt typed as
`/stage-guard:fold <stage> […]` (or `/fold …`) is recorded in `stage-folds.json`. An agent's
tool call never reaches that hook. Edit, Write and shell writes naming the file are refused, and
so is a shell command that runs this hook, which could feed it a forged prompt event.
Read-only and settings calls (`--status`, `--doctor`, `--help`, `--single`, `compose`, `config`,
`intent`, `space`, `plugin`, `knowledge`, `unit`, …) pass. Initialization stages pass. Without an
active intent (the first run creates one) it passes. Once an event is known to be a guarded call,
anything it cannot check (no `gh`, no network, an invalid config file, an internal error) refuses
it. Standard library only.
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

SHELL_OPS = {"&&", "||", ";", "|", "&", "(", ")", ";;", "|&"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
ORCHESTRATE = {"orchestrate", "orchestrate.ts", "aidlc-orchestrate.ts"}
# First words of `next` that never start or continue a stage.
EXEMPT_VERBS = {
    "--status", "--doctor", "--version", "--help", "help", "--config", "config", "intent", "space",
    "plugin", "knowledge", "unit", "--claim", "--release", "compose", "--new-scope", "--new-intent",
    "--guard-policy", "--change-control", "--sensors", "--learnings", "--summary-confirmation",
}
EXEMPT_ANYWHERE = {"--single", "--status", "--doctor", "--help", "--version"}
STAGE_LINE = re.compile(r"^- \[(.)\] ([a-z0-9-]+) — (EXECUTE|SKIP)\b")
PHASE_LINE = re.compile(r"^### ([A-Z]+) PHASE")
STAGE_PHASES = {"IDEATION", "INCEPTION"}
UNIT_PHASES = {"CONSTRUCTION", "OPERATION"}
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
FOLDED = "--folded--"
START_DATE = re.compile(r"^- \*\*Start Date\*\*: *(\S+)", re.MULTILINE)
CONFIG_FILE = ".stage-guard.json"
DEFAULT_PR_TEMPLATE = ".github/pull_request_template.md"
DEV_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")  # a configured branch prefix
FOLDS = "stage-folds.json"
START_CHECK = "start-check.md"
APPROVAL = "start-check-approval.json"
PROTECTED = (FOLDS, APPROVAL)  # written only by this hook, when the developer types the command
CONFIRM_PROMPT = re.compile(r"^\s*/(?:stage-guard:)?confirm-start-check(?:\s+(\S+))?\s*$")
BLOCKERS = re.compile(r"^\s*[-*]?\s*\*\*Blockers:\*\*[ \t]*(.*?)[ \t]*$", re.MULTILINE)
# Lines of `aidlc engine status` (its Validity block); the engine prints no JSON for status.
VALIDITY = re.compile(r"^Validity:[ \t]*(.*?)[ \t]*$", re.MULTILINE)
STATUS_LIST = r"^{}:[ \t]*(.*?)[ \t]*$"
FOLD_PROMPT = re.compile(r"^\s*/(?:stage-guard:)?fold(?:\s+(.*))?$")
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
# Commands that may name the folds file without writing it (a commit message, a pull-request body);
# a redirection into it still refuses.
READERS = {"git", "gh", "cat", "less", "head", "tail", "grep", "rg", "ls", "wc", "diff", "jq", "echo", "printf"}
GIT_WRITES = {"checkout", "restore", "mv", "rm", "apply", "stash", "reset"}
HOOK_NAME = "stage_guard"  # this hook's module name
HOOK_FILE = HOOK_NAME + ".py"
HOOK_IMPORT = re.compile(r"\bimport\s+stage_guard\b|\bfrom\s+stage_guard\s+import\b|stage_guard\.py|"
                         r"""['"]stage_guard['"]""")
PYTHON = re.compile(r"(?:python|pypy)[0-9.]*")
# Words that run the command after them: `env X=1 python3 …`, `exec …`, `uv run …`.
LAUNCHERS = {"env", "exec", "nohup", "time", "command", "nice", "uv"}


class Refusal(Exception):
    rules_ref = None  # the project's `rulesRef`, set once its config is known


class ConfigError(Refusal):
    pass


RULE = ("one branch and one pull request per Ideation or Inception stage, one per Unit in "
        "Construction, merged before the next one starts")


def refuse(why, rules_ref=None):
    tail = rules_ref or f"The rule: {RULE}."
    print(f"Refused by the stage-guard plugin: {why} ({tail})", file=sys.stderr)
    return 2


class Config:
    """The project's choices, from `.stage-guard.json` at the git top level. Every key is optional.

    developers         allowed branch prefixes (default: any `[a-z0-9]+(-[a-z0-9]+)*`)
    ticket             regex of the ticket key as a whole path segment (default: no ticket segment)
    mainBranch         the trunk (default `main`)
    startCheck         require a confirmed start-check.md before Construction (default false)
    prTemplate         pull-request template, named in messages when the file exists
    rulesRef           free text appended to refusals in parentheses
    startCheckSources  repo-relative files `scripts/start_check.py` reads (default none)
    """

    def __init__(self, data, top):
        if not isinstance(data, dict):
            raise ConfigError(f"`{CONFIG_FILE}` must hold a JSON object.")
        self.developers = self._get(data, "developers", None, "a non-empty list of branch prefixes",
                                    lambda v: isinstance(v, list) and v and len(set(v)) == len(v)
                                    and all(isinstance(d, str) and DEV_NAME.fullmatch(d) for d in v))
        self.ticket = self._get(data, "ticket", None, "a non-empty regex string",
                                lambda v: isinstance(v, str) and v)
        if self.ticket:
            try:
                re.compile(self.ticket)
            except re.error as exc:
                raise ConfigError(f"`{CONFIG_FILE}`: `ticket` is not a valid regular expression ({exc}).") from None
        self.main = self._get(data, "mainBranch", "main", "a non-empty branch name",
                              lambda v: isinstance(v, str) and v.strip() and not v.startswith("-"))
        self.start_check = self._get(data, "startCheck", False, "true or false", lambda v: isinstance(v, bool))
        self.pr_template = self._get(data, "prTemplate", DEFAULT_PR_TEMPLATE, "a non-empty path",
                                     lambda v: isinstance(v, str) and v)
        self.rules_ref = self._get(data, "rulesRef", None, "a string", lambda v: isinstance(v, str))
        self.sources = self._get(data, "startCheckSources", [], "a list of repo-relative paths",
                                 lambda v: isinstance(v, list) and all(
                                     isinstance(p, str) and p and not os.path.isabs(p)
                                     and ".." not in p.split("/") for p in v))
        self.has_template = os.path.isfile(os.path.join(top, self.pr_template))
        dev = "(?P<dev>" + ("|".join(re.escape(d) for d in self.developers) if self.developers else SLUG) + ")"
        key = f"(?P<key>(?:{self.ticket}))/" if self.ticket else ""
        # `<dev>/<ticket>/<stage>`, or a fold branch `<dev>/<ticket>/<main stage>--folded--<stage>[,<stage>…]`
        # that names the stage it was opened for first and then the folded stages in stage order.
        self.stage_branch = re.compile(
            rf"^{dev}/{key}(?P<main>{SLUG})(?:{FOLDED}(?P<folded>{SLUG}(?:,{SLUG})*))?$")
        self.unit_branch = re.compile(rf"^{dev}/{key}[^/]+$")

    @staticmethod
    def _get(data, key, default, what, valid):
        if key not in data:
            return default
        if not valid(data[key]):
            raise ConfigError(f"`{CONFIG_FILE}`: `{key}` must be {what}.")
        return data[key]

    def branch(self, dev, key, name):
        return f"{dev}/" + (f"{key or '<ticket>'}/" if self.ticket else "") + name

    def own(self, key, name):
        """A branch name for the first configured developer, or the placeholder `<you>`."""
        return self.branch(self.developers[0] if self.developers else "<you>", key, name)

    def own_alts(self, key, name):
        """`own` for every configured developer, as `a` (or `b`)."""
        names = [self.branch(d, key, name) for d in (self.developers or ["<you>"])]
        return f"`{names[0]}`" + (" (or " + ", ".join(f"`{n}`" for n in names[1:]) + ")" if names[1:] else "")

    def shape(self, name):
        dev = "<" + "|".join(self.developers) + ">" if self.developers else "<developer>"
        return f"{dev}/" + ("<ticket>/" if self.ticket else "") + name

    def pr_from(self):
        return f" from `{self.pr_template}`" if self.has_template else ""


def load_config(top):
    """The project's `.stage-guard.json` as a Config; the defaults when the file does not exist,
    a ConfigError (a Refusal naming the file) when it cannot be read or has a wrong value."""
    try:
        with open(os.path.join(top, CONFIG_FILE), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as exc:
        raise ConfigError(f"`{CONFIG_FILE}` cannot be read ({exc}).") from None
    return Config(data, top)


def words(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def next_calls(command, depth=0):
    """Yield the argument list of every `orchestrate next` call in a shell command,
    including calls wrapped in `bash -c '…'` (or sh, zsh, dash, ksh) and `eval '…'`."""
    tokens = words(command)
    for k in range(len(tokens)):
        name = os.path.basename(tokens[k])
        if name in ORCHESTRATE and k + 1 < len(tokens) and tokens[k + 1] == "next":
            args = []
            for tok in tokens[k + 2:]:
                if tok in SHELL_OPS:
                    break
                args.append(tok)
            yield args
        if depth >= 3:
            continue
        if name in SHELLS:
            for j in range(k + 1, len(tokens)):
                tok = tokens[j]
                if tok in SHELL_OPS or not tok.startswith("-"):
                    break
                if "c" in tok[1:] and not tok.startswith("--") and j + 1 < len(tokens):
                    yield from next_calls(tokens[j + 1], depth + 1)
                    break
        elif tokens[k] == "eval":
            inner = []
            for tok in tokens[k + 1:]:
                if tok in SHELL_OPS:
                    break
                inner.append(tok)
            if inner:
                yield from next_calls(" ".join(inner), depth + 1)


def exempt(args):
    if args and args[0] in EXEMPT_VERBS:
        return True
    return any(a in EXEMPT_ANYWHERE for a in args)


def run(cmd, cwd, timeout=20):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def git(cwd, *args, check=True):
    proc = run(["git", *args], cwd)
    if check and proc.returncode != 0:
        raise Refusal(f"`git {' '.join(args)}` failed: {proc.stderr.strip() or proc.returncode}.")
    return proc


def read_cursor(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            value = f.read().strip()
        return value or default
    except OSError:
        return default


def state_file(top):
    space = read_cursor(os.path.join(top, "aidlc", "active-space"), "default")
    intents = os.path.join(top, "aidlc", "spaces", space, "intents")
    intent = read_cursor(os.path.join(intents, "active-intent"))
    if not intent:
        return None
    path = os.path.join(intents, intent, "aidlc-state.md")
    return path if os.path.isfile(path) else None


def stages(path):
    """(phase, slug, mark, execute) for every line of the state file's Stage Progress, in order."""
    out, phase = [], None
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = PHASE_LINE.match(line)
            if m:
                phase = m.group(1)
                continue
            m = STAGE_LINE.match(line)
            if m and phase:
                out.append((phase, m.group(2), m.group(1), m.group(3) == "EXECUTE"))
    return out


def stage_numbers(top):
    try:
        with open(os.path.join(top, ".claude", "tools", "data", "stage-graph.json"), encoding="utf-8") as f:
            return {s["number"]: s["slug"] for s in json.load(f) if isinstance(s, dict) and "number" in s}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def option(args, name):
    for k, arg in enumerate(args):
        if arg == name and k + 1 < len(args):
            return args[k + 1]
        if arg.startswith(name + "="):
            return arg.split("=", 1)[1]
    return None


def target_index(rows, args, top):
    """Index in rows of the stage this `next` call works on, or None."""
    jump = option(args, "--stage")
    if jump:
        slug = stage_numbers(top).get(jump, jump)
        for i, row in enumerate(rows):
            if row[1] == slug:
                return i
        return None
    phase = option(args, "--phase")
    if phase:
        names = {"0": "INITIALIZATION", "1": "IDEATION", "2": "INCEPTION", "3": "CONSTRUCTION", "4": "OPERATION"}
        wanted = names.get(phase, phase.upper())
        for i, row in enumerate(rows):
            if row[0] == wanted and row[3]:
                return i
        return None
    for i, row in enumerate(rows):
        if row[2] in "-?R":
            return i
    for i, row in enumerate(rows):
        if row[2] == " " and row[3]:
            return i
    return None


def started(path):
    """The intent's Start Date from its state file, or "" when it has none."""
    with open(path, encoding="utf-8") as f:
        m = START_DATE.search(f.read())
    return m.group(1) if m else ""


def key_of(m):
    """The ticket key of a stage-branch or Unit-branch match, None when no ticket pattern is set."""
    return m.groupdict().get("key") if m else None


def intent_prs(top, slugs, since, cfg):
    """Pull requests from a stage branch of this intent, oldest first.

    Only stages of this intent's Ideation and Inception count, and only pull requests created
    since the intent started, so an earlier intent's branch of the same name is never taken for
    this one's. Each carries the `key` and the `stages` read from its branch: its one stage, or,
    from a fold branch, the main stage followed by the folded stages, as the branch names them."""
    try:
        proc = run(["gh", "pr", "list", "--state", "all", "--limit", "1000",
                    "--json", "number,state,url,headRefName,createdAt"], top)
    except FileNotFoundError:
        raise Refusal("the GitHub CLI `gh` is not installed, so the previous stage's pull request "
                      "cannot be checked. Install it and run `gh auth login`.") from None
    except subprocess.TimeoutExpired:
        raise Refusal("GitHub did not answer in time, so the previous stage's pull request cannot be "
                      "checked. Try again when online.") from None
    if proc.returncode != 0:
        raise Refusal("`gh pr list` failed, so the previous stage's pull request cannot be checked "
                      f"({proc.stderr.strip() or proc.returncode}). Run `gh auth login` and try again.")
    prs = []
    for pr in json.loads(proc.stdout or "[]"):
        m = cfg.stage_branch.match(pr.get("headRefName", ""))
        if not m or pr.get("createdAt", "") < since:
            continue
        main, folded = branch_stages(m)
        if all(slug in slugs for slug in [main] + folded):
            prs.append(dict(pr, key=key_of(m), stages=[main] + folded))
    return sorted(prs, key=lambda pr: pr.get("createdAt", ""))


def after_approval(cfg, prev, branch):
    return (
        f"Stage `{prev}` is approved but its pull request is not open yet. On `{branch}`: commit "
        f"everything, push, open the pull request{cfg.pr_from()}, then park the workflow with "
        "`aidlc engine orchestrate park` until it is merged."
    )


def new_branch(cfg, target, key):
    others = ""
    if cfg.developers and len(cfg.developers) > 1:
        others = " (with your own prefix: " + " or ".join(f"`{d}/`" for d in cfg.developers) + ")"
    return (f"`git switch {cfg.main} && git pull --ff-only && git switch -c {cfg.own(key, target)}`"
            f"{others}, then resume")


UNKNOWN = object()  # whether a branch heads an open pull request could not be asked


def open_pr(top, branch):
    """The open pull request whose head is `branch`, None when there is none, UNKNOWN when `gh`
    cannot say."""
    try:
        proc = run(["gh", "pr", "list", "--head", branch, "--state", "open",
                    "--json", "number,url,headRefName,state"], top, timeout=10)
        rows = json.loads(proc.stdout or "[]") if proc.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        rows = None
    if rows is None:
        return UNKNOWN
    return next((pr for pr in rows if pr.get("headRefName") == branch and pr.get("state") == "OPEN"), None)


def replace_pr_steps(cfg, old, new, url, number):
    # Renaming a branch on GitHub retargets the pull requests whose BASE it is, but closes the
    # ones whose HEAD it is, so the head moves by a new pull request instead.
    return (f"rename the branch locally: `git branch -m {old} {new}`; push the new name: "
            f"`git push -u origin {new}`; open a new pull request from it{cfg.pr_from()} whose "
            f"description links {url}; close the old one with a comment linking the new one: "
            f"`gh pr close {number} --comment \"Continued in <new pull request URL>.\"`; only after that "
            f"delete the old remote branch: `git push origin --delete {old}`. The old pull request keeps "
            "its review as history; the new one starts without an approval and needs a new review "
            "once its work is ready")


def rename_steps(cfg, old, new, pr=UNKNOWN):
    """The steps that move the branch `old` to `new`. `pr` is the open pull request whose head is
    `old`, None when there is none, or UNKNOWN."""
    github_rename = (f"if `{old}` is pushed, rename it on GitHub too: `gh api -X POST "
                     f"repos/{{owner}}/{{repo}}/branches/{old}/rename -f new_name={new}`, then "
                     f"`git fetch origin && git branch -u origin/{new}`")
    if pr is None:
        return f"rename the branch: `git branch -m {old} {new}`; no pull request is open from it, so {github_rename}"
    if pr is not UNKNOWN:
        return (f"move the branch by a new pull request, because `{old}` is the head of the open pull "
                f"request {pr['url']} and renaming it on GitHub would close that pull request: "
                + replace_pr_steps(cfg, old, new, pr["url"], pr["number"]))
    return (f"check whether `{old}` is the head of an open pull request: `gh pr list --head {old} "
            "--state open`. If it is, never rename it on GitHub, which closes that pull request; instead, "
            + replace_pr_steps(cfg, old, new, "that pull request", "<its number>")
            + f". If it is not, rename the branch: `git branch -m {old} {new}`; {github_rename}")


def folds_path(state_path):
    return os.path.join(os.path.dirname(state_path), FOLDS)


def read_folds(state_path):
    """The record's fold approvals, keyed by fold branch; {} when there are none."""
    try:
        with open(folds_path(state_path), encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise Refusal(f"`{FOLDS}` in the intent's record cannot be read ({exc}).") from None
    return data if isinstance(data, dict) else {}


def branch_stages(m):
    """(main stage, folded stages as named) of a stage-branch match."""
    return m.group("main"), (m.group("folded").split(",") if m.group("folded") else [])


def fold_branch(cfg, dev, key, main, folded):
    return cfg.branch(dev, key, main) + (FOLDED + ",".join(folded) if folded else "")


def fold_matches(fold, intent, on_branch):
    return isinstance(fold, dict) and fold.get("intent") == intent and fold.get("stages") == on_branch


def listed(names):
    return ", ".join(f"`{s}`" for s in names)


def sha256_of(file):
    with open(file, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def blockers_of(text):
    """(value, problem) of the single `**Blockers:**` line of a start check. The value is None when
    the line is missing or there is more than one, so a note or an earlier line cannot stand in for
    the Result line."""
    found = BLOCKERS.findall(text)
    if not found:
        return None, f"`{START_CHECK}` has no `**Blockers:**` line (`none`, or the items that block this intent)"
    if len(found) > 1:
        return None, (f"`{START_CHECK}` has {len(found)} `**Blockers:**` lines; only the Result line may have "
                      "one. Rerun `start_check.py` without it in the note")
    return found[0].strip(), None


def no_blockers(value):
    return value.strip(" .`").lower() == "none"


def start_check_problem(path):
    """Why the intent's `start-check.md` does not yet allow Construction, or None when it does."""
    record = os.path.dirname(path)
    file = os.path.join(record, START_CHECK)
    if not os.path.isfile(file):
        return (f"the intent's record has no `{START_CHECK}`. Before its Construction, draft it with "
                "the plugin's `scripts/start_check.py --intent <slug>`")
    with open(file, encoding="utf-8") as f:
        value, problem = blockers_of(f.read())
    if problem:
        return problem
    if not no_blockers(value):
        return (f"`{START_CHECK}` still lists blockers ({value}). Construction waits until "
                "each is decided; then rerun `start_check.py` so the line reads `**Blockers:** none`")
    try:
        with open(os.path.join(record, APPROVAL), encoding="utf-8") as f:
            approval = json.load(f)
    except (OSError, ValueError):
        approval = None
    if not isinstance(approval, dict) or approval.get("sha256") != sha256_of(file):
        return (f"the developer has not confirmed the current `{START_CHECK}`. Only they give it, by typing "
                "`/stage-guard:confirm-start-check`; any change to the file needs a new confirmation")
    return None


def status_list(text, label):
    m = re.search(STATUS_LIST.format(re.escape(label)), text, re.MULTILINE)
    value = m.group(1) if m else ""
    return [] if value in ("", "none") else [s.strip() for s in value.split(",") if s.strip()]


def drifted(top):
    """(directly stale, needing revalidation) completed stages, as `aidlc engine status` reports them.

    The engine keeps a fingerprint of each stage's artifacts, and of the ones it read, when the stage
    is approved, and compares it with the files on every call; it only warns. Untracked stages (no
    fingerprint, like the initialization stages) do not count."""
    try:
        proc = run(["aidlc", "engine", "status", "--project-dir", top], top, timeout=60)
    except FileNotFoundError:
        raise Refusal("the hooks do not find the `aidlc` command, so the earlier stages' validity cannot be "
                      "checked. Install it and link it into `/usr/local/bin` (`README.md`, Set up a machine).") from None
    except subprocess.TimeoutExpired:
        raise Refusal("`aidlc engine status` did not answer in time, so the earlier stages' validity cannot be "
                      "checked. Try again.") from None
    if proc.returncode != 0:
        raise Refusal("`aidlc engine status` failed, so the earlier stages' validity cannot be checked "
                      f"({(proc.stderr or proc.stdout).strip()[-200:] or proc.returncode}).")
    m = VALIDITY.search(proc.stdout)
    if not m:
        raise Refusal("`aidlc engine status` printed no Validity line, so the earlier stages' validity cannot be "
                      "checked; the engine's status output may have changed, and the hook needs updating.")
    if m.group(1).startswith(("Current", "Untracked")):
        return [], []
    if m.group(1).startswith("Drift"):
        return status_list(proc.stdout, "Directly stale"), status_list(proc.stdout, "Revalidate")
    raise Refusal(f"the earlier stages' validity cannot be checked ({m.group(1)}); `/aidlc --status` shows "
                  "the warnings.")


def drift_problem(top, rows, i, fold_hint):
    """Why the stage at rows[i] would build on an earlier stage that drifted since its approval, or None.

    Only stages before it count: a drifted stage at or after it runs again anyway once the
    workflow reaches it. `fold_hint(stage)` adds how the stage can be carried in this branch's
    pull request, or returns ""."""
    stale, revalidate = drifted(top)
    order = {row[1]: k for k, row in enumerate(rows)}
    before = [s for s in stale + revalidate if order.get(s, -1) < i]  # a stage not in the plan counts
    if not before:
        return None
    earliest = min(before, key=lambda s: order.get(s, -1))
    parts = []
    if [s for s in stale if s in before]:
        parts.append(f"{listed([s for s in stale if s in before])} changed after approval")
    if [s for s in revalidate if s in before]:
        parts.append(f"{listed([s for s in revalidate if s in before])} read the results of a stage that did")
    return (f"stage `{rows[i][1]}` would build on stale work: {'; '.join(parts)} (`/aidlc --status`, "
            "Validity: a stage's artifacts, or the ones it read, no longer match what was approved). A stage "
            f"whose approved work changes is reopened and approved again: reopen `{earliest}` as a Bash call of "
            f"its own, `aidlc engine jump execute --target {earliest} --direction backward --scope <the intent's "
            "scope>`, then unpark if parked and resume; every stage after it runs again, each with its gate."
            + fold_hint(earliest)
            + " If the change was a mistake, revert it instead; the stage is current again once its files "
            "match.")


def check(args, cwd):
    proc = git(cwd, "rev-parse", "--show-toplevel", check=False)
    if proc.returncode != 0:
        return 0  # not inside a git checkout: nothing to guard
    top = proc.stdout.strip()
    cfg = load_config(top)
    try:
        return check_stage(args, top, cfg)
    except Refusal as why:
        why.rules_ref = cfg.rules_ref
        raise


def check_stage(args, top, cfg):
    path = state_file(top)
    if path is None:
        return 0  # no active intent yet; the first run creates it
    rows = stages(path)
    i = target_index(rows, args, top)
    if i is None:
        return 0  # nothing left to run
    phase, target, mark, _ = rows[i]
    if phase == "INITIALIZATION":
        return 0
    branch = git(top, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()

    if phase in UNIT_PHASES:
        if cfg.start_check:
            problem = start_check_problem(path)
            if problem:
                raise Refusal(f"stage `{target}` cannot start: {problem}.")
        unit = cfg.shape("<name>")
        if branch in (cfg.main, "HEAD"):
            raise Refusal(f"stage `{target}` would run on `{branch}`. Construction runs on the Unit's "
                          f"branch `{unit}`, created from an up-to-date {cfg.main}.")
        if not cfg.unit_branch.match(branch):
            raise Refusal(f"stage `{target}` would run on `{branch}`, which is not a Unit branch. Switch to "
                          f"the Unit's branch `{unit}`" + (" (the ticket is the Unit's key)." if cfg.ticket else "."))
        problem = drift_problem(top, rows, i, lambda stage: "")
        if problem:
            raise Refusal(problem)
        return 0

    slugs = {r[1] for r in rows if r[0] in STAGE_PHASES}
    plan = [r[1] for r in rows if r[0] in STAGE_PHASES and r[3]]
    if branch in (cfg.main, "HEAD"):
        try:
            prs = intent_prs(top, slugs, started(path), cfg)
        except Refusal:
            prs = []  # the refusal below stands without the ticket key
        key = prs[0]["key"] if prs else None
        raise Refusal(f"stage `{target}` would run on `{branch}`. Create its branch from an up-to-date "
                      f"{cfg.main}: {new_branch(cfg, target, key)}.")

    # The intent's ticket key is the one on its first stage pull request; before there is one,
    # the current branch sets it. Without a ticket pattern there is no key.
    prs = intent_prs(top, slugs, started(path), cfg)
    m = cfg.stage_branch.match(branch)
    key = prs[0]["key"] if prs else key_of(m)
    main, folded = branch_stages(m) if m else (None, [])
    on_branch = [main] if m else []  # the stages this branch's pull request carries, in plan order
    prev = next((r[1] for r in reversed(rows[:i]) if r[0] in STAGE_PHASES and r[2] == "x" and r[3]), None)
    intent = os.path.basename(os.path.dirname(path))
    folds = read_folds(path)

    if folded:
        if any(s not in plan for s in [main] + folded) or main in folded or len(set(folded)) != len(folded) \
                or [plan.index(s) for s in folded] != sorted(plan.index(s) for s in folded):
            raise Refusal(f"`{branch}` names its folded stages out of stage order, twice, or outside this "
                          f"plan's Ideation and Inception stages; after `{FOLDED}` they follow in stage order.")
        on_branch = sorted([main] + folded, key=plan.index)
        positions = [plan.index(s) for s in on_branch]
        if positions != list(range(positions[0], positions[0] + len(positions))):
            raise Refusal(f"`{branch}` does not carry consecutive stages of this plan; a fold also carries "
                          "every stage between, because the workflow runs them in order.")
        if not fold_matches(folds.get(branch), intent, on_branch):
            raise Refusal(f"`{branch}` carries {listed(on_branch)} in one pull request, and the intent's "
                          f"`{FOLDS}` records no fold approval for this branch. Only the developer gives it, "
                          "by asking for the fold and typing `/stage-guard:fold <stage> […]`; otherwise each "
                          "stage runs on its own branch.")
    last = on_branch[-1] if on_branch else None

    if target not in on_branch:
        # A fold approved on this branch that takes the stage, but the branch is not renamed yet.
        approved = next((b for b, f in folds.items() if isinstance(f, dict) and f.get("from") == branch
                         and f.get("intent") == intent and target in (f.get("stages") or [])), None)
        if approved:
            own_pr = next((pr for pr in prs if pr.get("headRefName") == branch and pr.get("state") == "OPEN"),
                          None)
            raise Refusal(f"the fold that takes `{target}` is approved for the branch `{approved}`. Before "
                          f"resuming, {rename_steps(cfg, branch, approved, own_pr)}.")
        fold_too = (f"To carry `{target}` in this branch's pull request instead, the developer can ask for "
                    f"it by typing `/stage-guard:fold {target}`; an agent cannot give that approval.")
        if prev and last == prev:
            prev_prs = [pr for pr in prs if prev in pr["stages"]]
            if not prev_prs:
                raise Refusal(after_approval(cfg, prev, branch) + " " + fold_too)
            open_prs = [pr for pr in prev_prs if pr.get("state") == "OPEN"]
            if open_prs:
                raise Refusal(f"stage `{prev}` is waiting for review in {open_prs[0]['url']}. Park the "
                              "workflow with `aidlc engine orchestrate park` until it is merged; then "
                              f"{new_branch(cfg, target, key)}.")
            raise Refusal(f"stage `{prev}` is merged; stage `{target}` needs its own branch: "
                          f"{new_branch(cfg, target, key)}.")
        if on_branch and on_branch[0] in plan and target in plan and plan.index(target) < plan.index(on_branch[0]):
            raise Refusal(f"stage `{target}` is reopened on `{branch}`, the branch of {listed(on_branch)}. A "
                          f"reopened stage runs on its own branch: {new_branch(cfg, target, key)}. " + fold_too)
        raise Refusal(f"stage `{target}` would run on `{branch}`; it runs on {cfg.own_alts(key, target)}. "
                      f"Create it from an up-to-date {cfg.main}: {new_branch(cfg, target, key)}.")
    if cfg.ticket and key_of(m) != key:
        raise Refusal(f"this intent's stage branches carry the ticket `{key}` (its first stage pull request, "
                      f"{prs[0]['url']}), but `{branch}` carries `{key_of(m)}`. Rename the branch to "
                      f"`{m.group('dev')}/{key}/{branch.split('/', 2)[2]}`.")

    # A stage carried on this branch is the previous stage's pull request for the next one, so
    # only a previous stage outside the branch needs a merged pull request of its own; a pull
    # request from this branch never stands in for it.
    if prev and prev not in on_branch:
        prev_prs = [pr for pr in prs if prev in pr["stages"] and pr["headRefName"] != branch]
        open_prs = [pr for pr in prev_prs if pr.get("state") == "OPEN"]
        if open_prs:
            raise Refusal(f"the previous stage `{prev}` is still under review in {open_prs[0]['url']}. "
                          f"Wait for it to merge, then bring this branch up to date with {cfg.main} "
                          f"(rebase it onto `origin/{cfg.main}`, keeping its commits) and resume.")
        if not any(pr.get("state") == "MERGED" for pr in prev_prs):
            raise Refusal(f"the previous stage `{prev}` has no merged pull request since this intent "
                          f"started. Open it from `{cfg.own(key, prev)}`"
                          + (f" with `{cfg.pr_template}`" if cfg.has_template else "")
                          + f" and wait for the merge before stage `{target}` starts.")

    if mark == " " and prev not in on_branch:  # the first stage this branch starts
        git(top, "fetch", "--quiet", "origin", cfg.main, check=False)
        if git(top, "merge-base", "--is-ancestor", f"origin/{cfg.main}", "HEAD", check=False).returncode != 0:
            raise Refusal(f"`{branch}` does not contain the latest {cfg.main}, so stage `{target}` would start "
                          f"from stale documents. Rebase it onto `origin/{cfg.main}` (or recreate it: "
                          f"{new_branch(cfg, target, key)}).")

    def fold_hint(stage):
        if stage in on_branch or stage not in plan:
            return ""
        return (f" To carry it in this branch's pull request instead of its own branch, the developer can type "
                f"`/stage-guard:fold {stage}`; an agent cannot give that approval.")

    problem = drift_problem(top, rows, i, fold_hint)
    if problem:
        raise Refusal(problem)
    return 0


def fold_prompt(event):
    """Record the developer's typed `/stage-guard:fold <stage> […]` in the record's stage-folds.json.

    Runs on UserPromptSubmit, so only text the person typed reaches it. Prints the outcome as
    context for the agent and never blocks the prompt."""
    m = FOLD_PROMPT.match((event.get("prompt") or "").strip().split("\n", 1)[0])
    if not m:
        return 0

    def say(text):
        print("stage-guard: " + text)
        return 0

    cwd = event.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    proc = git(cwd, "rev-parse", "--show-toplevel", check=False)
    if proc.returncode != 0:
        return say("fold not recorded: this is not a git checkout.")
    top = proc.stdout.strip()
    try:
        cfg = load_config(top)
    except ConfigError as why:
        return say(f"fold not recorded: {why}")
    path = state_file(top)
    if path is None:
        return say("fold not recorded: there is no active AI-DLC intent.")
    plan = [r[1] for r in stages(path) if r[0] in STAGE_PHASES and r[3]]
    numbers = stage_numbers(top)
    asked = [numbers.get(a, a) for a in re.split(r"[\s,]+", (m.group(1) or "").strip()) if a]
    branch = git(top, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    b = cfg.stage_branch.match(branch)
    if not b:
        return say(f"fold not recorded: `{branch}` is not a stage branch `{cfg.shape('<stage>')}`. The fold "
                   "is typed on the branch whose pull request carries it.")
    main, folded_now = branch_stages(b)
    named = [main] + folded_now
    wrong = [s for s in named + asked if s not in plan]
    if wrong:
        return say(f"fold not recorded: {listed(wrong)} is not an Ideation or Inception stage of this plan.")
    if not [a for a in asked if a not in named]:
        return say(f"fold not recorded: name the stage or stages the pull request of `{main}` should also "
                   "carry: an earlier stage to reopen into it, or a later stage to run on it.")
    lo = min(plan.index(s) for s in named + asked)
    hi = max(plan.index(s) for s in named + asked)
    carried = plan[lo:hi + 1]  # the workflow runs stages in order, so a fold is a run of consecutive stages
    try:
        folds = read_folds(path)
    except Refusal as why:
        return say(f"fold not recorded: {why}")
    new = fold_branch(cfg, b.group("dev"), key_of(b), main, [s for s in carried if s != main])
    who = git(top, "config", "user.name", check=False).stdout.strip() or "the developer"
    folds[new] = {
        "intent": os.path.basename(os.path.dirname(path)), "stages": carried, "main": main, "from": branch,
        "approvedBy": who, "approvedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    with open(folds_path(path), "w", encoding="utf-8") as f:
        json.dump(folds, f, indent=2, ensure_ascii=False)
        f.write("\n")
    between = [s for s in carried if s not in named and s not in asked]
    steps = [] if new == branch else [rename_steps(cfg, branch, new, open_pr(top, branch))]
    if lo < min(plan.index(s) for s in named):
        # One backward jump to the earliest stage reopens it and resets everything after it.
        steps.append(f"as a Bash call of its own: `aidlc engine jump execute --target {carried[0]} --direction "
                     "backward --scope <the intent's scope>`, unless the workflow is already back on it")
    steps += ["if the workflow is parked, `aidlc engine state unpark`",
              f"resume the workflow and run, review and approve every stage of the fold on `{new}`, in order",
              f"commit `{FOLDS}` with the work, then open the pull request (or update the open one) and name "
              "the folded stages under \"What\" in its description"]
    return say(f"{who} approved carrying {listed(carried)} in one pull request, recorded for the branch `{new}` "
               f"in the intent's `{FOLDS}`."
               + (f" {listed(between)} is included because the workflow runs the stages in order." if between else "")
               + " Steps: " + "; ".join(f"({n}) {t}" for n, t in enumerate(steps, 1)) + ".")


def confirm_prompt(event):
    """Record the developer's typed `/stage-guard:confirm-start-check [<intent>]` as the sha256 of the
    intent's current start-check.md in the record's start-check-approval.json.

    Runs on UserPromptSubmit, so only text the person typed reaches it. Prints the outcome as
    context for the agent and never blocks the prompt."""
    m = CONFIRM_PROMPT.match((event.get("prompt") or "").strip().split("\n", 1)[0])
    if not m:
        return 0

    def say(text):
        print("stage-guard: " + text)
        return 0

    cwd = event.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    proc = git(cwd, "rev-parse", "--show-toplevel", check=False)
    if proc.returncode != 0:
        return say("start check not confirmed: this is not a git checkout.")
    top = proc.stdout.strip()
    try:
        cfg = load_config(top)
    except ConfigError as why:
        return say(f"start check not confirmed: {why}")
    if not cfg.start_check:
        return say(f"start check not confirmed: the start check is not enabled for this project (set "
                   f"`\"startCheck\": true` in `{CONFIG_FILE}` to use it).")
    state = state_file(top)
    if m.group(1):
        intents = os.path.join(top, "aidlc", "spaces", read_cursor(os.path.join(top, "aidlc", "active-space"),
                                                                    "default"), "intents")
        try:
            with open(os.path.join(intents, "intents.json"), encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            return say("start check not confirmed: intents.json cannot be read.")
        row = next((r for r in rows if m.group(1) in (r.get("slug"), r.get("dirName"))), None)
        if not row:
            return say(f"start check not confirmed: `{m.group(1)}` is not an intent in intents.json.")
        state = os.path.join(intents, row["dirName"], "aidlc-state.md")
    elif state is None:
        return say("start check not confirmed: there is no active AI-DLC intent.")
    record = os.path.dirname(state)
    file = os.path.join(record, START_CHECK)
    if not os.path.isfile(file):
        return say(f"start check not confirmed: the record has no `{START_CHECK}`. Draft it with "
                   "the plugin's `scripts/start_check.py --intent <slug>`.")
    with open(file, encoding="utf-8") as f:
        value, problem = blockers_of(f.read())
    if problem:
        return say(f"start check not confirmed: {problem}.")
    if not no_blockers(value):
        return say(f"start check not confirmed: `{START_CHECK}` lists blockers ({value}). A list with "
                   "blockers is not confirmed; rerun `start_check.py` once they are decided.")
    who = git(top, "config", "user.name", check=False).stdout.strip() or "the developer"
    with open(os.path.join(record, APPROVAL), "w", encoding="utf-8") as f:
        json.dump({"intent": os.path.basename(record), "sha256": sha256_of(file), "approvedBy": who,
                   "approvedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
                  f, indent=2, ensure_ascii=False)
        f.write("\n")
    return say(f"{who} confirmed the current `{START_CHECK}` of `{os.path.basename(record)}` (no blockers), "
               f"recorded in `{APPROVAL}` with the file's sha256. Commit both files with the work. Any "
               f"change to `{START_CHECK}` needs a new confirmation.")


def segments(tokens):
    """The simple commands of a token list, split at shell operators."""
    out, current = [], []
    for tok in tokens + [";"]:
        if tok in SHELL_OPS:
            if current:
                out.append(current)
            current = []
        else:
            current.append(tok)
    return out


def runs_hook(command, depth=0):
    """True when a shell command executes or imports this hook, which could hand it a forged
    UserPromptSubmit event: `stage_guard.py` run directly or by a Python interpreter (as its
    script, from stdin, as `-m stage_guard`, or imported in `-c` code), also inside `bash -c '…'`
    and `eval '…'`. Reading, linting or testing the file is not running it."""
    for seg in segments(words(command)):
        while seg and (seg[0] in LAUNCHERS or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", seg[0])):
            seg = seg[2:] if seg[0] == "uv" and len(seg) > 1 and seg[1] == "run" else seg[1:]
        if not seg:
            continue
        first = os.path.basename(seg[0])
        if first == HOOK_FILE:
            return True
        if depth < 3 and (first in SHELLS or seg[0] == "eval"):
            inner = seg[1:] if seg[0] == "eval" else [
                seg[j + 1] for j in range(1, len(seg) - 1) if seg[j].startswith("-") and "c" in seg[j][1:]
                and not seg[j].startswith("--")][:1]
            if inner and runs_hook(" ".join(inner), depth + 1):
                return True
            continue
        if not PYTHON.fullmatch(first):
            continue
        args, k = seg[1:], 0
        stdin = next((seg[j + 1] for j in range(len(seg) - 1) if seg[j] == "<"), "")
        while k < len(args) and args[k].startswith("-") and args[k] != "-":
            if args[k] == "-m":
                return k + 1 < len(args) and args[k + 1] == HOOK_NAME
            if args[k] == "-c":
                return k + 1 < len(args) and bool(HOOK_IMPORT.search(args[k + 1]))
            k += 1
        script = args[k] if k < len(args) else "-"
        if os.path.basename(script) == HOOK_FILE or (script == "-" and os.path.basename(stdin) == HOOK_FILE):
            return True
    return False


def touches_folds(event):
    """Why a tool call would write the record's stage-folds.json or start-check-approval.json, record
    a fold or a confirmation, or None.

    Covers an Edit or Write of the file; a shell command that names the file and is not a reader,
    redirects into it, or restores, moves or removes it through git; and a shell command that runs
    this hook (see `runs_hook`)."""
    tool = event.get("tool_name")
    tool_input = event.get("tool_input") or {}
    if tool in EDIT_TOOLS:
        target = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        name = os.path.basename(target)
        return f"`{name}` is written only by the stage-guard hook" if name in PROTECTED else None
    command = tool_input.get("command", "") if tool == "Bash" else ""
    if not any(n in command for n in PROTECTED) and HOOK_NAME not in command:
        return None
    try:
        tokens = words(command)
        if HOOK_NAME in command and runs_hook(command):
            return "running the hook by hand could record a fold or a confirmation the developer never typed"
    except ValueError:
        return "the command names a protected record or the hook and cannot be parsed"
    for segment in segments(tokens):
        if not any(n in t for t in segment for n in PROTECTED):
            continue
        first = os.path.basename(segment[0])
        if first not in READERS:
            return "`stage-folds.json` and `start-check-approval.json` are written only by the stage-guard hook"
        if first == "git" and any(t in GIT_WRITES for t in segment[1:]):
            return "`stage-folds.json` and `start-check-approval.json` are never restored, moved or removed through git by an agent"
        for k, t in enumerate(segment[:-1]):
            if t.endswith(">") and any(n in segment[k + 1] for n in PROTECTED):
                return "`stage-folds.json` and `start-check-approval.json` are written only by the stage-guard hook"
    return None


def guard(event):
    if event.get("hook_event_name") == "UserPromptSubmit":
        return fold_prompt(event) or confirm_prompt(event)
    why = touches_folds(event)
    if why:
        return refuse(f"{why}. They hold the developer's fold approvals and start-check confirmations and "
                      "are written only when the developer types `/stage-guard:fold <stage>` or "
                      "`/stage-guard:confirm-start-check`; an agent never writes them or records either.")
    if event.get("tool_name") != "Bash":
        return 0
    command = (event.get("tool_input") or {}).get("command", "")
    if "orchestrate" not in command or "next" not in command:
        return 0
    try:
        calls = list(next_calls(command))
    except ValueError:
        return 0  # not parseable as shell words, so not a call we can recognise
    cwd = event.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    for args in calls:
        if exempt(args):
            continue
        try:
            check(args, cwd)
        except Refusal as why:
            return refuse(str(why), why.rules_ref)
    return 0


def main():
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    try:
        return guard(event)
    except Exception as exc:  # fail closed on an event that reached the checks
        if event.get("hook_event_name") == "UserPromptSubmit":
            print(f"stage-guard: nothing recorded: internal error ({exc!r}).")
            return 0
        return refuse(f"internal error ({exc!r}).")


if __name__ == "__main__":
    sys.exit(main())
