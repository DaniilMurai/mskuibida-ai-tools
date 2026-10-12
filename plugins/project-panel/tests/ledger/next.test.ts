import { describe, expect, test } from 'claude-code/testing'
import { matchPrs } from '../../src/providers/ledger/match'
import { pickNext } from '../../src/providers/ledger/next'
import { parseLedger } from '../../src/providers/ledger/parse'
import * as rem from '../../fixtures/ledger/reminders'
import * as fsv from '../../fixtures/ledger/field-service'
import { item, pr } from './helpers'

describe('pickNext', () => {
  test('the first planned item whose ledger dependencies are done', () => {
    const items = [item('A1', { declared: 'done' }), item('A2', { deps: ['A1'] }), item('A3', { deps: ['A2'] })]
    expect(pickNext(items, matchPrs(items, []))).toEqual({ itemId: 'A2', deps: ['A1'] })
  })
  test('a dependency that is not done blocks the item; the next free one is chosen', () => {
    const items = [item('A1', { declared: 'open' }), item('A2', { deps: ['A1'] }), item('A3')]
    expect(pickNext(items, matchPrs(items, []))?.itemId).toBe('A3')
  })
  test('an item with an open PR is not next', () => {
    const items = [item('A1'), item('A2')]
    const matches = matchPrs(items, [pr(1, 'feat/A1-x', { state: 'OPEN' })])
    expect(matches.get('A1')?.status).toBe('open')
    expect(pickNext(items, matches)?.itemId).toBe('A2')
  })
  test('a planned item with an open follow-up PR is skipped too', () => {
    const items = [item('A1', { declared: 'planned' }), item('A2')]
    const matches = matchPrs(items, [pr(1, 'fix/A1-x', { state: 'OPEN' })])
    expect(pickNext(items, matches)?.itemId).toBe('A2')
  })
  test('dependencies that are not ledger items are ignored', () => {
    const items = [item('A1', { deps: ['X9', 'prose-thing'] })]
    expect(pickNext(items, matchPrs(items, []))).toEqual({ itemId: 'A1', deps: [] })
  })
  test('deterministic: ledger order, not id order', () => {
    const items = [item('Z1'), item('A1')]
    expect(pickNext(items, matchPrs(items, []))?.itemId).toBe('Z1')
  })
  test('null when everything is done or blocked', () => {
    const done = [item('A1', { declared: 'done' })]
    expect(pickNext(done, matchPrs(done, []))).toBeNull()
    const blocked = [item('A1', { declared: 'open' }), item('A2', { deps: ['A1'] })]
    expect(pickNext(blocked, matchPrs(blocked, []))).toBeNull()
    expect(pickNext([], new Map())).toBeNull()
  })
  test('reminders fixture: T04 is open and T05 failed QA, so T06 is next', () => {
    const items = parseLedger(rem.ledgerText).items
    const next = pickNext(items, matchPrs(items, rem.prs))
    expect(next?.itemId).toBe('T06')
  })
  test('reminders fixture without the open PR: T04 is next, with its deps', () => {
    const items = parseLedger(rem.ledgerText).items
    const next = pickNext(items, matchPrs(items, rem.prs.filter(p => p.number !== 67)))
    expect(next).toEqual({ itemId: 'T04', deps: ['T01a', 'T01b', 'T02', 'T03'] })
  })
  test('field-service fixture: the pick is a planned ledger item', () => {
    const items = parseLedger(fsv.ledgerText).items
    const next = pickNext(items, matchPrs(items, fsv.prs))
    expect(items.some(i => i.id === next?.itemId)).toBe(true)
    expect(matchPrs(items, fsv.prs).get(next?.itemId ?? '')?.status).toBe('planned')
  })
})
