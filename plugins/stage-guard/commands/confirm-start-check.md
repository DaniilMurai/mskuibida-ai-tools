---
description: Confirm an intent's start-check.md (developer's decision only; needs "startCheck": true in .stage-guard.json)
argument-hint: [<intent slug or record directory>]  (default: the active intent)
disable-model-invocation: true
---

The developer typed this command, confirming the current `start-check.md` of the intent in
`$ARGUMENTS` (the active intent when empty). The stage-guard plugin's UserPromptSubmit hook has
already answered it: find its `stage-guard:` line in this turn's context.

- If that line says `start check not confirmed`, tell the developer why in one sentence and stop.
  When the reason is that the start check is not enabled for this project, say that a project
  turns it on with `"startCheck": true` in `.stage-guard.json`.
- Otherwise the hook wrote `start-check-approval.json` next to `start-check.md`. Tell the developer
  both files are to be committed with the work, and that any later change to `start-check.md`
  (for example rerunning `start_check.py`) needs a new confirmation.
- Never write or edit `start-check-approval.json` yourself; the hook wrote it, and you only commit it.
- If there is no `stage-guard:` line at all, the plugin's prompt hook did not run: say so and stop.
