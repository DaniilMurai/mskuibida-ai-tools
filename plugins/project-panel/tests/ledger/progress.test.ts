import { describe, expect, test } from 'claude-code/testing'
import { matchPrs } from '../../src/providers/ledger/match'
import { parseLedger } from '../../src/providers/ledger/parse'
import {
  WEIGHTS,
  creditOf,
  currentItemForBranch,
  defaultExpanded,
  headerMode,
  overall,
  sectionsByPhase,
} from '../../src/providers/ledger/progress'
import type { ItemMatch, ItemStatus } from '../../src/providers/ledger/types'
import * as rem from '../../fixtures/ledger/reminders'
import * as fsv from '../../fixtures/ledger/field-service'
import { item, pr, sized } from './helpers'

const m = (status: ItemStatus, over: Partial<ItemMatch> = {}): ItemMatch => ({
  status,
  prs: [],
  followups: [],
  slices: [],
  reverts: [],
  source: 'pr',
  ...over,
})

describe('weights and credit', () => {
  test('size weights, with XS at half a task', () => {
    expect(WEIGHTS).toEqual({ XS: 0.5, S: 1, M: 2, L: 3, XL: 5 })
  })
  test('done counts 1, partial 0.5, everything else 0', () => {
    expect(creditOf('done')).toBe(1)
    expect(creditOf('partial')).toBe(0.5)
    for (const s of ['open', 'failed', 'planned', 'skipped'] as const) expect(creditOf(s)).toBe(0)
  })
  test('overall percent is weighted by size', () => {
    const items = [sized('A1', 'L'), sized('A2', 'S')]
    const matches = new Map([['A1', m('done')], ['A2', m('planned')]])
    expect(overall(items, matches).percent).toBe(75)
  })
  test('XS items weigh half of an S', () => {
    const items = [sized('A1', 'XS'), sized('A2', 'S')]
    const matches = new Map([['A1', m('done')], ['A2', m('planned')]])
    expect(overall(items, matches).percent).toBe(33)
  })
  test('an unknown size counts as one', () => {
    const items = [item('A1'), sized('A2', 'S')]
    const matches = new Map([['A1', m('done')], ['A2', m('planned')]])
    expect(overall(items, matches).percent).toBe(50)
  })
  test('partial earns half credit', () => {
    const items = [sized('A1', 'M')]
    expect(overall(items, new Map([['A1', m('partial')]])).percent).toBe(50)
  })
  test('skipped items are excluded from the totals', () => {
    const items = [sized('A1', 'M'), sized('A2', 'XL')]
    const o = overall(items, new Map([['A1', m('done')], ['A2', m('skipped')]]))
    expect(o.percent).toBe(100)
    expect(o.counts.total).toBe(1)
    expect(o.counts.skipped).toBe(1)
  })
  test('counts by status', () => {
    const items = [item('A1'), item('A2'), item('A3'), item('A4')]
    const o = overall(items, new Map([['A1', m('done')], ['A2', m('done')], ['A3', m('open')], ['A4', m('failed')]]))
    expect(o.counts).toEqual({ done: 2, partial: 0, open: 1, failed: 1, planned: 0, skipped: 0, total: 4 })
  })
  test('an empty ledger is 0%', () => {
    expect(overall([], new Map())).toEqual({
      percent: 0,
      counts: { done: 0, partial: 0, open: 0, failed: 0, planned: 0, skipped: 0, total: 0 },
    })
  })
})

describe('sections by phase', () => {
  const items = [
    item('A1', { phase: 'One' }),
    item('A2', { phase: 'One' }),
    item('B1', { phase: 'Two' }),
    item('B2', { phase: 'Two' }),
    item('C1', { phase: 'Three' }),
    item('D1', { phase: 'Four' }),
  ]
  const matches = new Map<string, ItemMatch>([
    ['A1', m('done')],
    ['A2', m('done')],
    ['B1', m('done')],
    ['B2', m('open')],
    ['C1', m('partial')],
    ['D1', m('planned')],
  ])
  const sections = sectionsByPhase(items, matches)

  test('one section per phase in ledger order, with slug ids', () => {
    expect(sections.map(s => s.id)).toEqual(['one', 'two', 'three', 'four'])
    expect(sections.map(s => s.phase)).toEqual(['One', 'Two', 'Three', 'Four'])
  })
  test('status: built, active, partial, planned', () => {
    expect(sections.map(s => s.status)).toEqual(['built', 'active', 'partial', 'planned'])
  })
  test('percent and counts', () => {
    expect(sections.map(s => s.percent)).toEqual([100, 50, 50, 0])
    expect(sections[1]?.counts).toEqual({ done: 1, total: 2 })
  })
  test('failed also makes a section active', () => {
    const s = sectionsByPhase([item('A1', { phase: 'P' })], new Map([['A1', m('failed')]]))
    expect(s[0]?.status).toBe('active')
  })
  test('each entry carries the item, its match and the status', () => {
    expect(sections[1]?.items.map(e => [e.item.id, e.status])).toEqual([['B1', 'done'], ['B2', 'open']])
  })
  test('items without a match are left out', () => {
    expect(sectionsByPhase([item('Z1', { phase: 'Z' })], new Map())).toEqual([])
  })
})

