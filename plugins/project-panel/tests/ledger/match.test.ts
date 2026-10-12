import { describe, expect, test } from 'claude-code/testing'
import { isRevert, itemIdForBranch, matchPrs, namesAsSubject, naiveMatch, tierOf } from '../../src/providers/ledger/match'
import { parseLedger } from '../../src/providers/ledger/parse'
import * as rem from '../../fixtures/ledger/reminders'
import * as fsv from '../../fixtures/ledger/field-service'
import { item, pr } from './helpers'

const numbers = (prs: { number: number }[]) => prs.map(p => p.number)

describe('word boundaries', () => {
  test('T04 does not match T04a, and T04a does not match T04', () => {
    const m = matchPrs([item('T04'), item('T04a')], [pr(1, 'feat/T04a-clock'), pr(2, 'feat/T04-act')])
    expect(numbers(m.get('T04')?.prs ?? [])).toEqual([2])
    expect(numbers(m.get('T04a')?.prs ?? [])).toEqual([1])
  })
  test('T1 does not match T10 and API-3 does not match API-30', () => {
    const m = matchPrs([item('T1'), item('T10'), item('API-3'), item('API-30')], [pr(1, 'feat/T10-x'), pr(2, 'feat/API-30-log')])
    expect(m.get('T1')?.status).toBe('planned')
    expect(m.get('T10')?.status).toBe('done')
    expect(m.get('API-3')?.status).toBe('planned')
    expect(m.get('API-30')?.status).toBe('done')
  })
  test('titles match with a conventional-commit scope: feat(T04): …', () => {
    const m = matchPrs([item('T04')], [pr(1, 'claude/odd-branch', { title: 'feat(T04): act buttons' })])
    expect(numbers(m.get('T04')?.prs ?? [])).toEqual([1])
  })
  test('lowercase ids in branches match case-insensitively', () => {
    const m = matchPrs([item('T04a')], [pr(1, 'qa/t04a-preprod')])
    expect(numbers(m.get('T04a')?.prs ?? [])).toEqual([1])
  })
  test('an id inside a longer word does not match', () => {
    const m = matchPrs([item('T04')], [pr(1, 'feat/restore-state', { title: 'xT04 and T04xyz' })])
    expect(m.get('T04')?.status).toBe('planned')
  })
  test('items without a real id never match', () => {
    const synthetic = item('phase-1#1', { hasRealId: false, declared: 'planned' })
    const m = matchPrs([synthetic], [pr(1, 'feat/phase-1#1')])
    expect(m.get('phase-1#1')).toMatchObject({ status: 'planned', source: 'declared', prs: [] })
  })
})

