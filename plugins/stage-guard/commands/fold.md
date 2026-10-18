---
description: Fold consecutive AI-DLC stages into this branch's pull request (developer's decision only)
argument-hint: <stage> [<stage> …]  (slug or number: an earlier stage to reopen, or a later one to carry)
disable-model-invocation: true
---

The developer typed this command, approving a fold of $ARGUMENTS into the pull request of the
current branch. The stage-guard plugin's UserPromptSubmit hook has already answered it: find its
`stage-guard:` line in this turn's context.

- If that line says `fold not recorded`, tell the developer why in one sentence and stop.
- Otherwise follow its numbered steps in order. Run a backward jump as a Bash call of its own,
  never in the same command as `orchestrate next`, or stage-guard refuses the call. After a jump,
  record the reuse decision for the reopened stage with `--decision modify` and re-confirm its
  summary as the workflow asks; every stage of the fold gets its review and gate on the branch.
- Never rename on GitHub a branch that is the head of an open pull request: GitHub closes that
  pull request. When the branch has one, step 1 moves it by a new pull request that links the
  old one; delete the old remote branch only after the old pull request is closed. The new pull
  request has no approval yet: ask for a new review once its work is ready.
- Never write or edit `stage-folds.json` yourself; the hook wrote it, and you only commit it.
- If there is no `stage-guard:` line at all, the plugin's prompt hook did not run: say so and stop.
