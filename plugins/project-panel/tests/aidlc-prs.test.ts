// The AI-DLC provider's two truths (M3): the working tree's state file against the default branch's, and the
// PRs between. A scripted git/gh world (tests/aidlc-world.ts); sanitised, no real names.
import { describe, expect, test } from 'claude-code/testing'
import { aidlc } from '../src/providers/aidlc'
import { changedFiles, listChanges, refOf, resetCache } from '../src/providers/aidlc/prs'
import type { StagePr } from '../src/providers/aidlc/prs'
import { baseLine, derive, mapPrs, statusOfMarker } from '../src/providers/aidlc/truths'
import type { Two } from '../src/providers/aidlc/truths'
import { parseState } from '../src/providers/aidlc/parse-state'
import { NOW, OPTIONS } from './world'
import { CONSTRUCTION, INCEPTION, PREFIX, REPO, REPO_URL, aload, aworld, ascripted, branchOf, itemOf, pr, sectionOf, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const MERGED_AT = '2026-10-03T10:00:00Z'
const merged = (number: number, ...stages: string[]) => pr(number, branchOf(...stages), { state: 'MERGED', mergedAt: MERGED_AT })
/** One fetch of the list is an open query and a merged query side by side; count the open ones. */
const prLines = (lines: string[]) => lines.filter(line => line.startsWith('gh pr list --state open'))
const kinds = (model: { gates: { kind: string }[] }) => model.gates.map(gate => gate.kind)

/** user-stories and requirements-analysis are on main (merged PRs), refined-mockups is in PR #33. */
function regression(over: Partial<AWorld> = {}): AWorld {
  return aworld({
    local: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' },
      { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } },
    ),
    main: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
    branch: branchOf('refined-mockups'),
    prs: [pr(33, branchOf('refined-mockups')), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
    ...over,
  })
}

describe('the regression: refined-mockups in PR #33, domain-design only in this worktree', () => {
  test('refined-mockups is in a PR, not done', async () => {
    const { model } = await aload(regression())
    const item = itemOf(model, 'refined-mockups')
    expect(item.landing).toBe('in-pr')
    expect(item.status).toBe('open')
    expect(item.statusWord).toBe('in review')
    expect(item.chips).toEqual([{ kind: 'pr', label: '#33', tone: 'accent', href: `${REPO_URL}/pull/33` }])
  })

  test('domain-design is local only, and current', async () => {
    const { model } = await aload(regression())
    const item = itemOf(model, 'domain-design')
    expect(item.landing).toBe('local')
    expect(item.status).toBe('open')
    expect(item.statusWord).toBe('local only')
    expect(item.isCurrent).toBe(true)
    expect(item.chips).toEqual([])
  })

  test('user-stories is merged, with the chip of its merged PR', async () => {
    const { model } = await aload(regression())
    const item = itemOf(model, 'user-stories')
    expect(item.landing).toBe('merged')
    expect(item.status).toBe('done')
    expect(item).not.toHaveProperty('statusWord')
    expect(item.chips).toEqual([{ kind: 'pr', label: '#31', tone: 'success', href: `${REPO_URL}/pull/31` }])
  })

  test('the PR gate and the Parked gate both hang after refined-mockups, in that order', async () => {
    const { model } = await aload(regression())
    expect(model.gates).toEqual([
      {
        id: 'pr:33',
        kind: 'pr-not-merged',
        tone: 'warning',
        title: 'PR #33 not merged',
        caption: "domain-design can't start on main until it lands.",
        sectionId: 'INCEPTION',
        afterItemId: 'refined-mockups',
        href: `${REPO_URL}/pull/33`,
      },
      {
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: 'Parked at domain-design',
        caption: 'Waiting on PR #33 to merge; parked 2026-10-06 09:30. Resume with /aidlc once it lands.',
        sectionId: 'INCEPTION',
        afterItemId: 'refined-mockups',
      },
    ])
  })

  test('the header says where main stands', async () => {
    const { model } = await aload(regression())
    expect(model.header.base).toBe('main: refined-mockups in review, PR #33')
    expect(model.header.mode).toBe('stage')
  })

  test('progress follows the local state: a stage checked off here counts as done, in its open PR or not', async () => {
    const { model } = await aload(regression())
    // requirements-analysis and user-stories merged; refined-mockups [x] here, in PR #33; domain-design in progress.
    expect(model.overall.counts).toEqual({ done: 3, open: 1, planned: 2, total: 6 })
    expect(model.overall.percent).toBe(50)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ status: 'open', landing: 'in-pr', isFinishedLocal: true })
    const inception = sectionOf(model, 'INCEPTION')
    expect(inception.counts).toEqual({ done: 3, total: 6 })
    expect(inception.percent).toBe(50)
    // The phase's own status is still main's: work done here does not make it partial.
    expect(inception.status).toBe('active')
    expect(inception.isCollapsed).toBe(false)
  })

  test('the model is plain data: it round-trips, and absent fields are absent, not undefined', async () => {
    const { model } = await aload(regression())
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
    expect(Object.keys(itemOf(model, 'requirements-analysis')).sort()).toEqual(['chips', 'id', 'isCurrent', 'landing', 'ordinal', 'points', 'status', 'title'])
    expect(Object.keys(itemOf(model, 'units-generation')).sort()).toEqual(['chips', 'id', 'isCurrent', 'ordinal', 'points', 'status', 'title'])
  })

  test('the commands: argv only, the PR list once, no model', async () => {
    const { s } = await aload(regression())
    const lines = s.lines()
    expect(lines).toContain(`git -C ${REPO} rev-parse --show-toplevel`)
    expect(lines).toContain(`git -C ${REPO}/${PREFIX.slice(0, -1)} rev-parse --show-prefix`)
    expect(lines).toContain(`git -C ${REPO} show origin/main:${PREFIX}aidlc-state.md`)
    expect(lines.filter(line => line.startsWith('gh pr list'))).toEqual([
      'gh pr list --state open --limit 100 --json number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests,latestReviews,body,author',
      'gh pr list --state merged --limit 200 --json number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url',
    ])
  })
})

