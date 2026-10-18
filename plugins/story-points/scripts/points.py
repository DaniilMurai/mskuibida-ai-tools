#!/usr/bin/env python3
"""Keep an intent's unit-points.csv (`unit,points,source`) up to date with the developers' story-point
estimates: from an issue tracker (Jira) when the project configures one, by hand with `set` when not.

    points.py plan  [--intent X] [--source ai|human] [UNIT ...]
    points.py apply --issues FILE [--intent X] [--source ai|human] [--dry-run] [UNIT ...]   (tracker only)
    points.py set   UNIT POINTS [--intent X] [--source human|ai]
    points.py claim [--issues FILE] [--intent X] [--ref REF] UNIT

Run it from the project root (`$CLAUDE_PROJECT_DIR`, else the git toplevel, else the current directory
is taken as the root). Configuration is the optional `<root>/.story-points.json`: `scale` (default
1, 2, 3, 5, 8), `intents` (the directory holding the intent records, default
`aidlc/spaces/<space>/intents` with `<space>` from `aidlc/active-space`, else `default`) and an
optional `tracker` block (`type` "jira", `site`, `project`, `field` required; `server`, `issueType`,
`fieldName` optional). A config that is not valid JSON or has a wrong type is an error (exit 2) that
names the file. The file format and the rows' meaning: the plugin's README.

Without a tracker, `plan` says so, `apply` exits 2, `set` records the developer's estimate and `claim`
checks the row alone. The rest of this text is the tracker (Jira) side.

The script never talks to Jira: the `sync` skill reads the Unit issues through the configured MCP
server and saves them to FILE, and `apply` folds them into the file. Which Units are checked:

    no UNIT, no --source   every Unit with a row in the file, and every Unit issue Jira returned
    UNIT ...               only these (`U3`, `u3` or `3`)
    --source ai            only Units whose row has that source (with UNITs: only those of them)

A Unit's issue is the one in FILE whose summary starts `U<n> ` (`U70 web-language-picker - ...`).
Its story-point estimate replaces the row's points and sets the source to `human`; a Unit with no
row gets one. An issue whose estimate is empty, a Unit with no issue and a Unit with two issues
leave the row as it is. An estimate off the scale is written, since it is the developers', and
reported. Comments, the header, blank lines and every other row stay byte for byte. FILE holds the
search responses as returned (one or a list of pages), or a list of
`{"key", "summary", "points", "parent"}`. Exit 1 when something needs a person's look.

The query leaves out finished Units (status category Done): they are never claimed, and a finished
Unit's row is no longer synced, so one that went Done before its sync keeps the row it had. Unit issues
carry no intent marker, so it cannot be narrowed to one intent; two open issues titled with the same
`U<n>` are reported for a look, never picked.

`set UNIT POINTS` writes the row with source `human` (`--source ai` is an assistant's own suggestion,
only when the developer asked for one). A value off the scale is written and reported (exit 1). A
missing file is created with its header.

`claim` is the check before a Unit is claimed, run after `apply` (or `set`). It reads
`unit-points.csv` as it is on REF (default `origin/main`; fetch first, a missing REF is an error),
not the working copy: a recorded row counts once its change is merged. With a tracker, exit 0: the
Unit is estimated in Jira and its row on REF says so with source `human`, and so is every other open
Unit of its epic. Exit 1, blocked: the Unit has no estimate in Jira, or its row on REF is not
synced. Exit 3, the developer's explicit approval is needed: the Unit is estimated, but other Units
of its epic (the issues with the same parent) have no estimate in Jira yet. Without a tracker, exit 0
when the row on REF has source `human`, else exit 1; there is no epic check. Exit 2 is an error.
Standard library only.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys

CONFIG_NAME = ".story-points.json"
DEFAULT_SCALE = [1, 2, 3, 5, 8]
POINTS_FILE = "unit-points.csv"
HEADER = "unit,points,source"
UNIT_ARG = re.compile(r"^[Uu]?(\d+)$")
UNIT_SUMMARY = re.compile(r"^\s*U(\d+)\s")
SOURCES = ("ai", "human")
NO_TRACKER = (f"no tracker is configured in {CONFIG_NAME}; the developers' estimates are recorded with "
              "`points.py set UNIT POINTS`")


class Problem(Exception):
    pass


# --- project configuration -------------------------------------------------------------------------

def project_root(cwd=None):
    """$CLAUDE_PROJECT_DIR, else the git toplevel, else the current directory."""
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return os.path.realpath(env)
    here = cwd or os.getcwd()
    try:
        proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=here, capture_output=True, text=True)
    except OSError:
        return os.path.realpath(here)
    return os.path.realpath(proc.stdout.strip() if proc.returncode == 0 else here)


def git_top(root):
    try:
        proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, capture_output=True, text=True)
    except OSError:
        proc = None
    if proc is None or proc.returncode != 0:
        raise Problem("the claim check reads the file from git: run it inside the project's git checkout")
    return os.path.realpath(proc.stdout.strip())


def text_key(raw, key, where, required=False, default=None):
    value = raw.get(key)
    if value is None:
        if required:
            raise Problem(f"{where}: `{key}` is required")
        return default
    if not isinstance(value, str) or not value.strip():
        raise Problem(f"{where}: `{key}` must be a non-empty string")
    return value.strip()


def tracker_of(raw, path):
    if raw is None:
        return None
    where = f"{path}: `tracker`"
    if not isinstance(raw, dict):
        raise Problem(f"{where} must be an object")
    if raw.get("type") != "jira":
        raise Problem(f'{where}: `type` must be "jira", the only tracker supported')
    return {
        "type": "jira",
        "server": text_key(raw, "server", where, default="jira"),
        "site": text_key(raw, "site", where, required=True),
        "project": text_key(raw, "project", where, required=True),
        "issueType": text_key(raw, "issueType", where, default="Unit"),
        "field": text_key(raw, "field", where, required=True),
        "fieldName": text_key(raw, "fieldName", where, default="Story point estimate"),
    }


def load_config(root):
    """The project's `.story-points.json` with its defaults filled in; the tracker is None without one."""
    path = os.path.join(root, CONFIG_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raw = {}
    except ValueError as why:
        raise Problem(f"{path} is not valid JSON: {why}") from None
    except OSError as why:
        raise Problem(f"{path} cannot be read: {why}") from None
    if not isinstance(raw, dict):
        raise Problem(f"{path} must hold a JSON object")
    scale = raw.get("scale", DEFAULT_SCALE)
    if (not isinstance(scale, list) or not scale
            or any(isinstance(n, bool) or not isinstance(n, (int, float)) or n <= 0 for n in scale)):
        raise Problem(f"{path}: `scale` must be a non-empty list of positive numbers")
    intents = raw.get("intents")
    if intents is None:
        space = "default"
        try:
            with open(os.path.join(root, "aidlc", "active-space"), encoding="utf-8") as f:
                space = f.read().strip() or "default"
        except OSError:
            pass
        intents = os.path.join("aidlc", "spaces", space, "intents")
    elif not isinstance(intents, str) or not intents.strip():
        raise Problem(f"{path}: `intents` must be a non-empty string")
    return {
        "path": path,
        "scale": [float(n) for n in scale],
        "intents": os.path.join(root, intents.strip()),
        "tracker": tracker_of(raw.get("tracker"), path),
    }


# --- the intent's file -------------------------------------------------------------------------------

def intent_dir(root, intents_root, wanted):
    """The intent's record: --intent (slug or directory), else the active-intent cursor, else the one
    intent in flight."""
    try:
        with open(os.path.join(intents_root, "intents.json"), encoding="utf-8") as f:
            intents = json.load(f)
    except (OSError, ValueError):
        intents = []
    if not wanted:
        try:
            with open(os.path.join(intents_root, "active-intent"), encoding="utf-8") as f:
                wanted = f.read().strip()
        except OSError:
            live = [i for i in intents if i.get("status") == "in-flight"]
            if len(live) != 1:
                raise Problem("name the intent with --intent: there is no active-intent cursor and "
                              f"{len(live)} intents are in flight") from None
            wanted = live[0]["dirName"]
    wanted = os.path.basename(wanted.rstrip("/"))
    for i in intents:
        if wanted in (i.get("slug"), i.get("dirName")):
            wanted = i["dirName"]
            break
    path = os.path.join(intents_root, wanted)
    if not os.path.isdir(path):
        raise Problem(f"no intent record {wanted} under {os.path.relpath(intents_root, root)}")
    return path


def unit_id(text):
    m = UNIT_ARG.match(text.strip())
    if not m:
        raise Problem(f"{text!r} is not a Unit id (U3, u3 or 3)")
    return f"U{int(m.group(1))}"


def number(unit):
    return int(unit[1:])


class PointsFile:
    """unit-points.csv as lines: every line is kept as it was unless its row changes."""

    def __init__(self, text):
        self.lines = text.splitlines()
        self.rows = {}  # unit -> list of line indexes, in file order
        self.values = {}  # line index -> (unit, points, source)
        for k, line in enumerate(self.lines):
            bare = line.strip()
            if not bare or bare.startswith("#") or bare.replace(" ", "").lower().startswith("unit,points"):
                continue
            cells = next(csv.reader([line]))
            cells += [""] * (3 - len(cells))
            try:
                unit = unit_id(cells[0])
            except Problem:
                raise Problem(f"line {k + 1} of {POINTS_FILE} is not a `unit,points,source` row: {line}") from None
            self.rows.setdefault(unit, []).append(k)
            self.values[k] = (unit, cells[1].strip(), cells[2].strip())

    def current(self, unit):
        """The row that counts, the last one for the Unit (as the project panel reads it)."""
        k = self.rows[unit][-1]
        return k, self.values[k]

    def set(self, unit, points, source="human"):
        line = f"{unit},{points},{source}"
        if unit in self.rows:
            k = self.rows[unit][-1]
            self.lines[k] = line
            self.values[k] = (unit, points, source)
            return
        after = [k for u, ks in self.rows.items() if number(u) < number(unit) for k in ks]
        at = max(after) + 1 if after else self._first_row_slot()
        self.lines.insert(at, line)
        self.rows = {u: [k + 1 if k >= at else k for k in ks] for u, ks in self.rows.items()}
        self.values = {(k + 1 if k >= at else k): v for k, v in self.values.items()}
        self.rows[unit] = [at]
        self.values[at] = (unit, points, source)

    def _first_row_slot(self):
        for k, line in enumerate(self.lines):
            if line.replace(" ", "").lower().startswith("unit,points"):
                return k + 1
        return len(self.lines)

    def text(self):
        return "\n".join(self.lines) + "\n"


def points_text(raw):
    """The estimate as written in the file, None when the tracker's field is empty."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, bool):
        raise ValueError(raw)
    value = float(raw)
    if value <= 0 or value != value or value == float("inf"):
        raise ValueError(raw)
    return str(int(value)) if value.is_integer() else str(value)


def off_scale(points, scale):
    """A reason when `points` is not on the scale, else None."""
    if float(points) in scale:
        return None
    top = max(scale)
    return (f"above {top:g}, so the Unit is to be split" if float(points) > top else "not on the scale")


def write_atomic(path, text):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


# --- recording an estimate by hand (no tracker needed) ----------------------------------------------

def record(sheet, unit, points, source, scale):
    """Write the row; (line for the report, whether the file changed, a look-line or None)."""
    reason = off_scale(points, scale)
    look = (f"{unit}: {points} points, {reason} ({', '.join(f'{n:g}' for n in scale)}); written as given"
            if reason else None)
    if unit not in sheet.rows:
        sheet.set(unit, points, source)
        return f"added {unit} {points} {source}", True, look
    _, (_, old_points, old_source) = sheet.current(unit)
    if (old_points, old_source) == (points, source):
        return f"{unit} {points} {source} already in the file", False, look
    sheet.set(unit, points, source)
    return f"{unit} {old_points or '-'} {old_source or '-'} -> {points} {source}", True, look


def claim_by_row(sheet, unit, local=None, ref="origin/main"):
    """(exit code, lines) without a tracker: the Unit's row on `ref` must have source `human`."""
    row = sheet.current(unit)[1][1:] if sheet is not None and unit in sheet.rows else None
    if row and row[0] and row[1] == "human":
        return 0, [f"{unit}: {row[0]} points, human estimate on {ref}",
                   "no tracker configured; there is no epic to check"]
    have = ("no file" if sheet is None else "no row" if row is None else f"{row[0] or '-'},{row[1] or '-'}")
    mine = local.current(unit)[1][1:] if local is not None and unit in local.rows else None
    if mine and mine[0] and mine[1] == "human":
        return 1, [f"BLOCKED {unit}: the working copy has {mine[0]} human, but {POINTS_FILE} on {ref} has {have}; "
                   "merge the change that records it, fetch, and check again"]
    return 1, [f"BLOCKED {unit}: {POINTS_FILE} on {ref} has {have}; the developers estimate it first "
               f"(`set {unit} POINTS`), merge that change, fetch, and check again"]


# --- tracker: Jira ------------------------------------------------------------------------------------
# Everything below up to `main` knows Jira and nothing else does: the query, the shape of the saved
# responses, the sync of the issues into the file and the epic check of a claim.

def nodes_of(data):
    """Every issue in a saved search response, a list of pages, or a flat list."""
    if isinstance(data, list):
        for item in data:
            yield from nodes_of(item)
    elif isinstance(data, dict):
        issues = data.get("issues")
        if isinstance(issues, dict) and isinstance(issues.get("nodes"), list):
            yield from issues["nodes"]
        elif isinstance(issues, list):
            yield from issues
        elif "key" in data:
            yield data


def field_value(fields, field):
    if field in fields:
        return fields[field]
    extra = fields.get("customFields")
    if isinstance(extra, dict):
        return extra.get(field)
    if isinstance(extra, list):
        for entry in extra:
            if isinstance(entry, dict) and field in (entry.get("id"), entry.get("key"), entry.get("fieldId")):
                return entry.get("value")
    return None


def issues_of(data, field):
    """[(key, summary, raw points, parent key)] from the saved file."""
    found = []
    for node in nodes_of(data):
        if not isinstance(node, dict) or "key" not in node:
            continue
        fields = node.get("fields") if isinstance(node.get("fields"), dict) else {}
        summary = node.get("summary", fields.get("summary", ""))
        points = node["points"] if "points" in node else field_value(fields, field)
        parent = node.get("parent", fields.get("parent"))
        if isinstance(parent, dict):
            parent = parent.get("key")
        found.append((node["key"], summary or "", points, parent or None))
    return found


def selected(sheet, wanted, source, jira_units):
    if wanted:
        units = list(dict.fromkeys(wanted))
    else:
        units = sorted(sheet.rows, key=number)
        if not source:
            units += sorted(set(jira_units) - set(units), key=number)
    if source:
        units = [u for u in units if u in sheet.rows and sheet.current(u)[1][2] == source]
    return units


def apply(sheet, issues, wanted, source, scale):
    by_unit = {}
    for key, summary, raw, _ in issues:
        m = UNIT_SUMMARY.match(summary)
        if m:
            by_unit.setdefault(f"U{int(m.group(1))}", []).append((key, raw))
    report = {"changed": [], "added": [], "same": [], "empty": [], "no issue": [], "look": []}
    for unit in selected(sheet, wanted, source, by_unit):
        found = by_unit.get(unit, [])
        if len(sheet.rows.get(unit, [])) > 1:
            report["look"].append(f"{unit}: {POINTS_FILE} has {len(sheet.rows[unit])} rows; the last one is the one updated")
        if not found:
            report["no issue"].append(unit)
            continue
        if len(found) > 1:
            report["look"].append(f"{unit}: more than one Jira issue ({', '.join(k for k, _ in found)}); row left as it is")
            continue
        key, raw = found[0]
        try:
            points = points_text(raw)
        except (TypeError, ValueError):
            report["look"].append(f"{unit} ({key}): story points {raw!r} are not a positive number; row left as it is")
            continue
        if points is None:
            report["empty"].append(f"{unit} ({key})")
            continue
        reason = off_scale(points, scale)
        if reason:
            report["look"].append(f"{unit} ({key}): {points} points, {reason} ({', '.join(f'{n:g}' for n in scale)}); "
                                  "written as the developers' estimate")
        if unit not in sheet.rows:
            sheet.set(unit, points)
            report["added"].append(f"{unit} {points} human ({key})")
            continue
        _, (_, old_points, old_source) = sheet.current(unit)
        if old_points == points and old_source == "human":
            report["same"].append(unit)
            continue
        sheet.set(unit, points)
        report["changed"].append(f"{unit} {old_points or '-'} {old_source or '-'} -> {points} human ({key})")
    return report


def claim(sheet, issues, unit, local=None, ref="origin/main"):
    """(exit code, lines): may the Unit be claimed? `sheet` is the file on `ref` (None when it is not
    there), `local` the working copy, which only explains a block."""
    units = {}
    for key, summary, raw, parent in issues:
        m = UNIT_SUMMARY.match(summary)
        if m:
            units.setdefault(f"U{int(m.group(1))}", []).append((key, raw, parent))
    found = units.get(unit, [])
    if len(found) != 1:
        what = "no Jira issue" if not found else f"more than one Jira issue ({', '.join(k for k, _, _ in found)})"
        raise Problem(f"{unit} has {what} titled `{unit} ...`; it cannot be checked")
    key, raw, parent = found[0]
    try:
        points = points_text(raw)
    except (TypeError, ValueError):
        points = None
    if points is None:
        return 1, [f"BLOCKED {unit} ({key}): no story points in Jira; the developers estimate it before it is claimed"]

    def synced(points_file):
        if points_file is None or unit not in points_file.rows:
            return None
        return points_file.current(unit)[1][1:]

    row = synced(sheet)
    if row != (points, "human"):
        have = "no file" if sheet is None else f"{row[0]},{row[1]}" if row else "no row"
        if synced(local) == (points, "human"):
            return 1, [f"BLOCKED {unit} ({key}): Jira says {points} and the working copy is synced, but "
                       f"{POINTS_FILE} on {ref} has {have}; merge the sync, fetch, and check again"]
        return 1, [f"BLOCKED {unit} ({key}): Jira says {points}, {POINTS_FILE} on {ref} has {have}; sync it "
                   f"(`apply` with {unit}), merge that change, fetch, and check again"]
    lines = [f"{unit} ({key}): {points} points, synced"]
    if not parent:
        return 0, lines + [f"{unit} has no epic; nothing else to check"]
    missing = []
    for other, entries in sorted(units.items(), key=lambda item: number(item[0])):
        for other_key, other_raw, other_parent in entries:
            if other == unit or other_parent != parent:
                continue
            try:
                estimated = points_text(other_raw) is not None
            except (TypeError, ValueError):
                estimated = False
            if not estimated:
                missing.append(f"{other} ({other_key})")
    if missing:
        return 3, lines + [f"WARN epic {parent}: {len(missing)} other Unit(s) have no story points in Jira: "
                           f"{', '.join(missing)}; claiming {unit} needs the developer's explicit approval"]
    return 0, lines + [f"every other Unit of epic {parent} is estimated"]


def jql(tracker):
    return (f'project = {tracker["project"]} AND issuetype = "{tracker["issueType"]}" '
            'AND statusCategory != Done ORDER BY key ASC')


def jira_plan(tracker):
    return {
        "tracker": "jira",
        "server": tracker["server"],
        "site": tracker["site"],
        "jql": jql(tracker),
        "fields": ["summary", "parent", tracker["field"]],
        "field": tracker["field"],
        "fieldName": tracker["fieldName"],
    }


def load_issues(args, tracker):
    if not args.issues:
        raise Problem("--issues FILE is required: the saved Jira search responses")
    with open(args.issues, encoding="utf-8") as f:
        data = json.load(f)
    issues = issues_of(data, tracker["field"])
    if not issues:
        raise Problem(f"{args.issues} holds no Jira issues")
    return issues


def print_report(report, record_dir, count, dry_run):
    verb = "would change" if dry_run else "changed"
    print(f"{os.path.basename(record_dir)}/{POINTS_FILE}: {count} Jira Unit issues read")
    labels = [("changed", verb), ("added", "would add" if dry_run else "added"),
              ("same", "already the developers' estimate"), ("empty", "story points empty in Jira, row left as it is"),
              ("no issue", "no open Jira issue titled U<n> (none, or Done), row left as it is"), ("look", "needs a look")]
    for name, label in labels:
        if report[name]:
            print(f"{label} ({len(report[name])}):")
            if name in ("same", "no issue"):  # bare Unit ids, one line
                print("  " + ", ".join(report[name]))
                continue
            for line in report[name]:
                print(f"  {line}")
    if not (report["changed"] or report["added"]):
        print("nothing to write")


# --- command line -------------------------------------------------------------------------------------

def parse(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("plan", "apply", "claim"):
        s = sub.add_parser(name)
        s.add_argument("units", nargs=1 if name == "claim" else "*", metavar="UNIT")
        s.add_argument("--intent")
        if name != "claim":
            s.add_argument("--source", choices=SOURCES)
        if name != "plan":
            s.add_argument("--issues", help="the saved Jira search responses (needs a tracker)")
        if name == "claim":
            s.add_argument("--ref", default="origin/main", help="the git ref whose unit-points.csv counts")
        if name == "apply":
            s.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("set", help="record the developers' estimate of a Unit")
    s.add_argument("unit", metavar="UNIT")
    s.add_argument("points", metavar="POINTS")
    s.add_argument("--intent")
    s.add_argument("--source", choices=SOURCES, default="human",
                   help="human (default) is the developers' estimate; ai only for a suggestion they asked for")
    return p.parse_args(argv)


def read_sheet(path):
    try:
        with open(path, encoding="utf-8") as f:
            return PointsFile(f.read())
    except OSError:
        raise Problem(f"{path} does not exist") from None


def cmd_set(args, cfg, path):
    unit = unit_id(args.unit)
    try:
        points = points_text(args.points)
    except (TypeError, ValueError):
        points = None
    if points is None:
        raise Problem(f"{args.points!r} is not a positive number of story points")
    created = not os.path.exists(path)
    sheet = PointsFile(HEADER + "\n") if created else read_sheet(path)
    line, changed, look = record(sheet, unit, points, args.source, cfg["scale"])
    if changed:
        write_atomic(path, sheet.text())
    print(f"{os.path.basename(os.path.dirname(path))}/{POINTS_FILE}: {line}" + (" (file created)" if created else ""))
    if look:
        print(f"needs a look: {look}")
    return 1 if look else 0


def main(argv=None, cwd=None):
    args = parse(sys.argv[1:] if argv is None else argv)
    try:
        root = project_root(cwd)
        cfg = load_config(root)
        tracker = cfg["tracker"]
        if args.command == "apply" and tracker is None:
            raise Problem(NO_TRACKER)
        record_dir = intent_dir(root, cfg["intents"], args.intent)
        path = os.path.join(record_dir, POINTS_FILE)
        if args.command == "set":
            return cmd_set(args, cfg, path)
        sheet = read_sheet(path)
        wanted = [unit_id(u) for u in args.units]
        if args.command == "plan":
            units = selected(sheet, wanted, args.source, {})
            plan = {"file": os.path.relpath(path, root)}
            if tracker is None:
                plan.update({"units": units if (wanted or args.source) else sorted(sheet.rows, key=number),
                             "tracker": None, "message": NO_TRACKER + "; there is nothing to read or sync"})
            else:
                plan["units"] = units if (wanted or args.source) else "every Unit in the file and every Unit issue in Jira"
                plan.update(jira_plan(tracker))
            print(json.dumps(plan, indent=2, ensure_ascii=False))
            return 0
        if args.command == "claim":
            if tracker is not None:
                issues = load_issues(args, tracker)
            top = git_top(root)
            known = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"{args.ref}^{{commit}}"],
                                   cwd=top, capture_output=True, text=True)
            if known.returncode != 0:
                raise Problem(f"{args.ref} does not exist; run git fetch origin main")
            shown = subprocess.run(["git", "show", f"{args.ref}:{os.path.relpath(path, top)}"],
                                   cwd=top, capture_output=True, text=True)
            merged = PointsFile(shown.stdout) if shown.returncode == 0 else None
            if tracker is None:
                code, lines = claim_by_row(merged, wanted[0], local=sheet, ref=args.ref)
            else:
                code, lines = claim(merged, issues, wanted[0], local=sheet, ref=args.ref)
            print("\n".join(lines))
            return code
        issues = load_issues(args, tracker)
        report = apply(sheet, issues, wanted, args.source, cfg["scale"])
        if (report["changed"] or report["added"]) and not args.dry_run:
            write_atomic(path, sheet.text())
        print_report(report, record_dir, len(issues), args.dry_run)
        return 1 if report["look"] else 0
    except Problem as why:
        print(f"points.py: {why}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as why:
        print(f"points.py: {why}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
