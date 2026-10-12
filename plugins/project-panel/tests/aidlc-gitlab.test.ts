// The AI-DLC provider on a self-hosted GitLab (glab, through the forge layer): `!N` chips, merge-request wording,
// the gates from a merge request's pipeline, approvals and merge state, and the fingerprint. glab answers from
// fixtures/forge/* (tests/aidlc-world.ts); host gitlab.example.test, project acme/platform/scanner.
import { describe, expect, test } from 'claude-code/testing'
import { ForgeError } from '../src/forge'
import { aidlc } from '../src/providers/aidlc'
import { en } from '../src/strings/en'
import type { Detection } from '../types'
import { GITLAB_HOST, GITLAB_WEB, REPO, aload, ascripted, aworld, branchOf, gitlabAworld, itemOf, mr, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const MERGED_AT = '2026-10-03T10:00:00Z'
const merged = (iid: number, ...stages: string[]) => mr(iid, branchOf(...stages), { state: 'merged', merged_at: MERGED_AT, detailed_merge_status: '' })
const kinds = (model: { gates: { kind: string }[] }) => model.gates.map(gate => gate.kind)
const href = (iid: number) => `${GITLAB_WEB}/-/merge_requests/${iid}`

/** user-stories and requirements-analysis are on main, refined-mockups is in !33, domain-design only in this worktree. */
function regression(over: Partial<AWorld> = {}): AWorld {
  return gitlabAworld({
    local: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' },
      { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } },
    ),
    main: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
    branch: branchOf('refined-mockups'),
    mrs: [mr(33, branchOf('refined-mockups')), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
    ...over,
  })
}

const open33 = (over: Parameters<typeof mr>[2] = {}, extra: Partial<AWorld> = {}) =>
  regression({ mrs: [mr(33, branchOf('refined-mockups'), over), merged(31, 'user-stories'), merged(30, 'requirements-analysis')], ...extra })

