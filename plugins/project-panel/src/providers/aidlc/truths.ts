// Two truths for one intent (M3), the pure half: the state file in the working tree against the state file on
// the default branch, and the pull requests in between. No I/O here (./two.ts reads, ./prs.ts asks the forge);
// everything below is a function of its arguments, so each rule is unit-tested on plain data.
//
// Per stage, with L the marker in this working tree and M the marker on the default branch (pending when the
// row is not there):
//   M completed (or a merged PR maps the stage)   merged: ✓, whatever the branch says; but reopened ↺ (not done)
//                                                  when an open PR or this session's branch carries it again, or an
//                                                  open PR touches its folder, and every merged stage after the
//                                                  earliest reopened one is stale
//   an open PR maps the stage (its branch name)    in-pr:  ◐, never done
//   L is ahead of M, or L is [R]evising, no open PR local: ◌, never done; but a stage on a PUSHED session branch
//                                                  is in-pr "not merged" when the PRs could not be read,
//                                                  local "pushed, no PR" when they could and there is none
//   current / in progress here, no files yet       "up next": planned, no landing (nothing started)
//   otherwise                                      the default branch's own status, no landing
// Only merged counts as done; the section rings and the plan's percent read the derived statuses.
import { t } from '../../strings/en'
import type { Chip, Gate, ItemStatus, Landing } from '../../../types'
import type { ForgeKind } from '../../forge'
import type { ReviewState } from '../../../types'
import { reviewStateOf } from '../review/facts'
import { NO_VIEWER, reviewRows, reviewWord, slackChips } from '../review/view'
import type { ReviewCtx } from '../review/view'
import type { StagePr } from './prs'
import { matchStageBranch } from './select'
import type { ParsedState, StageMarker } from './types'

/** upstream's checkbox, as the panel's own status; a skipped row is out of scope whatever its box says. */
export function statusOfMarker(marker: StageMarker, isExecuted: boolean): ItemStatus {
  if (!isExecuted || marker === 'skipped') return 'skipped'
  switch (marker) {
    case 'completed':
      return 'done'
    case 'in-progress':
      return 'open'
    case 'awaiting-approval':
      return 'awaiting'
    case 'revising':
      return 'revising'
    default:
      return 'planned'
  }
}

/** How far a stage has got; "ahead" is a higher rank. */
export const RANK: Record<StageMarker, number> = {
  pending: 0,
  skipped: 0,
  'in-progress': 1,
  revising: 1,
  'awaiting-approval': 2,
  completed: 3,
}

// ── pull requests onto stages ────────────────────────────────────────────────

export type BranchOptions = {
  stageBranchPattern: string
  foldSeparator: string
  /**
   * The plan's phases by name in lower case (`inception`), each with its executed stages in plan order: a branch whose
   * last segment names one (`docs/inception`, `semka/construction`) carries all of them, one PR for the whole phase.
   */
  phases?: Readonly<Record<string, readonly string[]>>
}

/** A pull request and the stages its branch carries, in plan order (only slugs that are rows of the state). */
export type Mapped = {
  pr: StagePr
  stages: string[]
  /** The branch names a phase (`docs/inception`), not stages: it carries the phase, not a redo of what already landed. */
  isPhase?: boolean
}

/** The ticket of a stage branch, or null when the branch is not one. */
export function ticketOf(branch: string, o: BranchOptions): string | null {
  return matchStageBranch(branch, o.stageBranchPattern, o.foldSeparator)?.ticket ?? null
}

/**
 * The stages (of `order`) a branch carries, in plan order. A fold's stages are consecutive (the workflow runs them
 * in order), so the ones between the named ones are carried too.
 */
export function stagesOf(branch: string, order: readonly string[], o: BranchOptions): string[] {
  return carriedBy(branch, order, o).stages
}

/** The stages a branch carries, and whether it carries them as a phase branch (by the phase's name, not the stages'). */
export function carriedBy(branch: string, order: readonly string[], o: BranchOptions): { stages: string[]; isPhase: boolean } {
  const found = matchStageBranch(branch, o.stageBranchPattern, o.foldSeparator)
  const at = (found?.stages ?? []).map(slug => order.indexOf(slug)).filter(index => index >= 0)
  if (at.length > 0) return { stages: order.slice(Math.min(...at), Math.max(...at) + 1), isPhase: false }
  const phase = phaseStagesOf(branch, order, o)
  return { stages: phase, isPhase: phase.length > 0 }
}

