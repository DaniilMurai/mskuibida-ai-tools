#!/usr/bin/env python3
"""Review findings: parse them, summarise them for the chat, lay them out as a board form.

Sources
  parse --brief FILE    the text `aidlc engine review-brief review --stage S` prints at an approval gate
  parse --review FILE   a readable `reviews/review-NN.md` of a stage (the 6-column `### Findings` table)
  parse --report FILE   the input of Claude Code's `ReportFindings` tool (`{"findings": [...]}`)

A findings document is JSON:
  {"source": "aidlc" | "code-review", "stage": "<slug>", "stage_name": "Domain Design", "artifact": "<path>",
   "reviewer"?, "findings": [{"id", "severity", "where", "finding", "action", "status", "blocking", "title",
                              "scenario"?, "category"?}]}
`findings` holds the OPEN findings only (AI-DLC: Status New or Unresolved; code review: all of them).
Blocking is severity Critical or Major (AI-DLC), or verdict CONFIRMED (code review).

  summary --findings FILE   the inline summary block for the chat
  question --findings FILE  the triage AskUserQuestion input (header Findings), as JSON
  board --findings FILE [--id ID] [--title T] [--project-dir D] --out DIR
                            forms.json, cards/<qid>.json and writes.json for one ArtifactData batch that
                            opens a BOARD form in the "AI-DLC question forms" artifact

`-` as a file reads stdin. Standard library only; the guard hook imports this file by path.
"""

import argparse
import datetime
import json
import os
import re
import sys

BLOCKING_SEVERITIES = {"critical", "major"}
OPEN_STATUSES = {"new", "unresolved"}
FINDING_ID = re.compile(r"^[A-Za-z]+-\d+$")
QUOTE = re.compile(r"^>\s*([A-Za-z]+-\d+)\s+(Finding|Where|Required action):\s*(.*)$")
FIELD_NAMES = {"finding": "finding", "where": "where", "required action": "action"}
SUMMARY_LIMIT = 140
WHERE_LIMIT = 80
TITLE_LIMIT = 90

TRIAGE_HEADER = "Findings"
FIX_LABEL, ACCEPT_LABEL, FORM_LABEL = "Fix", "Accept", "Open in form"


# ---------------------------------------------------------------- text helpers

def one_line(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def clip(text, limit):
    text = one_line(text)
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def first_sentence(text, limit):
    """The first sentence of a text on one line, cut to `limit` characters (with a final ellipsis when cut)."""
    text = one_line(text)
    found = re.search(r"(?<=[.!?])\s+(?=[A-Z0-9`\"'(])", text)
    return clip(text[:found.start()] if found else text, limit)


def cell(text):
    """One markdown table cell: one line, pipes escaped."""
    return one_line(text).replace("|", "\\|")


def slug(text):
    return re.sub(r"[^a-z0-9._-]+", "-", str(text).lower()).strip("-")


def severity_of(raw):
    raw = one_line(raw)
    return raw[:1].upper() + raw[1:].lower() if raw else ""


# ---------------------------------------------------------------- tables and quotes

def split_row(line):
    """The cells of a markdown table row; `\\|` inside a cell is a literal pipe."""
    body = line.strip()
    body = body[1:] if body.startswith("|") else body
    body = body[:-1] if body.endswith("|") and not body.endswith("\\|") else body
    return [c.replace("\\|", "|").strip() for c in re.split(r"(?<!\\)\|", body)]


def tables(text):
    """[(header cells, [row cells])] for each markdown table in the text."""
    found, header, rows = [], None, []
    for line in text.splitlines() + [""]:
        if line.strip().startswith("|"):
            cells = split_row(line)
            if header is None:
                header = [c.lower() for c in cells]
            elif all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) or not c for c in cells):
                continue
            else:
                rows.append(cells)
        elif header is not None:
            found.append((header, rows))
            header, rows = None, []
    return found


def findings_table(text):
    """The first table with an ID, a Severity and a Status column, as [{column name: cell}]."""
    for header, rows in tables(text):
        if "id" in header and "severity" in header and "status" in header:
            return [{h: (row[i] if i < len(row) else "") for i, h in enumerate(header)} for row in rows
                    if row and FINDING_ID.match(row[0])]
    return []


