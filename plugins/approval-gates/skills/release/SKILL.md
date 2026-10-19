---
name: release
description: Typed by the developer as `/approval-gates:release` to clear the approval-gates guard for this session. The hook has already cleared it when the prompt was submitted; this skill only tells the assistant so.
disable-model-invocation: true
---

# Release the approval-gates guard

The developer typed `/approval-gates:release`. The `gate_guard.py` hook deleted this session's
guard state when the prompt was submitted, so the Approval question and the approved or rejected
report are no longer held back for this session.

Say so in one line and go on with what the developer was doing. Do not publish a gate page, ask
anything, or touch the state file yourself. The next `aidlc engine orchestrate report
--result awaiting-approval` opens the guard again.