describe('tiers and follow-ups', () => {
  test('tierOf: delivery branch, follow-up branch, loose mention', () => {
    expect(tierOf('T04', 'feat/T04-act')).toBe(1)
    expect(tierOf('T04', 'chore/t04')).toBe(1)
    expect(tierOf('T04', 'fix/T04-x')).toBe(2)
    expect(tierOf('T04', 'hotfix/T04-x')).toBe(2)
    expect(tierOf('T04', 'qa/t04-preprod')).toBe(2)
    expect(tierOf('T04', 'fix/fix-T04-x')).toBe(3)
    expect(tierOf('T04', 'claude/foo')).toBe(3)
    expect(tierOf('T04', 'T04-no-type')).toBe(3)
  })
  test('a fix PR on a delivered item stays a follow-up', () => {
    const m = matchPrs([item('T04a')], [pr(1, 'feat/T04a-clock'), pr(2, 'fix/T04a-late', { title: 'fix(T04a): late' }), pr(3, 'qa/t04a-preprod')])
    const x = m.get('T04a')
    expect(numbers(x?.prs ?? [])).toEqual([1])
    expect(numbers(x?.followups ?? [])).toEqual([3, 2])
    expect(x?.status).toBe('done')
  })
  test('a hotfix-only item is done by its hotfix', () => {
    const m = matchPrs([item('T25')], [pr(1, 'hotfix/T25-overdue-alarm-spin')])
    expect(m.get('T25')).toMatchObject({ status: 'done', source: 'pr' })
  })
  test('the best tier decides: an open delivery PR beats a merged fix', () => {
    const m = matchPrs([item('T05')], [pr(1, 'feat/T05-x', { state: 'OPEN' }), pr(2, 'fix/T05-y')])
    expect(m.get('T05')?.status).toBe('open')
    expect(numbers(m.get('T05')?.followups ?? [])).toEqual([2])
  })
  test('within a tier any merged PR means done, even beside an open one', () => {
    const m = matchPrs([item('T05')], [pr(1, 'feat/T05-x'), pr(2, 'feat/T05-y', { state: 'OPEN' })])
    expect(m.get('T05')?.status).toBe('done')
  })
  test('closed-only PRs fall through to the declared status and stay visible as follow-ups', () => {
    const m = matchPrs([item('T06', { declared: 'planned' })], [pr(1, 'feat/T06-x', { state: 'CLOSED' })])
    expect(m.get('T06')).toMatchObject({ status: 'planned', source: 'declared', prs: [] })
    expect(numbers(m.get('T06')?.followups ?? [])).toEqual([1])
  })
  test('closed-only with a declared done keeps done', () => {
    const m = matchPrs([item('T06', { declared: 'done' })], [pr(1, 'feat/T06-x', { state: 'CLOSED' })])
    expect(m.get('T06')?.status).toBe('done')
  })
  test('no evidence and nothing declared is planned with source none', () => {
    expect(matchPrs([item('T07')], []).get('T07')).toMatchObject({ status: 'planned', source: 'none' })
  })
  test('declared open and done come through when no PR speaks', () => {
    const m = matchPrs([item('A1', { declared: 'open' }), item('A2', { declared: 'done' })], [])
    expect(m.get('A1')).toMatchObject({ status: 'open', source: 'declared' })
    expect(m.get('A2')).toMatchObject({ status: 'done', source: 'declared' })
  })
  test('itemIdForBranch finds the item by its tier-1 or tier-2 pattern, longest id first', () => {
    const items = [item('T04a'), item('fix-T04a-backdate-picker')]
    expect(itemIdForBranch('feat/T04a-clock', items)).toBe('T04a')
    expect(itemIdForBranch('fix/fix-T04a-backdate-picker', items)).toBe('fix-T04a-backdate-picker')
    expect(itemIdForBranch('claude/T04a', items)).toBe('T04a')
    expect(itemIdForBranch('revert/T04a-x', items)).toBeNull()
    expect(itemIdForBranch('main', items)).toBeNull()
  })
})

describe('containment', () => {
  const items = [item('T04a'), item('fix-T04a-backdate-picker'), item('fix-T04a-backdate-picker-dst-labels')]
  test('a PR naming a slug id belongs to that slug, not to the code id inside it', () => {
    const m = matchPrs(items, [pr(1, 'fix/fix-T04a-backdate-picker')])
    expect(numbers(m.get('fix-T04a-backdate-picker')?.prs ?? [])).toEqual([1])
    expect(m.get('T04a')?.status).toBe('planned')
    expect(m.get('T04a')?.followups).toHaveLength(0)
    expect(m.get('fix-T04a-backdate-picker-dst-labels')?.status).toBe('planned')
  })
  test('the longer slug wins over the shorter one it contains', () => {
    const m = matchPrs(items, [pr(2, 'fix/fix-T04a-backdate-picker-dst-labels')])
    expect(numbers(m.get('fix-T04a-backdate-picker-dst-labels')?.prs ?? [])).toEqual([2])
    expect(m.get('fix-T04a-backdate-picker')?.status).toBe('planned')
    expect(m.get('T04a')?.status).toBe('planned')
  })
  test('the field-service fixture: fix PRs do not inflate T04a', () => {
    const parsed = parseLedger(fsv.ledgerText).items
    const m = matchPrs(parsed, fsv.prs)
    expect(numbers(m.get('T04a')?.prs ?? [])).toEqual([162])
    expect(numbers(m.get('fix-T04a-backdate-picker')?.prs ?? [])).toEqual([259])
    expect(numbers(m.get('fix-T04a-backdate-picker-dst-labels')?.prs ?? [])).toEqual([267])
    expect(numbers(m.get('fix-T04a-day-refresh-after-flush')?.prs ?? [])).toEqual([274])
    expect(numbers(m.get('T04a')?.followups ?? [])).toEqual([166])
  })
})

