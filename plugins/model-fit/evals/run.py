#!/usr/bin/env python3
"""Eval harness for model-fit's Haiku task classifier.

Runs every case in an evals file through one or more classifier prompts (each call is one
`claude -p` request to Haiku), grades the replies against `expected`, and writes a
skill-creator workspace plus a summary:

    workspace/iteration-N/eval-<id>-<name>/<config>/run-<k>/outputs/reply.json
                                                       .../grading.json  .../timing.json
    workspace/iteration-N/eval-<id>-<name>/eval_metadata.json
    workspace/iteration-N/summary.md  summary.json  benchmark.json  review.html

Configs: `candidate` -> with_skill, `v2.1.0` (the shipped prompt) -> old_skill, any other prompt
path -> its file stem. Python 3 standard library only. See README.md.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROMPTS_DIR = HERE / "prompts"
# The skill-creator skill's folder (for its benchmark aggregator and review viewer). Set it with
# --skill-creator or SKILL_CREATOR_DIR; without it the summary is still written, the viewer skipped.
DEFAULT_SKILL_CREATOR = os.environ.get("SKILL_CREATOR_DIR", "")
SKILL_NAME = "model-fit-classifier"

TIERS = ["haiku", "sonnet", "opus", "fable"]
RANK = {"haiku": 0, "sonnet": 1, "opus": 2, "fable": 3, "opus-or-fable": 2}
LUMPED = "opus-or-fable"  # what a prompt that has no fable tier means by "opus"
UNPARSED = "unparsed"
CURRENT_MODELS = ["haiku", "sonnet", "opus", "fable"]

# Named prompts: name -> (file, config directory name)
NAMED = {
    "candidate": (PROMPTS_DIR / "candidate.txt", "with_skill"),
    "v2.1.0": (PROMPTS_DIR / "v2.1.0.txt", "old_skill"),
}

# Mirrors hooks/classify.ts so the model sees exactly what the plugin would send.
VOTES = 3  # CLASSIFIER_VOTES in hooks/classify.ts
MAX_SUBSETS = 120  # cap on the 3-subsets of one case's reps
MAX_CLASSIFIED_CHARS = 4_000
MAX_RESULT_CHARS = 2_000
MAX_RESULTS_TOTAL_CHARS = 8_000

AUTH_PATTERN = re.compile(
    r"not logged in|please run /login|run /login|invalid api key|authentication_error|"
    r"oauth token (?:has )?expired|invalid x-api-key|credit balance is too low",
    re.I,
)


class AuthError(Exception):
    pass


# --------------------------------------------------------------------------- prompt building


MAX_FROM_CHARS = 160  # keep equal to MAX_FROM_CHARS in hooks/classify.ts

# JavaScript's String.prototype.trim() strips exactly these (WhiteSpace and LineTerminator). Python's
# str.strip() differs (it also strips U+0085 and U+001C-U+001F), so the prompt twin uses this set.
JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def js_trim(text: str) -> str:
    return text.strip(JS_WHITESPACE)


def js_len(text: str) -> int:
    """String length in UTF-16 code units, as JavaScript counts it."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def js_slice(text: str, count: int) -> str:
    """text.slice(0, count) in UTF-16 code units: it may cut a surrogate pair in two, as JS does."""
    return text.encode("utf-16-le", "surrogatepass")[: 2 * count].decode("utf-16-le", "surrogatepass")


