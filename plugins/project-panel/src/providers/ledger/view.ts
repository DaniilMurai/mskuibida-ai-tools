import { t } from '../../strings/en'
import type { Chip, Drift, Gate, Item, ItemStatus, Next, PanelModel, Section, Tone } from '../../../types'
import { reviewStateOf } from '../review/facts'
import { NO_VIEWER, reviewNext, reviewRows, reviewWord, slackChips } from '../review/view'
import type { ReviewCtx } from '../review/view'
import { applyAssignment } from './ai'
import type { AiDrift, AssignmentResult, PinnedSection } from './ai'
import { deterministicDrift } from './drift'
import { pickNext } from './next'
import { currentItemForBranch, defaultExpanded, headerMode, overallOfEntries, sectionsByPhase } from './progress'
import type { ItemMatch, LedgerItem, ParsedLedger, Pr, SectionEntry, SectionStatus } from './types'

// Builds the PanelModel of a ledger from the pure core's results. No I/O: the provider reads, this shapes.

const MAX_PRIMARY_CHIPS = 3
const MAX_SLICE_CHIPS = 2
const MAX_FOLLOWUP_CHIPS = 2

/** A section before it becomes the contract's: entries still carry their match. */
export type Shaped = {
  id: string
  title: string
  caption: string
  percent: number
  counts: { done: number; total: number }
  status: SectionStatus
  entries: SectionEntry[]
}

/** The sections of a view and which one opens by default. */
export type Shape = { sections: Shaped[]; expandedId: string | null }

/** Phase sections straight from the ledger (layer 1). */
export function phaseShape(items: LedgerItem[], matches: Map<string, ItemMatch>): Shape {
  const used = new Set<string>()
  const sections = sectionsByPhase(items, matches).map(s => {
    const base = s.id === '' ? 'tasks' : s.id
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    return {
      id,
      title: s.phase === '' ? t('ledger.section.tasks') : s.phase,
      caption: '',
      percent: s.percent,
      counts: s.counts,
      status: s.status,
      entries: s.items,
    }
  })
  return { sections, expandedId: openOne(sections) }
}

/** Product sections from a pinned set and an assignment (layer 2); the unassigned section is titled here. */
export function productShape(
  items: LedgerItem[],
  matches: Map<string, ItemMatch>,
  pinned: { sections: PinnedSection[] },
  assignment: AssignmentResult,
): Shape {
  const sections = applyAssignment({ items, matches }, pinned, assignment).map(s => ({
    id: s.id,
    title: s.title === '' ? t('ledger.section.unassigned') : s.title,
    caption: s.caption,
    percent: s.percent,
    counts: s.counts,
    status: s.status,
    entries: s.items,
  }))
  return { sections, expandedId: openOne(sections) }
}

/** The default-open section; a lone section is always open. */
function openOne(sections: Shaped[]): string | null {
  if (sections.length === 1) return (sections[0] as Shaped).id
  return defaultExpanded(sections.map(s => ({ id: s.id, percent: s.percent, status: s.status, items: s.entries })))
}

function tone(pr: Pr, isFailing: boolean): Tone {
  if (isFailing) return 'error'
  return pr.state === 'MERGED' ? 'success' : pr.state === 'OPEN' ? 'accent' : 'neutral'
}

/** How a change number is spelled: the forge's (`#33` on GitHub, `!275` on GitLab). */
export type RefOf = (n: number) => string

const hashRef: RefOf = n => `#${n}`

function prChip(pr: Pr, refOf: RefOf, isFailing = false): Chip {
  const chip: Chip = { kind: 'pr', label: refOf(pr.number), tone: tone(pr, isFailing) }
  if (pr.url) chip.href = pr.url
  return chip
}

/**
 * Chips of one item, best first: best-tier PRs (at most 3), then sub-slices (at most 2), then reverts and
 * follow-ups (at most 2), then one "+N more" tag for whatever was left out. One chip per PR number; a
 * follow-up does not count toward the item's status, so its chip is neutral whatever the PR's state.
 */