describe('sub-slices', () => {
  const prs = [pr(1, 'feat/T06a-locations'), pr(2, 'feat/T06b-tasks', { state: 'OPEN' }), pr(3, 'feat/T06c-hints')]
  test('with no T06a row the parent is partial when a slice merged', () => {
    const m = matchPrs([item('T06', { declared: 'planned' })], prs)
    expect(m.get('T06')?.status).toBe('partial')
    expect(m.get('T06')?.source).toBe('slices')
    expect(m.get('T06')?.slices.map(s => s.sliceId)).toEqual(['T06c', 'T06b', 'T06a'])
    expect(m.get('T06')?.prs).toHaveLength(0)
  })
  test('with only open slices the parent is open', () => {
    const m = matchPrs([item('T06')], [pr(2, 'feat/T06b-tasks', { state: 'OPEN' })])
    expect(m.get('T06')).toMatchObject({ status: 'open', source: 'slices' })
  })
  test('closed-only slices fall through to the declared status', () => {
    const m = matchPrs([item('T06', { declared: 'planned' })], [pr(2, 'feat/T06b-tasks', { state: 'CLOSED' })])
    expect(m.get('T06')).toMatchObject({ status: 'planned', source: 'declared' })
  })
  test('a slice that is itself an item is not a sub-slice', () => {
    const m = matchPrs([item('T06'), item('T06a')], [pr(1, 'feat/T06a-locations')])
    expect(m.get('T06')?.slices).toHaveLength(0)
    expect(m.get('T06a')?.status).toBe('done')
  })
  test('the parent keeps its own PR status and still lists the slices', () => {
    const m = matchPrs([item('P04')], [pr(1, 'feat/P04-branding'), pr(2, 'feat/P04a-api'), pr(3, 'feat/P04b-form')])
    expect(m.get('P04')?.status).toBe('done')
    expect(m.get('P04')?.slices.map(s => s.sliceId)).toEqual(['P04b', 'P04a'])
  })
  test('slugs and ids that do not end in a digit have no sub-slices', () => {
    const m = matchPrs([item('chore-qa-api-call')], [pr(1, 'chore/chore-qa-api-calls')])
    expect(m.get('chore-qa-api-call')?.slices).toHaveLength(0)
  })
  test('three-letter tails and uppercase tails are not slices', () => {
    const m = matchPrs([item('T06')], [pr(1, 'feat/T06abc-x'), pr(2, 'feat/T06AB-x')])
    expect(m.get('T06')?.slices).toHaveLength(0)
  })
  test('the field-service fixture: T03b has no row, so its PR is a slice of T03', () => {
    const m = matchPrs(parseLedger(fsv.ledgerText).items, fsv.prs)
    expect(m.get('T03')?.slices.map(s => s.sliceId)).toEqual(['T03b'])
    expect(numbers(m.get('T03')?.prs ?? [])).toEqual([154])
  })
})

