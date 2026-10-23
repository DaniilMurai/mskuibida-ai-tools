# review-findings

When review findings reach you, you decide what happens to them before anything else does. The
agent shows a short summary of the open findings and asks one question: **Fix**, **Accept** (only
when nothing blocks) or **Open in form**. A hook keeps that order.

Two sources, nothing else in this version:

- **AI-DLC stage reviews.** The review brief the protocol prints at an approval gate
  (`aidlc engine review-brief review --stage …`). Open findings are the rows with status `New` or
  `Unresolved`; `Critical` and `Major` block.
  The brief must be printed unpiped and in full: a piped or redirected call is refused, and a
  cut-off output (table without the `> R-NN Finding:` lines) is not recorded as findings.
- **Code review.** `/code-review` reports its findings through the `ReportFindings` tool. Every
  finding is open; those marked `CONFIRMED` block.

```
skills/review-findings/SKILL.md   the procedure: the summary, the question, what each answer means, the board form
skills/release/SKILL.md           /review-findings:release
scripts/findings.py               parses a brief, a review-NN.md or a ReportFindings input; renders the summary and the board rows
hooks/findings_guard.py           the guard (PreToolUse, PostToolUse, UserPromptSubmit)
```

## What you see

A summary in chat, then the question:

```
**Review findings — Domain Design:** 3 open, 1 blocking
| ID | Severity | Where | Finding |
|---|---|---|---|
| R-02 | Major | domain-model.md > Cart aggregate | The `Cart` rule is ambiguous. |
...
3 review findings are open (1 blocking). What should I do with them?   Fix / Open in form
```

- **Fix.** At a stage gate the agent presents the gate as usual and says that Request Changes
  carries the findings. When you pick Request Changes, the reason names every open finding and its
  required action. In a code review the agent applies the fixes now.
- **Accept.** Offered only when no finding blocks. At a gate, Approve records the findings as
  accepted risks (the engine does that). In a code review they are listed as accepted.
- **Open in form.** The agent opens a board in your **AI-DLC question forms** artifact (the
  `question-forms` plugin): one card per finding, in the boxes Fix, Accept and Reject (reason
  required), each card starting where its severity says. You sort them and press Done; the agent
  shows one line per card and acts on it. Rejected cards go on the rejected report as
  `--reject-finding`.

## What the hook refuses

While findings are waiting for the first answer:

- any other question, the Approval gate included;
- `aidlc engine orchestrate report --result approved|rejected`;
- code review only: edits (a file outside the project is fine) and `git commit|push`.

And always:

- a triage question that offers Accept while a finding blocks, or leaves it out when none does;
- after Fix, a rejected report whose `--reason` misses an open finding id;
- after Open in form, the gate and the report until the form reads `status: "done"`;
- an agent writing `status: "done"` on a findings form (only your press on Done does that).

A refusal ends with how to release it. Type `/review-findings:release` to clear the guard for the
session. If python3 is missing, the hook refuses guarded calls only while a state file exists, and
says so.

State is in `~/.claude/review-findings/<session>.json` (`REVIEW_FINDINGS_DIR` moves it) next to
the findings file the agent renders from (`<session>.findings`). The hook changes it; the agent
does not.

## The data

`findings.py` turns every source into one findings document:

```json
{"source": "aidlc", "stage": "domain-design", "stage_name": "Domain Design", "artifact": "<path>",
 "findings": [{"id": "R-02", "severity": "Major", "where": "…", "finding": "…", "action": "…",
               "status": "New", "blocking": true, "title": "…"}]}
```

```
findings.py parse --brief FILE | --review FILE | --report FILE [--stage SLUG] [--unit U]
findings.py summary  --findings FILE
findings.py question --findings FILE
findings.py board    --findings FILE [--id ID] [--title T] [--project-dir D] --out DIR
```

`board` writes `forms.json`, `cards/<id>.json` and `writes.json` for one `ArtifactData` batch: the
form `forms/<id>` (`view: "board"`, three boxes) and a `forms/<id>/questions/<finding id>` card per
finding, in the contract of the `question-forms` template. The form id is
`<intent>-<stage>[-<unit>]-findings-<YYYYMMDDTHHMM>`, or `code-review-<YYYYMMDDTHHMM>`.

## Install

```bash
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install review-findings@mskuibida-tooling
```

## Pairs with

- `question-forms` for the board. Without it the Fix and Accept answers work as described; Open in
  form needs the artifact and the template from that plugin.
- `approval-gates`, which treats the same Approval question as the engine's gate. This plugin
  stands before it: the findings are answered first, the gate comes after.

## Tests

```bash
python3 -m unittest discover -s plugins/review-findings/tests
```

Standard library only; no network and no `aidlc` binary needed.