/**
 * A phase branch's stages: a branch whose last `/` segment is a phase's name (`docs/inception`, `semka/Construction`)
 * carries every executed stage of it, in plan order; [] otherwise. Only the last segment: a branch that starts with a
 * phase (`inception/mvp-to-refined-mockups`) may be a part of it. Asked only when the branch names no stage.
 */
function phaseStagesOf(branch: string, order: readonly string[], o: BranchOptions): string[] {
  const last = branch.split('/').pop()?.toLowerCase() ?? ''
  const named = new Set(o.phases?.[last] ?? [])
  return order.filter(slug => named.has(slug))
}

/**
 * Which pull requests speak about the plan's stages. Closed ones never do. A session on a stage branch only
 * sees its own ticket's PRs (`ticket`); anywhere else every ticket counts. A merged PR from before the intent
 * started (`startMs`) belongs to an earlier life of the same branch names and is dropped.
 */
export function mapPrs(
  prs: readonly StagePr[],
  order: readonly string[],
  o: BranchOptions & { ticket: string | null; startMs: number | null },
): Mapped[] {
  const out: Mapped[] = []
  for (const pr of prs) {
    if (pr.state === 'CLOSED') continue
    if (pr.state === 'MERGED' && o.startMs !== null) {
      const at = pr.mergedAt === null ? Number.NaN : Date.parse(pr.mergedAt)
      if (!(at >= o.startMs)) continue
    }
    // A branch the stage pattern reads names its ticket, and on a stage branch only the session's ticket counts; a
    // phase branch (docs/inception) names none, so no ticket rules it out.
    const found = matchStageBranch(pr.headRefName, o.stageBranchPattern, o.foldSeparator)
    if (found && o.ticket !== null && found.ticket !== o.ticket) continue
    const { stages, isPhase } = carriedBy(pr.headRefName, order, o)
    if (stages.length > 0) out.push(isPhase ? { pr, stages, isPhase } : { pr, stages })
  }
  return out
}

// ── derivation ───────────────────────────────────────────────────────────────

/**
 * The copy key for a forge's own noun: the text is written for pull requests, and GitLab's merge-request wording
 * sits under `<key>.gitlab`.
 */
export function wording(key: string, kind: ForgeKind): string {
  return kind === 'gitlab' ? `${key}.gitlab` : key
}

/** Everything the two reads and the forge said, ready to derive from. */
export type Two = {
  /** The forge's own spelling of a change's number ("#33", "!275"); never spelled in the copy. */
  refOf: (number: number) => string
  /** Which forge the changes are on: it picks the noun in the copy (see `wording`). */
  forgeKind: ForgeKind
  /** The default branch's name. */
  base: string
  /** The default branch's copy of the state file; null when the intent is not on it yet. */
  main: ParsedState | null
  /** Open and merged PRs on this plan's stages (see `mapPrs`). */
  mapped: Mapped[]
  /** The changed paths of the newest open PRs, by number (for reopens). */
  files: ReadonlyMap<number, string[]>
  /** Where the intent's directory sits in the repository: `aidlc/spaces/default/intents/<dir>/`, or ''. */
  prefix: string
  /** The branch this session is on ('' when detached). */
  sessionBranch: string
  /** The stages that branch carries, in plan order. */
  sessionStages: string[]
  /** Commits on the default branch the session's branch lacks; 0 when not asked or none. */
  behind: number
  /** false when the PR list could not be read (gh failed): the PRs are unknown, not absent. */
  isPrsKnown: boolean
  /** The session's branch exists on origin (`refs/remotes/origin/<branch>`); only asked where it matters. */
  isPushed: boolean
  /** The stage the session is on (the shown step); '' when none. */
  current: string
  /** Candidates for "up next" whose artifact folder holds no files in the working tree (see ./two.ts). */
  quiet: ReadonlySet<string>
  /** Every open PR of the repository, mapped onto the plan or not: the rows tied to the viewer look at all of them. */
  open?: StagePr[]
  /** Who is looking, whether the `pr-review` commands run here, the Slack domain; absent = nobody known. */
  review?: ReviewCtx
}

/** What the derivation decides about one item; `./load.ts` copies the fields onto the Item. */
export type ItemFacts = {
  status: ItemStatus
  chips: Chip[]
  landing?: Landing
  /** Checked off in this checkout's state, not landed on main (local only, pushed, or in an open PR): counts as done. */
  isFinishedLocal?: boolean
  statusWord?: string
  group?: string
  /** The open PR's review state (landing in-pr), when the status word says it. */
  review?: ReviewState
  /** The open PR the item is in (landing in-pr). */
  owner?: StagePr
}

