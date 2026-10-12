// Internal types for the ledger provider core. These are NOT the panel contract: the adapter that
// wires this core into the panel maps them onto it, so nothing here may import from the seam.
import type { ReviewFacts } from '../review/facts'

/** T-shirt size of a task, as the ledger writes it. */
export type Size = 'XS' | 'S' | 'M' | 'L' | 'XL'

/**
 * What the ledger text itself says about an item; null when it says nothing. `held` is not started and not to be
 * picked up now (blocked, deliberately not built, out of scope, dropped): it counts as planned, but is never "next".
 */
export type DeclaredStatus = 'done' | 'open' | 'planned' | 'held' | null

/** A merge request or pull request a table row cites as where the unit landed (`landed via !60`). */
export type Citation = { prefix: '!' | '#'; number: number }

/** One task of the ledger, normalised from a table row, a heading or a checkbox. */
export type LedgerItem = {
  /** As written: 'T01a', 'T-HF02', 'chore-finish-the-rename', or synthetic for un-id'd checkboxes. */
  id: string
  /** False for synthetic ids (checkbox items without an id): they are never matched to PRs. */
  hasRealId: boolean
  /** First clause of the task cell / heading / checkbox text, markdown stripped. */
  title: string
  /** Ids only; prose dependencies are dropped. */
  deps: string[]
  size: Size | null
  /** Nearest preceding `## ` heading text, '' when none. */
  phase: string
  /** 1-based line in the ledger, so the panel can open the ledger at the item. */
  line: number
  declared: DeclaredStatus
  /** `landed via !N` style citations of a table row, in order of appearance; [] for headings and checkboxes. */
  citations: Citation[]
}

/** The subset of `gh pr list --json ...` the matcher needs. */
export type Pr = {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headRefName: string
  labels: { name: string }[]
  mergedAt: string | null
  /** Web address of the PR, when the source carries it (`gh pr list --json url`). */
  url?: string
  isDraft?: boolean
  /** The head commit (open PRs): an approval given on another one is stale. */
  headRefOid?: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or '' (`reviewDecision`). */
  reviewDecision?: string
  /** Author, review requests, latest reviews and the Slack thread; open PRs only. */
  review?: ReviewFacts
}

/** Result of parsing one ledger. */
export type ParsedLedger = {
  title: string
  items: LedgerItem[]
  /** Phases in order of appearance, only those holding at least one item. */
  phases: string[]
  /** How many items came from checkboxes (discovery needs it to tell a ledger from a todo list). */
  checkboxCount: number
}

/** Effective status of an item once PR evidence and the ledger's own words are combined. */
export type ItemStatus = 'done' | 'partial' | 'open' | 'failed' | 'planned' | 'skipped'

/** Where an item's status came from; the AI layer may judge only 'declared' and 'none'. */
export type MatchSource = 'pr' | 'slices' | 'declared' | 'none'

/** A PR attributed to a parent item through a sub-slice id such as T06a under T06. */
export type SliceHit = { sliceId: string; pr: Pr }

/** Everything the matcher knows about one item. */
export type ItemMatch = {
  status: ItemStatus
  /** PRs of the best tier present: the ones the status is derived from. */
  prs: Pr[]
  /** Lower-tier PRs (fixes, hotfixes, QA branches, loose mentions) kept as chips. */
  followups: Pr[]
  slices: SliceHit[]
  /** Reverts never count toward status; they stay visible as chips. */
  reverts: Pr[]
  source: MatchSource
}

/** One item as a section shows it: the ledger item, its match and the status used for the numbers. */
export type SectionEntry = {
  item: LedgerItem
  match: ItemMatch
  /** Effective status: the match's, unless the AI layer judged an item with no PR evidence. */
  status: ItemStatus
  /** Display title: the ledger's, unless the AI layer wrote a shorter one. */
  title: string
}

/** Roll-up status of a section. */
export type SectionStatus = 'active' | 'built' | 'partial' | 'planned'

/** A section of the ledger, one per phase. */
export type LedgerSection = {
  id: string
  phase: string
  items: SectionEntry[]
  /** Weighted completion, 0-100, rounded. */
  percent: number
  counts: { done: number; total: number }
  status: SectionStatus
}

/** The whole-ledger roll-up. */
export type Overall = {
  percent: number
  counts: Record<ItemStatus, number> & { total: number }
}

/** Structured drift: the adapter resolves each kind to copy later. */
export type DriftKind =
  | 'declared-open-but-merged'
  | 'declared-done-but-open'
  | 'declared-done-no-pr-open-pr'
  | 'qa-failed'

/** One drift finding: its kind, the item, and the PR that shows it when there is one. */
export type DriftFlag = { kind: DriftKind; itemId: string; pr?: number }

/** Why an item is next: the item and the ledger dependencies that are already done. */
export type NextPick = { itemId: string; deps: string[] }
