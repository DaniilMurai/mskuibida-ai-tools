// A merged stage reopened (a backward jump folded it into a later stage's branch): it is not done until the new work
// lands, and every stage merged after it is stale. In progress, in review and not started keep their own status.
import { describe, expect, test } from 'claude-code/testing'
import { derive } from '../src/providers/aidlc/truths'
import type { Two } from '../src/providers/aidlc/truths'
import { stagesOf } from '../src/providers/aidlc/truths'
import { matchStageBranch } from '../src/providers/aidlc/select'
import { parseState } from '../src/providers/aidlc/parse-state'
import { itemLook } from '../src/render/item'
import { mixOf } from '../src/render/ring'
import type { Item } from '../types'
import { OPTIONS } from './world'
import { PREFIX, REPO_URL, aload, aworld, branchOf, itemOf, pr, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const MERGED_AT = '2026-10-03T10:00:00Z'
const merged = (number: number, ...stages: string[]) => pr(number, branchOf(...stages), { state: 'MERGED', mergedAt: MERGED_AT })
const FOLD = 'dev/SHOP-7/domain-design--folded--refined-mockups'

/**
 * The case that motivated it: refined-mockups merged in #33, main parked at domain-design (in progress there), and
 * this session on the fold branch, back on refined-mockups after a backward jump. No PR for the fold yet.
 */
function reopenedHere(over: Partial<AWorld> = {}): AWorld {
  return aworld({
    local: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' },
      { current: 'refined-mockups' },
    ),
    main: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' },
      { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-11T06:32:27Z' } },
    ),
    branch: FOLD,
    prs: [merged(33, 'refined-mockups'), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
    pushed: [FOLD],
    behind: 3,
    ...over,
  })
}

describe('a stage reopened on this session\'s fold branch, before any PR', () => {
  test('the reopened stage is reopened, not done, and keeps the chip of the PR that merged it', async () => {
    const { model } = await aload(reopenedHere())
    const item = itemOf(model, 'refined-mockups')
    expect(item.status).toBe('reopened')
    expect(item.isCurrent).toBe(true)
    expect(item).not.toHaveProperty('landing')
    expect(item.chips).toEqual([{ kind: 'pr', label: '#33', tone: 'success', href: `${REPO_URL}/pull/33` }])
  })

  test('in progress stays in progress, not started stays planned, the stages before stay done', async () => {
    const { model } = await aload(reopenedHere())
    expect(itemOf(model, 'domain-design').status).toBe('open')
    expect(itemOf(model, 'units-generation').status).toBe('planned')
    expect(itemOf(model, 'user-stories')).toMatchObject({ status: 'done', landing: 'merged' })
    expect(itemOf(model, 'requirements-analysis')).toMatchObject({ status: 'done', landing: 'merged' })
  })

  test('a reopened stage does not count as done', async () => {
    const { model } = await aload(reopenedHere())
    expect(model.overall.counts).toEqual({ done: 2, reopened: 1, open: 1, planned: 2, total: 6 })
  })

  test('the fold branch is still behind main after its last stage', async () => {
    const { model } = await aload(reopenedHere())
    expect(model.gates.find(gate => gate.id === 'behind:session')).toMatchObject({ afterItemId: 'domain-design' })
  })

  test('re-approved here but not merged yet, it is still reopened', async () => {
    const local = state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' }, { current: 'domain-design' })
    const { model } = await aload(reopenedHere({ local }))
    expect(itemOf(model, 'refined-mockups').status).toBe('reopened')
  })

  test('a checkout of the merged PR\'s own branch is stale work, not a reopen: main wins', async () => {
    const branch = branchOf('refined-mockups')
    const { model } = await aload(reopenedHere({ branch, pushed: [branch] }))
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ status: 'done', landing: 'merged' })
  })

  test('without the PR list, only a box that went back below completed reopens', async () => {
    expect(itemOf((await aload(reopenedHere({ prs: null }))).model, 'refined-mockups').status).toBe('reopened')
    const local = state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x' }, { current: 'domain-design' })
    expect(itemOf((await aload(reopenedHere({ prs: null, local }))).model, 'refined-mockups').status).toBe('done')
  })

  test('once the fold has an open PR, the stage is reopened in it', async () => {
    const { model } = await aload(reopenedHere({ prs: [pr(48, FOLD), merged(33, 'refined-mockups'), merged(31, 'user-stories')] }))
    const item = itemOf(model, 'refined-mockups')
    expect(item.status).toBe('reopened')
    expect(item.chips.map(chip => chip.label)).toEqual(['#33', '↺ reopened in #48'])
  })
})