export function chipsOf(match: ItemMatch, refOf: RefOf = hashRef): Chip[] {
  const seen = new Set<number>()
  const fresh = (pr: Pr) => !seen.has(pr.number) && (seen.add(pr.number), true)
  const withHref = (chip: Chip, pr: Pr): Chip => (pr.url ? { ...chip, href: pr.url } : chip)

  const primary = match.prs.filter(fresh)
  const failing = match.status === 'failed' ? match.prs[0]?.number : undefined
  const slices = match.slices.filter(s => fresh(s.pr))
  const reverts = match.reverts.filter(fresh)
  const followups = match.followups.filter(fresh)

  const chips: Chip[] = [
    ...primary.slice(0, MAX_PRIMARY_CHIPS).map(pr => prChip(pr, refOf, pr.number === failing)),
    ...slices.slice(0, MAX_SLICE_CHIPS).map(s => withHref({ kind: 'tag', label: `${s.sliceId} ${refOf(s.pr.number)}`, tone: tone(s.pr, false) }, s.pr)),
    ...[
      ...reverts.map(pr => withHref({ kind: 'tag', label: t('ledger.chip.revert', { ref: refOf(pr.number) }), tone: 'warning' }, pr)),
      ...followups.map(pr => withHref({ kind: 'pr', label: refOf(pr.number), tone: 'neutral' }, pr)),
    ].slice(0, MAX_FOLLOWUP_CHIPS),
  ]
  const hidden =
    Math.max(0, primary.length - MAX_PRIMARY_CHIPS) +
    Math.max(0, slices.length - MAX_SLICE_CHIPS) +
    Math.max(0, reverts.length + followups.length - MAX_FOLLOWUP_CHIPS)
  if (hidden > 0) chips.push({ kind: 'tag', label: t('ledger.chip.more', { count: String(hidden) }), tone: 'neutral' })
  return chips
}

/** Where a line of a file can be read on a branch; '' without a repository address. The forge knows its own URL shape. */
export type FileUrl = (repoUrl: string, branch: string, path: string, line: number) => string

/**
 * The open PR an item in progress is in: its own (best tier) first, else an open sub-slice. On the session's
 * branch, the PR of that branch wins. undefined when the item is not in progress or has none.
 */
export function openPrOf(match: ItemMatch, status: string, branch = ''): Pr | undefined {
  if (status !== 'open') return undefined
  const open = [...match.prs, ...match.slices.map(s => s.pr)].filter(pr => pr.state === 'OPEN')
  return open.find(pr => branch !== '' && pr.headRefName === branch) ?? open[0]
}

/** GitHub's shape; the default for a view with no forge. */
const githubFileUrl: FileUrl = (repoUrl, branch, path, line) =>
  repoUrl === '' ? '' : `${repoUrl}/blob/${branch}/${encodeURI(path)}#L${line}`

function itemOf(entry: SectionEntry, currentId: string | null, link: (line: number) => string, refOf: RefOf, review: ReviewCtx): Item {
  const href = entry.match.prs[0]?.url || link(entry.item.line)
  const item: Item = {
    id: entry.item.id,
    title: entry.title || entry.item.id,
    status: entry.status as ItemStatus,
    isCurrent: entry.item.id === currentId,
    chips: chipsOf(entry.match, refOf),
  }
  if (href) item.href = href
  // An item in progress says where its PR's review stands ("awaiting dev-b", "approved"), and shows its Slack thread.
  const pr = openPrOf(entry.match, entry.status)
  if (pr) {
    const state = reviewStateOf(pr)
    const word = reviewWord(pr, state, review)
    if (word !== '') {
      item.statusWord = word
      item.review = state
    }
    item.chips.push(...slackChips(pr, review))
  }
  return item
}

/** Everything `modelOf` needs besides the shape: the repository, the ledger and the session. */
export type ViewInput = {
  root: string
  ledgerPath: string
  repoUrl: string
  defaultBranch: string
  branch: string
  now: number
  parsed: ParsedLedger
  matches: Map<string, ItemMatch>
  shape: Shape
  /** Candidate header captions, most important first; only the first non-empty one is shown. */
  captions: string[]
  proposed: PinnedSection[]
  actions: { id: string; label: string }[]
  aiDrift: AiDrift[]
  watch: string[]
  /** The forge's spelling of a change number and its file links; GitHub's when absent. */
  refOf?: RefOf
  fileUrl?: FileUrl
  /** Every PR gh listed (the rows tied to the viewer look at all the open ones); [] when gh failed. */
  prs?: Pr[]
  /** Who is looking, whether the `pr-review` commands run here, the Slack domain. */
  review?: ReviewCtx
}

