import { escapeRegExp, slug } from './text'
import { isRevertBranch, itemIdForBranch } from './match'
import type {
  ItemMatch,
  ItemStatus,
  LedgerItem,
  LedgerSection,
  Overall,
  SectionEntry,
  SectionStatus,
  Size,
} from './types'

// Turns items plus their PR matches into percentages, sections and the few facts the panel header needs.
// Percentages are weighted by size so one XL task outweighs a handful of XS chores.

/** Weight of a task by size; an unknown size counts as one S. */
export const WEIGHTS: Record<Size, number> = { XS: 0.5, S: 1, M: 2, L: 3, XL: 5 }

/** Weight of one item. */
export function weightOf(size: Size | null): number {
  return size === null ? 1 : WEIGHTS[size]
}

/** Credit of a status: done counts fully, partial half, everything else nothing. */
export function creditOf(status: ItemStatus): number {
  return status === 'done' ? 1 : status === 'partial' ? 0.5 : 0
}

/** Entry for an item using the status its match derived. */
export function entryOf(item: LedgerItem, match: ItemMatch): SectionEntry {
  return { item, match, status: match.status, title: item.title }
}

/** Weighted completion of a set of entries, 0-100 rounded; `skipped` entries are excluded; empty is 0. */
export function percentOf(entries: SectionEntry[]): number {
  let total = 0
  let got = 0
  for (const e of entries) {
    if (e.status === 'skipped') continue
    const w = weightOf(e.item.size)
    total += w
    got += w * creditOf(e.status)
  }
  return total === 0 ? 0 : Math.round((got / total) * 100)
}

/** Done count and total (skipped excluded) of a set of entries. */
export function countsOf(entries: SectionEntry[]): { done: number; total: number } {
  const live = entries.filter(e => e.status !== 'skipped')
  return { done: live.filter(e => e.status === 'done').length, total: live.length }
}

/** Roll-up status of a set of entries: active > built > partial > planned. */
export function statusOf(entries: SectionEntry[], percent: number): SectionStatus {
  const live = entries.filter(e => e.status !== 'skipped')
  if (live.some(e => e.status === 'open' || e.status === 'failed')) return 'active'
  if (live.length > 0 && live.every(e => e.status === 'done')) return 'built'
  return percent > 0 ? 'partial' : 'planned'
}

/** One section per phase, in ledger order; items without a phase form a section with id ''. */
export function sectionsByPhase(items: LedgerItem[], matches: Map<string, ItemMatch>): LedgerSection[] {
  const order: string[] = []
  const groups = new Map<string, SectionEntry[]>()
  for (const item of items) {
    const match = matches.get(item.id)
    if (!match) continue
    if (!groups.has(item.phase)) {
      groups.set(item.phase, [])
      order.push(item.phase)
    }
    groups.get(item.phase)?.push(entryOf(item, match))
  }
  return order.map(phase => {
    const entries = groups.get(phase) ?? []
    const percent = percentOf(entries)
    return {
      id: slug(phase),
      phase,
      items: entries,
      percent,
      counts: countsOf(entries),
      status: statusOf(entries, percent),
    }
  })
}

/** Whole-ledger roll-up, weighted like the sections. */
export function overall(items: LedgerItem[], matches: Map<string, ItemMatch>): Overall {
  const entries: SectionEntry[] = []
  for (const item of items) {
    const match = matches.get(item.id)
    if (match) entries.push(entryOf(item, match))
  }
  return overallOfEntries(entries)
}

/** Same roll-up over entries that may carry judged statuses. */
export function overallOfEntries(entries: SectionEntry[]): Overall {
  const counts: Overall['counts'] = { done: 0, partial: 0, open: 0, failed: 0, planned: 0, skipped: 0, total: 0 }
  for (const e of entries) {
    counts[e.status] += 1
    if (e.status !== 'skipped') counts.total += 1
  }
  return { percent: percentOf(entries), counts }
}

/** What `defaultExpanded` needs to know about a section; `items` and `isProposed` refine the choice when given. */
export type ExpandCandidate = { id: string; percent: number; status: SectionStatus; items?: readonly unknown[]; isProposed?: boolean }

/**
 * Which section to open: the least-done active one; with none active, the least-done section that is not
 * built and holds at least one item. Proposed and empty sections are chosen only when no section holds a
 * task at all. Ties go to the earlier section. Returns null when there is nothing to open.
 */
export function defaultExpanded(sections: ExpandCandidate[]): string | null {
  const least = (pool: ExpandCandidate[]) =>
    pool.reduce<ExpandCandidate | null>((best, s) => (best === null || s.percent < best.percent ? s : best), null)
  const isFilled = (s: ExpandCandidate) => s.isProposed !== true && (s.items === undefined || s.items.length > 0)
  const open = sections.filter(s => s.status !== 'built')
  const active = open.filter(s => s.status === 'active' && isFilled(s))
  if (active.length) return least(active)?.id ?? null
  const filled = open.filter(isFilled)
  if (filled.length) return least(filled)?.id ?? null
  // Only when no section holds any task at all is an empty or proposed one worth opening.
  if (sections.some(isFilled)) return null
  return least(open)?.id ?? null
}

/** 'idle' when nothing is in flight (no open or failed item, no partial item with an open slice). */
export function headerMode(matches: Map<string, ItemMatch>): 'idle' | 'inferred' {
  for (const m of matches.values()) {
    if (m.status === 'open' || m.status === 'failed') return 'inferred'
    if (m.status === 'partial' && m.slices.some(s => s.pr.state === 'OPEN')) return 'inferred'
  }
  return 'idle'
}

/**
 * The item a branch is working on: the id its delivery or follow-up pattern names, or the parent of a
 * sub-slice id (a branch for `T06a` belongs to `T06`). Null when the branch names no item.
 */
export function currentItemForBranch(branch: string, items: LedgerItem[]): string | null {
  const direct = itemIdForBranch(branch, items)
  if (direct) return direct
  const slash = branch.indexOf('/')
  if (slash <= 0 || isRevertBranch(branch)) return null
  const rest = branch.slice(slash + 1)
  let best: string | null = null
  for (const it of items) {
    if (!it.hasRealId || !/\d$/.test(it.id)) continue
    const m = new RegExp(`^${escapeRegExp(it.id)}([a-z]{1,2})(?![A-Za-z0-9])`, 'i').exec(rest)
    if (!m || m[1] !== (m[1] as string).toLowerCase()) continue
    if (items.some(o => o.id.toLowerCase() === (it.id + m[1]).toLowerCase())) continue
    if (best === null || it.id.length > best.length) best = it.id
  }
  return best
}