describe('stale: what was merged after a reopened stage', () => {
  const two = (over: Partial<Two> = {}): Two => ({
    refOf: n => `#${n}`,
    forgeKind: 'github',
    base: 'main',
    main: null,
    mapped: [],
    files: new Map(),
    prefix: PREFIX,
    sessionBranch: 'dev/SHOP-7/user-stories-again',
    sessionStages: ['user-stories'],
    behind: 0,
    isPrsKnown: true,
    isPushed: false,
    current: 'user-stories',
    quiet: new Set<string>(),
    ...over,
  })

  test('done stages after it are stale; in progress and planned keep their status; earlier ones stay done', () => {
    const local = parseState(state({ 'requirements-analysis': 'x', 'user-stories': '-' }, { current: 'user-stories' }))
    const main = parseState(
      state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': 'x', 'units-generation': '-' }),
    )
    const out = derive(local, two({ main }))
    const status = (slug: string) => out.items.get(slug)?.status
    expect(status('requirements-analysis')).toBe('done')
    expect(status('user-stories')).toBe('reopened')
    expect(status('refined-mockups')).toBe('stale')
    expect(status('domain-design')).toBe('stale')
    expect(status('units-generation')).toBe('open')
    expect(status('contract-design')).toBe('planned')
    expect(out.items.get('refined-mockups')).not.toHaveProperty('landing')
  })

  test('an open PR touching an earlier stage\'s folder reopens it, and the merged stages after it go stale', () => {
    const local = parseState(state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' }))
    const main = parseState(state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x' }))
    const open = {
      pr: { number: 41, title: '', state: 'OPEN' as const, isDraft: false, headRefName: branchOf('domain-design'), headRefOid: '', reviewDecision: '', mergeStateStatus: 'CLEAN', failingChecks: [], mergedAt: null, url: '' },
      stages: ['domain-design'],
    }
    const files = new Map([[41, [`${PREFIX}inception/user-stories/stories.md`]]])
    const out = derive(local, two({ main, mapped: [open], files, sessionBranch: branchOf('domain-design'), sessionStages: ['domain-design'] }))
    expect(out.items.get('user-stories')?.status).toBe('reopened')
    expect(out.items.get('refined-mockups')?.status).toBe('stale')
    expect(out.items.get('domain-design')).toMatchObject({ status: 'open', landing: 'in-pr' })
  })
})

describe('fold branch names', () => {
  const order = ['requirements-analysis', 'user-stories', 'refined-mockups', 'domain-design', 'units-generation']

  test('stages after the separator may be a comma list; a word that is no stage is dropped', () => {
    const branch = 'dev/ABC-5/refined-mockups--folded--requirements-analysis,user-stories'
    expect(matchStageBranch(branch, OPTIONS.stageBranchPattern, OPTIONS.foldSeparator)?.stages).toEqual([
      'refined-mockups',
      'folded',
      'requirements-analysis',
      'user-stories',
    ])
    expect(stagesOf(branch, order, OPTIONS)).toEqual(['requirements-analysis', 'user-stories', 'refined-mockups'])
  })

  test('the stages between the named ones are carried too', () => {
    expect(stagesOf('dev/ABC-5/domain-design--folded--user-stories', order, OPTIONS)).toEqual(['user-stories', 'refined-mockups', 'domain-design'])
  })

  test('a branch naming no stage of the plan carries none', () => {
    expect(stagesOf('dev/ABC-5/project-plugins', order, OPTIONS)).toEqual([])
  })
})

describe('how reopened and stale are drawn', () => {
  const item = (status: Item['status']): Item => ({ id: 'x', title: 'x', status, isCurrent: false, chips: [] })

  test('↺ reopened and a warning ✓ stale, each with its word', () => {
    expect(itemLook(item('reopened'))).toMatchObject({ glyph: '↺', color: 'warning', word: 'reopened' })
    expect(itemLook(item('stale'))).toMatchObject({ glyph: '✓', color: 'warning', word: 'stale' })
  })

  test('the strip counts reopened as live work and stale as the rest, neither as done', () => {
    expect(mixOf([item('done'), item('reopened'), item('stale')])).toEqual({ done: 1, live: 1, failed: 0, rest: 1, total: 3 })
  })
})