describe('landings', () => {
  test('merged on main: done, ✓, the merged PR chip, no gate, no base line when main is no different', async () => {
    const w = aworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }),
      main: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }),
      prs: [merged(31, 'user-stories')],
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories')).toMatchObject({ landing: 'merged', status: 'done', chips: [{ kind: 'pr', label: '#31', tone: 'success' }] })
    expect(itemOf(model, 'requirements-analysis')).toMatchObject({ landing: 'merged', chips: [] })
    const current = itemOf(model, 'domain-design')
    expect(current).toMatchObject({ status: 'open' })
    expect(current).not.toHaveProperty('landing')
    expect(model.gates).toEqual([])
    expect(model.header).not.toHaveProperty('base')
  })

  test('the newest merged PR of a stage is the chip', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x' }),
      main: state({ 'user-stories': 'x' }),
      prs: [pr(20, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-09-20T10:00:00Z' }), pr(25, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-10-02T10:00:00Z' })],
    })
    expect(itemOf((await aload(w)).model, 'user-stories').chips.map(chip => chip.label)).toEqual(['#25'])
  })

  test('local only: ahead of main, no PR; never done', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': '-' }),
      main: state({ 'user-stories': 'x' }, { current: 'user-stories' }),
      branch: branchOf('refined-mockups'),
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'local', status: 'open', statusWord: 'local only' })
    expect(model.overall.counts.done).toBe(1)
    expect(model.gates).toEqual([])
  })

  test('a completed stage nobody has put in a PR is local, status open', async () => {
    const w = aworld({ local: state({ 'user-stories': 'x' }), main: state({}), branch: 'main' })
    const item = itemOf((await aload(w)).model, 'user-stories')
    expect(item).toMatchObject({ landing: 'local', status: 'open' })
  })

  test('an awaiting stage in a PR stays awaiting, and its approval gate follows the PR gate', async () => {
    const w = regression({ local: state({ 'user-stories': 'x', 'refined-mockups': '?' }, { current: 'refined-mockups' }) })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', status: 'awaiting', statusWord: 'in review' })
    expect(kinds(model)).toEqual(['pr-not-merged', 'awaiting-approval'])
    expect(model.gates.every(gate => gate.afterItemId === 'refined-mockups')).toBe(true)
  })

  test('a revising stage in a PR stays revising', async () => {
    const { model } = await aload(regression({ local: state({ 'user-stories': 'x', 'refined-mockups': 'R' }) }))
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', status: 'revising' })
  })

  test('a draft PR: a neutral chip with the draft label and the draft word', async () => {
    const w = regression({ prs: [pr(33, branchOf('refined-mockups'), { isDraft: true })] })
    const item = itemOf((await aload(w)).model, 'refined-mockups')
    expect(item.statusWord).toBe('in draft')
    expect(item.chips).toEqual([{ kind: 'pr', label: '#33 draft', tone: 'neutral', href: `${REPO_URL}/pull/33` }])
  })

  test('skipped stays skipped, with no landing', async () => {
    const w = aworld({ local: state({}, {}, ['contract-design']), main: state({}, {}, ['contract-design']) })
    const item = itemOf((await aload(w)).model, 'contract-design')
    expect(item).toMatchObject({ status: 'skipped', chips: [] })
    expect(item).not.toHaveProperty('landing')
  })

  test('main running, local the same: the status is main\'s and nothing is drawn extra', async () => {
    const w = aworld({ local: state({ 'domain-design': '-' }), main: state({ 'domain-design': '-' }) })
    const item = itemOf((await aload(w)).model, 'domain-design')
    expect(item.status).toBe('open')
    expect(item).not.toHaveProperty('landing')
    expect(item).not.toHaveProperty('statusWord')
  })

  test('a working tree behind main: main\'s completed stage is merged even where the tree says pending', async () => {
    const w = aworld({ local: state({}), main: state({ 'requirements-analysis': 'x' }) })
    expect(itemOf((await aload(w)).model, 'requirements-analysis')).toMatchObject({ landing: 'merged', status: 'done' })
  })
})