def escape_text(text: str) -> str:
    """Python port of escapeText in hooks/classify.ts: nothing between the tags can form a tag."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def clean_from(frm) -> str | None:
    """Python port of cleanFrom in hooks/classify.ts: a label safe inside from="..."."""
    if not isinstance(frm, str):
        return None
    cleaned = re.sub(r"[\r\n]+", " ", frm)
    cleaned = re.sub(r'["<>]', "", cleaned)
    cleaned = js_trim(js_slice(js_trim(cleaned), MAX_FROM_CHARS))
    return cleaned or None


def as_result(result) -> dict:
    """A context entry is a plain string (no label) or {"from": ..., "text": ...}."""
    if isinstance(result, dict):
        return {"from": result.get("from"), "text": str(result.get("text", ""))}
    return {"from": None, "text": str(result)}


def build_classifier_prompt(text: str, results: list) -> str:
    """Python port of buildClassifierPrompt + selectResults in hooks/classify.ts. The two MUST build
    the same text (same escaping, caps, trimming and UTF-16 slicing): tests/test_prompt_twin.py checks
    both against tests/fixtures/prompts.json, or the evals would measure a prompt the plugin never sends."""
    body = js_slice(js_trim(text), MAX_CLASSIFIED_CHARS)
    request = f"<request>\n{escape_text(body)}\n</request>"

    shown: list[dict] = []
    used = 0
    for entry in results:
        result = as_result(entry)
        head = js_slice(js_trim(result["text"]), MAX_RESULT_CHARS)
        room = MAX_RESULTS_TOTAL_CHARS - used
        if head == "" or room <= 0:
            continue
        shown.append({"from": result["from"], "text": js_slice(head, room)})
        used += min(js_len(head), room)

    if not shown:
        return request

    blocks = []
    for r in shown:
        label = clean_from(r["from"])
        tag = "<result>" if label is None else f'<result from="{label}">'
        blocks.append(f"{tag}\n{escape_text(r['text'])}\n</result>")
    return f"{request}\n<context>\n" + "\n".join(blocks) + "\n</context>"


# --------------------------------------------------------------------------- reply parsing


def first_object(text: str) -> dict | None:
    """Tolerant parse, like parseVerdict: the first {...} in the text, else the widest span."""
    candidates = []
    m = re.search(r"\{[^{}]*\}", text)
    if m:
        candidates.append(m.group(0))
    first, last = text.find("{"), text.rfind("}")
    if first != -1 and last > first:
        candidates.append(text[first : last + 1])
    # Haiku now and then closes the object with a stray `,"}` or `,}`; try the repaired spelling too.
    candidates = [c for span in candidates for c in (span, re.sub(r',\s*"?\s*\}$', "}", span))]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def normalise(obj: dict | None) -> dict | None:
    """Reply object -> {kind, enough, tier, rule, reason, lumped}; None when it is not a verdict.

    Candidate format: {"kind","enough","rule","tier","reason"}.
    Baseline format:  {"tier":"chat|haiku|sonnet|opus","enough","reason"}: `chat` becomes
    kind chat / tier haiku, and `opus` becomes "opus-or-fable" (the baseline has no fable tier).
    """
    if obj is None:
        return None
    label = str(obj.get("tier", "")).strip().lower()
    enough = obj.get("enough") is True  # only an explicit true counts, as in the plugin
    reason = re.sub(r"\s+", " ", str(obj.get("reason", ""))).strip()
    rule = str(obj.get("rule", "")).strip()

    if "kind" in obj:
        kind = str(obj.get("kind", "")).strip().lower()
        if kind == "chat":
            return {"kind": "chat", "enough": enough, "tier": "haiku", "rule": rule or "none",
                    "reason": reason, "lumped": False}
        if kind == "task" and label in TIERS:
            return {"kind": "task", "enough": enough, "tier": label, "rule": rule,
                    "reason": reason, "lumped": False}
        return None

    # legacy / baseline format
    if label == "chat":
        return {"kind": "chat", "enough": enough, "tier": "haiku", "rule": "", "reason": reason,
                "lumped": False}
    if label in ("haiku", "sonnet"):
        return {"kind": "task", "enough": enough, "tier": label, "rule": "", "reason": reason,
                "lumped": False}
    if label == "opus":
        return {"kind": "task", "enough": enough, "tier": LUMPED, "rule": "", "reason": reason,
                "lumped": True}
    return None


# --------------------------------------------------------------------------- the model call


def fake_claude(system_text: str, built_prompt: str, seed: str) -> str:
    """--dry-run: a deterministic pseudo-classifier that answers in `claude -p --output-format
    json` shape, in whichever reply format the prompt asks for. Variance is seeded by (case,
    config, rep), so a re-run reproduces exactly."""
    h = int(hashlib.sha256(seed.encode()).hexdigest(), 16)
    text = built_prompt.lower()
    has_context = "<context>" in text
    request = text.split("</request>")[0]
    words = len(request.split())

    task_verbs = (r"\b(fix|build|add|implement|write|refactor|rename|find|list|search|grep|convert|"
                  r"bump|run|review|design|migrate|debug|create|make|update|investigate|prove|"
                  r"invent|summar|translate|count|format|change|remove|delete|deploy|analy[sz]e)")
    is_chat = bool(re.search(r"^<request>\s*(hi|hello|hey|thanks|thank you|how are you|what do you think)", text)) \
        or (words <= 14 and "?" in request and not re.search(task_verbs, request))
    enough = not (re.search(r"prompt\.md|plan\.md|docs/|\bcontinue\b|\bdo it\b|same as before|the plan|ticket",
                            request) and not has_context)

    if re.search(r"new (consensus|crypto|algorithm|protocol)|open research|from scratch|formally (prove|verify)", request):
        tier = "fable"
    elif re.search(r"race|deadlock|concurren|idempoten|crash|corrupt|migrat\w* live|ledger|overdraw|"
                   r"threat model|exploit|vulnerab|auth\w* design|flaky|intermittent|root cause|"
                   r"across (services|systems)|re-?architect", request):
        tier = "opus"
    elif re.search(r"\b(rename|list|find|grep|search|count|convert|bump|translate|summar\w+|look up|"
                   r"reformat|format)\b", request):
        tier = "haiku"
    else:
        tier = "sonnet"

    noise = h % 100
    if noise < 12 and not is_chat:  # drift one tier
        i = TIERS.index(tier) + (1 if (h >> 8) % 2 else -1)
        tier = TIERS[max(0, min(3, i))]
    if 12 <= noise < 16:
        enough = not enough
    legacy = '"kind"' not in system_text

    if noise >= 97:
        reply_text = "I would pick " + tier + " for this one."
    elif legacy:
        label = "chat" if is_chat else ("opus" if tier == "fable" else tier)
        reply_text = json.dumps({"tier": label, "enough": enough,
                                 "reason": f"dry-run guess for {label}"})
    else:
        reply_text = json.dumps({"kind": "chat" if is_chat else "task", "enough": enough,
                                 "rule": "none" if is_chat else "S4",
                                 "tier": "haiku" if is_chat else tier,
                                 "reason": "dry-run pseudo-classifier"}, separators=(",", ":"))

    in_tok = (len(system_text) + len(built_prompt)) // 4
    return json.dumps({
        "type": "result", "subtype": "success", "is_error": False,
        "duration_ms": 250 + (h >> 16) % 600, "num_turns": 1, "result": reply_text,
        "total_cost_usd": round(in_tok * 1e-6 + 0.00002, 6),
        "usage": {"input_tokens": in_tok, "output_tokens": 40,
                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    })


class Caller:
    """Calls Haiku for one case under one prompt; retries once on a non-zero exit."""

    def __init__(self, args: argparse.Namespace, scratch: Path):
        self.args = args
        self.scratch = scratch
        self.auth_failed = threading.Event()
        self.env = dict(os.environ)
        # Keep ambient context out of the classifier: no CLAUDE.md files, no auto-memory.
        self.env.update({"CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"})

    def command(self, prompt_file: Path) -> list[str]:
        a = self.args
        cmd = ["claude", "-p", "--model", a.model, "--effort", a.effort,
               "--system-prompt-file", str(prompt_file), "--tools", "",
               "--no-session-persistence", "--output-format", "json", "--max-turns", "1",
               # Run clean of the user's hooks/plugins/skills/MCP; auth is unaffected.
               "--setting-sources", "project", "--disable-slash-commands", "--strict-mcp-config"]
        return cmd + list(a.claude_arg or [])

    def call(self, prompt_file: Path, system_text: str, built: str, seed: str) -> dict:
        """Returns {ok, text, error, duration_ms, cost_usd, usage, attempts, wall_ms}."""
        if self.auth_failed.is_set():
            raise AuthError("skipped after an earlier authentication failure")
        t0 = time.time()
        info: dict = {"ok": False, "text": "", "error": None, "duration_ms": None,
                      "cost_usd": None, "usage": None, "attempts": 0}

        for attempt in (1, 2):
            info["attempts"] = attempt
            if self.args.dry_run:
                rc, out, err = 0, fake_claude(system_text, built, seed), ""
            else:
                try:
                    # The prompt goes on stdin: `--tools` is variadic and would swallow a
                    # trailing positional prompt.
                    proc = subprocess.run(self.command(prompt_file), input=built, text=True,
                                          capture_output=True, cwd=self.scratch, env=self.env,
                                          timeout=self.args.timeout)
                    rc, out, err = proc.returncode, proc.stdout, proc.stderr
                except subprocess.TimeoutExpired:
                    rc, out, err = 124, "", f"timed out after {self.args.timeout}s"
                except FileNotFoundError:
                    raise SystemExit("`claude` CLI not found on PATH")

            if AUTH_PATTERN.search(out + "\n" + err):
                self.auth_failed.set()
                raise AuthError((err or out).strip()[:300])

            payload = parse_cli_json(out)
            is_error = bool(payload and payload.get("is_error"))
            if rc == 0 and payload is not None and not is_error:
                usage = payload.get("usage") or {}
                info.update(ok=True, text=str(payload.get("result", "")), error=None,
                            duration_ms=payload.get("duration_ms"),
                            cost_usd=payload.get("total_cost_usd", payload.get("cost_usd")),
                            usage=usage)
                break
            info["error"] = (f"exit {rc}: " if rc else "") + ((err or out).strip()[:300] or "no output")
            if payload is not None and payload.get("result"):
                info["text"] = str(payload.get("result"))
        info["wall_ms"] = int((time.time() - t0) * 1000)
        if info["duration_ms"] is None:
            info["duration_ms"] = info["wall_ms"]
        return info


def parse_cli_json(out: str) -> dict | None:
    """`--output-format json` prints one result object (some versions: an array of events)."""
    try:
        value = json.loads(out)
    except json.JSONDecodeError:
        return None
    if isinstance(value, list):
        for item in reversed(value):
            if isinstance(item, dict) and item.get("type") == "result":
                return item
        return None
    return value if isinstance(value, dict) else None


# --------------------------------------------------------------------------- cases


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:48] or "case"


def load_cases(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    raw = data["evals"] if isinstance(data, dict) else data
    cases = []
    for i, c in enumerate(raw, start=1):
        ctx = c.get("context") or []
        if isinstance(ctx, (str, dict)):
            ctx = [ctx]
        try:
            eid = int(c.get("id", i))
        except (TypeError, ValueError):
            eid = i
        cases.append({
            "id": eid, "orig_id": c.get("id", eid),
            "name": slug(c.get("name") or f"case-{eid}"),
            "prompt": c["prompt"], "context": [as_result(x) for x in ctx],
            "expected": c.get("expected") or {},
            "tier_uncertain": c.get("tier_uncertain", False),
            "assertions": c.get("assertions") or [],
        })
    ids = [c["id"] for c in cases]
    if len(set(ids)) != len(ids):  # non-numeric or clashing ids: fall back to position
        for i, c in enumerate(cases, start=1):
            c["id"] = i
    return cases


def tier_ok(expected_tier, got: str, lumped: bool) -> bool:
    options = expected_tier if isinstance(expected_tier, list) else [expected_tier]
    if got == LUMPED:
        return any(t in ("opus", "fable") for t in options)
    return got in options


def grade(case: dict, norm: dict | None, raw: str) -> dict:
    exp = case["expected"]
    checks: list[tuple[str, bool | None, str]] = []  # (text, passed, evidence)

    def evidence_for_miss() -> str:
        return f"reply did not parse into a verdict: {raw.strip()[:160]!r}"

    if "kind" in exp:
        text = f'kind is "{exp["kind"]}"'
        checks.append((text, norm is not None and norm["kind"] == exp["kind"],
                       evidence_for_miss() if norm is None else f'got kind "{norm["kind"]}"'))
    if "enough" in exp:
        text = f'enough is {str(bool(exp["enough"])).lower()}'
        checks.append((text, norm is not None and norm["enough"] == bool(exp["enough"]),
                       evidence_for_miss() if norm is None else f'got enough {str(norm["enough"]).lower()}'))
    if "tier" in exp and not case["tier_uncertain"]:
        want = exp["tier"]
        shown = "/".join(want) if isinstance(want, list) else want
        text = f'tier is "{shown}"'
        if norm is None:
            checks.append((text, False, evidence_for_miss()))
        else:
            ok = tier_ok(want, norm["tier"], norm["lumped"])
            note = ""
            if norm["lumped"]:
                note = " (baseline has no fable tier: opus counts for opus or fable)"
            checks.append((text, ok, f'got tier "{norm["tier"]}"{note}'))

    expectations = [{"text": t, "passed": bool(p), "evidence": e} for t, p, e in checks]
    passed = sum(1 for e in expectations if e["passed"])
    total = len(expectations)
    return {
        "expectations": expectations,
        "summary": {"passed": passed, "failed": total - passed, "total": total,
                    "pass_rate": round(passed / total, 4) if total else 0.0},
        "execution_metrics": {"total_tool_calls": 0, "errors_encountered": 0 if norm else 1,
                              "output_chars": len(raw)},
        "verdict": norm,
    }


# --------------------------------------------------------------------------- one run


def run_one(caller: Caller, case: dict, cfg: dict, rep: int, iter_dir: Path, built: str) -> dict:
    eval_dir = iter_dir / f"eval-{case['id']}-{case['name']}"
    run_dir = eval_dir / cfg["config"] / f"run-{rep}"
    (run_dir / "outputs").mkdir(parents=True, exist_ok=True)

    started = datetime.now(timezone.utc)
    seed = f"{case['id']}|{cfg['config']}|{rep}"
    info = caller.call(cfg["file"], cfg["text"], built, seed)
    ended = datetime.now(timezone.utc)

    raw = info["text"]
    obj = first_object(raw) if info["ok"] or raw else None
    norm = normalise(obj)
    failure = None
    if not info["ok"] and norm is None:
        failure = f"call failed: {info['error']}"
    elif norm is None:
        failure = "reply did not parse into a verdict"

    usage = info["usage"] or {}
    tokens = sum(int(usage.get(k) or 0) for k in
                 ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    dur_ms = info["duration_ms"] or 0

    (run_dir / "outputs" / "reply.json").write_text(json.dumps({
        "raw": raw, "parsed": obj, "normalised": norm, "ok": norm is not None, "failure": failure,
        "attempts": info["attempts"], "call_error": info["error"], "duration_ms": dur_ms,
        "cost_usd": info["cost_usd"], "usage": usage, "dry_run": caller.args.dry_run,
    }, indent=2, ensure_ascii=False) + "\n")

    grading = grade(case, norm, raw)
    (run_dir / "grading.json").write_text(json.dumps(grading, indent=2, ensure_ascii=False) + "\n")
    (run_dir / "timing.json").write_text(json.dumps({
        "total_tokens": tokens, "duration_ms": dur_ms,
        "total_duration_seconds": round(dur_ms / 1000, 3),
        "executor_start": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "executor_end": ended.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "executor_duration_seconds": round(dur_ms / 1000, 3),
    }, indent=2) + "\n")

    return {"eval_id": case["id"], "config": cfg["config"], "rep": rep, "norm": norm, "raw": raw,
            "failure": failure, "grading": grading, "duration_ms": dur_ms,
            "cost_usd": info["cost_usd"] or 0.0, "tokens": tokens}


def skipped_record(case: dict, cfg: dict, rep: int, why: str) -> dict:
    return {"eval_id": case["id"], "config": cfg["config"], "rep": rep, "norm": None, "raw": "",
            "failure": why, "grading": None, "duration_ms": 0, "cost_usd": 0.0, "tokens": 0,
            "skipped": True}


# --------------------------------------------------------------------------- summary


def verdict_key(norm: dict | None):
    return None if norm is None else (norm["kind"], norm["enough"], norm["tier"])


def majority(records: list[dict]) -> tuple | None:
    keys = [verdict_key(r["norm"]) for r in records if r["norm"]]
    if not keys:
        return None
    counts = Counter(keys)
    # most common; ties go to the lower tier (the plugin's own tie-breaker), then enough=True
    return sorted(counts, key=lambda k: (-counts[k], RANK[k[2]], not k[1]))[0]


def window_outcome(verdict: tuple | None, current: str) -> str:
    """What the plugin's window would do on a session running `current`."""
    if verdict is None:
        return "no verdict"
    kind, enough, tier = verdict
    if kind == "chat":
        return "no window (chat)"
    if not enough:
        return "no window (not enough)"
    if tier == LUMPED:
        return "fits" if current in ("opus", "fable") else "switch to opus/fable"
    return "fits" if tier == current else f"switch to {tier}"


