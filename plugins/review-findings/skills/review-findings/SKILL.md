---
name: review-findings
description: Use whenever review findings reach the developer — the review brief printed at an AI-DLC approval gate (`aidlc engine review-brief review --stage …`) with open findings, or the result of a code review (`/code-review`, the ReportFindings tool). Show a compact summary of the open findings, ask one question first (Fix / Accept / Open in form), and act on the answer; Open in form sorts each finding in a board form in the developer's "AI-DLC question forms" artifact. A hook holds back everything else until the question is answered.
---

# Review findings

Findings are decisions, not a wall of text. When they reach the developer, the developer first
says what happens to them: fix them, accept them, or sort them one by one in a form. The
`findings_guard.py` hook records every step from what the harness reports and refuses what
comes out of order. This file is the procedure; the hook's refusals say which step is open.

`FINDINGS` below stands for `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/findings.py"`.

## 1. When it applies

- **AI-DLC stage review.** At the end of a stage with a reviewer, the protocol runs `aidlc engine
  review-brief review --stage <slug> …` and prints its output. Open findings are the table rows
  with Status `New` or `Unresolved`; `Critical` and `Major` block, `Minor` does not. Rows that are
  `Resolved`, `Accepted risk` or `Rejected: …` are closed and do not count. (Findings of
  adversarial mid-loop reviews never reach the brief; the engine's own loop fixes them, so there
  is nothing to ask.)
- **Code review.** `/code-review` reports through the `ReportFindings` tool. Every finding is open;
  those with verdict `CONFIRMED` block, `PLAUSIBLE` ones do not. An empty report asks nothing.

**Print the brief unpiped and in full, as the only command:** `aidlc engine review-brief review
--stage <slug> …` with no `| head`, `| tail`, `| grep` and no `>` redirect. The per-finding detail
(`> R-NN Finding:`, `Where:`, `Required action:`) comes after the table, so a cut-off output holds
rows with nothing to decide on. The hook refuses a piped or redirected brief before it runs. If a
cut-off output reaches it anyway, it records no findings, says the brief was cut off, and refuses
the questions, the gate and the approved/rejected reports until you run the same command again,
unpiped. `findings.py summary|question|board` refuse a findings file with an empty finding text
for the same reason.

When there are open findings, the hook's `review-findings:` message arrives right after the
brief or the report. It holds the summary block and the path of a saved findings file (the
`--findings` argument of the commands below).

## 2. The summary and the question

Print the summary block from the hook message in chat (or render it again with `FINDINGS summary
--findings <file>`):

```
**Review findings — Domain Design:** 2 open, 1 blocking
| ID | Severity | Where | Finding |
|---|---|---|---|
| R-02 | Major | domain-model.md > Cart aggregate | The `Cart` rule is ambiguous. |
```

Then ask one `AskUserQuestion` and nothing else before it (`FINDINGS question --findings <file>`
prints it as JSON): header `Findings`, question `"3 review findings are open (1 blocking). What
should I do with them?"` (`(none blocking)` when no finding blocks), and the options in this order:

- `Fix`: "Fix every open finding. At a stage gate this goes through Request Changes with the
  findings as the reason."
- `Accept`: "Accept all as known risks and go on." Offered **only when no finding is blocking**;
  the hook refuses the question otherwise, and refuses it when it is missing while nothing blocks.
- `Open in form`: "Sort each finding in a form: fix, accept or reject with a reason."

Until it is answered the hook refuses every other question (the Approval gate included), the
approved and rejected reports and, for a code review, edits and `git commit|push`.

## 3. What each answer means

**Fix**

- AI-DLC: go on with the gate as the protocol requires. The awaiting-approval report may already
  be done. Do **not** edit the reviewed documents before the gate; the engine's review-freeze
  refuses it. In the completion message say that Request Changes carries these findings. When the
  developer picks Request Changes, the `--reason` of the rejected report names **every** open
  finding id with its required action (`R-02: state the winning event; R-03: …`); the hook refuses
  the report when an id is missing. Then revise, re-review, re-present as the protocol says.
- Code review: apply the fixes now (the `--fix` flow), then say what changed, finding by finding.

**Accept**

- AI-DLC: go on with the gate. On Approve the engine records every open finding as `Accepted
  risk` by itself. Say in the completion message that they are carried as accepted.
- Code review: list the findings as accepted in chat and go on. No fix.

**Open in form**: section 4.

An answer typed under Other decides nothing: ask in chat what the developer wants, or ask the
question again.

## 4. Open in form

The form is a board of the `question-forms` plugin (its `SKILL.md` § 5 is the contract) in the
developer's **AI-DLC question forms** artifact. If the developer has no such artifact, follow
that skill's § 1 to publish it first.

1. Build the rows: `FINDINGS board --findings <file> --out <scratch dir>`. It prints the form id
   (`<intent>-<stage>[-<unit>]-findings-<YYYYMMDDTHHMM>`, or `code-review-<YYYYMMDDTHHMM>`) and
   the path of `writes.json`. The board is titled "Review findings · <stage name>" and has three
   boxes: **Fix** ("Fixed before approval"), **Accept** ("Carried as a known risk") and **Reject
   (reason required)** ("Not applicable; write why in the note"). Each finding is one card: the
   title is its first sentence, the details hold Where, Finding and Required action, and it starts
   in Fix when it blocks and in Accept when it does not.
2. Write the rows with **one** `ArtifactData` `batch` whose `writes` are the array in
   `writes.json`, as it is (new rows: no `if_version`).
3. Send the form check, as `question-forms` § 5b A says: `AskUserQuestion`, header `Form`, question
   `Look at the form and pick one from above: <artifact url>#<form id>`, options `Saved in the
   form` and `Something is wrong in the form`. Only `Saved in the form` goes on, and only once the
   form reads `status: "done"`: read it with `ArtifactData` `get` of `forms/<form id>`. If it is
   not done, say so and wait. If something is wrong in the form, fix the rows (the same batch sets
   the form's `status` back to `open`) and ask again. You never write `status: "done"`; the hook
   refuses it.
4. Read the answers back: `answers[qid].k[0]` is the card's box, `note` the developer's words.
   Show one line per card with its box and note ("Summary of your answers"), then:
   - **Fix** cards: as Fix above. The rejected report's `--reason` names these cards by id with
     their required action.
   - **Accept** cards: carried; on Approve the engine records them as accepted risks.
   - **Reject** cards: `--reject-finding "<review artifact path>#R-NN=<note>"` on the rejected
     report. That is only possible together with Request Changes. When nothing is to be fixed, a
     rejected finding is carried like an accepted one and its note is quoted in chat.
   - Code review: Fix cards are fixed now, Accept cards listed as accepted, Reject cards listed
     with their note.
5. The gate (and, for a code review, every edit and commit) waits until the form is done; the hook
   refuses with `Answer the form to continue: <link>`.

## 5. After the gate

The hook clears the findings when the engine's approved or rejected report for the stage runs, so
a revision's next brief starts a new round. If the same findings are printed again while the
question is already answered, the answer stands.

If the guard gets in the way, the developer types `/review-findings:release`.