describe('folds', () => {
  const fold = (over: Partial<AWorld> = {}) =>
    aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': 'x' }, { current: 'domain-design' }),
      main: state({ 'user-stories': 'x' }, { current: 'refined-mockups' }),
      branch: branchOf('refined-mockups', 'domain-design'),
      prs: [pr(40, branchOf('refined-mockups', 'domain-design')), merged(31, 'user-stories')],
      ...over,
    })

  test('one PR over two stages: a shared group, the chip on the first only, the word on both', async () => {
    const { model } = await aload(fold())
    const first = itemOf(model, 'refined-mockups')
    const second = itemOf(model, 'domain-design')
    expect(first.group).toBe('pr-40')
    expect(second.group).toBe('pr-40')
    expect(first.chips.map(chip => chip.label)).toEqual(['#40'])
    expect(second.chips).toEqual([])
    expect(first.statusWord).toBe('in review')
    expect(second.statusWord).toBe('in review')
    expect(itemOf(model, 'user-stories')).not.toHaveProperty('group')
  })

  test('one gate, after the LAST stage of the PR, naming the next stage', async () => {
    const { model } = await aload(fold())
    expect(model.gates).toHaveLength(1)
    expect(model.gates[0]).toMatchObject({
      id: 'pr:40',
      afterItemId: 'domain-design',
      caption: "units-generation can't start on main until it lands.",
    })
  })

  test('the CI chip sits on the first item too; the review state is every stage\'s word', async () => {
    const w = fold({ prs: [pr(40, branchOf('refined-mockups', 'domain-design'), { reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE', name: 'build' }] })] })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['#40', 'CI failing'])
    expect(itemOf(model, 'domain-design').chips).toEqual([])
    for (const id of ['refined-mockups', 'domain-design']) expect(itemOf(model, id)).toMatchObject({ statusWord: 'changes requested', review: 'changes' })
  })

  test('a merged fold PR draws no group', async () => {
    const w = aworld({
      local: state({ 'refined-mockups': 'x', 'domain-design': 'x' }),
      main: state({ 'refined-mockups': 'x', 'domain-design': 'x' }),
      prs: [merged(41, 'refined-mockups', 'domain-design')],
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).not.toHaveProperty('group')
    expect(itemOf(model, 'domain-design').chips.map(chip => chip.label)).toEqual(['#41'])
  })

  test('the parked stage inside the PR hangs after the PR gate', async () => {
    const w = fold({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' }, { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } }),
    })
    const { model } = await aload(w)
    expect(model.gates.map(gate => [gate.kind, gate.afterItemId])).toEqual([
      ['pr-not-merged', 'domain-design'],
      ['parked', 'domain-design'],
    ])
    expect(model.gates[1]?.caption).toContain('Waiting on PR #40')
  })
})

describe('reopens', () => {
  const reopen = (files: string[]) =>
    aworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }),
      main: state({ 'requirements-analysis': 'x', 'user-stories': 'x' }),
      branch: branchOf('domain-design'),
      prs: [pr(41, branchOf('domain-design')), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
      files: { 41: files },
    })

  test('an open PR that touches an earlier stage\'s directory reopens that stage', async () => {
    const { model, s } = await aload(reopen([`${PREFIX}inception/user-stories/stories.md`, `${PREFIX}inception/domain-design/model.md`, 'src/app.ts']))
    expect(itemOf(model, 'user-stories').chips).toEqual([
      { kind: 'pr', label: '#31', tone: 'success', href: `${REPO_URL}/pull/31` },
      { kind: 'reopen', label: '↺ reopened in #41', tone: 'warning', href: `${REPO_URL}/pull/41` },
    ])
    expect(itemOf(model, 'user-stories')).toMatchObject({ status: 'reopened' })
    expect(itemOf(model, 'user-stories')).not.toHaveProperty('landing')
    expect(itemOf(model, 'requirements-analysis').chips.map(chip => chip.kind)).toEqual(['pr'])
    expect(s.lines()).toContain('gh pr view 41 --json files')
  })

  test('its own stage and the later ones are never reopened by it; other phases need their own directory', async () => {
    const { model } = await aload(reopen([`${PREFIX}inception/domain-design/model.md`, `${PREFIX}construction/user-stories/x.md`, `${PREFIX}inception/units-generation/x.md`]))
    expect(itemOf(model, 'user-stories').chips.map(chip => chip.kind)).toEqual(['pr'])
    expect(itemOf(model, 'domain-design').chips.map(chip => chip.kind)).toEqual(['pr'])
  })

  test('a failing `gh pr view` reopens nothing', async () => {
    const w = reopen([])
    delete w.files[41]
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories').chips.map(chip => chip.kind)).toEqual(['pr'])
  })

  test('the changed files are asked for the five newest open PRs at most', async () => {
    const stages = ['units-generation', 'contract-design', 'functional-design', 'code-generation', 'domain-design', 'refined-mockups']
    const w = aworld({
      local: state({}),
      main: state({}),
      prs: stages.map((slug, i) => pr(50 + i, branchOf(slug))),
      branch: 'main',
    })
    const { s } = await aload(w)
    expect(s.lines().filter(line => line.startsWith('gh pr view'))).toHaveLength(5)
  })
})

describe('blockers', () => {
  test('behind main on the PR: a gate with the branch and the PR', async () => {
    const w = regression({ prs: [pr(33, branchOf('refined-mockups'), { mergeStateStatus: 'BEHIND' })] })
    const { model, s } = await aload(w)
    expect(kinds(model)).toEqual(['pr-not-merged', 'behind-main', 'parked'])
    expect(model.gates[1]).toMatchObject({
      id: 'behind:33',
      tone: 'warning',
      title: 'dev/SHOP-7/refined-mockups is behind main',
      caption: 'PR #33 is out of date with main; update the branch.',
      afterItemId: 'refined-mockups',
    })
    // The PR's own merge state is known, so the session is not asked how far behind it is.
    expect(s.lines().some(line => line.includes('rev-list'))).toBe(false)
  })

  test('behind main on the session branch with no PR: counted with rev-list', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': '-' }),
      main: state({ 'user-stories': 'x' }),
      branch: branchOf('refined-mockups'),
      behind: 3,
    })
    const { model, s } = await aload(w)
    expect(s.lines()).toContain(`git -C ${REPO} rev-list --count HEAD..origin/main`)
    expect(model.gates).toEqual([
      {
        id: 'behind:session',
        kind: 'behind-main',
        tone: 'warning',
        title: 'dev/SHOP-7/refined-mockups is behind main',
        caption: '3 new commits on main; merge or rebase before it can land.',
        sectionId: 'INCEPTION',
        afterItemId: 'refined-mockups',
      },
    ])
  })

  test('not behind: no gate; on the default branch or off a stage branch: no rev-list at all', async () => {
    const stageBranch = aworld({ local: state({ 'refined-mockups': '-' }), main: state({}), branch: branchOf('refined-mockups'), behind: 0 })
    expect((await aload(stageBranch)).model.gates).toEqual([])
    const onMain = aworld({ local: state({ 'refined-mockups': '-' }), main: state({}), branch: 'main', behind: 4 })
    const loaded = await aload(onMain)
    expect(loaded.model.gates).toEqual([])
    expect(loaded.s.lines().some(line => line.includes('rev-list'))).toBe(false)
  })

  test('CI failing: the tag chip, and a gate naming up to three checks', async () => {
    const rollup = [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'lint', state: 'ERROR' },
      { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'deploy-preview', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'slow', status: 'IN_PROGRESS', conclusion: '' },
    ]
    const { model } = await aload(regression({ prs: [pr(33, branchOf('refined-mockups'), { statusCheckRollup: rollup })] }))
    expect(itemOf(model, 'refined-mockups').chips).toEqual([
      { kind: 'pr', label: '#33', tone: 'accent', href: `${REPO_URL}/pull/33` },
      { kind: 'tag', label: 'CI failing', tone: 'error' },
    ])
    expect(model.gates[1]).toMatchObject({ id: 'ci:33', kind: 'ci-failing', tone: 'error', title: 'CI failing on PR #33', caption: 'Failing: build, lint, e2e…' })
  })

  test('changes requested: the status word, and a gate after the CI one', async () => {
    const w = regression({
      prs: [pr(33, branchOf('refined-mockups'), { reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE', name: 'build' }] })],
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['#33', 'CI failing'])
    expect(itemOf(model, 'refined-mockups').statusWord).toBe('changes requested')
    expect(kinds(model)).toEqual(['pr-not-merged', 'ci-failing', 'changes-requested', 'parked'])
    expect(model.gates[2]).toMatchObject({ id: 'review:33', title: 'Changes requested on PR #33', caption: 'Address the review before it can merge.' })
  })

  test('two open PRs: the newest first, each with its own gates', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x' }),
      main: state({}),
      prs: [pr(33, branchOf('user-stories')), pr(34, branchOf('refined-mockups'), { statusCheckRollup: [{ conclusion: 'FAILURE', name: 'build' }] })],
    })
    const { model } = await aload(w)
    expect(model.gates.map(gate => gate.id)).toEqual(['pr:34', 'ci:34', 'pr:33'])
    expect(model.gates.map(gate => gate.afterItemId)).toEqual(['refined-mockups', 'refined-mockups', 'user-stories'])
  })

  test('a gate keeps its section open', async () => {
    const w = aworld({
      local: state({ 'functional-design': '-' }, { current: 'functional-design' }),
      main: state({}),
      prs: [pr(60, branchOf('functional-design'))],
      branch: branchOf('functional-design'),
    })
    const { model } = await aload(w)
    expect(model.gates[0]).toMatchObject({ id: 'pr:60', sectionId: 'CONSTRUCTION', afterItemId: 'functional-design', caption: "code-generation can't start on main until it lands." })
    expect(sectionOf(model, 'CONSTRUCTION').isCollapsed).toBe(false)
  })

  test('the last stage of the plan: no next, so no caption', async () => {
    const w = aworld({ local: state({ 'code-generation': '-' }), main: state({}), prs: [pr(61, branchOf('code-generation'))], branch: branchOf('code-generation') })
    const gate = (await aload(w)).model.gates[0]
    expect(gate?.id).toBe('pr:61')
    expect(gate).not.toHaveProperty('caption')
  })

  test('Parked on a stage the PR does not block keeps its own place and caption', async () => {
    const w = regression({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x' }, { current: 'units-generation', parked: { at: 'units-generation', since: '2026-10-06T09:30:00Z' } }),
    })
    const { model } = await aload(w)
    expect(model.gates[1]).toMatchObject({ id: 'parked', afterItemId: 'units-generation', caption: 'The workflow was parked 2026-10-06 09:30. Resume it with /aidlc.' })
  })
})