describe('AI-DLC on a self-hosted GitLab', () => {
  test('chips are !N and link to the merge request; the words say merge request', async () => {
    const { model } = await aload(regression())
    expect(itemOf(model, 'refined-mockups')).toMatchObject({
      landing: 'in-pr',
      status: 'open',
      statusWord: 'in review',
      chips: [{ kind: 'pr', label: '!33', tone: 'accent', href: href(33) }],
    })
    expect(itemOf(model, 'user-stories').chips).toEqual([{ kind: 'pr', label: '!31', tone: 'success', href: href(31) }])
    expect(model.header.base).toBe('main: refined-mockups in review, MR !33')
    expect(model.gates[0]).toMatchObject({ id: 'pr:33', kind: 'pr-not-merged', title: 'MR !33 not merged', href: href(33) })
    expect(model.gates[1]?.caption).toBe('Waiting on MR !33 to merge; parked 2026-10-06 09:30. Resume with /aidlc once it lands.')
  })

  test('no chip, title, caption or base line spells a GitLab number with #', async () => {
    const worlds = [
      regression(),
      open33({ detailed_merge_status: 'need_rebase' }),
      open33({ detailed_merge_status: 'conflict' }),
      open33({ detailed_merge_status: 'requested_changes' }),
      open33({}, { pipelines: { 33: 'failed' } }),
    ]
    for (const w of worlds) {
      const { model } = await aload(w)
      const texts = [
        model.header.base ?? '',
        ...model.gates.flatMap(g => [g.title, g.caption ?? '']),
        ...model.sections.flatMap(s => s.items.flatMap(i => [i.statusWord ?? '', ...i.chips.map(c => c.label)])),
      ]
      expect(texts.filter(text => text.includes('#'))).toEqual([])
      expect(texts.some(text => text.includes('PR '))).toBe(false)
    }
  })

  test('a failed pipeline is a CI-failing gate and chip; a running or green one is not', async () => {
    const { model } = await aload(open33({}, { pipelines: { 33: 'failed' } }))
    expect(kinds(model)).toEqual(['pr-not-merged', 'ci-failing', 'parked'])
    expect(model.gates[1]).toMatchObject({ id: 'ci:33', tone: 'error', title: 'CI failing on MR !33', caption: 'Failing: pipeline', href: href(33) })
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['!33', 'CI failing'])
    for (const status of ['running', 'success', 'pending', null] as const) {
      expect(kinds((await aload(open33({}, { pipelines: { 33: status } }))).model)).toEqual(['pr-not-merged', 'parked'])
    }
  })

  test('requested changes: the status word and a gate; the approval lookup is skipped', async () => {
    const { model, s } = await aload(open33({ detailed_merge_status: 'requested_changes' }))
    expect(kinds(model)).toEqual(['pr-not-merged', 'changes-requested', 'parked'])
    expect(model.gates[1]).toMatchObject({ id: 'review:33', title: 'Changes requested on MR !33' })
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['!33'])
    expect(itemOf(model, 'refined-mockups')).toMatchObject({ statusWord: 'changes requested', review: 'changes' })
    expect(s.lines().some(line => line.endsWith('/merge_requests/33/approvals'))).toBe(false)
  })

  test('need_rebase is a behind-main gate on the merge request; the session is not asked how far behind it is', async () => {
    const { model, s } = await aload(open33({ detailed_merge_status: 'need_rebase' }, { behind: 4 }))
    expect(kinds(model)).toEqual(['pr-not-merged', 'behind-main', 'parked'])
    expect(model.gates[1]).toMatchObject({
      id: 'behind:33',
      title: 'dev/SHOP-7/refined-mockups is behind main',
      caption: 'MR !33 is out of date with main; update the branch.',
    })
    expect(s.lines().some(line => line.includes('rev-list --count'))).toBe(false)
  })

  test('a conflict is an error gate on the merge request', async () => {
    const { model } = await aload(open33({ detailed_merge_status: 'conflict' }))
    expect(kinds(model)).toEqual(['pr-not-merged', 'conflicts', 'parked'])
    expect(model.gates[1]).toMatchObject({ id: 'conflicts:33', tone: 'error', title: 'MR !33 has conflicts with main' })
  })

  test('a draft merge request: the draft chip and word', async () => {
    const item = itemOf((await aload(open33({ draft: true }))).model, 'refined-mockups')
    expect(item.statusWord).toBe('in draft')
    expect(item.chips).toEqual([{ kind: 'pr', label: '!33 draft', tone: 'neutral', href: href(33) }])
  })

  test('pushed work with no merge request says "pushed, no MR"', async () => {
    const w = gitlabAworld({
      local: state({ 'user-stories': 'x', 'refined-mockups': '-' }),
      main: state({ 'user-stories': 'x' }, { current: 'user-stories' }),
      branch: branchOf('refined-mockups'),
      pushed: [branchOf('refined-mockups')],
    })
    expect(itemOf((await aload(w)).model, 'refined-mockups')).toMatchObject({ landing: 'local', statusWord: 'pushed, no MR' })
  })

  test('an open merge request touching an earlier stage reopens it (!N), by its diffs', async () => {
    const w = gitlabAworld({
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'domain-design': '-' }),
      main: state({ 'requirements-analysis': 'x', 'user-stories': 'x' }),
      branch: branchOf('domain-design'),
      mrs: [mr(41, branchOf('domain-design')), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
      files: { 41: ['aidlc/spaces/default/intents/261006-shop-mvp/inception/user-stories/stories.md'] },
    })
    const { model, s } = await aload(w)
    expect(itemOf(model, 'user-stories').chips.map(chip => [chip.kind, chip.label])).toEqual([
      ['pr', '!31'],
      ['reopen', '↺ reopened in !41'],
    ])
    expect(s.lines()).toContain(`glab api --hostname ${GITLAB_HOST} projects/${encodeURIComponent('acme/platform/scanner')}/merge_requests/41/diffs?per_page=100`)
  })

  test('the commands: glab only, open with status and merged without, the web address from the origin, no gh', async () => {
    const { s } = await aload(open33({}, { pipelines: { 33: 'running' } }))
    const lines = s.lines()
    expect(lines.filter(line => line.startsWith('glab mr list'))).toEqual([
      `glab mr list -R ${GITLAB_WEB} -F json -P 100 -p 1`,
      `glab mr list -R ${GITLAB_WEB} --merged -F json -P 100 -p 1`,
    ])
    expect(lines).toContain(`glab mr view 33 -R ${GITLAB_WEB} -F json`)
    expect(lines.filter(line => line.startsWith('glab mr view'))).toHaveLength(1)
    expect(lines).toContain(`glab auth status --hostname ${GITLAB_HOST}`)
    expect(lines.some(line => line.startsWith('gh '))).toBe(false)
    expect(lines.some(line => line.includes(' --all'))).toBe(false)
  })

  test('the default branch is the project\'s own, from glab', async () => {
    const { s } = await aload(open33({}, { base: 'trunk', branch: branchOf('refined-mockups'), local: state({}), main: state({}) }))
    expect(s.lines()).toContain(`git -C ${REPO} show origin/trunk:aidlc/spaces/default/intents/261006-shop-mvp/aidlc-state.md`)
  })

  test('a list call that fails once (a flapping network) still gives the merge requests', async () => {
    const { model } = await aload(regression({ mrFlaps: 1 }))
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['!33'])
  })

  test('glab not logged in from the start: the merge requests are unknown, not absent', async () => {
    const { model } = await aload(regression({ isGlabAuthed: false, isGlabUp: false }))
    expect(model.gates.map(g => g.kind)).not.toContain('pr-not-merged')
    expect(itemOf(model, 'refined-mockups').chips).toEqual([])
  })
})

