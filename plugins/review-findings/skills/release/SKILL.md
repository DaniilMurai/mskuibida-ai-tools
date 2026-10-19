---
name: release
description: Typed by the developer as `/review-findings:release` to clear the review-findings guard for this session. The hook has already cleared it when the prompt was submitted; this skill only tells the assistant so.
disable-model-invocation: true
---

# Release the review-findings guard

The developer typed `/review-findings:release`. The `findings_guard.py` hook deleted this
session's state when the prompt was submitted, so the review findings that were waiting for a
decision no longer hold anything back: the Approval question, the approved or rejected report,
edits and commits are free again in this session.

Find the `review-findings:` line in this turn's context. If it says the state was cleared, say so
in one line and go on with what the developer was doing. If there is no such line, the plugin's
prompt hook did not run: say so and stop.

Do not ask the Findings question, open a form, or touch the state file yourself. The next review
brief with open findings, or the next `ReportFindings` call, starts the guard again.