describe('one truth', () => {
  test('not in a git work tree: the 0.6.0 model, one command', async () => {
    const w = aworld({ isRepo: false, local: state({ 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' }) })
    const { model, s } = await aload(w)
    expect(s.lines()).toEqual([`git -C ${REPO} rev-parse --show-toplevel`])
    expect(itemOf(model, 'refined-mockups')).toEqual({ id: 'refined-mockups', title: 'refined-mockups', ordinal: '2.3', status: 'done', isCurrent: false, chips: [], points: '1 pt' })
    expect(model.overall.counts.done).toBe(2)
    expect(model.header).not.toHaveProperty('base')
    expect(model.gates).toEqual([])
  })

  test('no origin/main and nothing to fetch: the same, after one fetch and no gh pr list', async () => {
    const w = aworld({ hasRef: false, refAfterFetch: false })
    const { model, s } = await aload(w)
    expect(s.lines().filter(line => line.includes('fetch --quiet origin main'))).toHaveLength(1)
    expect(prLines(s.lines())).toEqual([])
    expect(model.header).not.toHaveProperty('base')
    expect(itemOf(model, 'user-stories')).not.toHaveProperty('landing')
  })

  test('origin/main appears after the fetch: two truths', async () => {
    const w = regression({ hasRef: false, refAfterFetch: true })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups').landing).toBe('in-pr')
  })

  test('gh down: the two files still decide; done on the branch without a PR is local', async () => {
    const { model } = await aload(regression({ prs: null }))
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'local', status: 'open', chips: [] })
    expect(itemOf(model, 'user-stories')).toMatchObject({ landing: 'merged', chips: [] })
    expect(model.gates.map(gate => gate.kind)).toEqual(['parked'])
  })
})

describe('the intent is not on main yet', () => {
  test('every stage is pending there: local, the "not on main" line, nothing built', async () => {
    const w = aworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': '-' }, { current: 'user-stories', progress: { Inception: 'Active' } }),
      main: null,
      branch: branchOf('requirements-analysis', 'user-stories'),
    })
    const { model } = await aload(w)
    expect(model.header.base).toBe('This intent is not on main yet')
    expect(itemOf(model, 'requirements-analysis')).toMatchObject({ landing: 'local', status: 'open', statusWord: 'local only' })
    expect(itemOf(model, 'user-stories')).toMatchObject({ landing: 'local' })
    // Nothing is merged, but requirements-analysis is finished here: it counts, still drawn as local only.
    expect(itemOf(model, 'requirements-analysis').isFinishedLocal).toBe(true)
    expect(model.overall.counts.done).toBe(1)
    expect(sectionOf(model, 'INCEPTION').status).toBe('planned')
  })

  test('with a PR, the stage is in it', async () => {
    const w = aworld({
      local: state({ 'requirements-analysis': 'x' }),
      main: null,
      prs: [pr(5, branchOf('requirements-analysis'))],
      branch: branchOf('requirements-analysis'),
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'requirements-analysis')).toMatchObject({ landing: 'in-pr', statusWord: 'in review' })
    expect(model.header.base).toBe('This intent is not on main yet')
  })
})

