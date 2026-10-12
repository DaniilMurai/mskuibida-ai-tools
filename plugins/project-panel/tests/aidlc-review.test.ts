// Review fixes for the AI-DLC two truths (M3): when a behind-main gate is true, what a load costs, revising,
// stale refs, the split PR list, a gh that never works, conflicts and where a fold's chip sits.
import { describe, expect, test } from 'claude-code/testing'
import { ForgeError } from '../src/forge'
import { aidlc } from '../src/providers/aidlc'
import { changedFiles, defaultBranch, listChanges, resetCache } from '../src/providers/aidlc/prs'
import type { StagePr } from '../src/providers/aidlc/prs'
import type { Detection } from '../types'
import { NOW } from './world'
import { PREFIX, REPO, REPO_URL, aload, ascripted, aworld, branchOf, itemOf, pr, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const merged = (number: number, ...stages: string[]) => pr(number, branchOf(...stages), { state: 'MERGED', mergedAt: '2026-10-03T10:00:00Z' })
const kinds = (model: { gates: { kind: string }[] }) => model.gates.map(gate => gate.kind)
const listCalls = (lines: string[]) => lines.filter(line => line.startsWith('gh pr list --state open'))
const fetches = (lines: string[]) => lines.filter(line => line.includes(' fetch '))

/** A scripted context with the detection, for loading more than once. */
async function session(w: AWorld) {
  const s = ascripted(w)
  const detection = (await aidlc.detect(s.ctx)) as Detection
  const load = (now = NOW) => aidlc.load({ ...s.ctx, now }, detection)
  return { s, w, detection, load }
}

describe('behind main is only true for what has not landed', () => {
  test('a session branch whose stages are all merged on main has no behind gate and costs no rev-list', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x' }),
      main: state({ 'user-stories': 'x' }),
      branch: branchOf('user-stories'),
      prs: [merged(31, 'user-stories')],
      behind: 5,
    })
    const { model, s } = await aload(w)
    expect(model.gates).toEqual([])
    expect(s.lines().some(line => line.includes('rev-list'))).toBe(false)
  })

  test('a fold with one merged and one unmerged stage hangs the gate after the unmerged one', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': '-' }),
      main: state({ 'user-stories': 'x' }),
      branch: branchOf('user-stories', 'refined-mockups'),
      behind: 2,
    })
    const { model } = await aload(w)
    expect(model.gates).toHaveLength(1)
    expect(model.gates[0]).toMatchObject({ id: 'behind:session', afterItemId: 'refined-mockups' })
  })

  test('a stage whose merged PR the stale origin/main does not show yet counts as merged', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x' }),
      main: state({}),
      branch: branchOf('user-stories'),
      prs: [merged(31, 'user-stories')],
      behind: 5,
    })
    expect((await aload(w)).model.gates).toEqual([])
  })

  test('with an open PR whose merge state says CLEAN, the session is still counted with rev-list', async () => {
    const w = aworld({
      local: state({ 'refined-mockups': 'x' }),
      main: state({}),
      branch: branchOf('refined-mockups'),
      prs: [pr(33, branchOf('refined-mockups'), { mergeStateStatus: 'CLEAN' })],
      behind: 4,
    })
    const { model, s } = await aload(w)
    expect(s.lines()).toContain(`git -C ${REPO} rev-list --count HEAD..origin/main`)
    expect(kinds(model)).toEqual(['pr-not-merged', 'behind-main'])
    expect(model.gates[1]).toMatchObject({ id: 'behind:session', caption: '4 new commits on main; merge or rebase before it can land.' })
  })

  test('with a PR that is BEHIND, one behind gate per branch: the PR\'s, and no rev-list', async () => {
    const w = aworld({
      local: state({ 'refined-mockups': 'x' }),
      main: state({}),
      branch: branchOf('refined-mockups'),
      prs: [pr(33, branchOf('refined-mockups'), { mergeStateStatus: 'BEHIND' })],
      behind: 4,
    })
    const { model, s } = await aload(w)
    expect(model.gates.filter(gate => gate.kind === 'behind-main').map(gate => gate.id)).toEqual(['behind:33'])
    expect(s.lines().some(line => line.includes('rev-list'))).toBe(false)
  })
})

