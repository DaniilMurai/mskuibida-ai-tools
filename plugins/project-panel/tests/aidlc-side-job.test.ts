// A side job in the AI-DLC provider: not a stage of the plan, so it suggests no `/aidlc`, says what the session
// itself is on (its branch, its open PR, how far it is from the default branch), and folds the plan behind that
// once there is more to say than the branch. A scripted git/gh world (tests/aidlc-world.ts); sanitised names.
import { describe, expect, test } from 'claude-code/testing'
import { ME, SCENARIOS } from '../fixtures/review'
import { REPO, aload, aworld, branchOf, gitlabAworld, mr, pr, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

/** Two segments, so the stage-branch pattern does not match: the bound session is a side job. */
const SIDE = 'claude/side-work'
const SETTINGS = { [`${REPO}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'pr-review@acme': true } }) }
const PARKED = { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } }

const base = (over: Partial<AWorld>): Partial<AWorld> => ({
  local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }, PARKED),
  main: state({ 'requirements-analysis': 'x', 'user-stories': 'x' }, { current: 'domain-design' }),
  branch: SIDE,
  viewer: ME,
  extra: SETTINGS,
  ...over,
})
const world = (over: Partial<AWorld> = {}): AWorld => aworld(base(over))

describe('a side job with something to show', () => {
  const awaiting = () => pr(25, SIDE, { ...SCENARIOS.awaiting.raw })

  test('context lines: the branch, its open PR with the review word as a link, and the distance from main', async () => {
    const { model } = await aload(world({ prs: [awaiting()], distance: { ahead: 3, behind: 2 } }))
    expect(model.header.mode).toBe('side-job')
    expect(model.header.context).toEqual([
      { id: 'branch', text: 'on claude/side-work' },
      { id: 'pr', text: 'PR #25, awaiting dev-b', href: 'https://example.test/acme/shop/pull/25' },
      { id: 'distance', text: '3 ahead, 2 behind main', tone: 'warning' },
    ])
  })

  test('the plan folds, and the caption no longer points "below"', async () => {
    const { model } = await aload(world({ prs: [awaiting()] }))
    expect(model.isPlanCollapsed).toBe(true)
    expect(model.header.caption).toBe("This session is not bound to a stage of shop-mvp. The intent's progress is folded under Plan.")
    expect(model.sections.length).toBeGreaterThan(0)
  })

  test('it suggests no /aidlc, not even the review command of the intent\'s own PR', async () => {
    const { model } = await aload(world({ prs: [awaiting(), pr(33, branchOf('domain-design'), { ...SCENARIOS.awaitingYou.raw })] }))
    expect(model).not.toHaveProperty('next')
    expect(JSON.stringify(model.gates.map(gate => gate.caption))).not.toContain('/aidlc')
  })

  test('only ahead, only behind: one short line, behind in warning', async () => {
    const ahead = await aload(world({ prs: [awaiting()], distance: { ahead: 4, behind: 0 } }))
    expect(ahead.model.header.context?.at(-1)).toEqual({ id: 'distance', text: '4 ahead of main' })
    const behind = await aload(world({ prs: [awaiting()], distance: { ahead: 0, behind: 1 } }))
    expect(behind.model.header.context?.at(-1)).toEqual({ id: 'distance', text: '1 behind main', tone: 'warning' })
  })

  test('commits ahead with no PR yet are enough to fold the plan', async () => {
    const { model } = await aload(world({ distance: { ahead: 2, behind: 0 } }))
    expect(model.header.context?.map(line => line.id)).toEqual(['branch', 'distance'])
    expect(model.isPlanCollapsed).toBe(true)
  })

  test('the parked gate says it is parked, and names no command to resume it', async () => {
    const { model } = await aload(world({ prs: [awaiting()] }))
    expect(model.gates.find(gate => gate.kind === 'parked')?.caption).toBe('The workflow was parked 2026-10-06 09:30.')
  })

  test('a gate on a PR the parked stage waits on says so, with no command', async () => {
    const { model } = await aload(
      world({ prs: [pr(33, branchOf('user-stories', 'domain-design'), { ...SCENARIOS.awaiting.raw })], distance: { ahead: 1, behind: 0 } }),
    )
    const caption = model.gates.find(gate => gate.kind === 'parked')?.caption ?? ''
    expect(caption).toContain('PR #33')
    expect(caption).not.toContain('/aidlc')
  })

  test('on GitLab the line says merge request, spelled !25', async () => {
    const { model } = await aload(gitlabAworld(base({ mrs: [mr(25, SIDE)], distance: { ahead: 1, behind: 0 } })))
    expect(model.header.context?.find(line => line.id === 'pr')?.text).toMatch(/^MR !25, /)
  })
})

describe('a side job with nothing to show beyond its branch', () => {
  test('keeps the plan open, with the old caption and no /aidlc', async () => {
    const { model } = await aload(world({ distance: { ahead: 0, behind: 0 } }))
    expect(model.header.context).toEqual([{ id: 'branch', text: 'on claude/side-work' }])
    expect(model).not.toHaveProperty('isPlanCollapsed')
    expect(model.header.caption).toBe('This session is not bound to a stage of shop-mvp. Progress below is the intent the workspace points at.')
    expect(model).not.toHaveProperty('next')
  })

  test('a side job on the default branch itself is just its branch, and asks git nothing about distance', async () => {
    const { s, model } = await aload(world({ branch: 'main', distance: { ahead: 9, behind: 9 } }))
    expect(model.header.context).toEqual([{ id: 'branch', text: 'on main' }])
    expect(s.lines().some(line => line.includes('--left-right'))).toBe(false)
  })

  test('a PR for another branch is not this session\'s', async () => {
    const { model } = await aload(world({ prs: [pr(40, 'dev/other/thing', { ...SCENARIOS.awaiting.raw })] }))
    expect(model.header.context?.map(line => line.id)).toEqual(['branch'])
  })

  test('git failing on the distance leaves it out', async () => {
    const { model } = await aload(world({ prs: [pr(25, SIDE, { ...SCENARIOS.awaiting.raw })] }))
    expect(model.header.context?.map(line => line.id)).toEqual(['branch', 'pr'])
  })

  test('a detached HEAD has no branch to name: no context at all', async () => {
    const { model } = await aload(world({ branch: '' }))
    expect(model.header).not.toHaveProperty('context')
    expect(model).not.toHaveProperty('isPlanCollapsed')
  })
})

describe('a stage session is untouched', () => {
  test('no context, the plan open, /aidlc still the Next, the parked caption still says how to resume', async () => {
    const { model } = await aload(world({ branch: branchOf('domain-design') }))
    expect(model.header.mode).toBe('stage')
    expect(model.header).not.toHaveProperty('context')
    expect(model).not.toHaveProperty('isPlanCollapsed')
    expect(model.next?.command).toBe('/aidlc')
    expect(model.gates.find(gate => gate.kind === 'parked')?.caption).toBe('The workflow was parked 2026-10-06 09:30. Resume it with /aidlc.')
  })
})