describe('which PRs count', () => {
  test('a session on a stage branch only sees its own ticket; elsewhere every ticket counts', async () => {
    const other = pr(9, 'dev/SHOP-9/refined-mockups')
    const mine = aworld({ local: state({ 'refined-mockups': 'x' }), main: state({}), branch: branchOf('refined-mockups'), prs: [other] })
    expect(itemOf((await aload(mine)).model, 'refined-mockups').landing).toBe('local')
    const elsewhere = aworld({ local: state({ 'refined-mockups': 'x' }), main: state({}), branch: 'main', prs: [other] })
    expect(itemOf((await aload(elsewhere)).model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', statusWord: 'in review' })
  })

  test('closed PRs are ignored', async () => {
    const w = regression({ prs: [pr(33, branchOf('refined-mockups'), { state: 'CLOSED' })] })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'local' })
    expect(model.gates.map(gate => gate.kind)).toEqual(['parked'])
  })

  test('a PR merged before the intent started gives no chip', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x' }),
      main: state({ 'user-stories': 'x' }),
      prs: [pr(3, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-08-01T10:00:00Z' })],
    })
    const item = itemOf((await aload(w)).model, 'user-stories')
    expect(item).toMatchObject({ landing: 'merged', chips: [] })
  })

  test('without a parsable Start Date a merged PR counts whenever it merged', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x' }).replace(/- \*\*Start Date\*\*: .*/, '- **Start Date**: soon'),
      main: state({ 'user-stories': 'x' }),
      prs: [pr(3, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-08-01T10:00:00Z' })],
    })
    expect(itemOf((await aload(w)).model, 'user-stories').chips.map(chip => chip.label)).toEqual(['#3'])
  })

  test('a branch that is not a stage branch, or names no stage of the plan, is not a PR of the plan', async () => {
    const w = regression({ prs: [pr(33, branchOf('refined-mockups')), pr(70, 'hotfix/login'), pr(71, branchOf('not-a-stage')), pr(72, 'main')] })
    const { model } = await aload(w)
    expect(model.gates.map(gate => gate.id)).toEqual(['pr:33', 'parked'])
  })

  test('a stage branch pattern the person changed, and a fold separator, are honoured', async () => {
    const w = aworld({
      local: state({ 'refined-mockups': 'x', 'domain-design': 'x' }),
      main: state({}),
      branch: 'SHOP-7+refined-mockups+domain-design',
      prs: [pr(8, 'SHOP-7+refined-mockups+domain-design'), pr(9, 'SHOP-8+refined-mockups')],
    })
    const { model } = await aload(w, { stageBranchPattern: '^(?<ticket>SHOP-\\d+)\\+(?<stages>.+)$', foldSeparator: '+' })
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr', group: 'pr-8', statusWord: 'in review' })
    expect(itemOf(model, 'domain-design')).toMatchObject({ group: 'pr-8' })
  })
})

