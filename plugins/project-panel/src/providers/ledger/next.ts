import type { ItemMatch, LedgerItem, NextPick } from './types'

/**
 * The next task to pick up: the first item in ledger order that is still planned (and not held: blocked or
 * deliberately not built), has no open PR, and whose
 * ledger dependencies are all done (dependencies that are not ledger items are ignored). Deterministic,
 * no model involved.
 */
export function pickNext(items: LedgerItem[], matches: Map<string, ItemMatch>): NextPick | null {
  const known = new Map(items.map(i => [i.id, i]))
  for (const item of items) {
    const m = matches.get(item.id)
    if (!m || m.status !== 'planned' || item.declared === 'held') continue
    const hasOpenPr = [...m.prs, ...m.followups, ...m.slices.map(s => s.pr)].some(p => p.state === 'OPEN')
    if (hasOpenPr) continue
    const deps = item.deps.filter(d => known.has(d))
    if (deps.every(d => matches.get(d)?.status === 'done')) return { itemId: item.id, deps }
  }
  return null
}