describe('qa:failed and reverts', () => {
  test('a qa:failed label on the most recent PR of the best tier means failed', () => {
    const m = matchPrs([item('T05')], [pr(1, 'feat/T05-x'), pr(2, 'feat/T05-y', { labels: ['qa:failed'] })])
    expect(m.get('T05')?.status).toBe('failed')
  })
  test('a qa:failed label on an older PR does not fail the item', () => {
    const m = matchPrs([item('T05')], [pr(1, 'feat/T05-x', { labels: ['qa:failed'] }), pr(2, 'feat/T05-y')])
    expect(m.get('T05')?.status).toBe('done')
  })
  test('the reminders fixture carries a failed item', () => {
    const m = matchPrs(parseLedger(rem.ledgerText).items, rem.prs)
    expect(m.get('T05')).toMatchObject({ status: 'failed', source: 'pr' })
  })
  test('reverts never count toward status and are kept as chips', () => {
    const m = matchPrs([item('T12')], [pr(1, 'feat/T12-install'), pr(2, 'revert/T12-install')])
    expect(m.get('T12')?.status).toBe('done')
    expect(numbers(m.get('T12')?.reverts ?? [])).toEqual([2])
    expect(numbers(m.get('T12')?.prs ?? [])).toEqual([1])
  })
  test('a revert alone does not make an item done, whether named by branch or by title', () => {
    expect(matchPrs([item('T12')], [pr(1, 'revert/T12-install')]).get('T12')?.status).toBe('planned')
    expect(matchPrs([item('T12')], [pr(1, 'claude/x', { title: 'Revert "feat(T12): install"' })]).get('T12')?.status).toBe('planned')
    expect(isRevert(pr(1, 'revert/x'))).toBe(true)
    expect(isRevert(pr(1, 'feat/x', { title: 'revert: undo' }))).toBe(true)
    expect(isRevert(pr(1, 'feat/x', { title: 'feat: reverts nothing' }))).toBe(false)
  })
})

describe('loose mentions count only when the title names the item as its subject', () => {
  test('namesAsSubject: scopes, leading forms and trailing parentheses', () => {
    const yes = [
      'feat(T04): act buttons',
      'fix(app,T04): late',
      'fix(app, T04): late',
      'feat(t04)!: shout',
      '[T04] Act buttons',
      'T04: act buttons',
      'T04 — act buttons',
      'T04 – act buttons',
      'T04 - act buttons',
      'feat(api): T04 — act buttons',
      'test: two worker tests no longer depend on the real clock (T04)',
      'fix: something (T04).',
      'fix: something (T05, T04)',
    ]
    for (const title of yes) expect(namesAsSubject(title, 'T04')).toBe(true)
    const no = [
      'docs(workplan): make command suggestions a T01 deliverable, not a T04',
      'T04a — act buttons',
      'feat(T04a): act buttons',
      'T040: nope',
      'Mentions T04 in passing',
      'T04 is a thing',
      'fix: see (T04) for context, then more words',
      'feat(app): rework T04a and T04',
      'fix: something (app, T04).',
      'refactor (builds on T04)',
      'refactor (not T04)',
    ]
    for (const title of no) expect(namesAsSubject(title, 'T04')).toBe(false)
  })
  test('namesAsSubject works for slug ids', () => {
    expect(namesAsSubject('fix(ci): the tag push (fix-release-tag-push-hooks)', 'fix-release-tag-push-hooks')).toBe(true)
    expect(namesAsSubject('chore(chore-qa-tool): x', 'chore-qa-tool')).toBe(true)
    expect(namesAsSubject('chore(qa-tool): x', 'chore-qa-tool')).toBe(false)
  })
  test('the T06-shaped case: a docs PR that says "not a T06" does not make T06 done', () => {
    const docs = pr(18, 'docs/T00-command-suggestions', { title: 'docs(workplan): make command suggestions a T01 deliverable, not a T06' })
    const m = matchPrs([item('T06', { declared: 'planned' })], [docs])
    expect(m.get('T06')).toMatchObject({ status: 'planned', source: 'declared', prs: [] })
    expect(numbers(m.get('T06')?.followups ?? [])).toEqual([18])
  })
  test('the same PR counts once its title names the item', () => {
    const m = matchPrs([item('T17')], [pr(43, 'claude/odd-branch', { title: 'fix(test): pin the clock (T17)' })])
    expect(m.get('T17')).toMatchObject({ status: 'done', source: 'pr' })
  })
  test('a loose mention never beats a stronger tier, and a weak open PR does not make an item open', () => {
    const m = matchPrs([item('T05')], [pr(1, 'claude/x', { title: 'refactor: prepare for T05', state: 'OPEN' })])
    expect(m.get('T05')).toMatchObject({ status: 'planned', source: 'none' })
  })
  test('a slice PR with only a loose mention is not a slice', () => {
    const m = matchPrs([item('T06')], [pr(1, 'claude/x', { title: 'docs: notes on T06b' })])
    expect(m.get('T06')?.slices).toHaveLength(0)
    const named = matchPrs([item('T06')], [pr(2, 'claude/x', { title: 'feat(T06b): tasks' })])
    expect(named.get('T06')?.slices.map(s => s.sliceId)).toEqual(['T06b'])
  })
  test('a slug id that begins with the branch type is read as a delivery branch', () => {
    expect(tierOf('chore-qa-tooling', 'chore/qa-tooling-get-location')).toBe(1)
    expect(tierOf('fix-x-y', 'fix/x-y')).toBe(2)
    const m = matchPrs([item('chore-qa-tooling')], [pr(1, 'chore/qa-tooling-get-location', { title: 'chore: read-by-id' })])
    expect(m.get('chore-qa-tooling')).toMatchObject({ status: 'done', source: 'pr' })
  })
})

