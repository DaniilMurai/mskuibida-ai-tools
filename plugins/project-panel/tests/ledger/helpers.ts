import type { DeclaredStatus, LedgerItem, Pr, Size } from '../../src/providers/ledger/types'

// Small builders so tests state only what matters about an item or a PR.

/** A ledger item with sensible defaults; `line` counts up so ledger order is stable. */
let nextLine = 1
export function item(id: string, over: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id,
    hasRealId: true,
    title: id,
    deps: [],
    size: null,
    phase: 'Phase A',
    line: nextLine++,
    declared: null,
    citations: [],
    ...over,
  }
}

export function sized(id: string, size: Size, declared: DeclaredStatus = null, over: Partial<LedgerItem> = {}): LedgerItem {
  return item(id, { size, declared, ...over })
}

/** A PR; labels are given as plain names. */
export function pr(
  number: number,
  headRefName: string,
  over: { title?: string; state?: Pr['state']; labels?: string[] } = {},
): Pr {
  const state = over.state ?? 'MERGED'
  return {
    number,
    title: over.title ?? `change ${number}`,
    state,
    headRefName,
    labels: (over.labels ?? []).map(name => ({ name })),
    mergedAt: state === 'MERGED' ? '2026-01-01T00:00:00Z' : null,
  }
}