/** An open PR that holds back what comes after it: where its gates hang and what it blocks. */
export type Hold = {
  pr: StagePr
  stages: string[]
  last: string
  /** The next executed stage that is not on the PR; '' when none. */
  next: string
  sectionId: string
  /** The PR's reference as its forge spells it, and which forge that is. */
  ref: string
  forgeKind: ForgeKind
}

export type Derived = {
  items: Map<string, ItemFacts>
  /** PR gates, newest PR first (pr-not-merged, ci-failing, changes-requested, behind-main, conflicts), then the session's. */
  gates: Gate[]
  holds: Hold[]
  /** Needs-attention rows tied to the viewer (../review/view.ts), the ones a PR gate does not already carry. */
  rows: Gate[]
}

type Row = { slug: string; phase: string; marker: StageMarker; isExecuted: boolean }

function rowsOf(state: ParsedState): Row[] {
  return state.phases.flatMap(phase =>
    phase.stages.map(s => ({ slug: s.slug, phase: phase.key, marker: s.marker, isExecuted: s.isExecuted })),
  )
}

/** The marker of `slug` on the default branch's copy; pending when the row is not there or out of scope. */
export function markerOn(main: ParsedState | null, slug: string): StageMarker {
  for (const phase of main?.phases ?? []) {
    for (const row of phase.stages) {
      if (row.slug === slug) return row.isExecuted && row.marker !== 'skipped' ? row.marker : 'pending'
    }
  }
  return 'pending'
}

const REOPEN_CAP = 5

/** The newest `REOPEN_CAP` open stage PRs: the ones whose changed files are worth asking for. */
export function reopenCandidates(mapped: readonly Mapped[]): StagePr[] {
  return mapped
    .filter(m => m.pr.state === 'OPEN')
    .map(m => m.pr)
    .sort((a, b) => b.number - a.number)
    .slice(0, REOPEN_CAP)
}

function chipOf(kind: Chip['kind'], label: string, tone: Chip['tone'], href: string): Chip[] {
  if (label === '') return []
  return [{ kind, label, tone, ...(href === '' ? {} : { href }) }]
}

function gateOf(g: Omit<Gate, 'caption' | 'href'> & { caption: string; href: string }): Gate {
  const { caption, href, ...rest } = g
  return { ...rest, ...(caption === '' ? {} : { caption }), ...(href === '' ? {} : { href }) }
}

/** The failing checks as a short list: three names, then an ellipsis. */
function checksText(names: readonly string[]): string {
  return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')
}