def expected_outcome(case: dict, current: str) -> list[str] | None:
    """The window outcomes that would be right for this case on `current`, or None when unknown.
    An expected tier may be a list (any of them is right): then fitting is right if `current` is in
    it, and so is a switch to any other tier in it."""
    exp = case["expected"]
    if exp.get("kind") == "chat":
        return ["no window (chat)"]
    if exp.get("enough") is False:
        return ["no window (not enough)"]
    tier = exp.get("tier")
    if case["tier_uncertain"] or tier is None:
        return None
    tiers = tier if isinstance(tier, list) else [tier]
    wants = ["fits"] if current in tiers else []
    wants += [f"switch to {t}" for t in tiers if t != current]
    return wants


def outcomes_agree(got: str, wants: list[str] | None) -> bool | None:
    if wants is None:
        return None
    if got == "switch to opus/fable":
        return any(w in ("switch to opus", "switch to fable") for w in wants)
    return got in wants


def vote_norms(norms: list[dict | None]) -> dict | None:
    """The plugin's vote, on normalised replies (None = a reply that did not parse).

    KEEP IDENTICAL to `vote()` in hooks/classify.ts; change both together. Replies are compared by
    (kind, enough, tier), a chat being only its kind. The most common key wins, with the first reply
    that has it. Without a majority: none parsed is no verdict, one parsed is used, otherwise chat
    if most replies said chat, else the median tier of the task replies (the lower middle when
    there are two) with `enough` only if most of them said so.
    """
    parsed = [n for n in norms if n is not None]
    if not parsed:
        return None
    if len(parsed) == 1:
        return parsed[0]

    def key(n: dict):
        return ("chat",) if n["kind"] == "chat" else ("task", n["enough"], n["tier"])

    counts = Counter(key(n) for n in parsed)
    best = max(counts.values())
    if best >= 2:
        return next(n for n in parsed if counts[key(n)] == best)

    tasks = [n for n in parsed if n["kind"] == "task"]
    if len(parsed) - len(tasks) > len(parsed) / 2:
        return next(n for n in parsed if n["kind"] == "chat")

    ranks = sorted(RANK[n["tier"]] for n in tasks)
    median = ranks[(len(ranks) - 1) // 2]
    decider = next(n for n in tasks if RANK[n["tier"]] == median)
    sure = sum(1 for n in tasks if n["enough"]) > len(tasks) / 2
    return {**decider, "enough": sure}


def rep_subsets(reps: list[dict]) -> list[list[dict]]:
    """Every 3-subset of a case's reps (capped); with fewer than 3 reps, the reps there are."""
    if len(reps) <= VOTES:
        return [reps] if reps else []
    return [list(c) for c in itertools.islice(itertools.combinations(reps, VOTES), MAX_SUBSETS)]


def vote_stats(cases: list[dict], recs: list[dict]) -> dict:
    """What a majority of three calls would have done: every 3-subset of each case's reps is voted
    and graded like a single run; the voted verdict is also re-scored as a window outcome on each
    current model against `expected`."""
    by_case: dict[int, list[dict]] = defaultdict(list)
    for r in recs:
        if not r.get("skipped"):
            by_case[r["eval_id"]].append(r)

    subsets_n = subsets_ok = 0
    outcome_n = {m: 0 for m in CURRENT_MODELS}
    outcome_ok = {m: 0 for m in CURRENT_MODELS}
    all_models_n = all_models_ok = 0
    failing: list[dict] = []

    for case in cases:
        rs = by_case.get(case["id"], [])
        subs = rep_subsets(rs)
        bad = 0
        for sub in subs:
            voted = vote_norms([r["norm"] for r in sub])
            g = grade(case, voted, "")
            ok = g["summary"]["failed"] == 0 and g["summary"]["total"] > 0
            subsets_n += 1
            subsets_ok += 1 if ok else 0
            bad += 0 if ok else 1
            verdict = verdict_key(voted)
            checks = []
            for m in CURRENT_MODELS:
                agree = outcomes_agree(window_outcome(verdict, m), expected_outcome(case, m))
                checks.append(agree)
                if agree is not None:
                    outcome_n[m] += 1
                    outcome_ok[m] += 1 if agree else 0
            if checks and all(c is not None for c in checks):
                all_models_n += 1
                all_models_ok += 1 if all(checks) else 0
        if bad:
            failing.append({"id": case["id"], "name": case["name"], "failing_subsets": bad,
                            "subsets": len(subs), "expected": fmt_expected(case)})

    return {
        "votes": VOTES, "subsets": subsets_n, "fully_correct": ratio(subsets_ok, subsets_n),
        "fully_correct_subsets": subsets_ok,
        "window_outcome_correct_by_model": {
            m: {"correct": outcome_ok[m], "n": outcome_n[m], "accuracy": ratio(outcome_ok[m], outcome_n[m])}
            for m in CURRENT_MODELS},
        "window_outcome_correct_on_every_model": {
            "correct": all_models_ok, "n": all_models_n, "accuracy": ratio(all_models_ok, all_models_n)},
        "failing_cases": failing,
    }


def pct(n: int, d: int) -> str:
    return "n/a" if d == 0 else f"{100 * n / d:.0f}% ({n}/{d})"


def ratio(n: int, d: int):
    return None if d == 0 else round(n / d, 4)


def config_stats(cfg: dict, cases: list[dict], recs: list[dict]) -> dict:
    by_case: dict[int, list[dict]] = defaultdict(list)
    for r in recs:
        by_case[r["eval_id"]].append(r)
    case_by_id = {c["id"]: c for c in cases}

    exp_passed = exp_total = full_ok = 0
    kind_n = kind_ok = enough_n = enough_ok = tier_n = tier_ok_n = 0
    per_tier: dict[str, list[int]] = {t: [0, 0] for t in TIERS}
    confusion: dict[str, Counter] = {t: Counter() for t in TIERS}
    kind_confusion: dict[str, Counter] = {"task": Counter(), "chat": Counter()}
    lumped_credit = Counter()
    nofable_n = nofable_ok = 0
    failures_unparsed = 0

    for r in recs:
        case = case_by_id[r["eval_id"]]
        exp = case["expected"]
        g = r["grading"]
        if g is None:  # skipped
            continue
        exp_passed += g["summary"]["passed"]
        exp_total += g["summary"]["total"]
        full_ok += 1 if g["summary"]["failed"] == 0 and g["summary"]["total"] else 0
        norm = r["norm"]
        if norm is None:
            failures_unparsed += 1
        if "kind" in exp:
            kind_n += 1
            kind_ok += 1 if norm and norm["kind"] == exp["kind"] else 0
            if exp["kind"] in kind_confusion:
                kind_confusion[exp["kind"]][norm["kind"] if norm else UNPARSED] += 1
        if "enough" in exp:
            enough_n += 1
            enough_ok += 1 if norm and norm["enough"] == bool(exp["enough"]) else 0
        if "tier" in exp and not case["tier_uncertain"]:
            want = exp["tier"]
            want_list = want if isinstance(want, list) else [want]
            ok = bool(norm) and tier_ok(want, norm["tier"], norm["lumped"])
            tier_n += 1
            tier_ok_n += 1 if ok else 0
            for t in want_list:
                if t in per_tier:
                    per_tier[t][1] += 1
                    per_tier[t][0] += 1 if ok else 0
            row = want_list[0] if want_list[0] in confusion else "haiku"
            confusion[row][norm["tier"] if norm else UNPARSED] += 1
            if norm and norm["lumped"]:
                lumped_credit["said_opus"] += 1
                if "fable" in want_list and "opus" not in want_list:
                    lumped_credit["credit_for_expected_fable"] += 1
            if "fable" not in want_list:
                nofable_n += 1
                nofable_ok += 1 if ok else 0

    consistent = 0
    for cid, rs in by_case.items():
        keys = [verdict_key(r["norm"]) for r in rs]
        if keys and None not in keys and len(set(keys)) == 1:
            consistent += 1

    durations = [r["duration_ms"] for r in recs if not r.get("skipped")]
    stats = {
        "config": cfg["config"], "prompt": str(cfg["file"]), "runs": len(recs),
        "unparsed_runs": failures_unparsed,
        "expectation_pass_rate": ratio(exp_passed, exp_total),
        "expectations_passed": exp_passed, "expectations_total": exp_total,
        "runs_fully_correct": ratio(full_ok, len(recs)),
        "kind_accuracy": ratio(kind_ok, kind_n), "kind_n": kind_n,
        "enough_accuracy": ratio(enough_ok, enough_n), "enough_n": enough_n,
        "tier_accuracy": ratio(tier_ok_n, tier_n), "tier_n": tier_n, "tier_correct": tier_ok_n,
        "tier_accuracy_by_expected": {t: {"correct": v[0], "n": v[1], "accuracy": ratio(v[0], v[1])}
                                      for t, v in per_tier.items()},
        "tier_accuracy_excluding_expected_fable": ratio(nofable_ok, nofable_n),
        "lumped_opus_replies": lumped_credit["said_opus"],
        "lumped_credit_for_expected_fable": lumped_credit["credit_for_expected_fable"],
        "confusion": {t: dict(c) for t, c in confusion.items()},
        "kind_confusion": {k: dict(c) for k, c in kind_confusion.items()},
        "consistency": ratio(consistent, len(by_case)), "consistent_cases": consistent,
        "cases": len(by_case),
        "mean_latency_ms": round(sum(durations) / len(durations), 1) if durations else None,
        "total_cost_usd": round(sum(r["cost_usd"] for r in recs), 6),
        "total_tokens": sum(r["tokens"] for r in recs),
        "majority_of_3": vote_stats(cases, recs),
    }
    return stats


def fmt_verdict(v: tuple | None) -> str:
    if v is None:
        return "(no parseable reply)"
    kind, enough, tier = v
    return "chat" if kind == "chat" else f"task/{tier}" + ("" if enough else " (not enough)")


def fmt_expected(case: dict) -> str:
    e = case["expected"]
    if e.get("kind") == "chat":
        return "chat"
    t = e.get("tier", "?")
    t = "/".join(t) if isinstance(t, list) else t
    out = f"task/{t}" + ("?" if case["tier_uncertain"] else "")
    if e.get("enough") is False:
        out += " (not enough)"
    return out


def build_summary(cases, cfgs, records, args, iteration) -> tuple[dict, str]:
    case_by_id = {c["id"]: c for c in cases}
    per_cfg_recs: dict[str, list[dict]] = {c["config"]: [] for c in cfgs}
    for r in records:
        per_cfg_recs[r["config"]].append(r)

    summary: dict = {
        "iteration": iteration, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dry_run": args.dry_run, "model": args.model, "reps": args.reps, "cases": len(cases),
        "configs": {},
    }
    md: list[str] = []
    w = md.append
    w(f"# model-fit classifier eval: iteration {iteration}")
    w("")
    if args.dry_run:
        w("> **DRY RUN**: replies come from a deterministic pseudo-classifier, not from Haiku. "
          "These numbers test the pipeline only.")
        w("")
    w(f"{len(cases)} cases x {args.reps} reps, model `{args.model}`, effort `{args.effort}`. "
      f"Configs: " + ", ".join(f"`{c['config']}` = {c['name']} ({Path(c['file']).name})" for c in cfgs) + ".")
    w("")

    stats_by_cfg = {}
    for cfg in cfgs:
        stats_by_cfg[cfg["config"]] = config_stats(cfg, cases, per_cfg_recs[cfg["config"]])
    summary["configs"] = stats_by_cfg

    # ---- headline table
    w("## Headline")
    w("")
    head = ["Metric"] + [f"`{c['config']}`" for c in cfgs]
    w("| " + " | ".join(head) + " |")
    w("|" + "---|" * len(head))

    def row(label, fn):
        w("| " + label + " | " + " | ".join(fn(stats_by_cfg[c["config"]]) for c in cfgs) + " |")

    def p(s, key, n_key=None, c_key=None):
        v = s[key]
        return "n/a" if v is None else f"{100 * v:.1f}%"

    row("Overall pass rate (expectations)", lambda s: pct(s["expectations_passed"], s["expectations_total"]))
    row("Runs with every expectation met", lambda s: p(s, "runs_fully_correct"))
    row("Tier accuracy", lambda s: pct(s["tier_correct"], s["tier_n"]))
    row("Kind accuracy", lambda s: p(s, "kind_accuracy"))
    row("Enough accuracy", lambda s: p(s, "enough_accuracy"))
    row("Majority-of-3 fully correct", lambda s: pct(s["majority_of_3"]["fully_correct_subsets"], s["majority_of_3"]["subsets"]))
    row("Consistency (all reps identical)", lambda s: pct(s["consistent_cases"], s["cases"]))
    row("Unparseable replies", lambda s: str(s["unparsed_runs"]))
    row("Mean latency", lambda s: "n/a" if s["mean_latency_ms"] is None else f"{s['mean_latency_ms']:.0f} ms")
    row("Total cost", lambda s: f"${s['total_cost_usd']:.4f}")
    row("Total tokens", lambda s: str(s["total_tokens"]))
    w("")

    # ---- tier accuracy by expected tier
    w("## Tier accuracy by expected tier")
    w("")
    w("Cases flagged `tier_uncertain` are excluded from every tier number.")
    w("")
    w("| Expected tier | " + " | ".join(f"`{c['config']}`" for c in cfgs) + " |")
    w("|---|" + "---|" * len(cfgs))
    for t in TIERS:
        cells = []
        for c in cfgs:
            v = stats_by_cfg[c["config"]]["tier_accuracy_by_expected"][t]
            cells.append(pct(v["correct"], v["n"]))
        w(f"| {t} | " + " | ".join(cells) + " |")
    w("")
    for c in cfgs:
        s = stats_by_cfg[c["config"]]
        if s["lumped_opus_replies"]:
            fa = s["tier_accuracy_excluding_expected_fable"]
            w(f"**`{c['config']}` has no fable tier.** Its `opus` is read as opus-or-fable and counted right for "
              f"either expectation. {s['lumped_opus_replies']} replies said opus; "
              f"{s['lumped_credit_for_expected_fable']} of them were credited against an expected "
              f"**fable** that the prompt cannot express. Tier accuracy without the fable-expected "
              f"cases: {'n/a' if fa is None else f'{100 * fa:.1f}%'} "
              f"(with them: {pct(s['tier_correct'], s['tier_n'])}).")
            w("")

    # ---- confusion matrices
    w("## Confusion matrix: expected tier (rows) vs got tier (columns)")
    w("")
    cols = TIERS + [LUMPED, UNPARSED]
    for c in cfgs:
        s = stats_by_cfg[c["config"]]
        used = [col for col in cols if col in TIERS or any(col in s["confusion"][t] for t in TIERS)]
        w(f"**`{c['config']}`**")
        w("")
        w("| expected \\ got | " + " | ".join(used) + " |")
        w("|---|" + "---|" * len(used))
        for t in TIERS:
            w(f"| {t} | " + " | ".join(str(s["confusion"][t].get(col, 0)) for col in used) + " |")
        w("")
        kc = s["kind_confusion"]
        w("kind: " + "; ".join(
            f"expected {k} -> " + (", ".join(f"{g} x{n}" for g, n in v.items()) or "none")
            for k, v in kc.items()))
        w("")

    # ---- majority of three (what the plugin does: three calls, the majority decides)
    w("## Majority of 3")
    w("")
    w("The plugin makes three Haiku calls at once and the majority decides (`vote()` in "
      "`hooks/classify.ts`; `vote_norms` here is the same rule). Every 3-subset of a case's reps is "
      "voted and graded like a single run; with fewer than 3 reps the reps there are voted. "
      "The window rows score the voted verdict as an outcome on each current model against `expected` "
      "(cases whose expected tier is unknown or uncertain are left out).")
    w("")
    w("| Metric | " + " | ".join(f"`{c['config']}`" for c in cfgs) + " |")
    w("|---|" + "---|" * len(cfgs))
    w("| Majority-of-3 fully correct (share of subsets) | " + " | ".join(
        pct(stats_by_cfg[c["config"]]["majority_of_3"]["fully_correct_subsets"],
            stats_by_cfg[c["config"]]["majority_of_3"]["subsets"]) for c in cfgs) + " |")
    for m in CURRENT_MODELS:
        w(f"| Window outcome right on {m} | " + " | ".join(
            pct(stats_by_cfg[c["config"]]["majority_of_3"]["window_outcome_correct_by_model"][m]["correct"],
                stats_by_cfg[c["config"]]["majority_of_3"]["window_outcome_correct_by_model"][m]["n"])
            for c in cfgs) + " |")
    w("| Window outcome right on all four models | " + " | ".join(
        pct(stats_by_cfg[c["config"]]["majority_of_3"]["window_outcome_correct_on_every_model"]["correct"],
            stats_by_cfg[c["config"]]["majority_of_3"]["window_outcome_correct_on_every_model"]["n"])
        for c in cfgs) + " |")
    w("")
    for c in cfgs:
        failing = stats_by_cfg[c["config"]]["majority_of_3"]["failing_cases"]
        w(f"**`{c['config']}`: cases the vote still gets wrong**")
        w("")
        if not failing:
            w("- none")
        for f in failing:
            w(f"- **{f['id']} {f['name']}**: {f['failing_subsets']}/{f['subsets']} subsets wrong. "
              f"Expected {f['expected']}.")
        w("")

    # ---- model invariance
    w("## Model invariance")
    w("")
    w("The classifier never sees the session's model, so each case's majority verdict is one fixed "
      "recommendation. This table is what the window would do on each current model. "
      "The last column checks the outcome against `expected` on all four models "
      "(`-` = expected tier unknown or uncertain). Ties among reps go to the lower tier.")
    w("")
    invariance: dict = {}
    for c in cfgs:
        cname = c["config"]
        w(f"**`{cname}`**")
        w("")
        w("| Case | Expected | Majority verdict | on haiku | on sonnet | on opus | on fable | matches expected |")
        w("|---|---|---|---|---|---|---|---|")
        invariance[cname] = {}
        by_case: dict[int, list[dict]] = defaultdict(list)
        for r in per_cfg_recs[cname]:
            by_case[r["eval_id"]].append(r)
        agree_all = checked = 0
        for case in cases:
            rs = by_case.get(case["id"], [])
            mv = majority(rs)
            outs = {m: window_outcome(mv, m) for m in CURRENT_MODELS}
            checks = [outcomes_agree(outs[m], expected_outcome(case, m)) for m in CURRENT_MODELS]
            if any(ch is None for ch in checks):
                mark = "-"
            else:
                checked += 1
                ok = all(checks)
                agree_all += 1 if ok else 0
                mark = "yes" if ok else "NO"
            invariance[cname][str(case["id"])] = {"majority": fmt_verdict(mv), "outcomes": outs, "matches_expected": mark}
            w(f"| {case['id']} {case['name']} | {fmt_expected(case)} | {fmt_verdict(mv)} | "
              + " | ".join(outs[m] for m in CURRENT_MODELS) + f" | {mark} |")
        w("")
        w(f"Window outcome matches expected on every model for {pct(agree_all, checked)} of the checkable cases.")
        w("")
    summary["invariance"] = invariance

    # ---- failing cases
    w("## Failing cases")
    w("")
    fail_summary: dict = {}
    for c in cfgs:
        cname = c["config"]
        w(f"**`{cname}`**")
        w("")
        by_case = defaultdict(list)
        for r in per_cfg_recs[cname]:
            by_case[r["eval_id"]].append(r)
        fail_summary[cname] = []
        any_fail = False
        for case in cases:
            rs = by_case.get(case["id"], [])
            bad = [r for r in rs if r["grading"] is None or r["grading"]["summary"]["failed"] > 0]
            if not bad:
                continue
            any_fail = True
            got = Counter(fmt_verdict(verdict_key(r["norm"])) for r in rs)
            reasons = []
            for r in rs:
                if r["norm"] and r["norm"]["reason"] and r["norm"]["reason"] not in reasons:
                    reasons.append(r["norm"]["reason"])
            failed_texts = sorted({e["text"] for r in bad if r["grading"] for e in r["grading"]["expectations"]
                                   if not e["passed"]})
            w(f"- **{case['id']} {case['name']}**: {len(bad)}/{len(rs)} reps wrong "
              f"({'; '.join(failed_texts) or 'no reply'}). Expected {fmt_expected(case)}; got "
              + ", ".join(f"{g} x{n}" for g, n in got.most_common()) + ".")
            for reason in reasons[:3]:
                w(f"  - Haiku: \"{reason}\"")
            unparsed = [r for r in rs if r["norm"] is None]
            for r in unparsed[:1]:
                w(f"  - unparsed ({r['failure']}): `{(r['raw'] or '').strip()[:120]}`")
            fail_summary[cname].append({"id": case["id"], "name": case["name"], "wrong_reps": len(bad),
                                        "reps": len(rs), "expected": fmt_expected(case),
                                        "got": dict(got), "reasons": reasons})
        if not any_fail:
            w("- none")
        w("")
    summary["failing_cases"] = fail_summary

    # ---- head to head
    if len(cfgs) >= 2:
        a, b = cfgs[0]["config"], cfgs[1]["config"]
        w(f"## Head to head: `{a}` vs `{b}`")
        w("")
        diffs = []
        for case in cases:
            va = majority([r for r in per_cfg_recs[a] if r["eval_id"] == case["id"]])
            vb = majority([r for r in per_cfg_recs[b] if r["eval_id"] == case["id"]])
            if va != vb:
                diffs.append(f"| {case['id']} {case['name']} | {fmt_expected(case)} | {fmt_verdict(va)} | {fmt_verdict(vb)} |")
        w(f"{len(diffs)} of {len(cases)} cases differ in majority verdict.")
        w("")
        if diffs:
            w(f"| Case | Expected | `{a}` | `{b}` |")
            w("|---|---|---|---|")
            md.extend(diffs)
            w("")

    return summary, "\n".join(md) + "\n"


# --------------------------------------------------------------------------- aggregation + viewer


def run_tools(args, iter_dir: Path, iteration: int, cases: list[dict]) -> None:
    sc = Path(args.skill_creator)
    if not sc.is_dir():
        print(f"! skill-creator not found at {sc}; skipping aggregator and viewer", file=sys.stderr)
        return

    r = subprocess.run([sys.executable, "-m", "scripts.aggregate_benchmark", str(iter_dir),
                        "--skill-name", SKILL_NAME], cwd=sc, capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        print("! aggregator failed; skipping viewer", file=sys.stderr)
        return

    # The aggregator leaves placeholders and no eval_name; fill in what is known.
    bpath = iter_dir / "benchmark.json"
    bench = json.loads(bpath.read_text())
    names = {c["id"]: c["name"] for c in cases}
    bench["metadata"].update({
        "skill_name": SKILL_NAME, "skill_path": str(HERE / "prompts"),
        "executor_model": f"{args.model} via claude -p" + (" (DRY RUN, fake replies)" if args.dry_run else ""),
        "analyzer_model": "none (graded programmatically)", "runs_per_configuration": args.reps,
    })
    for run in bench["runs"]:
        run["eval_name"] = names.get(run["eval_id"], f"Eval {run['eval_id']}")
    bench["notes"] = ["Graded programmatically from each case's `expected`; see summary.md for tier "
                      "accuracy, confusion matrices and consistency.",
                      "Delta is the first config minus the second, alphabetically: old_skill minus with_skill."]
    if args.dry_run:
        bench["notes"].insert(0, "DRY RUN: fake replies from a pseudo-classifier; numbers test the pipeline only.")
    bpath.write_text(json.dumps(bench, indent=2) + "\n")

    cmd = [sys.executable, str(sc / "eval-viewer" / "generate_review.py"), str(iter_dir),
           "--skill-name", SKILL_NAME, "--benchmark", str(bpath), "--static", str(iter_dir / "review.html")]
    prev = iter_dir.parent / f"iteration-{iteration - 1}"
    if iteration > 1 and prev.is_dir():
        cmd += ["--previous-workspace", str(prev)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    print((r.stdout + r.stderr).strip())
    if r.returncode != 0:
        print("! viewer generation failed", file=sys.stderr)


# --------------------------------------------------------------------------- main


def resolve_prompt(spec: str) -> dict:
    if spec in NAMED:
        file, config = NAMED[spec]
        name = spec
    else:
        file = Path(spec).expanduser().resolve()
        config, name = slug(file.stem).replace("-", "_"), file.stem
    if not file.is_file():
        raise SystemExit(f"prompt file not found: {file}")
    return {"name": name, "config": config, "file": file, "text": file.read_text()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--evals", default=str(HERE / "evals.json"), help="evals file (default: evals/evals.json)")
    ap.add_argument("--prompt", action="append",
                    help="candidate | v2.1.0 | <path>; repeatable (default: candidate and v2.1.0)")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--iteration", type=int, help="default: the next unused iteration number")
    ap.add_argument("--workspace", default=str(HERE / "workspace"))
    ap.add_argument("--only", help="comma-separated case ids to run")
    ap.add_argument("--dry-run", action="store_true", help="fake replies from a pseudo-classifier; no claude calls")
    ap.add_argument("--overwrite", action="store_true", help="replace an existing iteration directory")
    ap.add_argument("--skip-viewer", action="store_true", help="skip the skill-creator aggregator and viewer")
    ap.add_argument("--skill-creator", default=os.environ.get("SKILL_CREATOR", DEFAULT_SKILL_CREATOR))
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--timeout", type=int, default=120, help="seconds per claude call")
    ap.add_argument("--claude-arg", action="append",
                    help="extra argument passed to every claude call (repeatable), e.g. --claude-arg=--bare")
    args = ap.parse_args()

    cfgs = [resolve_prompt(p) for p in (args.prompt or ["candidate", "v2.1.0"])]
    if len({c["config"] for c in cfgs}) != len(cfgs):
        raise SystemExit("two --prompt values map to the same config name")

    cases = load_cases(Path(args.evals))
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        cases = [c for c in cases if str(c["id"]) in wanted or str(c["orig_id"]) in wanted or c["name"] in wanted]
    if not cases:
        raise SystemExit("no cases to run")

    ws = Path(args.workspace)
    ws.mkdir(parents=True, exist_ok=True)
    iteration = args.iteration
    if iteration is None:
        used = [int(m.group(1)) for d in ws.glob("iteration-*") if (m := re.fullmatch(r"iteration-(\d+)", d.name))]
        iteration = max(used, default=0) + 1
    iter_dir = ws / f"iteration-{iteration}"
    if iter_dir.exists() and any(iter_dir.iterdir()):
        if not args.overwrite:
            raise SystemExit(f"{iter_dir} already has results; pass --overwrite or pick another --iteration")
        shutil.rmtree(iter_dir)
    iter_dir.mkdir(parents=True, exist_ok=True)

    # per-eval metadata, in the eval dir (the aggregator) and each config dir (the viewer)
    built = {}
    for case in cases:
        built[case["id"]] = build_classifier_prompt(case["prompt"], case["context"])
        eval_dir = iter_dir / f"eval-{case['id']}-{case['name']}"
        meta = {"eval_id": case["id"], "eval_name": case["name"], "prompt": built[case["id"]],
                "request": case["prompt"], "context": case["context"], "expected": case["expected"],
                "tier_uncertain": case["tier_uncertain"], "assertions": case["assertions"]}
        eval_dir.mkdir(parents=True, exist_ok=True)
        (eval_dir / "eval_metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
        for cfg in cfgs:
            (eval_dir / cfg["config"]).mkdir(exist_ok=True)
            (eval_dir / cfg["config"] / "eval_metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")

    jobs = [(case, cfg, rep) for case in cases for cfg in cfgs for rep in range(1, args.reps + 1)]
    mode = "DRY RUN" if args.dry_run else f"{args.model} via claude -p"
    print(f"iteration {iteration}: {len(cases)} cases x {len(cfgs)} configs x {args.reps} reps = "
          f"{len(jobs)} calls ({mode}), {args.jobs} at a time")

    records: list[dict] = []
    lock = threading.Lock()
    done = 0
    with tempfile.TemporaryDirectory(prefix="model-fit-eval-") as scratch:
        caller = Caller(args, Path(scratch))

        def work(job):
            case, cfg, rep = job
            try:
                return run_one(caller, case, cfg, rep, iter_dir, built[case["id"]])
            except AuthError as e:
                return {"auth_error": str(e), **skipped_record(case, cfg, rep, "auth")}

        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = [pool.submit(work, j) for j in jobs]
            for fut in as_completed(futures):
                rec = fut.result()
                with lock:
                    records.append(rec)
                    done += 1
                    if done % 10 == 0 or done == len(jobs):
                        bad = sum(1 for r in records if r["failure"])
                        print(f"  {done}/{len(jobs)} done ({bad} failed)", flush=True)

        if caller.auth_failed.is_set():
            msg = next((r["auth_error"] for r in records if r.get("auth_error") and r["auth_error"] != "skipped after an earlier authentication failure"), "")
            print("\nThe claude CLI is not logged in (or its credentials were rejected).\n"
                  f"  {msg}\n"
                  "Log in by running `claude` and typing /login, then re-run with --overwrite. "
                  "--dry-run needs no login.", file=sys.stderr)
            return 2

    records.sort(key=lambda r: (r["eval_id"], r["config"], r["rep"]))

    # per-eval timing.json (the per-run ones are written by run_one)
    for case in cases:
        timing = {}
        for cfg in cfgs:
            rs = [r for r in records if r["eval_id"] == case["id"] and r["config"] == cfg["config"]]
            timing[cfg["config"]] = {
                "runs": len(rs), "total_tokens": sum(r["tokens"] for r in rs),
                "duration_ms": sum(r["duration_ms"] for r in rs),
                "total_duration_seconds": round(sum(r["duration_ms"] for r in rs) / 1000, 3)}
        (iter_dir / f"eval-{case['id']}-{case['name']}" / "timing.json").write_text(json.dumps(timing, indent=2) + "\n")

    summary, md = build_summary(cases, cfgs, records, args, iteration)
    (iter_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    (iter_dir / "summary.md").write_text(md)
    print(f"wrote {iter_dir / 'summary.md'}")

    if not args.skip_viewer:
        run_tools(args, iter_dir, iteration, cases)

    for cfg in cfgs:
        s = summary["configs"][cfg["config"]]
        print(f"  {cfg['config']:<10} pass {s['expectation_pass_rate'] if s['expectation_pass_rate'] is None else round(100 * s['expectation_pass_rate'], 1)}%"
              f"  tier {s['tier_accuracy'] if s['tier_accuracy'] is None else round(100 * s['tier_accuracy'], 1)}%"
              f"  consistency {s['consistency'] if s['consistency'] is None else round(100 * s['consistency'], 1)}%"
              f"  cost ${s['total_cost_usd']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
