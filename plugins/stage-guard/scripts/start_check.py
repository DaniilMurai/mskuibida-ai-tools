#!/usr/bin/env python3
"""Draft an intent's start-check.md, the list the developer confirms before Construction.

    python3 <plugin dir>/scripts/start_check.py --intent <slug|dir> [options]

Reads the files named in `startCheckSources` of `.stage-guard.json` (repo-relative paths; default
none) and `intents/intents.json` of the active space, and writes `start-check.md` into the
intent's record (`--print` writes to stdout instead). A source is a Markdown file of numbered open
items, each `## <n>. <title>` with exactly one Decided line, either `**Decided:** —` (open) or
`**Decided (<date> …):**` (decided), and, for an open item, a `**Blocks:**` paragraph. Per open
item the tool applies the item's **Blocks** line: an item naming the intent in backticks, or
"every intent" with no condition, is blocking; "every intent whose …" is a condition only the
developer can judge, and so is every other intent that is not archived. Those stay undecided, and
the **Blockers:** line says so, until a judgement is passed:

    --touches N          open item N concerns this intent's scope (blocking)
    --not-touches N      open item N does not (not blocking)
    --overlaps SLUG      the in-flight intent SLUG overlaps this intent's scope (blocking)
    --no-overlap SLUG    it does not
    --note TEXT          a line of context under the heading

An item number applies to the item with that number in every source. Without sources only the
other intents are listed. The confirmation and the Construction gate are the hook's (README,
"Confirming a start check"). The tool writes nothing but `start-check.md`, so running it again
means a new confirmation. Standard library only.
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

SPACE = os.path.join("aidlc", "spaces", "default")
INTENTS = os.path.join(SPACE, "intents")  # the default space; `intents_dir` follows aidlc/active-space
START_CHECK = "start-check.md"
ITEM = re.compile(r"^## (\d+)\. (.+?)\s*$", re.MULTILINE)
OPEN_LINE = re.compile(r"^\*\*Decided:\*\*[ \t]*—[ \t]*$", re.MULTILINE)  # the only open form
DECIDED_LINE = re.compile(r"^\*\*Decided \([^)]+\):\*\*", re.MULTILINE)  # the only decided form
ANY_DECIDED = re.compile(r"^\*\*Decided\b", re.MULTILINE)
BLOCKS = re.compile(r"^\*\*Blocks:\*\*[ \t]*(.*?)(?:\n\s*\n|\Z)", re.MULTILINE | re.DOTALL)
CONDITIONAL = re.compile(r"every intent\b\s+(?:whose|that|which|where|when)\b", re.IGNORECASE)
UNCONDITIONAL = re.compile(r"every intent\b", re.IGNORECASE)
CURRENT_STAGE = re.compile(r"^- \*\*Active Agent\*\*", re.MULTILINE)
HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "stage_guard.py")


class Problem(Exception):
    pass


def load_config(top):
    """The project's `.stage-guard.json`, read by the hook's own helper."""
    spec = importlib.util.spec_from_file_location("stage_guard_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        return module.load_config(top)
    except module.ConfigError as why:
        raise Problem(str(why)) from None


def top_of(cwd):
    proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise Problem("run it inside the project checkout")
    return proc.stdout.strip()


def intents_dir(top):
    """The active space's intents directory, relative to `top` (the default space without a cursor)."""
    try:
        with open(os.path.join(top, "aidlc", "active-space"), encoding="utf-8") as f:
            space = f.read().strip()
    except OSError:
        space = ""
    return os.path.join("aidlc", "spaces", space, "intents") if space else INTENTS


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as why:
        raise Problem(f"cannot read {path}: {why.strerror}") from None


def items(text, source):
    """The numbered items of a source file: number, title, open or decided, Blocks text."""
    name = os.path.basename(source)
    marks = list(ITEM.finditer(text))
    found = []
    for k, m in enumerate(marks):
        end = marks[k + 1].start() if k + 1 < len(marks) else len(text)
        body = text[m.end():end].split("\n---", 1)[0]
        is_open, is_decided = bool(OPEN_LINE.search(body)), bool(DECIDED_LINE.search(body))
        if len(ANY_DECIDED.findall(body)) != 1 or is_open == is_decided:
            raise Problem(f"item {m.group(1)} of {name} needs exactly one Decided line, either "
                          "`**Decided:** —` (open) or `**Decided (<date> …):**` (decided); any other form "
                          "could hide an open item")
        blocks = BLOCKS.search(body)
        if is_open and not blocks:
            raise Problem(f"open item {m.group(1)} of {name} has no **Blocks** line; a new item "
                          "gets one when it is raised (naming the intent that raised it)")
        found.append({"n": int(m.group(1)), "title": m.group(2), "open": is_open,
                      "blocks": " ".join(blocks.group(1).split()) if blocks else "",
                      "label": os.path.splitext(name)[0]})
    if not found:
        raise Problem(f"{name} has no numbered items")
    return found


def resolve(top, wanted):
    path = os.path.join(top, intents_dir(top), "intents.json")
    rows = json.loads(read(path))
    for row in rows:
        if wanted in (row.get("slug"), row.get("dirName")):
            return row, rows
    raise Problem(f"no intent `{wanted}` in intents.json (slugs: {', '.join(r.get('slug', '?') for r in rows)})")


def current_stage(top, row):
    path = os.path.join(top, intents_dir(top), row["dirName"], "aidlc-state.md")
    state = read(path) if os.path.exists(path) else ""
    done = re.findall(r"^- \[x\] ([a-z0-9-]+)", state, re.MULTILINE)
    return f"{len(done)} stages done" if state else "no state file"


