#!/usr/bin/env python3
"""PreToolUse guard for the AI-DLC rule files.

team.md and project.md carry no `## Corrections` heading. A lesson kept at a stage's learnings
question is saved with the learnings tool under a section the file already has; the tool's
`(learned …) <!-- cid -->` line ending is accepted.

Refuses, with exit code 2 and a reason on stderr:
- a `learnings persist` call (the tokens `…learnings` or `…learnings.ts` followed by `persist`)
  whose selections file routes a learning to a heading that is not already an H2 section of the
  target file (team.md or project.md of the active space), an empty one or Corrections included,
  or whose selections file or target file cannot be read;
- an Edit, MultiEdit or Write to aidlc/spaces/<space>/memory/team.md or project.md whose new
  text carries a `## Corrections` heading (any case).
Calls wrapped in `bash -c '…'` (or sh, zsh, dash, ksh) and `eval '…'` are checked too.
Text that merely mentions the command (a commit message, a PR body, a grep) passes. Sensor
selections pass. Once an event is known to concern the rule files, an internal error refuses it
rather than letting it through. Standard library only.
"""

import json
import os
import re
import shlex
import sys

H2 = re.compile(r"^##[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
RULE_FILE = re.compile(r"(?:^|/)aidlc/spaces/[^/]+/memory/(?:team|project)\.md$")
CORRECTIONS = re.compile(r"^##[ \t]+corrections\b", re.MULTILINE | re.IGNORECASE)
SHELL_OPS = {"&&", "||", ";", "|", "&", "(", ")", ";;", "|&"}


def refuse(why, allowed=None):
    where = ""
    if allowed:
        where = " " + "; ".join(f"{scope}.md: {', '.join(names) or '(no sections)'}" for scope, names in allowed.items()) + "."
    print(
        "Refused by the rule-guard plugin: " + why + " A kept lesson goes under a section the file "
        "already has, never `## Corrections`." + where,
        file=sys.stderr,
    )
    return 2


def memory_dir(cwd):
    """aidlc/spaces/<active space>/memory under the project root."""
    root = os.environ.get("CLAUDE_PROJECT_DIR") or cwd
    space = "default"
    try:
        with open(os.path.join(root, "aidlc", "active-space"), encoding="utf-8") as f:
            space = f.read().strip() or "default"
    except OSError:
        pass
    return os.path.join(root, "aidlc", "spaces", space, "memory")


def sections(cwd):
    """{scope: [H2 headings of <scope>.md, Corrections left out]}; None for an unreadable file."""
    found = {}
    for scope in ("team", "project"):
        try:
            with open(os.path.join(memory_dir(cwd), scope + ".md"), encoding="utf-8") as f:
                text = f.read()
        except OSError:
            found[scope] = None
            continue
        found[scope] = [h for h in H2.findall(text) if not CORRECTIONS.match("## " + h)]
    return found


SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}


def persist_calls(command, depth=0):
    """Yield the argument list of every `learnings persist` call in a shell command,
    including calls wrapped in `bash -c '…'` (or sh, zsh, dash, ksh) and `eval '…'`."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    tokens = list(lexer)
    for k in range(len(tokens)):
        name = os.path.basename(tokens[k])
        if name in ("learnings", "learnings.ts", "aidlc-learnings.ts") and k + 1 < len(tokens) and tokens[k + 1] == "persist":
            args = []
            for tok in tokens[k + 2:]:
                if tok in SHELL_OPS:
                    break
                args.append(tok)
            yield args
        if depth >= 3:
            continue
        if name in SHELLS:
            # `bash -c 'inner'`, `bash -lc 'inner'`, `bash -e -c 'inner'`
            for j in range(k + 1, len(tokens)):
                tok = tokens[j]
                if tok in SHELL_OPS or not tok.startswith("-"):
                    break
                if "c" in tok[1:] and not tok.startswith("--") and j + 1 < len(tokens):
                    yield from persist_calls(tokens[j + 1], depth + 1)
                    break
        elif tokens[k] == "eval":
            inner = []
            for tok in tokens[k + 1:]:
                if tok in SHELL_OPS:
                    break
                inner.append(tok)
            if inner:
                yield from persist_calls(" ".join(inner), depth + 1)


def selections_path(args):
    for k, arg in enumerate(args):
        if arg == "--selections-json" and k + 1 < len(args):
            return args[k + 1]
        if arg.startswith("--selections-json="):
            return arg.split("=", 1)[1]
    return None


def check_persist(args, cwd):
    path = selections_path(args)
    if path is None:
        return 0  # the tool refuses a call without a selections file by itself
    if "$" in path or "`" in path:
        return refuse("pass the selections file to `learnings persist` as a literal path, so its headings can be checked.")
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)
    try:
        with open(path, encoding="utf-8") as f:
            selections = json.load(f).get("selections", [])
    except (OSError, ValueError, AttributeError):
        return refuse(f"cannot read the selections file {path}; write it in a separate step before `learnings persist`.")
    allowed = None
    for sel in selections:
        if not isinstance(sel, dict) or sel.get("type") == "sensor":
            continue
        if allowed is None:
            allowed = sections(cwd)
        scope = "team" if sel.get("scope") == "team" else "project"
        if allowed[scope] is None:
            return refuse(f"cannot read {scope}.md in {memory_dir(cwd)}, so the section of selection "
                          f"{sel.get('candidate_id', '?')} cannot be checked.")
        heading = re.sub(r"^#+\s*", "", str(sel.get("heading") or "")).strip()
        if heading not in allowed[scope]:
            shown = heading or "(none, which the tool files under Corrections)"
            return refuse(f"selection {sel.get('candidate_id', '?')} is routed to `{shown}` in {scope}.md.",
                          {k: v for k, v in allowed.items() if v is not None})
    return 0


def new_text(tool_input):
    parts = [tool_input.get("content", ""), tool_input.get("new_string", "")]
    for edit in tool_input.get("edits", []) or []:
        if isinstance(edit, dict):
            parts.append(edit.get("new_string", ""))
    return "\n".join(p for p in parts if isinstance(p, str))


def guard(event):
    tool = event.get("tool_name", "")
    tool_input = event.get("tool_input", {}) or {}
    if tool == "Bash":
        command = tool_input.get("command", "")
        if "persist" not in command:
            return 0
        try:
            calls = list(persist_calls(command))
        except ValueError:
            return 0  # not parseable as shell words, so not a call we can recognise
        for args in calls:
            result = check_persist(args, event.get("cwd") or os.getcwd())
            if result:
                return result
        return 0
    if tool in ("Edit", "MultiEdit", "Write"):
        path = str(tool_input.get("file_path", "")).replace("\\", "/")
        if RULE_FILE.search(path) and CORRECTIONS.search(new_text(tool_input)):
            return refuse("this edit adds a `## Corrections` heading.")
    return 0


def main():
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    try:
        return guard(event)
    except Exception as exc:  # fail closed on an event that reached the checks
        return refuse(f"internal error ({exc!r}).")


if __name__ == "__main__":
    sys.exit(main())