def quotes(text):
    """{id: {finding, where, action}} from the `> R-NN Finding:` blocks of a brief; a block runs to the next blank line."""
    out, current = {}, None
    for line in text.splitlines():
        found = QUOTE.match(line)
        if found:
            fid, name, rest = found.groups()
            current = out.setdefault(fid, {}), FIELD_NAMES[name.lower()]
            current[0][current[1]] = rest.strip()
        elif current is not None and line.strip():
            current[0][current[1]] += "\n" + re.sub(r"^>\s?", "", line).strip()
        else:
            current = None
    return out


def header_line(text, name):
    found = re.search(rf"^\*\*{re.escape(name)}:\*\*[ \t]*(.+?)[ \t]*$", text, re.M)
    return found.group(1).strip() if found else ""


def is_blocking(severity):
    return severity.strip().lower() in BLOCKING_SEVERITIES


def record(fid, severity, where, finding, action, status):
    severity = severity_of(severity)
    return {"id": fid, "severity": severity, "where": where.strip(), "finding": finding.strip(),
            "action": action.strip(), "status": status.strip(), "blocking": is_blocking(severity),
            "title": first_sentence(finding, TITLE_LIMIT)}


# ---------------------------------------------------------------- parsers

def parse_brief(text, stage=None):
    """The open findings of a review brief. `stage` is the slug from the command (the brief names only the stage)."""
    name = header_line(text, "Stage")
    art = header_line(text, "Review artifact").strip("`")
    hydrated = quotes(text)
    found = []
    for row in findings_table(text):
        if one_line(row.get("status", "")).lower() not in OPEN_STATUSES:
            continue
        quote = hydrated.get(row["id"], {})
        found.append(record(row["id"], row.get("severity", ""), quote.get("where") or row.get("where", ""),
                            quote.get("finding", ""), quote.get("action", ""), row.get("status", "")))
    return {"source": "aidlc", "stage": stage or slug(name), "stage_name": name, "artifact": art,
            "outcome": header_line(text, "Review outcome"), "findings": found}


def parse_review(text, stage=None):
    """The open findings of a readable `reviews/review-NN.md`."""
    found = []
    for row in findings_table(text):
        if one_line(row.get("status", "")).lower() not in OPEN_STATUSES:
            continue
        found.append(record(row["id"], row.get("severity", ""), row.get("location", row.get("where", "")),
                            row.get("finding", ""), row.get("required action", ""), row.get("status", "")))
    doc = {"source": "aidlc", "stage": stage or "", "stage_name": "", "artifact": "", "findings": found}
    for key, name in (("verdict", "Verdict"), ("reviewer", "Reviewer"), ("iteration", "Iteration")):
        value = header_line(text, name)
        if value:
            doc[key] = value
    return doc


def parse_report(data):
    """The findings of a `ReportFindings` call: the tool input (`{"findings": [...]}`) or just the list."""
    items = data.get("findings") if isinstance(data, dict) else data
    found = []
    for n, item in enumerate(i for i in (items or []) if isinstance(i, dict)):
        verdict = str(item.get("verdict") or "").upper()
        where = str(item.get("file") or "")
        if where and item.get("line") not in (None, ""):
            where += f":{item['line']}"
        summary = str(item.get("summary") or item.get("short_summary") or "")
        found.append({
            "id": f"F-{n + 1:02d}", "severity": verdict.capitalize() if verdict else "Unrated", "where": where,
            "finding": summary.strip(), "action": "", "status": "New", "blocking": verdict == "CONFIRMED",
            "title": clip(item.get("short_summary") or first_sentence(summary, TITLE_LIMIT), TITLE_LIMIT),
            "scenario": str(item.get("failure_scenario") or "").strip(), "category": str(item.get("category") or "").strip(),
        })
    return {"source": "code-review", "stage": "", "stage_name": "code review", "artifact": "", "findings": found}


CUT_OFF = ("the review brief was cut off (piped through head/tail/grep or redirected): run the command again "
           "unpiped as the only command")