describe('the base line', () => {
  const at = (mainState: string, local = state({ 'refined-mockups': 'x', 'domain-design': '-' }), prs: Record<string, unknown>[] = []) =>
    aworld({ local, main: mainState, prs, branch: branchOf('domain-design') })

  test('main parked: where', async () => {
    const main = state({ 'refined-mockups': '-' }, { current: 'refined-mockups', parked: { at: 'refined-mockups', since: '2026-10-05T09:30:00Z' } })
    expect((await aload(at(main))).model.header.base).toBe('main: parked at refined-mockups')
  })

  test('main running its stage', async () => {
    expect((await aload(at(state({ 'refined-mockups': '-' }, { current: 'refined-mockups' })))).model.header.base).toBe('main: refined-mockups in progress')
  })

  test('main has not started it', async () => {
    expect((await aload(at(state({}, { current: 'refined-mockups' })))).model.header.base).toBe('main: refined-mockups not started')
  })

  test('main has finished it', async () => {
    expect((await aload(at(state({ 'refined-mockups': 'x' }, { current: 'refined-mockups' })))).model.header.base).toBe('main: refined-mockups merged')
  })

  test('same Current Stage and nothing local or in a PR: no line', async () => {
    const w = aworld({ local: state({ 'domain-design': '-' }), main: state({ 'domain-design': '-' }) })
    expect((await aload(w)).model.header).not.toHaveProperty('base')
  })
})

describe('the fetch of the PR list is shared', () => {
  test('a second load within a minute reuses the list; after a minute it asks again', async () => {
    const s = ascripted(regression())
    const detection = await aidlc.detect(s.ctx)
    if (!detection) throw new Error('expected a detection')
    await aidlc.load(s.ctx, detection)
    await aidlc.load(s.ctx, detection)
    expect(prLines(s.lines())).toHaveLength(1)
    await aidlc.load({ ...s.ctx, now: NOW + 61_000 }, detection)
    expect(prLines(s.lines())).toHaveLength(2)
  })
})

