#!/usr/bin/env python3
"""Build the rows for one AI-DLC approval gate.

    gate_bundle.py --stage <slug> [--unit <u>] [--why first|revision|stale] [--summary-file <path>]
                   [--project-dir <dir>] [--no-brief] --out <dir>

Writes into <dir>:
    gate.json               the `gates/<id>` row
    documents/<key>.json    one `gates/<id>/documents/<key>` row per document
    writes.json             the `writes` array for one ArtifactData batch (set, file_path entries, no
                            if_version: every row is new)
    writes-<n>.json         only when writes.json is over one batch (50 writes or 1 MiB): the same
                            writes in order, in batches that fit; the gate row is in the first
and prints a short JSON summary on stdout:
    {"id", "stage", "unit", "documents": [keys], "writes": "<abs path>", "batches": [<abs path>, ...], "round"}

The script never touches the artifact: the agent makes the ArtifactData call.

Where things are read from. The project directory is --project-dir, else $CLAUDE_PROJECT_DIR, else the
current directory. The space is `aidlc/active-space`, the intent `aidlc/spaces/<space>/intents/active-intent`,
and the record <R> is `aidlc/spaces/<space>/intents/<intent>/`. The stage's folder is
<R>/<phase>/<stage>, or <R>/construction/<unit>/<stage> with --unit. The phase comes from
`.claude/tools/data/stage-graph.json` when it is there, else the first of ideation, inception,
construction, operation that holds the folder. The graph is optional: without it everything still works.

Documents: the stage graph's `produces` keys first, in that order (`<key>.md`, else `<key>.json`), then every
other *.md and *.json of the folder by name. `memory.md`, hidden files and *.lock* are never shown. The
newest `reviews/review-NN.md` is added as kind `review`. A document over 200 000 bytes is cut and ends with
a line that says how much is missing.

Round: 1 plus the number of `GATE_REJECTED` entries of this stage in <R>/audit/*.md (an entry is the block
that holds `**Event**: GATE_REJECTED` and `**Stage**: <slug>`). With --unit an entry counts only when it also
has a `**Unit**: <u>` line; without --unit only an entry with no Unit line counts.

Review brief: for a stage with a reviewer (in the graph, or, when the graph does not know the stage, a
`reviews/` folder) the script runs `aidlc engine review-brief review --stage <slug> [--unit <u>] --why <why>`
in the project directory and keeps its stdout as `brief`. The program is `aidlc` on PATH, or the executable
that $APPROVAL_GATES_AIDLC names (the tests use that). A failure omits `brief` and warns on stderr.
Standard library only.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

MAX_DOC_BYTES = 200_000
MAX_BATCH_WRITES = 50
MAX_BATCH_BYTES = 1_000_000  # the limit is 1 MiB; stay under it
PHASES = ("ideation", "inception", "construction", "operation")
SKIPPED = {"memory.md"}
ACRONYMS = {"nfr": "NFR", "ci": "CI"}
BRIEF_TIMEOUT = 20


class BundleError(Exception):
    pass


# ---------------------------------------------------------------- reading the project

def read_line(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    return line.strip()
    except OSError:
        pass
    return ""


def record_root(project):
    """(space, intent, R) of the active intent, or raise BundleError."""
    space = read_line(os.path.join(project, "aidlc", "active-space"))
    if not space:
        raise BundleError(f"no active space: {os.path.join(project, 'aidlc', 'active-space')} is missing or empty")
    intents = os.path.join(project, "aidlc", "spaces", space, "intents")
    intent = read_line(os.path.join(intents, "active-intent"))
    if not intent:
        raise BundleError(f"no active intent: {os.path.join(intents, 'active-intent')} is missing or empty")
    root = os.path.join(intents, intent)
    if not os.path.isdir(root):
        raise BundleError(f"the active intent has no record folder: {root}")
    return space, intent, root


def load_graph(project):
    """The stage graph as {slug: stage}, or None when it is absent or unreadable."""
    path = os.path.join(project, ".claude", "tools", "data", "stage-graph.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    return {s["slug"]: s for s in data if isinstance(s, dict) and isinstance(s.get("slug"), str)}


def stage_dir(root, slug, unit, graph_stage):
    if unit:
        path = os.path.join(root, "construction", unit, slug)
        if os.path.isdir(path):
            return path, "construction"
        raise BundleError(f"stage folder not found: {path}")
    phases = list(PHASES)
    if graph_stage and graph_stage.get("phase") in PHASES:
        phases.remove(graph_stage["phase"])
        phases.insert(0, graph_stage["phase"])
    for phase in phases:
        path = os.path.join(root, phase, slug)
        if os.path.isdir(path):
            return path, phase
    raise BundleError(f"stage folder not found: {slug} is in none of {', '.join(os.path.join(root, p) for p in phases)}")


def state_field(root, label):
    """The value of `- **<label>**: …` in aidlc-state.md, or ''."""
    try:
        with open(os.path.join(root, "aidlc-state.md"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return ""
    found = re.search(r"^\s*-\s*\*\*" + re.escape(label) + r"\*\*:[ \t]*(.*)$", text, re.M)
    return found.group(1).strip() if found else ""


# ---------------------------------------------------------------- names

def stage_name(slug, graph_stage):
    if graph_stage and isinstance(graph_stage.get("name"), str) and graph_stage["name"].strip():
        return graph_stage["name"].strip()
    return " ".join(ACRONYMS.get(w, w.capitalize()) for w in slug.split("-") if w)


def slugify(name):
    return re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-") or "doc"


def humanize(key):
    words = re.sub(r"[-_.]+", " ", key).split()
    return " ".join(ACRONYMS.get(w, w.capitalize()) for w in words) or key


def clip(text, size):
    text = " ".join(text.split())
    return text if len(text) <= size else text[: size - 1].rstrip() + "…"


# ---------------------------------------------------------------- documents

def cut(text):
    """The text, cut to MAX_DOC_BYTES when longer, with a closing line that says how much is missing."""
    raw = text.encode("utf-8")
    if len(raw) <= MAX_DOC_BYTES:
        return text
    kept = raw[:MAX_DOC_BYTES].decode("utf-8", errors="ignore")
    missing = len(raw) - len(kept.encode("utf-8"))
    return kept + f"\n… (truncated, {missing} bytes more; open the file)"


def read_document(path, kind):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as why:
        raise BundleError(f"cannot read {path}: {why}") from None
    if kind == "json":
        try:
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except ValueError:
            pass  # shown as it is
    return cut(text)


def kind_of(name):
    if name.endswith("-questions.md"):
        return "questions"
    return "json" if name.endswith(".json") else "markdown"


def candidate_files(folder):
    names = []
    for name in sorted(os.listdir(folder)):
        full = os.path.join(folder, name)
        if name.startswith(".") or ".lock" in name or name in SKIPPED or not os.path.isfile(full):
            continue
        if name.endswith(".md") or name.endswith(".json"):
            names.append(name)
    return names


def ordered_names(folder, produces):
    names = candidate_files(folder)
    first = []
    for key in produces or []:
        for ext in (".md", ".json"):
            if key + ext in names and key + ext not in first:
                first.append(key + ext)
                break
    return first + [n for n in names if n not in first]


def newest_review(folder):
    """(path, NN) of the highest reviews/review-NN.md, or None."""
    reviews = os.path.join(folder, "reviews")
    best = None
    try:
        for name in os.listdir(reviews):
            found = re.fullmatch(r"review-(\d+)\.md", name)
            if found and (best is None or int(found.group(1)) > best[1]):
                best = (os.path.join(reviews, name), int(found.group(1)), found.group(1))
    except OSError:
        return None
    return (best[0], best[2]) if best else None


def parse_review(text):
    def field(label):
        found = re.search(r"^\*\*" + label + r":\*\*[ \t]*(.+?)\s*$", text, re.M)
        return found.group(1).strip() if found else ""

    out = {"verdict": field("Verdict"), "reviewer": field("Reviewer")}
    iteration = field("Iteration")
    out["iteration"] = int(iteration) if iteration.isdigit() else iteration
    return {k: v for k, v in out.items() if v != ""}


def build_documents(folder, project, produces):
    """[(row, index entry)] in display order."""
    docs, used = [], set()
    entries = [(n, os.path.join(folder, n), kind_of(n)) for n in ordered_names(folder, produces)]
    review = newest_review(folder)
    if review:
        entries.append((f"review-{review[1]}.md", review[0], "review"))
    for name, path, kind in entries:
        key = slugify(os.path.splitext(name)[0])
        if key in used:
            key = slugify(name.replace(".", "-"))
        used.add(key)
        text = read_document(path, kind)
        rel = os.path.relpath(path, project)
        row = {"n": len(docs) + 1, "key": key, "title": humanize(key), "path": rel, "kind": kind, "text": text}
        index = {"key": key, "title": row["title"], "path": rel, "kind": kind, "bytes": os.path.getsize(path)}
        docs.append((row, index, path))
    return docs


# ---------------------------------------------------------------- round and brief

def count_rejections(root, slug, unit):
    """How many GATE_REJECTED entries of this stage (and Unit) the audit trail holds."""
    audit = os.path.join(root, "audit")
    total = 0
    try:
        names = sorted(os.listdir(audit))
    except OSError:
        return 0
    for name in names:
        if not name.endswith(".md"):
            continue
        try:
            with open(os.path.join(audit, name), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for block in re.split(r"^(?:---\s*|## .*)$", text, flags=re.M):
            if not re.search(r"^\*\*Event\*\*:\s*GATE_REJECTED\s*$", block, re.M):
                continue
            stage = re.search(r"^\*\*Stage\*\*:\s*(\S+)", block, re.M)
            if not stage or stage.group(1) != slug:
                continue
            unit_line = re.search(r"^\*\*Unit\*\*:\s*(\S+)", block, re.M)
            if (unit_line.group(1) if unit_line else None) == (unit or None):
                total += 1
    return total


def has_reviewer(graph, graph_stage, folder):
    if graph_stage is not None:
        return bool(graph_stage.get("reviewer"))
    return os.path.isdir(os.path.join(folder, "reviews"))


def run_brief(project, slug, unit, why):
    """stdout of `aidlc engine review-brief review …`, or None (with a warning) on any failure."""
    program = os.environ.get("APPROVAL_GATES_AIDLC") or "aidlc"
    cmd = [program, "engine", "review-brief", "review", "--stage", slug]
    if unit:
        cmd += ["--unit", unit]
    cmd += ["--why", why]
    try:
        done = subprocess.run(cmd, cwd=project, capture_output=True, text=True, timeout=BRIEF_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as why_not:
        print(f"approval-gates: the review brief was left out ({why_not})", file=sys.stderr)
        return None
    out = done.stdout.strip()
    if done.returncode != 0 or not out:
        print(f"approval-gates: the review brief was left out (exit {done.returncode}: "
              f"{clip(done.stderr or 'no output', 160)})", file=sys.stderr)
        return None
    return out


# ---------------------------------------------------------------- the rows

def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def build(args):
    project = os.path.abspath(args.project_dir or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    _space, intent, root = record_root(project)
    graph = load_graph(project)
    graph_stage = graph.get(args.stage) if graph else None
    folder, phase = stage_dir(root, args.stage, args.unit, graph_stage)
    docs = build_documents(folder, project, (graph_stage or {}).get("produces"))
    if not docs:
        raise BundleError(f"the stage folder holds no document to show: {folder}")

    rounds = 1 + count_rejections(root, args.stage, args.unit)
    why = args.why or ("first" if rounds == 1 else "revision")
    name = stage_name(args.stage, graph_stage)
    stamp = now_utc()
    parts = [intent, args.stage] + ([args.unit] if args.unit else [])
    # lower-case, except the T of the time stamp (YYYYMMDDTHHMM), which the guard hook and the page expect
    gate_id = slugify("-".join(parts)) + "-" + stamp.strftime("%Y%m%dT%H%M")

    gate = {
        "title": name + (f" · {args.unit}" if args.unit else ""),
        "stage": args.stage,
        "stageName": name,
        "phase": phase,
        "intent": intent,
        "round": rounds,
        "why": why,
        "status": "open",
        "createdAt": stamp.isoformat().replace("+00:00", "Z"),
    }
    project_line = state_field(root, "Project")
    if project_line:
        gate["project"] = clip(re.split(r"(?<=[.!?])\s", project_line)[0], 200)
    if args.unit:
        gate["unit"] = args.unit
    if args.summary_file:
        try:
            with open(args.summary_file, encoding="utf-8") as f:
                summary = f.read().strip()
        except OSError as why_not:
            raise BundleError(f"cannot read the summary file {args.summary_file}: {why_not}") from None
        if summary:
            gate["summary"] = summary
    if not args.no_brief and has_reviewer(graph, graph_stage, folder):
        brief = run_brief(project, args.stage, args.unit, why)
        if brief:
            gate["brief"] = brief
    review = newest_review(folder)
    if review:
        with open(review[0], encoding="utf-8", errors="replace") as f:
            found = parse_review(f.read())
        if found:
            gate["review"] = dict(found, file=os.path.relpath(review[0], project))
    next_slug = re.match(r"[a-z0-9][a-z0-9-]*", state_field(root, "Next Stage"))
    next_name = ""
    if next_slug and next_slug.group(0) not in ("none", "n"):
        next_name = stage_name(next_slug.group(0), graph.get(next_slug.group(0)) if graph else None)
        gate["nextStage"] = next_name
    gate["options"] = [
        {"k": "approve", "t": "Approve", "d": f"Continue to {next_name}" if next_name else "Continue"},
        {"k": "changes", "t": "Request Changes", "d": "Provide revision feedback"},
    ]
    gate["documents"] = [index for _row, index, _path in docs]
    return gate_id, gate, [row for row, _index, _path in docs]


def batches_of(writes, sizes):
    """Split the writes, in order, into batches of at most MAX_BATCH_WRITES writes and MAX_BATCH_BYTES bytes."""
    out, current, weight = [], [], 0
    for write, size in zip(writes, sizes):
        if current and (len(current) >= MAX_BATCH_WRITES or weight + size > MAX_BATCH_BYTES):
            out.append(current)
            current, weight = [], 0
        current.append(write)
        weight += size
    if current:
        out.append(current)
    return out


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return os.path.getsize(path)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="gate_bundle.py", description="Build the rows for one AI-DLC approval gate.")
    ap.add_argument("--stage", required=True)
    ap.add_argument("--unit")
    ap.add_argument("--why", choices=("first", "revision", "stale"))
    ap.add_argument("--summary-file")
    ap.add_argument("--project-dir")
    ap.add_argument("--no-brief", action="store_true")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    try:
        gate_id, gate, docs = build(args)
    except BundleError as why_not:
        print(f"gate_bundle.py: {why_not}", file=sys.stderr)
        return 1
    out = os.path.abspath(args.out)
    writes, sizes = [], []
    path = os.path.join(out, "gate.json")
    sizes.append(write_json(path, gate))
    writes.append({"op": "set", "collection": "gates", "doc_id": gate_id, "file_path": path})
    for row in docs:
        path = os.path.join(out, "documents", row["key"] + ".json")
        sizes.append(write_json(path, row))
        writes.append({"op": "set", "collection": f"gates/{gate_id}/documents", "doc_id": row["key"], "file_path": path})
    main_path = os.path.join(out, "writes.json")
    write_json(main_path, writes)
    batches = batches_of(writes, sizes)
    paths = [main_path]
    if len(batches) > 1:
        paths = []
        for n, batch in enumerate(batches, 1):
            paths.append(os.path.join(out, f"writes-{n}.json"))
            write_json(paths[-1], batch)
        print(f"approval-gates: {len(writes)} writes do not fit one batch; send {len(paths)} batches, in order "
              f"({', '.join(os.path.basename(p) for p in paths)})", file=sys.stderr)
    print(json.dumps({"id": gate_id, "stage": args.stage, "unit": args.unit, "documents": [d["key"] for d in docs],
                      "writes": main_path, "batches": paths, "round": gate["round"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