def unfilled(doc):
    """The ids of the open findings that have no finding text: a brief whose `> R-NN Finding:` lines never arrived."""
    return [f.get("id", "?") for f in doc.get("findings") or [] if not one_line(f.get("finding"))]


def incomplete(doc):
    """The refusal text when an open finding has no finding text, else "". A form or a summary built from
    such a document would show the developer cards with nothing to decide on."""
    ids = unfilled(doc)
    return f"{CUT_OFF}. No finding text for: {', '.join(ids)}." if ids else ""


def counts(doc):
    found = doc.get("findings") or []
    return len(found), sum(1 for f in found if f.get("blocking"))


# ---------------------------------------------------------------- the chat side

def summary(doc):
    """The inline summary block the agent prints before it asks."""
    total, blocking = counts(doc)
    label = "code review" if doc.get("source") == "code-review" else (doc.get("stage_name") or doc.get("stage") or "review")
    head = f"**Review findings — {label}:** {total} open, {blocking} blocking"
    if not total:
        return head
    rows = ["| ID | Severity | Where | Finding |", "|---|---|---|---|"]
    for f in doc["findings"]:
        text = f.get("finding") or f.get("title") or ""
        rows.append("| " + " | ".join([cell(f["id"]), cell(f["severity"]), cell(clip(f.get("where"), WHERE_LIMIT)),
                                       cell(first_sentence(text, SUMMARY_LIMIT))]) + " |")
    return head + "\n" + "\n".join(rows)


def question_text(total, blocking):
    noun = "review finding is" if total == 1 else "review findings are"
    count = f"{blocking} blocking" if blocking else "none blocking"
    return f"{total} {noun} open ({count}). What should I do with them?"


def triage(doc):
    """The AskUserQuestion input of the triage question: Accept only when nothing blocks."""
    total, blocking = counts(doc)
    code = doc.get("source") == "code-review"
    options = [{"label": FIX_LABEL, "description": "Fix every open finding now." if code else
                "Fix every open finding. At a stage gate this goes through Request Changes with the findings as the reason."}]
    if not blocking:
        options.append({"label": ACCEPT_LABEL, "description": "Accept all as known risks and go on."})
    options.append({"label": FORM_LABEL, "description": "Sort each finding in a form: fix, accept or reject with a reason."})
    return {"questions": [{"question": question_text(total, blocking), "header": TRIAGE_HEADER,
                           "options": options, "multiSelect": False}]}


# ---------------------------------------------------------------- the board