describe('AI-DLC fingerprint on GitLab', () => {
  const fingerprint = async (s: ReturnType<typeof ascripted>) => {
    const detection = (await aidlc.detect(s.ctx)) as Detection
    return (aidlc.fingerprint as NonNullable<typeof aidlc.fingerprint>)(s.ctx, detection)
  }
  const digest = async (w: AWorld) => fingerprint(ascripted(w))

  test('the same world gives the same digest; a new merge request, a merge, a push, a red pipeline or a review each move it', async () => {
    const first = await digest(regression())
    expect(first).not.toBe('')
    expect(await digest(regression())).toBe(first)
    const moves: Partial<AWorld>[] = [
      { mrs: [...regression().mrs, mr(34, branchOf('domain-design'))] },
      { mrs: [mr(33, branchOf('refined-mockups'), { state: 'merged', merged_at: MERGED_AT }), merged(31, 'user-stories'), merged(30, 'requirements-analysis')] },
      { mrs: [mr(33, branchOf('refined-mockups'), { sha: 'new-head' }), merged(31, 'user-stories'), merged(30, 'requirements-analysis')] },
      { pipelines: { 33: 'failed' } },
      { mrs: [mr(33, branchOf('refined-mockups'), { detailed_merge_status: 'requested_changes' }), merged(31, 'user-stories'), merged(30, 'requirements-analysis')] },
    ]
    for (const over of moves) expect(await digest(regression(over))).not.toBe(first)
    // A green or running pipeline changes nothing the panel draws, so it does not move the digest.
    expect(await digest(regression({ pipelines: { 33: 'success' } }))).toBe(first)
  })

  test('the fingerprint costs one pipeline lookup per open merge request and no approvals; the load asks for the full status', async () => {
    const s = ascripted(regression())
    const detection = (await aidlc.detect(s.ctx)) as Detection
    await aidlc.fingerprint?.(s.ctx, detection)
    const fp = s.lines()
    expect(fp.filter(line => line.startsWith('glab mr view'))).toHaveLength(1)
    expect(fp.some(line => line.endsWith('/approvals'))).toBe(false)
    s.host.runs.length = 0
    const model = await aidlc.load({ ...s.ctx, now: s.ctx.now + 5_000 }, detection)
    expect(s.lines().filter(line => line.endsWith('/approvals'))).toHaveLength(1)
    expect(model.gates.length).toBeGreaterThan(0)
  })

  test('where glab worked and now is not logged in, it throws a ForgeError with the merge-request line', async () => {
    const s = ascripted(regression())
    await fingerprint(s)
    s.w.isGlabUp = false
    s.w.isGlabAuthed = false
    const error = await fingerprint(s).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).message).toBe(`glab not logged in to ${GITLAB_HOST}`)
    expect((error as ForgeError).display).toBe(`Could not check merge requests (glab not logged in to ${GITLAB_HOST}); they may be stale.`)
  })

  test('where glab is logged in but fails, the cause is "glab failed"', async () => {
    const s = ascripted(regression())
    await fingerprint(s)
    s.w.isGlabUp = false
    const error = await fingerprint(s).catch((e: unknown) => e)
    expect((error as ForgeError).display).toBe('Could not check merge requests (glab failed); they may be stale.')
  })

  test('where glab never answered, the digest is the tip alone: no throw, and it still moves with the tip', async () => {
    const a = await digest(regression({ isGlabAuthed: false, isGlabUp: false, remoteSha: 'aaaa1111' }))
    const b = await digest(regression({ isGlabAuthed: false, isGlabUp: false, remoteSha: 'bbbb2222' }))
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })

  test('the forge option is honoured by the default branch: none asks neither glab nor gh', async () => {
    const s = ascripted(regression(), { ...ascripted(regression()).ctx.options, forge: 'none' })
    const detection = (await aidlc.detect(s.ctx)) as Detection
    await aidlc.load(s.ctx, detection)
    await aidlc.fingerprint?.(s.ctx, detection)
    expect(s.lines().filter(line => line.startsWith('glab ') || line.startsWith('gh '))).toEqual([])
  })

  test('a GitHub world still goes through gh (no glab probe), and the forge option can force GitLab', async () => {
    const hub = ascripted(aworld({ prs: [] }))
    await fingerprint(hub)
    expect(hub.lines().some(line => line.startsWith('glab '))).toBe(false)

    const forced = ascripted(aworld({ prs: [] }), { ...hub.ctx.options, forge: 'gitlab' })
    const detection = (await aidlc.detect(forced.ctx)) as Detection
    await aidlc.load(forced.ctx, detection)
    expect(forced.lines().some(line => line.startsWith('gh pr list'))).toBe(false)
  })
})

describe('the copy', () => {
  test('every key that says pull request has a merge-request twin, and no twin says pull request or PR', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('aidlc.'))
    const twins = keys.filter(key => key.endsWith('.gitlab'))
    expect(twins.length).toBeGreaterThan(5)
    for (const twin of twins) {
      expect(keys).toContain(twin.slice(0, -'.gitlab'.length))
      expect((en as Record<string, string>)[twin]).not.toMatch(/\bPRs?\b|pull request/i)
    }
    const needing = keys.filter(key => !key.endsWith('.gitlab') && /\bPRs?\b|pull request/.test((en as Record<string, string>)[key] ?? ''))
    expect(needing.filter(key => !twins.includes(`${key}.gitlab`))).toEqual([])
  })
})
