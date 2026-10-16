// The single source of every user-facing string the panel draws.
//
// A mod may import only code files (.ts/.tsx/...), so the table is a module, not
// en.json (`import x from './en.json'` is refused by the engine). Keys are
// stable; a missing key resolves to '' and the renderer hides the element
// rather than substituting text (see `t` below). Placeholders are `{name}`.
//
// Generic chrome (pane, command, header, ring, section, item) is drawn by the
// renderer and the entry point. Keys under `forge.` are the forge layer's causes
// (src/forge/problem.ts). Keys under `aidlc.` and `ledger.` belong to the
// AI-DLC and ledger providers, which resolve them through `t()` while building their
// PanelModel; the model then carries display text, and '' means "hide".

export const en = {
  // ── chrome ────────────────────────────────────────────────────────────────
  'pane.title': 'Project',
  'pane.empty': 'No plan found for this session yet.',
  'pane.version': 'project-panel {version}',

  'command.description': 'Open the project panel: sections, items and what blocks the next one',
  'command.opened': 'Project panel opened.',
  'command.notPlaced': 'Project panel is open but not shown yet: widen the window or press ctrl+x tab.',
  'command.noPlan': 'No plan found above {root}.',
  'command.readFailed': 'Could not read the plan; the panel keeps what it had.',
  'command.disabled': 'The project panel is turned off (the panel option is set to off).',
  'command.openFailed': 'Could not open the project panel.',

  'reopen.hint': 'Project panel is closed.',
  'reopen.button': 'Open panel',

  'header.refresh': 'Refresh',
  'header.checked': 'checked {ago}',
  'ago.now': 'just now',
  'ago.seconds': '{n}s ago',
  'ago.minutes': '{n}m ago',
  'ago.hours': '{n}h ago',
  'header.readAt': 'read {time}',
  'header.badge.sideJob': 'Side job',
  'header.badge.idle': 'Idle',

  'now.label': 'Now',
  'now.where': '{section}, {index} of {total}',
  'now.nextUp': 'Next up',
  'now.sideJob.label': 'This session',
  'now.sideJob.headline': 'Side job, not a stage of this plan',
  'now.idle.label': 'Workspace',
  'now.idle.headline': 'Nothing in flight',
  'now.landing.local': 'local only, this worktree',

  'next.label': 'Next',
  'next.fill': 'Put in prompt',

  'attention.title': 'Needs attention ({count})',
  'attention.heading': 'Needs attention',
  'attention.whereAfter': '{section}, after {item}',
  'attention.whereOn': '{section}, {item}',

  'plan.title': 'Plan',
  'plan.summary': '{percent}% done, {done} of {total}',
  'plan.foldedHint': 'folded, show',

  'ring.alt': '{percent}% done',
  'strip.alt': '{done} of {total} done',
  'icon.alt.done': 'done',
  'icon.alt.stale': 'stale',
  'icon.alt.live': 'in progress',
  'icon.alt.local': 'local only',
  'icon.alt.current': 'current',
  'icon.alt.planned': 'planned',
  'icon.alt.skipped': 'skipped',
  'icon.alt.failed': 'failed',
  'icon.alt.mark': 'needs a look',
  'stepper.alt': 'Phases: {phases}',
  'stepper.alt.done': '{title} done',
  'stepper.alt.skipped': '{title} skipped',
  'stepper.alt.empty': '{title} not included yet',
  'stepper.alt.current': '{title} {percent}% done, current',
  'stepper.alt.open': '{title} {percent}% done',

  'section.count': '{done}/{total}',
  'section.skipped': 'skipped',
  'section.notIncluded': 'not included yet',
  'section.proposedHeading': 'Proposed',
  'section.doneFold': '{count} done, show',
  'section.doneHide': 'Hide done',
  'section.moreItems': 'Show {count} more',
  'section.fewerItems': 'Show fewer',

  'item.status.open': 'in progress',
  'item.status.awaiting': 'awaiting',
  'item.status.revising': 'revising',
  'item.status.reopened': 'reopened',
  'item.status.stale': 'stale',
  'item.status.skipped': 'skipped',
  'item.status.failed': 'failed',
  'item.status.partial': 'partial',

  // ── AI-DLC provider ───────────────────────────────────────────────────────
  'aidlc.name': 'AI-DLC',

  'aidlc.phase.INITIALIZATION': 'Initialization',
  'aidlc.phase.IDEATION': 'Ideation',
  'aidlc.phase.INCEPTION': 'Inception',
  'aidlc.phase.CONSTRUCTION': 'Construction',
  'aidlc.phase.OPERATION': 'Operation',
  'aidlc.phase.perUnit': 'per unit: {units}',

  'aidlc.header.unit': 'unit {unit}',

  // Construction drawn as Units of work (providers/aidlc/units.ts, points.ts): the section's caption, a Unit's points
  // chip, its status word ({stage} a per-unit stage slug, {units} the Unit IDs it waits on), the plan heading when
  // Construction counts by points, and the rows about the points file ({file}; {units} the Unit IDs it repeats).
  'aidlc.units.caption': '{done} of {total} story points done, {count} units',
  'aidlc.chip.points': '{points} pt',
  'aidlc.chip.pointsDefault': '{points} pt, default',
  'aidlc.unit.atStage': '{stage}',
  'aidlc.unit.paused': 'paused',
  'aidlc.unit.pausedAt': 'paused at {stage}',
  'aidlc.unit.stageDone': '{stage} done',
  'aidlc.unit.waitsOn': 'waits on {units}',
  'aidlc.overall.points': '{percent}% done, Construction by story points, {done} of {total}',
  'aidlc.gate.pointsUncommitted.title': '{file} not committed',
  'aidlc.gate.pointsRepeated.title': '{file} lists a unit more than once',
  'aidlc.gate.pointsRepeated.caption': '{units}: the last row counts. Remove the rows that are out of date.',
  'aidlc.gate.pointsUncommitted.caption': 'It has story points not committed yet, possibly added from Jira. Commit it with this branch.',

  'aidlc.sideJob.caption':
    'This session is not bound to a stage of {intent}. Progress below is the intent the workspace points at.',

  // A side job folds the intent's plan under its own context, so "below" is not where the progress is.
  'aidlc.sideJob.captionFolded': 'This session is not bound to a stage of {intent}. The intent\'s progress is folded under Plan.',

  // What the panel knows about the side-job session itself ({ref} as the forge spells it; `.gitlab` says merge request).
  'aidlc.session.branch': 'on {branch}',
  'aidlc.session.aheadBehind': '{ahead} ahead, {behind} behind {base}',
  'aidlc.session.ahead': '{ahead} ahead of {base}',
  'aidlc.session.behind': '{behind} behind {base}',
  'aidlc.session.pr': 'PR {ref}, {state}',
  'aidlc.session.pr.gitlab': 'MR {ref}, {state}',
  'aidlc.session.pr.open': 'open',

  'aidlc.idle.noneInFlight': 'This workspace has no intent in flight. Start one with /aidlc.',
  'aidlc.idle.noCursor': 'This workspace has more than one live intent and none is selected. Pick one with /aidlc.',
  'aidlc.idle.archived': 'This session was bound to an intent that has since been archived, so it shows no workflow.',

  'aidlc.gate.parked.title': 'Parked at {stage}',
  'aidlc.gate.parked.titleNoStage': 'Parked',
  'aidlc.gate.parked.caption': 'The workflow was parked {since}. Resume it with /aidlc.',
  // In a side job the workflow is not this session's to resume: the same facts, no command.
  'aidlc.gate.parked.captionSideJob': 'The workflow was parked {since}.',
  'aidlc.gate.awaiting-approval.title': '{stage} awaits your approval',
  'aidlc.gate.awaiting-approval.caption': 'The gate is open: approve or request changes to move on.',

  // Two truths (M3): the working tree against the default branch on origin, and the PRs between.
  // {ref} is the forge's own reference text ("#33", "!275"), never spelled here; {base} the default branch. Keys that
  // name a pull request have a `.gitlab` twin that says merge request (see `wording` in providers/aidlc/truths.ts).
  'aidlc.word.inPr': 'in review',
  'aidlc.word.inDraftPr': 'in draft',
  'aidlc.word.local': 'local only',
  'aidlc.word.unmerged': 'not merged',
  'aidlc.word.noPr': 'pushed, no PR',
  'aidlc.word.noPr.gitlab': 'pushed, no MR',
  'aidlc.word.upNext': 'up next',

  'aidlc.chip.pr': '{ref}',
  'aidlc.chip.prDraft': '{ref} draft',
  'aidlc.chip.ciFailing': 'CI failing',
  'aidlc.chip.reopened': '↺ reopened in {ref}',

  'aidlc.base.inPr': '{base}: {stage} in review, PR {ref}',
  'aidlc.base.inPr.gitlab': '{base}: {stage} in review, MR {ref}',
  'aidlc.base.inPrReview': '{base}: {stage} {review}, PR {ref}',
  'aidlc.base.inPrReview.gitlab': '{base}: {stage} {review}, MR {ref}',
  'aidlc.base.unmerged': '{base}: {stage} not merged yet',
  'aidlc.base.merged': '{base}: {stage} merged',
  'aidlc.base.running': '{base}: {stage} in progress',
  'aidlc.base.parked': '{base}: parked at {stage}',
  'aidlc.base.notStarted': '{base}: {stage} not started',
  'aidlc.base.absent': 'This intent is not on {base} yet',

  'aidlc.gate.pr-not-merged.title': 'PR {ref} not merged',
  'aidlc.gate.pr-not-merged.title.gitlab': 'MR {ref} not merged',
  'aidlc.gate.pr-not-merged.caption': "{next} can't start on {base} until it lands.",
  'aidlc.gate.ci-failing.title': 'CI failing on PR {ref}',
  'aidlc.gate.ci-failing.title.gitlab': 'CI failing on MR {ref}',
  'aidlc.gate.ci-failing.caption': 'Failing: {checks}',
  'aidlc.gate.changes-requested.title': 'Changes requested on PR {ref}',
  'aidlc.gate.changes-requested.title.gitlab': 'Changes requested on MR {ref}',
  'aidlc.gate.changes-requested.caption': 'Address the review before it can merge.',
  'aidlc.gate.behind-main.title': '{branch} is behind {base}',
  'aidlc.gate.behind-main.caption': '{count} new commits on {base}; merge or rebase before it can land.',
  'aidlc.gate.behind-main.captionPr': 'PR {ref} is out of date with {base}; update the branch.',
  'aidlc.gate.behind-main.captionPr.gitlab': 'MR {ref} is out of date with {base}; update the branch.',
  'aidlc.gate.conflicts.title': 'PR {ref} has conflicts with {base}',
  'aidlc.gate.conflicts.title.gitlab': 'MR {ref} has conflicts with {base}',
  'aidlc.gate.conflicts.caption': 'Resolve them before it can merge.',
  'aidlc.gate.parked.captionPr': 'Waiting on PR {ref} to merge; parked {since}. Resume with /aidlc once it lands.',
  'aidlc.gate.parked.captionPr.gitlab': 'Waiting on MR {ref} to merge; parked {since}. Resume with /aidlc once it lands.',
  'aidlc.gate.parked.captionPrSideJob': 'Waiting on PR {ref} to merge; parked {since}.',
  'aidlc.gate.parked.captionPrSideJob.gitlab': 'Waiting on MR {ref} to merge; parked {since}.',

  // ── ledger provider ───────────────────────────────────────────────────────
  'ledger.subtitle': '{path} · {done}/{total} done',

  'ledger.caption.localOnly': 'Showing the local copy of the ledger: the default branch could not be read.',
  'ledger.caption.noChanges.github': 'Pull requests could not be read ({cause}), so progress comes from the ledger alone.',
  'ledger.caption.noChanges.gitlab': 'Merge requests could not be read ({cause}), so progress comes from the ledger alone.',
  'ledger.caption.noRemote': 'No origin remote, so progress comes from the ledger alone.',
  'ledger.caption.proposal': 'Proposed product sections below — pin them to group tasks by product.',
  'ledger.caption.aiFailed': 'Grouping by product is unavailable right now; showing the last result.',
  'ledger.caption.aiUnavailable': 'Product grouping needs a model reply; showing phases.',
  'ledger.caption.stale': 'Could not fetch; the ledger may be behind origin.',

  'ledger.section.unassigned': 'Unassigned',
  'ledger.section.tasks': 'Tasks',

  'ledger.chip.more': '+{count} more',
  'ledger.chip.revert': 'revert {ref}',

  'ledger.next.command': 'start {id} — {title}',
  'ledger.next.commandNoTitle': 'start {id}',
  'ledger.next.reasonDeps': 'depends on {deps}, all done',
  'ledger.next.reasonFree': 'no unfinished dependencies',

  'ledger.drift.declared-open-but-merged': '{id}: the ledger says not done, but {ref} merged',
  'ledger.drift.declared-done-but-open': '{id}: the ledger says done, but {ref} is still open',
  'ledger.drift.declared-done-no-pr-open-pr': '{id}: the ledger says done, but {ref} (a slice of it) is still open',
  'ledger.drift.qa-failed': '{id}: QA failed on {ref}',
  'ledger.drift.note': '{id}: {note}',

  'ledger.action.propose': 'Propose product sections',
  'ledger.action.pin': 'Pin sections',
  'ledger.action.rebuild': 'Propose again',

  // ── pull request review (both providers) ──────────────────────────────────
  // {ref} is the forge's own reference ("#33"), {number} the bare number a command takes, {who} the logins
  // asked to review (the viewer reads as review.who.you).
  'review.word.draft': 'in draft',
  'review.word.awaiting': 'awaiting {who}',
  'review.word.changes': 'changes requested',
  'review.word.commented': 'commented',
  'review.word.stale': 'approved, new commits',
  'review.word.approved': 'approved',
  'review.word.approvedComments': 'approved with comments',
  'review.word.unreviewed': 'no reviewer',
  'review.who.you': 'you',
  'review.who.separator': ', ',

  'review.chip.slack': 'Slack thread',

  'review.row.review-requested.title': 'Your review is requested on PR {ref}',
  'review.row.review-requested.caption': '{title} — by {author}',
  'review.row.changes-requested.title': 'Changes requested on your PR {ref}',
  'review.row.changes-requested.caption': 'Answer the review before it can merge.',
  'review.row.review-commented.title': 'Comments on your PR {ref}',
  'review.row.review-commented.caption': 'A review left comments without a verdict.',
  'review.row.approval-stale.title': 'PR {ref} changed since its approval',
  'review.row.approval-stale.caption': 'Merging needs an approval of the latest commit.',
  'review.row.approved-comments.title': 'PR {ref} approved with comments',
  'review.row.approved-comments.caption': 'Take what you want from the comments, then merge.',
  'review.row.approved.title': 'PR {ref} approved',
  'review.row.approved.caption': 'Ready to merge.',
  'review.row.draft-not-requested.title': 'Your draft PR {ref} is not sent for review',
  'review.row.draft-not-requested.caption': 'Sending it for review marks it ready.',
  'review.row.review-not-requested.title': 'PR {ref} is not sent for review',
  'review.row.review-not-requested.caption': 'Nobody is asked to review it yet.',

  // The pr-review plugin's commands, put in the prompt from a row or from Next.
  'review.command.review': '/pr-review:review-pr {number}',
  'review.command.address': '/pr-review:address-review {number}',
  'review.command.merge': '/pr-review:address-review {number}',
  'review.command.request': '/pr-review:request-review {number}',

  // ── refresh engine (M2) ───────────────────────────────────────────────────
  'refresh.failed': 'Could not re-read the plan; showing the last good read.',
  'refresh.remoteFailed': 'Could not check the remote; changes may be stale.',
  'refresh.remoteFailed.github': 'Could not check pull requests ({cause}); they may be stale.',
  'refresh.remoteFailed.gitlab': 'Could not check merge requests ({cause}); they may be stale.',

  // ── forge layer (src/forge/): why a gh / glab call did not work ───────────
  'forge.cause.missing': '{cli} missing',
  'forge.cause.notLoggedIn': '{cli} not logged in to {host}',
  'forge.cause.unreachable': 'could not reach {host}',
  'forge.cause.failed': '{cli} failed',
  'forge.cause.noRemote': 'no origin remote',
} as const

export type StringKey = keyof typeof en

/**
 * Resolves `key` with `{param}` placeholders filled. Unknown key → ''. A
 * placeholder whose param is missing or empty makes the whole string '' so a
 * half-filled sentence is never drawn.
 */
export function t(key: string, params: Record<string, string> = {}): string {
  const template = (en as Record<string, string>)[key] ?? ''
  let isComplete = true
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined || value === '') isComplete = false
    return value ?? ''
  })
  return isComplete ? out : ''
}