describe('defaultExpanded', () => {
  test('the least-done active section opens', () => {
    const s = [
      { id: 'a', percent: 90, status: 'active' as const },
      { id: 'b', percent: 20, status: 'active' as const },
      { id: 'c', percent: 0, status: 'planned' as const },
    ]
    expect(defaultExpanded(s)).toBe('b')
  })
  test('with nothing active, the least-done section that is not built', () => {
    const s = [
      { id: 'a', percent: 100, status: 'built' as const },
      { id: 'b', percent: 60, status: 'partial' as const },
      { id: 'c', percent: 10, status: 'partial' as const },
    ]
    expect(defaultExpanded(s)).toBe('c')
  })
  test('ties go to the first in order', () => {
    const s = [
      { id: 'a', percent: 30, status: 'active' as const },
      { id: 'b', percent: 30, status: 'active' as const },
    ]
    expect(defaultExpanded(s)).toBe('a')
  })
  test('everything built, or nothing at all, opens nothing', () => {
    expect(defaultExpanded([{ id: 'a', percent: 100, status: 'built' }])).toBeNull()
    expect(defaultExpanded([])).toBeNull()
  })
  test('works on the reminders fixture', () => {
    const parsed = parseLedger(rem.ledgerText).items
    const secs = sectionsByPhase(parsed, matchPrs(parsed, rem.prs))
    expect(defaultExpanded(secs)).toBe(secs.find(s => s.status === 'active')?.id)
  })
})

describe('headerMode', () => {
  test('idle when nothing is in flight', () => {
    expect(headerMode(new Map([['A', m('done')], ['B', m('planned')]]))).toBe('idle')
    expect(headerMode(new Map())).toBe('idle')
  })
  test('inferred when an item is open or failed', () => {
    expect(headerMode(new Map([['A', m('open')]]))).toBe('inferred')
    expect(headerMode(new Map([['A', m('failed')]]))).toBe('inferred')
  })
  test('inferred for a partial item that still has an open slice', () => {
    const open = pr(2, 'feat/T06b-x', { state: 'OPEN' })
    const merged = pr(1, 'feat/T06a-x')
    const withOpen = m('partial', { slices: [{ sliceId: 'T06a', pr: merged }, { sliceId: 'T06b', pr: open }] })
    const allMerged = m('partial', { slices: [{ sliceId: 'T06a', pr: merged }] })
    expect(headerMode(new Map([['A', withOpen]]))).toBe('inferred')
    expect(headerMode(new Map([['A', allMerged]]))).toBe('idle')
  })
  test('the field-service fixture has nothing in flight', () => {
    const parsed = parseLedger(fsv.ledgerText).items
    expect(headerMode(matchPrs(parsed, fsv.prs))).toBe('idle')
  })
})

describe('currentItemForBranch', () => {
  const items = [item('T04'), item('T06'), item('T04a'), item('fix-T04a-backdate-picker')]
  test('the item named by the branch', () => {
    expect(currentItemForBranch('feat/T04-act', items)).toBe('T04')
    expect(currentItemForBranch('qa/t04a-preprod', items)).toBe('T04a')
    expect(currentItemForBranch('fix/fix-T04a-backdate-picker', items)).toBe('fix-T04a-backdate-picker')
  })
  test('a sub-slice branch belongs to its parent item', () => {
    expect(currentItemForBranch('feat/T06b-tasks', items)).toBe('T06')
  })
  test('null for main, unrelated branches and reverts', () => {
    expect(currentItemForBranch('main', items)).toBeNull()
    expect(currentItemForBranch('claude/random', items)).toBeNull()
    expect(currentItemForBranch('revert/T04-act', items)).toBeNull()
  })
})
