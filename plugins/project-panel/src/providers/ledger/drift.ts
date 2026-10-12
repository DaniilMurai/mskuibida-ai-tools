import type { DriftFlag, ItemMatch, LedgerItem } from './types'

/**
 * Disagreements between what the ledger declares and what the PRs show. Structured only: the adapter
 * resolves each kind to text. One flag per item at most, in ledger order.
 */
export function deterministicDrift(items: LedgerItem[], matches: Map<string, ItemMatch>): DriftFlag[] {
  const out: DriftFlag[] = []
  for (const item of items) {
    const m = matches.get(item.id)
    if (!m) continue
    if (m.status === 'failed') {
      out.push({ kind: 'qa-failed', itemId: item.id, pr: m.prs[0]?.number })
    } else if (m.source === 'pr' && m.status === 'done' && (item.declared === 'open' || item.declared === 'planned' || item.declared === 'held')) {
      out.push({ kind: 'declared-open-but-merged', itemId: item.id, pr: m.prs.find(p => p.state === 'MERGED')?.number })
    } else if (m.source === 'pr' && m.status === 'open' && item.declared === 'done') {
      out.push({ kind: 'declared-done-but-open', itemId: item.id, pr: m.prs.find(p => p.state === 'OPEN')?.number })
    } else if (m.source === 'slices' && m.status === 'open' && item.declared === 'done') {
      out.push({
        kind: 'declared-done-no-pr-open-pr',
        itemId: item.id,
        pr: m.slices.find(s => s.pr.state === 'OPEN')?.pr.number,
      })
    }
  }
  return out
}