/** Reads `local` (this working tree) against `two` and decides each stage's landing, chips and group, and the PR gates. */
export function derive(local: ParsedState, two: Two): Derived {
  const { refOf, forgeKind: kind } = two
  const viewing = two.review ?? NO_VIEWER
  const rows = rowsOf(local)
  const phaseOf = new Map(rows.map(r => [r.slug, r.phase]))
  const order = rows.filter(r => r.isExecuted && r.marker !== 'skipped').map(r => r.slug)
  const mainRows = new Map((two.main === null ? [] : rowsOf(two.main)).map(r => [r.slug, r]))
  const mainMarker = (slug: string): StageMarker => {
    const row = mainRows.get(slug)
    return row && row.isExecuted && row.marker !== 'skipped' ? row.marker : 'pending'
  }

  const open = two.mapped.filter(m => m.pr.state === 'OPEN').sort((a, b) => b.pr.number - a.pr.number)
  const merged = two.mapped
    .filter(m => m.pr.state === 'MERGED')
    .sort((a, b) => Date.parse(b.pr.mergedAt ?? '') - Date.parse(a.pr.mergedAt ?? '') || b.pr.number - a.pr.number)
  // A merged PR that carries a stage landed it, even when the local `origin/<base>` is behind and still shows the
  // old box. A stage main is revising is the one exception: that is later work than the merge.
  const hasMerged = new Set(merged.flatMap(m => m.stages))
  const effective = (slug: string): StageMarker => {
    const m = mainMarker(slug)
    return m !== 'completed' && m !== 'revising' && hasMerged.has(slug) ? 'completed' : m
  }
  // An open PR owns the stages its branch carries. A phase PR (docs/inception) carries its phase, not a redo of the
  // stages of it already on main: those stay merged (its changed files can still reopen one, below).
  const ownerOf = new Map<string, Mapped>()
  for (const m of open) {
    for (const slug of m.stages) {
      if (m.isPhase === true && effective(slug) === 'completed') continue
      if (!ownerOf.has(slug)) ownerOf.set(slug, m)
    }
  }
  // A PR's own chips sit on the first stage of its group that is not merged on main.
  const chipAt = new Map<number, string>()
  for (const m of open) {
    const slug = m.stages.find(s => ownerOf.get(s) === m && effective(s) !== 'completed')
    if (slug !== undefined) chipAt.set(m.pr.number, slug)
  }

  // Reopens: an open PR that touches the directory of a stage planned before its own.
  const reopened = new Map<string, StagePr>()
  for (const m of open.slice(0, REOPEN_CAP)) {
    const changed = two.files.get(m.pr.number) ?? []
    const first = m.isPhase === true ? m.stages.find(slug => ownerOf.get(slug) === m) : m.stages[0]
    if (changed.length === 0 || first === undefined) continue
    for (const slug of order.slice(0, order.indexOf(first))) {
      const dir = `${two.prefix}${(phaseOf.get(slug) ?? '').toLowerCase()}/${slug}/`
      if (!reopened.has(slug) && changed.some(path => path.startsWith(dir))) reopened.set(slug, m.pr)
    }
  }
  // Reopens on this session's own branch, before any PR: it carries a stage already merged (a backward jump folded
  // it in). Not when the branch is the merged PR's own (a stale checkout of it); without the PR list, only when the
  // box here went back below completed.
  const isMergedHead = merged.some(x => x.pr.headRefName === two.sessionBranch)
  const localMarker = new Map(rows.map(r => [r.slug, r.marker]))
  const reopenedHere = new Set(
    isMergedHead
      ? []
      : two.sessionStages.filter(
          slug => effective(slug) === 'completed' && !ownerOf.has(slug) && (two.isPrsKnown || localMarker.get(slug) !== 'completed'),
        ),
  )

  const items = new Map<string, ItemFacts>()
  for (const row of rows) {
    if (!row.isExecuted || row.marker === 'skipped') {
      items.set(row.slug, { status: 'skipped', chips: [] })
      continue
    }
    const m = effective(row.slug)
    const owner = ownerOf.get(row.slug)
    const latest = merged.find(x => x.stages.includes(row.slug))?.pr
    const mergedChip = latest ? chipOf('pr', t('aidlc.chip.pr', { ref: refOf(latest.number) }), 'success', latest.url) : []
    // [R]evising over any other box on main is work done here, whatever main says; a LOWER box here over main's
    // completed is a stale branch, and main wins.
    const isRevising = row.marker === 'revising' && m !== 'revising'

    if (m === 'completed' && !isRevising) {
      const again = owner?.pr ?? reopened.get(row.slug)
      // Reopened: merged once, being redone now. It is not done until the new work lands.
      items.set(
        row.slug,
        again || reopenedHere.has(row.slug)
          ? {
              status: 'reopened',
              chips: [...mergedChip, ...(again ? chipOf('reopen', t('aidlc.chip.reopened', { ref: refOf(again.number) }), 'warning', again.url) : [])],
            }
          : { status: 'done', landing: 'merged', chips: mergedChip },
      )
    } else if (!owner && two.quiet.has(row.slug)) {
      // Nothing written yet for the stage the session is on: it is next in line, not work in progress.
      items.set(row.slug, { status: 'planned', statusWord: t('aidlc.word.upNext'), chips: [] })
    } else if (owner) {
      const pr = owner.pr
      const ref = refOf(pr.number)
      // The review state is the status word ("changes requested", "approved"); where the review commands are not
      // in use and nobody was asked, the word stays "in review".
      const review = reviewStateOf(pr)
      const said = reviewWord(pr, review, viewing)
      const own: Chip[] =
        chipAt.get(pr.number) === row.slug
          ? [
              ...(pr.isDraft
                ? chipOf('pr', t('aidlc.chip.prDraft', { ref }), 'neutral', pr.url)
                : chipOf('pr', t('aidlc.chip.pr', { ref }), 'accent', pr.url)),
              ...(pr.failingChecks.length > 0 ? chipOf('tag', t('aidlc.chip.ciFailing'), 'error', '') : []),
              ...slackChips(pr, viewing),
            ]
          : []
      items.set(row.slug, {
        status: row.marker === 'awaiting-approval' ? 'awaiting' : row.marker === 'revising' ? 'revising' : 'open',
        landing: 'in-pr',
        // Checked off in this checkout: done by the local state, though its PR has not landed yet.
        ...(row.marker === 'completed' ? { isFinishedLocal: true } : {}),
        statusWord: said !== '' ? said : t(pr.isDraft ? 'aidlc.word.inDraftPr' : 'aidlc.word.inPr'),
        ...(said !== '' ? { review } : {}),
        chips: [...(m === 'completed' ? mergedChip : []), ...own],
        owner: pr,
        ...(owner.stages.length >= 2 ? { group: `pr-${pr.number}` } : {}),
      })
    } else if (isRevising || RANK[row.marker] > RANK[m]) {
      const status = statusOfMarker(row.marker, true)
      // Pushed work is not "local only": without the PR list it is in review as far as anyone can tell, with it
      // there is simply no PR yet.
      const isPushed = two.isPushed && two.sessionStages.includes(row.slug)
      const landing: Landing = isPushed && !two.isPrsKnown ? 'in-pr' : 'local'
      const word = !isPushed ? 'aidlc.word.local' : two.isPrsKnown ? wording('aidlc.word.noPr', kind) : 'aidlc.word.unmerged'
      items.set(row.slug, {
        status: status === 'done' ? 'open' : status,
        landing,
        // Checked off in this checkout: done by the local state, landed or not (local only, or pushed with no PR).
        ...(status === 'done' ? { isFinishedLocal: true } : {}),
        statusWord: t(word),
        chips: m === 'completed' ? mergedChip : [],
      })
    } else {
      items.set(row.slug, { status: statusOfMarker(m, true), chips: [] })
    }
  }

  // Stale: a stage merged after the earliest reopened one was built on what is being redone. Work in progress, in
  // review or not started keeps its own status.
  const firstReopened = order.findIndex(slug => items.get(slug)?.status === 'reopened')
  if (firstReopened >= 0) {
    for (const slug of order.slice(firstReopened + 1)) {
      const facts = items.get(slug)
      if (facts?.status === 'done') items.set(slug, { status: 'stale', chips: facts.chips })
    }
  }

  // Gates. One block per open PR that still holds something back, newest first.
  const gates: Gate[] = []
  const holds: Hold[] = []
  for (const m of open) {
    const last = m.stages[m.stages.length - 1]
    if (last === undefined || m.stages.every(slug => effective(slug) === 'completed')) continue
    const pr = m.pr
    const ref = refOf(pr.number)
    const sectionId = phaseOf.get(last) ?? ''
    const next = order.slice(order.indexOf(last) + 1).find(slug => !m.stages.includes(slug)) ?? ''
    holds.push({ pr, stages: m.stages, last, next, sectionId, ref, forgeKind: kind })
    const at = { sectionId, afterItemId: last, href: pr.url }
    gates.push(
      gateOf({
        id: `pr:${pr.number}`,
        kind: 'pr-not-merged',
        tone: 'warning',
        title: t(wording('aidlc.gate.pr-not-merged.title', kind), { ref }),
        caption: t('aidlc.gate.pr-not-merged.caption', { next, base: two.base }),
        ...at,
      }),
    )
    if (pr.failingChecks.length > 0) {
      gates.push(
        gateOf({
          id: `ci:${pr.number}`,
          kind: 'ci-failing',
          tone: 'error',
          title: t(wording('aidlc.gate.ci-failing.title', kind), { ref }),
          caption: t('aidlc.gate.ci-failing.caption', { checks: checksText(pr.failingChecks) }),
          ...at,
        }),
      )
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED' || reviewStateOf(pr) === 'changes') {
      gates.push(
        gateOf({
          id: `review:${pr.number}`,
          kind: 'changes-requested',
          tone: 'warning',
          title: t(wording('aidlc.gate.changes-requested.title', kind), { ref }),
          caption: t('aidlc.gate.changes-requested.caption'),
          ...at,
        }),
      )
    }
    if (pr.mergeStateStatus === 'BEHIND') {
      gates.push(
        gateOf({
          id: `behind:${pr.number}`,
          kind: 'behind-main',
          tone: 'warning',
          title: t('aidlc.gate.behind-main.title', { branch: pr.headRefName, base: two.base }),
          caption: t(wording('aidlc.gate.behind-main.captionPr', kind), { ref, base: two.base }),
          ...at,
        }),
      )
    }
    if (pr.mergeStateStatus === 'DIRTY') {
      gates.push(
        gateOf({
          id: `conflicts:${pr.number}`,
          kind: 'conflicts',
          tone: 'error',
          title: t(wording('aidlc.gate.conflicts.title', kind), { ref, base: two.base }),
          caption: t('aidlc.gate.conflicts.caption'),
          ...at,
        }),
      )
    }
  }

  // The session's own branch, when no open PR speaks for it and the default branch has moved on.
  // Only stages not yet on the default branch can be behind it: a merged stage has nothing left to land.
  const unmerged = two.sessionStages.filter(slug => effective(slug) !== 'completed' || reopenedHere.has(slug))
  const lastOfSession = unmerged[unmerged.length - 1]
  const isPrBehind = open.some(m => m.pr.headRefName === two.sessionBranch && m.pr.mergeStateStatus === 'BEHIND')
  if (two.behind > 0 && lastOfSession !== undefined && !isPrBehind) {
    gates.push(
      gateOf({
        id: 'behind:session',
        kind: 'behind-main',
        tone: 'warning',
        title: t('aidlc.gate.behind-main.title', { branch: two.sessionBranch, base: two.base }),
        caption: t('aidlc.gate.behind-main.caption', { count: String(two.behind), base: two.base }),
        sectionId: phaseOf.get(lastOfSession) ?? '',
        afterItemId: lastOfSession,
        href: '',
      }),
    )
  }
  // The rows tied to the viewer, over every open PR. One about a plan PR sits on its last stage; "changes
  // requested on your PR" is the PR's own changes-requested gate, which then says "your" and carries the command.
  const lastOf = new Map(two.mapped.filter(m => m.pr.state === 'OPEN').map(m => [m.pr.number, m.stages[m.stages.length - 1] ?? ''] as const))
  const viewerRows: Gate[] = []
  for (const row of reviewRows(two.open ?? [], viewing, pr => {
    const last = lastOf.get(pr.number) ?? ''
    return last === '' ? { sectionId: '' } : { sectionId: phaseOf.get(last) ?? '', afterItemId: last }
  })) {
    const number = row.id.slice(row.id.lastIndexOf(':') + 1)
    const gate = row.kind === 'changes-requested' ? gates.find(one => one.id === `review:${number}`) : undefined
    if (gate === undefined) {
      viewerRows.push(row)
      continue
    }
    gate.title = row.title
    if (row.command !== undefined) gate.command = row.command
  }
  return { items, gates, holds, rows: viewerRows }
}