/** The contract's model for one ledger. */
export function modelOf(input: ViewInput): PanelModel {
  const { parsed, matches, shape } = input
  const items = parsed.items
  const currentId = currentItemForBranch(input.branch, items)
  const refOf = input.refOf ?? hashRef
  const fileUrl = input.fileUrl ?? githubFileUrl
  const link = (line: number) => fileUrl(input.repoUrl, input.defaultBranch, input.ledgerPath, line)
  const review = input.review ?? NO_VIEWER

  const sections: Section[] = shape.sections.map(s => ({
    id: s.id,
    title: s.title,
    ...(s.caption === '' ? {} : { caption: s.caption }),
    percent: s.percent,
    counts: s.counts,
    status: s.status,
    isCollapsed: s.id !== shape.expandedId,
    items: s.entries.map(e => itemOf(e, currentId, link, refOf, review)),
  }))
  for (const p of input.proposed) {
    sections.push({
      id: `proposed:${p.id}`,
      title: p.title,
      ...(p.hint === '' ? {} : { caption: p.hint }),
      status: 'planned',
      isCollapsed: true,
      isProposed: true,
      items: [],
    })
  }

  const all = shape.sections.flatMap(s => s.entries)
  const overall = overallOfEntries(all)
  const mode = currentId !== null ? 'stage' : headerMode(matches) === 'idle' ? 'idle' : 'inferred'
  // The current item's PR first, when it asks something of the viewer; else the next task to start.
  const currentMatch = currentId === null ? undefined : matches.get(currentId)
  const currentPr = currentMatch ? openPrOf(currentMatch, currentMatch.status, input.branch) : undefined
  const next = (currentPr ? reviewNext(currentPr, review) : null) ?? nextOf(items, matches)
  const gates = rowsOf(shape, input.prs ?? [], review)

  const flags = deterministicDrift(items, matches)
  const drift: Drift[] = [
    ...flags.map(f => ({
      id: `${f.kind}:${f.itemId}`,
      label: t(`ledger.drift.${f.kind}`, { id: f.itemId, ref: f.pr === undefined ? '' : refOf(f.pr) }),
      tone: (f.kind === 'qa-failed' ? 'error' : 'warning') as Tone,
    })),
    ...input.aiDrift.map(d => ({
      id: `note:${d.itemId}`,
      label: t('ledger.drift.note', { id: d.itemId, note: d.note }),
      tone: 'warning' as Tone,
    })),
  ].filter(d => d.label !== '')

  return {
    version: 2,
    provider: 'ledger',
    root: input.root,
    header: {
      title: parsed.title,
      mode,
      subtitle: t('ledger.subtitle', {
        path: input.ledgerPath,
        done: String(overall.counts.done),
        total: String(overall.counts.total),
      }),
      badge: mode === 'idle' ? t('header.badge.idle') : '',
      caption: input.captions.find(c => c !== '') ?? '',
      updatedAt: '',
    },
    overall: { percent: overall.percent, counts: overall.counts },
    ...(next ? { next } : {}),
    ...(input.actions.length > 0 ? { actions: input.actions } : {}),
    sections,
    gates,
    drift,
    watch: input.watch,
    readAt: input.now,
  }
}

/** The Needs-attention rows tied to the viewer; one about a PR a task is in names that task's section and row. */
function rowsOf(shape: Shape, prs: Pr[], review: ReviewCtx): Gate[] {
  const places = new Map<number, { sectionId: string; afterItemId: string }>()
  for (const section of shape.sections) {
    for (const entry of section.entries) {
      for (const pr of [...entry.match.prs, ...entry.match.slices.map(s => s.pr)]) {
        if (!places.has(pr.number)) places.set(pr.number, { sectionId: section.id, afterItemId: entry.item.id })
      }
    }
  }
  return reviewRows(
    prs.filter(pr => pr.state === 'OPEN'),
    review,
    pr => places.get(pr.number) ?? { sectionId: '' },
  )
}

function nextOf(items: LedgerItem[], matches: Map<string, ItemMatch>): Next | undefined {
  const pick = pickNext(items, matches)
  if (!pick) return undefined
  const title = items.find(i => i.id === pick.itemId)?.title ?? ''
  const command =
    title === '' ? t('ledger.next.commandNoTitle', { id: pick.itemId }) : t('ledger.next.command', { id: pick.itemId, title })
  const reason = pick.deps.length > 0 ? t('ledger.next.reasonDeps', { deps: pick.deps.join(', ') }) : t('ledger.next.reasonFree')
  return { command, reason }
}