def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def active_intent(project_dir):
    """The active intent's directory name, or "" when the project has none."""
    try:
        with open(os.path.join(project_dir, "aidlc", "active-space"), encoding="utf-8") as f:
            space = f.read().strip()
        with open(os.path.join(project_dir, "aidlc", "spaces", space, "intents", "active-intent"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def form_id(doc, project_dir="", now=None):
    """`<intent>-<stage>[-<unit>]-findings-<YYYYMMDDTHHMM>` for AI-DLC, `code-review-<YYYYMMDDTHHMM>` otherwise."""
    stamp = (now or now_utc()).strftime("%Y%m%dT%H%M").lower()  # form ids are [a-z0-9._-]+
    if doc.get("source") == "code-review":
        return f"code-review-{stamp}"
    parts = [active_intent(project_dir) or "aidlc", doc.get("stage") or slug(doc.get("stage_name", "")) or "stage",
             doc.get("unit") or "", "findings", stamp]
    return slug("-".join(p for p in parts if p))


def boxes(code):
    return [
        {"k": "fix", "t": "Fix", "hint": "Fixed now" if code else "Fixed before approval", "tone": "ink"},
        {"k": "accept", "t": "Accept", "hint": "Carried as a known risk", "tone": "muted"},
        {"k": "reject", "t": "Reject (reason required)", "hint": "Not applicable; write why in the note",
         "tone": "warn", "sink": True},
    ]


def block(label, text):
    text = re.sub(r"\n\s*\n+", "\n", str(text or "").strip())
    return f"**{label}:** {text}" if text else ""


def card(n, f, code, reviewer=""):
    ctx = [block("Where", f.get("where")), block("Finding", f.get("finding"))]
    ctx.append(block("What goes wrong", f.get("scenario")) if code else block("Required action", f.get("action")))
    who = reviewer or ("Code review" if code else "AI review")
    return {
        "n": n, "text": f.get("title") or first_sentence(f.get("finding", ""), TITLE_LIMIT) or f["id"],
        "ctx": "\n\n".join(b for b in ctx if b), "kind": "card",
        "from": ", ".join(p for p in (who, f.get("severity"), f.get("category")) if p),
        "proposed": {"k": "fix" if f.get("blocking") else "accept", "why": f.get("severity", "")},
        "outcomes": {"fix": "Fixed now, in the code." if code else "Goes into Request Changes; fixed, then reviewed again.",
                     "accept": "Carried as a known risk; no change.",
                     "reject": "Not applicable; your note says why."},
    }


def board(doc, fid, title, out_dir, now=None):
    """Write forms.json, cards/<qid>.json and writes.json for one ArtifactData batch; returns a summary dict."""
    if not doc.get("findings"):
        raise ValueError("there are no open findings, so there is nothing to sort")
    if incomplete(doc):
        raise ValueError(incomplete(doc))
    code = doc.get("source") == "code-review"
    out = os.path.abspath(out_dir)
    os.makedirs(os.path.join(out, "cards"), exist_ok=True)
    row = {"title": title, "status": "open", "createdAt": (now or now_utc()).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "view": "board", "boxes": boxes(code)}
    if doc.get("stage_name") and not code:
        row["stage"] = doc["stage_name"]
    if doc.get("artifact"):
        row["file"] = doc["artifact"]
    writes = [{"op": "set", "collection": "forms", "doc_id": fid, "file_path": os.path.join(out, "forms.json")}]
    dump(os.path.join(out, "forms.json"), row)
    for n, f in enumerate(doc["findings"], 1):
        name = re.sub(r"[^A-Za-z0-9._-]", "_", f["id"])
        path = os.path.join(out, "cards", name + ".json")
        dump(path, card(n, f, code, doc.get("reviewer", "")))
        writes.append({"op": "set", "collection": f"forms/{fid}/questions", "doc_id": f["id"], "file_path": path})
    dump(os.path.join(out, "writes.json"), writes, indent=2)
    return {"id": fid, "cards": len(doc["findings"]), "writes": os.path.join(out, "writes.json")}


def dump(path, data, indent=2):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------- command line

def read(path):
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_findings(path):
    doc = json.loads(read(path))
    if not isinstance(doc, dict) or not isinstance(doc.get("findings"), list):
        raise ValueError(f"{path} is not a findings document (parse a brief, a review or a ReportFindings input first)")
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--brief")
    src.add_argument("--review")
    src.add_argument("--report")
    p.add_argument("--stage", help="the stage slug (a brief names only the stage's title)")
    p.add_argument("--unit")
    for name in ("summary", "question"):
        sub.add_parser(name).add_argument("--findings", required=True)
    b = sub.add_parser("board")
    b.add_argument("--findings", required=True)
    b.add_argument("--id")
    b.add_argument("--title")
    b.add_argument("--project-dir", default=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    b.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "parse":
            if args.brief:
                doc = parse_brief(read(args.brief), args.stage)
            elif args.review:
                doc = parse_review(read(args.review), args.stage)
            else:
                doc = parse_report(json.loads(read(args.report)))
            if args.unit:
                doc["unit"] = args.unit
            print(json.dumps(doc, indent=2, ensure_ascii=False))
        elif args.cmd == "summary":
            doc = load_findings(args.findings)
            if incomplete(doc):
                raise ValueError(incomplete(doc))
            print(summary(doc))
        elif args.cmd == "question":
            doc = load_findings(args.findings)
            if incomplete(doc):
                raise ValueError(incomplete(doc))
            print(json.dumps(triage(doc), indent=2, ensure_ascii=False))
        else:
            doc = load_findings(args.findings)
            code = doc.get("source") == "code-review"
            title = args.title or "Review findings · " + ("code review" if code else doc.get("stage_name") or doc.get("stage") or "review")
            result = board(doc, args.id or form_id(doc, args.project_dir), title, args.out)
            print(json.dumps(result))
    except (OSError, ValueError) as why:
        print(f"findings.py: {why}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