describe('what a load costs', () => {
  const parkedIntent = () =>
    aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' }, { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } }),
      main: state({ 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
      branch: branchOf('refined-mockups'),
      prs: [pr(33, branchOf('refined-mockups')), merged(31, 'user-stories')],
    })

  test('steady state: the second load asks git for the sha of origin/main and for how far behind the branch is, nothing else', async () => {
    const { s, load } = await session(parkedIntent())
    await load()
    s.host.runs.length = 0
    await load(NOW + 10_000)
    expect(s.lines()).toEqual([`git -C ${REPO} rev-parse --verify --quiet origin/main`, `git -C ${REPO} rev-list --count HEAD..origin/main`])
  })

  test('off a stage branch it is one process', async () => {
    const { s, load } = await session({ ...parkedIntent(), branch: 'main' })
    await load()
    s.host.runs.length = 0
    await load(NOW + 10_000)
    expect(s.lines()).toEqual([`git -C ${REPO} rev-parse --verify --quiet origin/main`])
  })

  test('the first load asks the static things once: top level, prefix, default branch, main\'s copy, the lists', async () => {
    const { s, load } = await session(parkedIntent())
    await load()
    const lines = s.lines()
    expect(lines.filter(line => line.endsWith('rev-parse --show-toplevel'))).toHaveLength(1)
    expect(lines.filter(line => line.endsWith('rev-parse --show-prefix'))).toHaveLength(1)
    expect(lines.filter(line => line.includes(' show origin/main:'))).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('gh repo view'))).toHaveLength(1)
    expect(listCalls(lines)).toHaveLength(1)
  })

  test('main\'s copy is read again only when origin/main moved', async () => {
    const { s, w, load } = await session(parkedIntent())
    await load()
    await load(NOW + 1_000)
    expect(s.lines().filter(line => line.includes(' show origin/main:'))).toHaveLength(1)
    w.localSha = 'bbbb2222'
    w.main = state({ 'user-stories': 'x', 'refined-mockups': 'x' }, { current: 'domain-design' })
    w.prs = [merged(33, 'refined-mockups'), merged(31, 'user-stories')]
    const model = await load(NOW + 2_000)
    expect(s.lines().filter(line => line.includes(' show origin/main:'))).toHaveLength(2)
    expect(itemOf(model, 'refined-mockups').landing).toBe('merged')
  })

  test('a failed PR list is retried once, then not asked again for 15 s', async () => {
    const { s, load } = await session({ ...parkedIntent(), prs: null })
    await load()
    expect(listCalls(s.lines())).toHaveLength(2)
    await load(NOW + 10_000)
    expect(listCalls(s.lines())).toHaveLength(2)
    await load(NOW + 16_000)
    expect(listCalls(s.lines())).toHaveLength(4)
  })

  test('a network that drops after a good read keeps the last PR list, not "local only"', async () => {
    const { w, load } = await session(parkedIntent())
    await load()
    w.isGhUp = false
    const later = await load(NOW + 61_000)
    const mockups = later.sections.flatMap(section => section.items).find(item => item.id === 'refined-mockups')
    expect(mockups?.landing).toBe('in-pr')
    expect(mockups?.chips.map(chip => chip.label)).toContain('#33')
  })

  test('a start during an outage uses the listing kept in the store', async () => {
    const first = ascripted(parkedIntent())
    const kept = new Map<string, unknown>()
    const withStore = { ...first.host, store: { get: async (key: string) => kept.get(key), set: async (key: string, value: unknown) => void kept.set(key, value) } }
    expect(await listChanges(withStore, REPO, NOW)).not.toBeNull()
    expect([...kept.keys()]).toEqual([`aidlc.prs:${REPO}`])
    resetCache()
    const down = ascripted({ ...parkedIntent(), isGhUp: false })
    const rows = await listChanges({ ...down.host, store: withStore.store }, REPO, NOW + 1)
    expect(rows?.map(row => row.number).sort()).toEqual([31, 33])
    expect(await listChanges(down.host, `${REPO}-other`, NOW + 1)).toBeNull()
  })

  test('a list call that fails once (a network that flaps) still gives the PRs', async () => {
    const { model } = await aload({ ...parkedIntent(), listFlaps: 1 })
    const mockups = model.sections.flatMap(section => section.items).find(item => item.id === 'refined-mockups')
    expect(mockups?.landing).toBe('in-pr')
    expect(mockups?.chips.map(chip => chip.label)).toContain('#33')
  })

  test('a failed changedFiles answers [] and is not asked again for a minute', async () => {
    const s = ascripted(aworld({ files: {} }))
    const row = { number: 9, headRefOid: 'x' } as StagePr
    expect(await changedFiles(s.host, REPO, row, NOW)).toEqual([])
    expect(await changedFiles(s.host, REPO, row, NOW + 30_000)).toEqual([])
    expect(s.lines().filter(line => line.startsWith('gh pr view'))).toHaveLength(1)
    await changedFiles(s.host, REPO, row, NOW + 61_000)
    expect(s.lines().filter(line => line.startsWith('gh pr view'))).toHaveLength(2)
  })

  test('a missing origin/main is fetched for once a minute at most', async () => {
    const { s, load } = await session(aworld({ hasRef: false, refAfterFetch: false }))
    await load()
    await load(NOW + 5_000)
    await load(NOW + 30_000)
    expect(fetches(s.lines())).toHaveLength(1)
    await load(NOW + 61_000)
    expect(fetches(s.lines())).toHaveLength(2)
  })

  test('once it appears, the two truths are back', async () => {
    const { s, w, load } = await session({ ...aworld({ hasRef: false, refAfterFetch: false }), prs: [pr(33, branchOf('refined-mockups'))], local: state({ 'refined-mockups': 'x' }) })
    expect(itemOf(await load(), 'refined-mockups')).not.toHaveProperty('landing')
    w.hasRef = true
    expect(itemOf(await load(NOW + 1_000), 'refined-mockups').landing).toBe('in-pr')
    expect(s.lines().length).toBeGreaterThan(0)
  })
})