describe('prs.ts', () => {
  const host = (w: AWorld) => ascripted(w).host

  test('refOf spells the forge\'s reference', () => {
    expect(refOf(33)).toBe('#33')
  })

  test('rows are read defensively: malformed ones dropped, optional fields defaulted', async () => {
    const w = aworld({
      prs: [
        pr(1, 'a/b/c'),
        { number: 'x' },
        null as unknown as Record<string, unknown>,
        pr(2, 'a/b/d', { state: 'WEIRD' }),
        pr(3, '', {}),
        { number: 4, title: 't', state: 'OPEN', headRefName: 'a/b/e' },
      ],
    })
    const rows = await listChanges(host(w), REPO, NOW)
    expect(rows?.map(row => row.number)).toEqual([1, 4])
    expect(rows?.[1]).toEqual({
      number: 4,
      title: 't',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'a/b/e',
      headRefOid: '',
      reviewDecision: '',
      mergeStateStatus: '',
      failingChecks: [],
      mergedAt: null,
      url: '',
      review: { author: '', requested: [], requestedTeams: [], reviews: [], slack: null },
    })
  })

  test('null when gh fails, or answers something that is not a list', async () => {
    expect(await listChanges(host(aworld({ prs: null })), REPO, NOW)).toBeNull()
    expect(await listChanges(host(aworld({ isGhUp: false })), REPO, NOW)).toBeNull()
    const odd = host(aworld())
    const run = odd.run
    odd.run = async (argv, init) => (argv[0] === 'gh' ? { exitCode: 0, stdout: '{"not":"a list"}', stderr: '' } : run(argv, init))
    resetCache()
    expect(await listChanges(odd, REPO, NOW)).toBeNull()
  })

  test('the failing checks: failed conclusions and error states only, each name once', async () => {
    const rollup = [
      { conclusion: 'FAILURE', name: 'build' },
      { conclusion: 'FAILURE', name: 'build' },
      { conclusion: 'ACTION_REQUIRED', name: 'approve' },
      { conclusion: 'STARTUP_FAILURE', name: 'boot' },
      { conclusion: 'NEUTRAL', name: 'info' },
      { conclusion: 'SKIPPED', name: 'skipped' },
      { state: 'FAILURE', context: 'ci/legacy' },
      { state: 'PENDING', context: 'ci/pending' },
      { state: 'SUCCESS', context: 'ci/ok' },
      'junk',
    ]
    const rows = await listChanges(host(aworld({ prs: [pr(1, 'a/b/c', { statusCheckRollup: rollup })] })), REPO, NOW)
    expect(rows?.[0]?.failingChecks).toEqual(['build', 'approve', 'boot', 'ci/legacy'])
  })

  test('changedFiles: cached by number and head commit; [] on failure', async () => {
    const s = ascripted(aworld({ files: { 7: ['a.md', 'b/c.md'] } }))
    const row = { number: 7, headRefOid: 'one' } as StagePr
    expect(await changedFiles(s.host, REPO, row, NOW)).toEqual(['a.md', 'b/c.md'])
    expect(await changedFiles(s.host, REPO, row, NOW)).toEqual(['a.md', 'b/c.md'])
    expect(s.lines().filter(line => line.startsWith('gh pr view'))).toHaveLength(1)
    await changedFiles(s.host, REPO, { ...row, headRefOid: 'two' }, NOW)
    expect(s.lines().filter(line => line.startsWith('gh pr view'))).toHaveLength(2)
    expect(await changedFiles(s.host, REPO, { ...row, number: 8 }, NOW)).toEqual([])
  })
})

describe('truths.ts, on plain data', () => {
  const two = (over: Partial<Two> = {}): Two => ({
    refOf: n => `#${n}`,
    forgeKind: 'github',
    base: 'main',
    main: parseState(state({})),
    mapped: [],
    files: new Map(),
    prefix: PREFIX,
    sessionBranch: '',
    sessionStages: [],
    behind: 0,
    isPrsKnown: true,
    isPushed: false,
    current: '',
    quiet: new Set<string>(),
    ...over,
  })
  const row = (number: number, stages: string[], over: Partial<StagePr> = {}): { pr: StagePr; stages: string[] } => ({
    pr: { number, title: '', state: 'OPEN', isDraft: false, headRefName: branchOf(...stages), headRefOid: '', reviewDecision: '', mergeStateStatus: 'CLEAN', failingChecks: [], mergedAt: null, url: '', ...over },
    stages,
  })

  test('statusOfMarker: the box, unless the row is out of scope', () => {
    expect(statusOfMarker('completed', true)).toBe('done')
    expect(statusOfMarker('completed', false)).toBe('skipped')
    expect(statusOfMarker('skipped', true)).toBe('skipped')
    expect(statusOfMarker('awaiting-approval', true)).toBe('awaiting')
    expect(statusOfMarker('pending', true)).toBe('planned')
  })

  test('a PR without a url draws a chip without an href', () => {
    const local = parseState(state({ 'refined-mockups': 'x' }))
    const out = derive(local, two({ mapped: [row(5, ['refined-mockups'])] }))
    expect(out.items.get('refined-mockups')?.chips).toEqual([{ kind: 'pr', label: '#5', tone: 'accent' }])
    expect(out.gates[0]).not.toHaveProperty('href')
  })

  test('a PR whose every stage is already on main holds nothing back: no gate, a reopen chip', () => {
    const local = parseState(state({ 'user-stories': 'x' }))
    const main = parseState(state({ 'user-stories': 'x' }))
    const out = derive(local, two({ main, mapped: [row(6, ['user-stories'])] }))
    expect(out.gates).toEqual([])
    expect(out.holds).toEqual([])
    expect(out.items.get('user-stories')?.chips.map(chip => chip.kind)).toEqual(['reopen'])
    expect(out.items.get('user-stories')?.status).toBe('reopened')
  })

  test('mapPrs keeps only stages that are rows, in plan order, and drops a merged PR with no merge time when the intent has a start', () => {
    const order = ['user-stories', 'refined-mockups']
    const o = { ...OPTIONS, ticket: null, startMs: Date.parse('2026-08-25T00:00:00Z') }
    const open = row(1, ['refined-mockups', 'user-stories', 'nope']).pr
    const undated = row(2, ['user-stories'], { state: 'MERGED', mergedAt: null }).pr
    expect(mapPrs([open, undated], order, o).map(m => m.stages)).toEqual([['user-stories', 'refined-mockups']])
  })

  test('baseLine is empty when main stands where the session does', () => {
    const local = parseState(state({}, { current: 'domain-design' }))
    const t2 = two({ main: parseState(state({}, { current: 'domain-design' })) })
    expect(baseLine(local, t2, derive(local, t2), 'domain-design')).toBe('')
  })
})