describe('reminders fixture end to end', () => {
  const items = parseLedger(rem.ledgerText).items
  const m = matchPrs(items, rem.prs)
  test('delivery PRs make items done', () => {
    for (const id of ['T01a', 'T01b', 'T02', 'T03', 'T07', 'T08', 'T10a', 'T10b', 'T11', 'T12', 'T13b']) {
      expect(m.get(id)?.status).toBe('done')
    }
  })
  test('an open PR makes the item open', () => {
    expect(m.get('T04')).toMatchObject({ status: 'open', source: 'pr' })
    expect(numbers(m.get('T04')?.prs ?? [])).toEqual([67])
  })
  test('a closed-only PR leaves the ledger status (nothing declared: planned)', () => {
    expect(m.get('T13c')).toMatchObject({ status: 'planned', source: 'none' })
    expect(numbers(m.get('T13c')?.followups ?? [])).toEqual([68])
  })
  test('a revert is a chip on the item and the item stays done', () => {
    expect(numbers(m.get('T12')?.reverts ?? [])).toEqual([69])
    expect(m.get('T12')?.status).toBe('done')
  })
  test('fix-only and hotfix-only items are done by their PRs', () => {
    expect(m.get('T21')).toMatchObject({ status: 'done', source: 'pr' })
    expect(m.get('T25')).toMatchObject({ status: 'done', source: 'pr' })
    expect(m.get('T-HF02')).toMatchObject({ status: 'done', source: 'pr' })
  })
  test('a docs PR that merely says "not a T06" leaves T06 planned', () => {
    expect(m.get('T06')).toMatchObject({ status: 'planned', source: 'declared' })
    expect(numbers(m.get('T06')?.followups ?? [])).toEqual([18])
  })
  test('a title that names the item as its subject is enough when nothing stronger exists', () => {
    expect(numbers(m.get('T17')?.prs ?? [])).toEqual([43])
    expect(m.get('T17')?.status).toBe('done')
  })
  test('the ledger says open but the PR is merged: the PR wins', () => {
    expect(items.find(i => i.id === 'T16')?.declared).toBe('open')
    expect(m.get('T16')?.status).toBe('done')
  })
  test('a closed docs PR is a follow-up beside the fix that delivered T21', () => {
    expect(numbers(m.get('T21')?.followups ?? [])).toEqual([49])
  })
})

describe('naive matching', () => {
  test('substring matching claims T04a PRs for T04', () => {
    const items = [item('T04'), item('T04a')]
    const prs = [pr(1, 'feat/T04a-clock')]
    expect(naiveMatch(items, prs).get('T04')?.status).toBe('done')
    expect(matchPrs(items, prs).get('T04')?.status).toBe('planned')
  })
})