describe('revising', () => {
  const merged31 = merged(31, 'user-stories')

  test('[R] over main\'s completed is local work, revising, with the merged PR chip kept', async () => {
    const w = aworld({ local: state({ 'user-stories': 'R' }), main: state({ 'user-stories': 'x' }), prs: [merged31], branch: 'main' })
    const item = itemOf((await aload(w)).model, 'user-stories')
    expect(item).toMatchObject({ landing: 'local', status: 'revising', statusWord: 'local only' })
    expect(item.chips).toEqual([{ kind: 'pr', label: '#31', tone: 'success', href: `${REPO_URL}/pull/31` }])
  })

  test('[R] over main\'s awaiting or in-progress is local too', async () => {
    for (const marker of ['?', '-']) {
      const w = aworld({ local: state({ 'user-stories': 'R' }), main: state({ 'user-stories': marker }), branch: 'main' })
      expect(itemOf((await aload(w)).model, 'user-stories')).toMatchObject({ landing: 'local', status: 'revising' })
    }
  })

  test('[R] on both sides is main\'s own status, nothing extra', async () => {
    const w = aworld({ local: state({ 'user-stories': 'R' }), main: state({ 'user-stories': 'R' }), branch: 'main' })
    const item = itemOf((await aload(w)).model, 'user-stories')
    expect(item.status).toBe('revising')
    expect(item).not.toHaveProperty('landing')
  })

  test('a LOWER box here over main\'s completed is a stale branch: main wins', async () => {
    for (const marker of [' ', '-', '?']) {
      const w = aworld({ local: state({ 'user-stories': marker }), main: state({ 'user-stories': 'x' }), branch: 'main' })
      expect(itemOf((await aload(w)).model, 'user-stories')).toMatchObject({ landing: 'merged', status: 'done' })
    }
  })

  test('[R] in an open PR is in the PR, revising', async () => {
    const w = aworld({ local: state({ 'user-stories': 'R' }), main: state({ 'user-stories': 'x' }), prs: [merged31, pr(45, branchOf('user-stories'))], branch: branchOf('user-stories') })
    const item = itemOf((await aload(w)).model, 'user-stories')
    expect(item).toMatchObject({ landing: 'in-pr', status: 'revising', statusWord: 'in review' })
    expect(item.chips.map(chip => chip.label)).toEqual(['#31'])
  })
})