def numbers(values):
    return {int(v) for v in values or []}


def verdict(item, slug, touches, not_touches):
    """(label, blocking, undecided) for one item."""
    if not item["open"]:
        return "not blocking (decided)", False, False
    if f"`{slug}`" in item["blocks"]:
        return "**blocking** (names this intent)", True, False
    if item["n"] in touches:
        return "**blocking** (touches this intent's scope, per the developer)", True, False
    if item["n"] in not_touches:
        return "not blocking (judged not to touch this scope)", False, False
    if CONDITIONAL.search(item["blocks"]):
        return "**undecided**: blocks the intents whose scope matches its Blocks line", False, True
    if UNCONDITIONAL.search(item["blocks"]):
        return "**blocking** (every intent)", True, False
    return "not blocking (names other intents)", False, False


def build(top, args):
    row, rows = resolve(top, args.intent)
    slug = row["slug"]
    sources = [(source, items(read(os.path.join(top, source)), source)) for source in load_config(top).sources]
    known = {e["n"] for _, entries in sources for e in entries if e["open"]}
    touches, not_touches = numbers(args.touches), numbers(args.not_touches)
    for n in touches | not_touches:
        if n not in known:
            raise Problem(f"item {n} is not an open item of the start-check sources")
    if args.note and "**Blockers:**" in args.note:
        raise Problem("the note may not contain a `**Blockers:**` line; only the Result line has one")
    others = [r for r in rows if r["dirName"] != row["dirName"] and r.get("status") != "archived"]
    archived = [r for r in rows if r["dirName"] != row["dirName"] and r.get("status") == "archived"]
    overlaps, no_overlap = set(args.overlaps or []), set(args.no_overlap or [])
    for s in overlaps | no_overlap:
        if s not in {r["slug"] for r in others}:
            raise Problem(f"`{s}` is not another intent in flight")

    blockers = []
    lines = [f"# Start check — {slug}", "",
             f"Written {datetime.now(timezone.utc):%Y-%m-%d} by the stage-guard plugin's `start_check.py`.", ""]
    if args.note:
        lines += [args.note, ""]
    for source, entries in sources:
        lines += [f"## Open items read (`{source}`)", "",
                  "| Item | Status | Blocks | Verdict |", "| --- | --- | --- | --- |"]
        for e in entries:
            label, blocking, undecided = verdict(e, slug, touches, not_touches)
            if blocking:
                blockers.append(f"{e['label']} item {e['n']}")
            if undecided:
                blockers.append(f"undecided: {e['label']} item {e['n']} "
                                f"(rerun with --touches {e['n']} or --not-touches {e['n']})")
            lines.append(f"| {e['n']} {e['title']} | {'**OPEN**' if e['open'] else 'decided'} | "
                         f"{e['blocks'] or '—'} | {label} |")
        lines.append("")
    if not sources:
        lines += ["No start-check source is configured (`startCheckSources` in `.stage-guard.json`).", ""]
    lines += ["## Other intents read (`intents/intents.json`)", "",
              "| Intent | Status | Verdict |", "| --- | --- | --- |"]
    for r in others:
        if r["slug"] in overlaps:
            blockers.append(f"intent `{r['slug']}` overlaps this scope")
            label = "**blocking** (overlaps this intent's scope, per the developer)"
        elif r["slug"] in no_overlap:
            label = "not blocking (judged not to overlap)"
        else:
            blockers.append(f"undecided: intent `{r['slug']}` (rerun with --overlaps {r['slug']} or --no-overlap {r['slug']})")
            label = "**undecided**: does it change the same contract, schema, deploy path or Unit?"
        lines.append(f"| `{r['slug']}` (`{r['dirName']}`) | in flight, {current_stage(top, r)} | {label} |")
    for r in archived:
        lines.append(f"| `{r['slug']}` (`{r['dirName']}`) | archived | nothing to take from it |")
    if not others:
        lines += ["", "No other intent is in flight."]
    lines += ["", "## Result", "",
              "- **Blockers:** " + ("; ".join(blockers) if blockers else "none"), ""]
    if blockers:
        lines[-2] += ". Construction of this intent waits until they are decided; then rerun the tool or change this line to `none`."
    return row, "\n".join(lines).replace("\n\n\n", "\n\n"), blockers


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draft an intent's start-check.md.")
    ap.add_argument("--intent", required=True, help="the intent's slug or record directory name")
    ap.add_argument("--touches", action="append", metavar="N")
    ap.add_argument("--not-touches", action="append", metavar="N")
    ap.add_argument("--overlaps", action="append", metavar="SLUG")
    ap.add_argument("--no-overlap", action="append", metavar="SLUG")
    ap.add_argument("--note")
    ap.add_argument("--print", action="store_true", help="print instead of writing the file")
    ap.add_argument("--root", help="the project root (default: the git top level of the current directory)")
    args = ap.parse_args(argv)
    try:
        top = args.root or top_of(os.getcwd())
        row, text, blockers = build(top, args)
        if args.print:
            print(text)
            return 0
        path = os.path.join(top, intents_dir(top), row["dirName"], START_CHECK)
        if not os.path.isdir(os.path.dirname(path)):
            raise Problem(f"the record {os.path.dirname(path)} does not exist")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {os.path.relpath(path, top)}")
        print("Blockers: " + ("; ".join(blockers) if blockers else "none"))
        if not blockers:
            print("No blockers. The developer confirms the list by typing `/stage-guard:confirm-start-check`.")
        return 0
    except Problem as why:
        print(f"start_check: {why}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