/**
 * Where the default branch stands, when this session is ahead of it ("main: refined-mockups in PR #33"):
 * main's own Current Stage with the landing derived for it. '' when main is no different from the session
 * (same Current Stage and the current item is not local or in a PR), and always the "not on main yet" line
 * when the intent is absent there.
 */
export function baseLine(local: ParsedState, two: Two, derived: Derived, currentSlug: string): string {
  if (two.main === null) return t('aidlc.base.absent', { base: two.base })
  const stage = two.main.fields['Current Stage'] ?? ''
  const landing = derived.items.get(currentSlug)?.landing
  if (stage === '' || (stage === (local.fields['Current Stage'] ?? '') && landing !== 'local' && landing !== 'in-pr')) return ''

  const facts = derived.items.get(stage)
  if (facts?.landing === 'in-pr') {
    if (!facts.owner) return t('aidlc.base.unmerged', { base: two.base, stage })
    const ref = two.refOf(facts.owner.number)
    // Where the change's review stands, when the item's word says it ("approved", "awaiting dev-b").
    const review = facts.review !== undefined ? (facts.statusWord ?? '') : ''
    return (
      (review !== '' ? t(wording('aidlc.base.inPrReview', two.forgeKind), { base: two.base, stage, review, ref }) : '') ||
      t(wording('aidlc.base.inPr', two.forgeKind), { base: two.base, stage, ref })
    )
  }
  if (facts?.landing === 'merged') return t('aidlc.base.merged', { base: two.base, stage })
  if ((two.main.fields['Parked'] ?? '') !== '') {
    return t('aidlc.base.parked', { base: two.base, stage: two.main.fields['Parked At Stage'] || stage })
  }
  const marker = two.main.phases.flatMap(p => p.stages).find(s => s.slug === stage)?.marker
  return t(marker === 'in-progress' ? 'aidlc.base.running' : 'aidlc.base.notStarted', { base: two.base, stage })
}