describe('the PR list follows the default branch', () => {
  test('when origin/main moves, the next load refetches the list: a reopen chip does not outlive its PR', async () => {
    const w = aworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }),
      main: state({ 'requirements-analysis': 'x', 'user-stories': 'x' }),
      branch: branchOf('domain-design'),
      prs: [pr(41, branchOf('domain-design')), merged(31, 'user-stories')],
      files: { 41: [`${PREFIX}inception/user-stories/stories.md`] },
    })
    const { s, w: world, load } = await session(w)
    expect(itemOf(await load(), 'user-stories').chips.map(chip => chip.kind)).toEqual(['pr', 'reopen'])
    await load(NOW + 5_000)
    expect(listCalls(s.lines())).toHaveLength(1)

    world.localSha = 'bbbb2222'
    world.prs = [merged(41, 'domain-design'), merged(31, 'user-stories')]
    const after = await load(NOW + 10_000)
    expect(listCalls(s.lines())).toHaveLength(2)
    expect(itemOf(after, 'user-stories').chips.map(chip => chip.kind)).toEqual(['pr'])
  })
})

describe('the PR list is two queries', () => {
  test('open with the review, merge and check fields; merged without them', async () => {
    const { s } = await aload(aworld({ prs: [] }))
    const [open, mergedQuery] = s.lines().filter(line => line.startsWith('gh pr list'))
    expect(open).toContain('--state open --limit 100')
    expect(open).toContain('statusCheckRollup')
    expect(open).toContain('reviewDecision')
    expect(open).toContain('mergeStateStatus')
    expect(mergedQuery).toContain('--state merged --limit 200')
    expect(mergedQuery).not.toContain('statusCheckRollup')
    expect(mergedQuery).not.toContain('reviewDecision')
  })

  test('both feed the model: an open PR\'s gates, a merged PR\'s chip', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x' }),
      main: state({ 'user-stories': 'x' }),
      prs: [pr(33, branchOf('refined-mockups'), { reviewDecision: 'CHANGES_REQUESTED' }), merged(31, 'user-stories')],
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories').chips.map(chip => chip.label)).toEqual(['#31'])
    expect(kinds(model)).toEqual(['pr-not-merged', 'changes-requested'])
  })

  test('one of the two failing is a failed list', async () => {
    const s = ascripted(aworld({ prs: [pr(33, branchOf('refined-mockups'))] }))
    const run = s.host.run
    s.host.run = async (argv, init) => (argv.includes('merged') ? { exitCode: 1, stdout: '', stderr: '' } : run(argv, init))
    const detection = (await aidlc.detect(s.ctx)) as Detection
    const model = await aidlc.load(s.ctx, detection)
    expect(kinds(model)).not.toContain('pr-not-merged')
  })
})

describe('a gh that does not work', () => {
  const fingerprint = async (s: ReturnType<typeof ascripted>) => {
    const detection = (await aidlc.detect(s.ctx)) as Detection
    return (aidlc.fingerprint as NonNullable<typeof aidlc.fingerprint>)(s.ctx, detection)
  }

  test('where gh never answered, the fingerprint is the tip alone: no throw, and it still moves with the tip', async () => {
    const a = await fingerprint(ascripted(aworld({ isGhUp: false, remoteSha: 'aaaa1111' })))
    const b = await fingerprint(ascripted(aworld({ isGhUp: false, remoteSha: 'bbbb2222' })))
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
    expect(await fingerprint(ascripted(aworld({ isGhUp: false, remoteSha: 'aaaa1111' })))).toBe(a)
  })

  test('it still fetches the default branch when its tip moved', async () => {
    const s = ascripted(aworld({ isGhUp: false, remoteSha: 'bbbb2222', localSha: 'aaaa1111' }))
    await fingerprint(s)
    expect(fetches(s.lines())).toHaveLength(1)
  })

  test('where gh worked before and now fails, it throws', async () => {
    const s = ascripted(aworld({ prs: [] }))
    await fingerprint(s)
    s.w.isGhUp = false
    const error = await fingerprint(s).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).display).toBe('Could not check pull requests (gh failed); they may be stale.')
  })

  test('the default branch: gh\'s answer is kept for minutes, the fallback for a minute', async () => {
    const down = ascripted(aworld({ base: 'develop', isGhUp: false }))
    expect(await defaultBranch(down.host, REPO, NOW)).toBe('main')
    down.w.isGhUp = true
    expect(await defaultBranch(down.host, REPO, NOW + 30_000)).toBe('main')
    expect(await defaultBranch(down.host, REPO, NOW + 61_000)).toBe('develop')
    down.w.isGhUp = false
    expect(await defaultBranch(down.host, REPO, NOW + 180_000)).toBe('develop')
    resetCache()
    expect(await defaultBranch(down.host, REPO, NOW)).toBe('main')
  })
})