describe('a phase branch: one PR for a whole phase (docs/inception)', () => {
  test('an open PR from docs/inception carries every Inception stage: one group, the chip on the first, the word on all', async () => {
    const w = aworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x' }, { current: 'domain-design' }),
      main: state({}, { current: 'requirements-analysis' }),
      prs: [pr(50, 'docs/inception')],
    })
    const { model } = await aload(w)
    for (const id of INCEPTION) {
      expect(itemOf(model, id).group).toBe('pr-50')
      expect(itemOf(model, id).statusWord).toBe('in review')
    }
    expect(itemOf(model, INCEPTION[0]!).chips.map(chip => chip.label)).toEqual(['#50'])
    for (const id of INCEPTION.slice(1)) expect(itemOf(model, id).chips).toEqual([])
    // Construction's stages are not the phase's.
    expect(itemOf(model, 'functional-design')).not.toHaveProperty('group')
  })

  test('stages of the phase already on main stay merged: the phase PR is not a redo of them', async () => {
    const landed = { 'requirements-analysis': 'x', 'user-stories': 'x' }
    const w = aworld({
      local: state({ ...landed, 'refined-mockups': 'x' }, { current: 'domain-design' }),
      main: state(landed, { current: 'refined-mockups' }),
      prs: [pr(56, 'docs/inception')],
    })
    const { model } = await aload(w)
    for (const id of ['requirements-analysis', 'user-stories']) {
      expect(itemOf(model, id)).toMatchObject({ status: 'done', landing: 'merged' })
      expect(itemOf(model, id)).not.toHaveProperty('group')
    }
    for (const id of ['refined-mockups', 'domain-design', 'units-generation', 'contract-design']) expect(itemOf(model, id).group).toBe('pr-56')
    // The chip sits on the first stage the PR still brings.
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['#56'])
  })

  test('a session on the phase branch does not reopen what already landed', async () => {
    const landed = { 'requirements-analysis': 'x', 'user-stories': 'x' }
    const w = aworld({ local: state(landed), main: state(landed), branch: 'docs/inception', prs: [] })
    const { model } = await aload(w)
    for (const id of ['requirements-analysis', 'user-stories']) expect(itemOf(model, id).status).toBe('done')
  })

  test('merged, it lands every Inception stage on main', async () => {
    const all = Object.fromEntries(INCEPTION.map(id => [id, 'x']))
    const w = aworld({ local: state(all), main: state(all), prs: [pr(51, 'docs/inception', { state: 'MERGED', mergedAt: MERGED_AT })] })
    const { model } = await aload(w)
    for (const id of INCEPTION) expect(itemOf(model, id)).toMatchObject({ status: 'done', landing: 'merged' })
    expect(INCEPTION.some(id => itemOf(model, id).chips.some(chip => chip.label === '#51'))).toBe(true)
  })

  test('a branch that only starts with a phase may be a part of it: it carries nothing', async () => {
    const w = aworld({ local: state({}), main: state({}), prs: [pr(55, 'inception/mvp-to-refined-mockups')] })
    const { model } = await aload(w)
    for (const id of INCEPTION) expect(itemOf(model, id).chips).toEqual([])
  })

  test('any case, any prefix, any phase: the last segment decides', async () => {
    const w = aworld({ local: state({}), main: state({}), prs: [pr(52, 'semka/Construction')] })
    const { model } = await aload(w)
    for (const id of CONSTRUCTION) expect(itemOf(model, id).group).toBe('pr-52')
    expect(itemOf(model, 'domain-design')).not.toHaveProperty('group')
  })

  test('a phase branch names no ticket, so a session on a stage branch still sees it', async () => {
    const w = aworld({ local: state({}), main: state({}), branch: branchOf('domain-design'), prs: [pr(53, 'docs/inception')] })
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories').group).toBe('pr-53')
  })

  test('a branch that names a stage maps to that stage, not its phase', async () => {
    const w = aworld({ local: state({}), main: state({}), prs: [pr(54, 'dev/SHOP-7/user-stories')] })
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories').chips.map(chip => chip.label)).toEqual(['#54'])
    expect(itemOf(model, 'domain-design').chips).toEqual([])
  })
})
