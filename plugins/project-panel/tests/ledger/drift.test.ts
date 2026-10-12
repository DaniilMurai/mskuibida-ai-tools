import { describe, expect, test } from 'claude-code/testing'
import { deterministicDrift } from '../../src/providers/ledger/drift'
import { matchPrs } from '../../src/providers/ledger/match'
import { parseLedger } from '../../src/providers/ledger/parse'
import * as rem from '../../fixtures/ledger/reminders'
import { item, pr } from './helpers'

const drift = (items: ReturnType<typeof item>[], prs: ReturnType<typeof pr>[]) => deterministicDrift(items, matchPrs(items, prs))

describe('deterministicDrift', () => {
  test('declared open but the PR is merged', () => {
    expect(drift([item('T16', { declared: 'open' })], [pr(38, 'feat/T16-resume')])).toEqual([
      { kind: 'declared-open-but-merged', itemId: 'T16', pr: 38 },
    ])
  })
  test('declared planned but the PR is merged', () => {
    expect(drift([item('T16', { declared: 'planned' })], [pr(38, 'feat/T16-resume')])).toEqual([
      { kind: 'declared-open-but-merged', itemId: 'T16', pr: 38 },
    ])
  })
  test('declared done but only an open PR exists', () => {
    expect(drift([item('T20', { declared: 'done' })], [pr(7, 'feat/T20-x', { state: 'OPEN' })])).toEqual([
      { kind: 'declared-done-but-open', itemId: 'T20', pr: 7 },
    ])
  })
  test('declared done, no PR of its own, an open sub-slice PR', () => {
    expect(drift([item('T06', { declared: 'done' })], [pr(9, 'feat/T06b-x', { state: 'OPEN' })])).toEqual([
      { kind: 'declared-done-no-pr-open-pr', itemId: 'T06', pr: 9 },
    ])
  })
  test('qa:failed', () => {
    expect(drift([item('T05')], [pr(70, 'feat/T05-x', { labels: ['qa:failed'] })])).toEqual([
      { kind: 'qa-failed', itemId: 'T05', pr: 70 },
    ])
  })
  test('no drift when ledger and PRs agree, or the ledger says nothing', () => {
    expect(drift([item('A1', { declared: 'done' })], [pr(1, 'feat/A1-x')])).toEqual([])
    expect(drift([item('A1', { declared: 'open' })], [pr(1, 'feat/A1-x', { state: 'OPEN' })])).toEqual([])
    expect(drift([item('A1', { declared: null })], [pr(1, 'feat/A1-x')])).toEqual([])
    expect(drift([item('A1', { declared: 'planned' })], [])).toEqual([])
  })
  test('a declared-done item is not drift just because the ledger text predates a fix PR', () => {
    const items = [item('A1', { declared: 'done' })]
    expect(drift(items, [pr(1, 'feat/A1-x'), pr(2, 'fix/A1-y', { state: 'OPEN' })])).toEqual([])
  })
  test('flags come in ledger order, one per item', () => {
    const items = [item('B1', { declared: 'open' }), item('A1', { declared: 'open' })]
    const flags = drift(items, [pr(1, 'feat/A1-x'), pr(2, 'feat/B1-x')])
    expect(flags.map(f => f.itemId)).toEqual(['B1', 'A1'])
  })
  test('reminders fixture: the ledger says T16 is open but its PR merged; T05 failed QA', () => {
    const items = parseLedger(rem.ledgerText).items
    const flags = deterministicDrift(items, matchPrs(items, rem.prs))
    expect(flags).toContainEqual({ kind: 'declared-open-but-merged', itemId: 'T16', pr: 38 })
    expect(flags).toContainEqual({ kind: 'qa-failed', itemId: 'T05', pr: 70 })
  })
})