describe('a merged PR the local origin/main has not caught up with', () => {
  test('the stage is merged and done, with the PR chip', async () => {
    const w = aworld({ local: state({ 'user-stories': 'x' }), main: state({}), prs: [merged(31, 'user-stories')], branch: 'main' })
    const { model } = await aload(w)
    expect(itemOf(model, 'user-stories')).toMatchObject({ landing: 'merged', status: 'done', chips: [{ kind: 'pr', label: '#31' }] })
    expect(model.overall.counts.done).toBe(1)
  })

  test('not when it merged before the intent started, and not over a stage main is revising', async () => {
    const early = aworld({
      local: state({ 'user-stories': 'x' }),
      main: state({}),
      prs: [pr(3, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-08-01T10:00:00Z' })],
      branch: 'main',
    })
    expect(itemOf((await aload(early)).model, 'user-stories').landing).toBe('local')
    const revising = aworld({ local: state({ 'user-stories': 'x' }), main: state({ 'user-stories': 'R' }), prs: [merged(31, 'user-stories')], branch: 'main' })
    expect(itemOf((await aload(revising)).model, 'user-stories').landing).not.toBe('merged')
  })

  test('an open PR for the next stage no longer blocks on it', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x' }),
      main: state({}),
      prs: [merged(31, 'user-stories'), pr(33, branchOf('refined-mockups'))],
      branch: branchOf('refined-mockups'),
    })
    const { model } = await aload(w)
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ landing: 'in-pr' })
    expect(model.gates[0]).toMatchObject({ id: 'pr:33' })
  })
})

describe('conflicts', () => {
  test('a DIRTY PR gets a gate after the PR\'s last stage, an error, after behind-main', async () => {
    const w = aworld({
      local: state({ 'refined-mockups': 'x', 'domain-design': 'x' }),
      main: state({}),
      branch: branchOf('refined-mockups', 'domain-design'),
      prs: [pr(33, branchOf('refined-mockups', 'domain-design'), { mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' })],
    })
    const { model } = await aload(w)
    expect(kinds(model)).toEqual(['pr-not-merged', 'changes-requested', 'conflicts'])
    expect(model.gates[2]).toEqual({
      id: 'conflicts:33',
      kind: 'conflicts',
      tone: 'error',
      title: 'PR #33 has conflicts with main',
      caption: 'Resolve them before it can merge.',
      sectionId: 'INCEPTION',
      afterItemId: 'domain-design',
      href: `${REPO_URL}/pull/33`,
    })
  })

  test('a clean or blocked PR has none', async () => {
    for (const mergeStateStatus of ['CLEAN', 'BLOCKED', 'UNSTABLE', 'UNKNOWN']) {
      const w = aworld({ local: state({ 'refined-mockups': 'x' }), main: state({}), prs: [pr(33, branchOf('refined-mockups'), { mergeStateStatus })], branch: 'main' })
      expect(kinds((await aload(w)).model)).not.toContain('conflicts')
    }
  })
})

describe('where a fold\'s chips sit', () => {
  test('on the first stage of the group that is not merged on main', async () => {
    const w = aworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': 'x' }),
      main: state({ 'user-stories': 'x' }),
      branch: branchOf('user-stories', 'refined-mockups', 'domain-design'),
      prs: [pr(40, branchOf('user-stories', 'refined-mockups', 'domain-design'), { reviewDecision: 'CHANGES_REQUESTED' })],
    })
    const { model } = await aload(w)
    // Merged once, carried again by the fold: reopened, not done.
    expect(itemOf(model, 'user-stories')).toMatchObject({ status: 'reopened' })
    expect(itemOf(model, 'user-stories')).not.toHaveProperty('landing')
    expect(itemOf(model, 'user-stories').chips.map(chip => chip.kind)).toEqual(['reopen'])
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['#40'])
    expect(itemOf(model, 'refined-mockups').statusWord).toBe('changes requested')
    expect(itemOf(model, 'domain-design').chips).toEqual([])
    expect(itemOf(model, 'refined-mockups').group).toBe('pr-40')
    expect(itemOf(model, 'domain-design').group).toBe('pr-40')
  })
})
