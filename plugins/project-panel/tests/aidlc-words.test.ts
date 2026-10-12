// The words of the two truths (0.7.0 feedback): "in review", "up next", and never "local only" for pushed work.
import { describe, expect, test } from 'claude-code/testing'
import { REPO, aload, aworld, branchOf, itemOf, pr, state, PREFIX } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const merged = (number: number, ...stages: string[]) => pr(number, branchOf(...stages), { state: 'MERGED', mergedAt: '2026-10-03T10:00:00Z' })
const view = (model: Awaited<ReturnType<typeof aload>>['model']) =>
  Object.fromEntries(model.sections.flatMap(s => s.items).filter(i => i.landing || i.statusWord).map(i => [i.id, [i.landing ?? '-', i.status, i.statusWord ?? '', i.chips.map(c => c.label).join('+')]]))

/** The parked-intent session: refined-mockups done here and in PR #33, domain-design current and nothing written for it. */
function parkedIntent(over: Partial<AWorld> = {}): AWorld {
  return aworld({
    local: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' },
      { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } },
    ),
    main: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
    branch: branchOf('refined-mockups'),
    prs: [pr(33, branchOf('refined-mockups')), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
    quiet: ['domain-design'],
    ...over,
  })
}

describe('the words', () => {
  test('in a PR: "in review"; a draft: "in draft"; the chip still carries the number', async () => {
    const { model } = await aload(parkedIntent())
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', statusWord: 'in review' })
    expect(itemOf(model, 'refined-mockups').chips[0]?.label).toBe('#33')
    const draft = await aload(parkedIntent({ prs: [pr(33, branchOf('refined-mockups'), { isDraft: true })] }))
    expect(itemOf(draft.model, 'refined-mockups')).toMatchObject({ statusWord: 'in draft' })
    expect(itemOf(draft.model, 'refined-mockups').chips[0]?.label).toBe('#33 draft')
  })

  test('the base line says in review, with the number', async () => {
    expect((await aload(parkedIntent())).model.header.base).toBe('main: refined-mockups in review, PR #33')
  })
})

describe('up next', () => {
  test('the parked-intent regression: domain-design is next in line, not work in progress', async () => {
    const { model } = await aload(parkedIntent())
    const item = itemOf(model, 'domain-design')
    expect(item).toMatchObject({ status: 'planned', statusWord: 'up next', isCurrent: true, chips: [] })
    expect(item).not.toHaveProperty('landing')
    expect(model.overall.counts).toEqual({ done: 2, open: 1, planned: 5, total: 8 })
    expect(model.gates.map(gate => [gate.kind, gate.afterItemId])).toEqual([
      ['pr-not-merged', 'refined-mockups'],
      ['parked', 'refined-mockups'],
    ])
    expect(model.header.base).toBe('main: refined-mockups in review, PR #33')
  })

  test('once something is written for it, it is local work', async () => {
    const { model } = await aload(parkedIntent({ quiet: [] }))
    expect(itemOf(model, 'domain-design')).toMatchObject({ landing: 'local', status: 'open', statusWord: 'local only' })
  })

  test('a file one level down counts as started; two levels down does not', async () => {
    const dir = `${REPO}/${PREFIX}inception/domain-design`
    const one = await aload(parkedIntent({ quiet: ['domain-design'], extra: { [`${dir}/entities/model.md`]: '#' } }))
    expect(itemOf(one.model, 'domain-design')).toMatchObject({ landing: 'local' })
    const two = await aload(parkedIntent({ quiet: ['domain-design'], extra: { [`${dir}/a/b/model.md`]: '#' } }))
    expect(itemOf(two.model, 'domain-design')).toMatchObject({ status: 'planned', statusWord: 'up next' })
  })

  test('the current stage still pending here is up next too; elsewhere in the plan nothing changes', async () => {
    const w = aworld({ local: state({ 'user-stories': 'x' }, { current: 'refined-mockups' }), main: state({ 'user-stories': 'x' }, { current: 'refined-mockups' }), branch: 'main' })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ status: 'planned', statusWord: 'up next', isCurrent: true })
    expect(itemOf(model, 'units-generation')).not.toHaveProperty('statusWord')
  })

  test('a stage an open PR carries is not up next, whatever this working tree holds', async () => {
    const { model } = await aload(parkedIntent({ quiet: ['refined-mockups', 'domain-design'], local: state({ 'user-stories': 'x', 'refined-mockups': '-', 'domain-design': '-' }, { current: 'domain-design' }) }))
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', statusWord: 'in review' })
  })

  test('a stage already completed on main, and a phase that works per unit, are never up next', async () => {
    const done = aworld({ local: state({ 'user-stories': '-' }, { current: 'user-stories' }), main: state({ 'user-stories': 'x' }), branch: 'main', quiet: ['user-stories'] })
    expect(itemOf((await aload(done)).model, 'user-stories')).toMatchObject({ landing: 'merged' })
    const unit = aworld({ local: state({ 'functional-design': '-' }, { current: 'functional-design', lifecycle: 'CONSTRUCTION' }), main: state({}), branch: 'main', quiet: ['functional-design'] })
    expect(itemOf((await aload(unit)).model, 'functional-design')).toMatchObject({ landing: 'local', statusWord: 'local only' })
  })
})

describe('pushed work is not "local only"', () => {
  const noDesign = (over: Partial<AWorld> = {}) => parkedIntent({ prs: null, ...over })

  test('gh could not be read, the branch is pushed: in review as far as anyone knows, "not merged"', async () => {
    const { model, s } = await aload(noDesign({ pushed: [branchOf('refined-mockups')] }))
    expect(s.lines()).toContain(`git -C ${REPO} rev-parse --verify --quiet refs/remotes/origin/${branchOf('refined-mockups')}`)
    const item = itemOf(model, 'refined-mockups')
    expect(item).toMatchObject({ landing: 'in-pr', status: 'open', statusWord: 'not merged', chips: [] })
    expect(model.overall.counts.done).toBe(2)
    expect(model.header.base).toBe('main: refined-mockups not merged yet')
    expect(itemOf(model, 'domain-design')).toMatchObject({ status: 'planned', statusWord: 'up next' })
  })

  test('gh could not be read, the branch is not pushed: local only', async () => {
    const { model } = await aload(noDesign())
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'local', statusWord: 'local only' })
  })

  test('the list was read and there is no PR, the branch is pushed: "pushed, no PR"', async () => {
    const { model } = await aload(parkedIntent({ prs: [merged(31, 'user-stories')], pushed: [branchOf('refined-mockups')] }))
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'local', status: 'open', statusWord: 'pushed, no PR' })
  })

  test('a stage the session branch does not carry stays local only, pushed or not', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': '-' }),
      main: state({ 'user-stories': 'x' }),
      branch: branchOf('user-stories'),
      pushed: [branchOf('user-stories')],
      prs: [],
    })
    expect(itemOf((await aload(w)).model, 'refined-mockups')).toMatchObject({ landing: 'local', statusWord: 'local only' })
  })

  test('a stage an open PR carries needs no look at the remote ref', async () => {
    const { s } = await aload(parkedIntent({ pushed: [branchOf('refined-mockups')] }))
    expect(s.lines().some(line => line.includes('refs/remotes/origin/dev'))).toBe(false)
  })

  test('on the default branch nothing is asked', async () => {
    const w = aworld({ local: state({ 'refined-mockups': '-' }), main: state({}), branch: 'main', prs: null })
    const { s } = await aload(w)
    expect(s.lines().some(line => line.includes('refs/remotes/origin/main'))).toBe(false)
  })
})
