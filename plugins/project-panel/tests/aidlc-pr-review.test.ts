// Review state in the AI-DLC provider: the status word of a stage in an open PR, the rows tied to the viewer
// (under Needs attention only), the PR's own changes-requested gate speaking to its author, Next for the PR
// the current stage hangs on, the Slack thread chip, and what is asked of gh. A scripted git/gh world
// (tests/aidlc-world.ts) and the review scenarios of fixtures/review.ts; sanitised, no real names.
import { describe, expect, test } from 'claude-code/testing'
import { ME, OTHER, SCENARIOS, TEAM, TS, CHANNEL } from '../fixtures/review'
import type { ScenarioName } from '../fixtures/review'
import { aidlc } from '../src/providers/aidlc'
import type { Detection, PanelModel } from '../types'
import { OPTIONS } from './world'
import { REPO, REPO_URL, aload, ascripted, aworld, branchOf, itemOf, pr, state } from './aidlc-world'
import type { AWorld } from './aidlc-world'

const MERGED_AT = '2026-10-03T10:00:00Z'
const merged = (number: number, ...stages: string[]) => pr(number, branchOf(...stages), { state: 'MERGED', mergedAt: MERGED_AT })
/** The workspace enables the pr-review plugin, as a team workspace does. */
const SETTINGS = { [`${REPO}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'pr-review@acme': true } }) }

/** PR #33 carries refined-mockups in the given review state; domain-design is current and parked behind it. */
function world(name: ScenarioName, over: Partial<AWorld> = {}): AWorld {
  return aworld({
    local: state(
      { 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': 'x', 'domain-design': '-' },
      { current: 'domain-design', parked: { at: 'domain-design', since: '2026-10-06T09:30:00Z' } },
    ),
    main: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
    branch: branchOf('domain-design'),
    prs: [pr(33, branchOf('refined-mockups'), { ...SCENARIOS[name].raw }), merged(31, 'user-stories'), merged(30, 'requirements-analysis')],
    viewer: ME,
    extra: SETTINGS,
    ...over,
  })
}

const rowsOf = (model: PanelModel) => model.gates.filter(gate => gate.isAttentionOnly === true)

describe('the status word of a stage in an open PR, per review state', () => {
  for (const name of Object.keys(SCENARIOS) as ScenarioName[]) {
    test(`${name}: "${SCENARIOS[name].word}"`, async () => {
      const { model } = await aload(world(name))
      const item = itemOf(model, 'refined-mockups')
      expect(item.landing).toBe('in-pr')
      expect(item.statusWord).toBe(SCENARIOS[name].word)
      expect(item.review).toBe(SCENARIOS[name].state)
    })
  }

  test('without the pr-review plugin, nobody asked stays "in review" and has no review state', async () => {
    const { model } = await aload(world('unreviewed', { extra: {} }))
    const item = itemOf(model, 'refined-mockups')
    expect(item.statusWord).toBe('in review')
    expect(item).not.toHaveProperty('review')
  })

  test('the reviewCommands option overrides the settings either way', async () => {
    const on = await aload(world('unreviewed', { extra: {} }), { ...OPTIONS, reviewCommands: 'on' })
    expect(itemOf(on.model, 'refined-mockups').statusWord).toBe('no reviewer')
    const off = await aload(world('unreviewed'), { ...OPTIONS, reviewCommands: 'off' })
    expect(itemOf(off.model, 'refined-mockups').statusWord).toBe('in review')
  })
})

describe('the Now card\'s line about main', () => {
  test('says where the PR\'s review stands', async () => {
    expect((await aload(world('approvedComments'))).model.header.base).toBe('main: refined-mockups approved with comments, PR #33')
    expect((await aload(world('awaiting'))).model.header.base).toBe(`main: refined-mockups awaiting ${OTHER}, PR #33`)
  })

  test('"in review" where the review state has no word of its own', async () => {
    expect((await aload(world('unreviewed', { extra: {} }))).model.header.base).toBe('main: refined-mockups in review, PR #33')
  })
})

describe('the rows tied to the viewer', () => {
  test('a review asked of the viewer: the first gate, attention only, on the PR\'s stage, with the command', async () => {
    const { model } = await aload(world('awaitingYou'))
    expect(model.gates[0]).toEqual({
      id: 'you:review-requested:33',
      kind: 'review-requested',
      tone: 'accent',
      title: 'Your review is requested on PR #33',
      caption: `feat(SHOP-7): refined-mockups — by ${OTHER}`,
      sectionId: 'INCEPTION',
      afterItemId: 'refined-mockups',
      href: `${REPO_URL}/pull/33`,
      command: '/pr-review:review-pr 33',
      isAttentionOnly: true,
    })
    // The PR's own gates and the park follow, as before.
    expect(model.gates.slice(1).map(gate => gate.kind)).toEqual(['pr-not-merged', 'parked'])
  })

  test('a review asked of a team the viewer is in: the same row and Next; gh is asked for the teams once', async () => {
    const { model, s } = await aload(world('awaitingTeam', { teams: [TEAM.slug] }))
    expect(itemOf(model, 'refined-mockups').statusWord).toBe(`awaiting ${TEAM.name}`)
    expect(rowsOf(model).map(row => [row.title, row.command])).toEqual([['Your review is requested on PR #33', '/pr-review:review-pr 33']])
    expect(model.next?.command).toBe('/pr-review:review-pr 33')
    expect(s.lines().filter(line => line.startsWith('gh api user/teams'))).toHaveLength(1)
  })

  test('a team the viewer is not in, or teams gh cannot list: no row', async () => {
    for (const teams of [['acme/other-team'], undefined]) {
      const { model } = await aload(world('awaitingTeam', { teams }))
      expect(rowsOf(model)).toEqual([])
    }
  })

  test('no team asked: the teams are never looked up', async () => {
    const { s } = await aload(world('awaitingYou', { teams: [TEAM.slug] }))
    expect(s.lines().some(line => line.startsWith('gh api user/teams'))).toBe(false)
  })

  test('a PR outside the plan (another branch) still gets its row, with no place', async () => {
    const w = world('unreviewed')
    w.prs = [...(w.prs ?? []), pr(40, 'fix/typo-in-readme', { ...SCENARIOS.awaitingYou.raw })]
    const { model } = await aload(w)
    const row = rowsOf(model).find(gate => gate.id === 'you:review-requested:40')
    expect(row).toMatchObject({ sectionId: '', command: '/pr-review:review-pr 40' })
    expect(row).not.toHaveProperty('afterItemId')
  })

  test('the viewer\'s own PR, per state: the row and its command', async () => {
    const cases: [ScenarioName, string, string][] = [
      ['commented', 'Comments on your PR #33', '/pr-review:address-review 33'],
      ['stale', 'PR #33 changed since its approval', '/pr-review:address-review 33'],
      ['draft', 'Your draft PR #33 is not sent for review', '/pr-review:request-review 33'],
      ['approved', 'PR #33 approved', '/pr-review:address-review 33'],
      ['approvedComments', 'PR #33 approved with comments', '/pr-review:address-review 33'],
      ['unreviewed', 'PR #33 is not sent for review', '/pr-review:request-review 33'],
    ]
    for (const [name, title, command] of cases) {
      const { model } = await aload(world(name))
      expect(rowsOf(model).map(row => [row.title, row.command])).toEqual([[title, command]])
    }
  })

  test('no rows for a PR awaiting someone else, or a re-review asked of someone else', async () => {
    for (const name of ['awaiting', 'reReview'] as const) {
      const { model } = await aload(world(name))
      expect(rowsOf(model)).toEqual([])
    }
  })

  test('changes requested on the viewer\'s PR: the PR\'s own gate says "your" and carries the command, no second row', async () => {
    const { model } = await aload(world('changes'))
    expect(rowsOf(model)).toEqual([])
    const gate = model.gates.find(one => one.id === 'review:33')
    expect(gate).toMatchObject({
      kind: 'changes-requested',
      title: 'Changes requested on your PR #33',
      command: '/pr-review:address-review 33',
      sectionId: 'INCEPTION',
      afterItemId: 'refined-mockups',
    })
    expect(gate).not.toHaveProperty('isAttentionOnly')
  })

  test('without branch protection the review alone makes the changes-requested gate', async () => {
    const { model } = await aload(world('changesUnprotected'))
    expect(model.gates.map(gate => gate.kind)).toEqual(['pr-not-merged', 'changes-requested', 'parked'])
  })

  test('without a viewer (gh api user fails) there are no rows, but the words stay', async () => {
    const { model } = await aload(world('awaitingYou', { viewer: undefined }))
    expect(rowsOf(model)).toEqual([])
    expect(itemOf(model, 'refined-mockups').statusWord).toBe(`awaiting ${ME}`)
  })
})

describe('Next follows the PR the current stage hangs on', () => {
  test('parked behind PR #33, which asks the viewer for a review: review it', async () => {
    const { model } = await aload(world('awaitingYou'))
    expect(model.next).toEqual({ command: '/pr-review:review-pr 33', reason: 'Your review is requested on PR #33' })
  })

  test('the current stage is in the viewer\'s approved PR: merge it through address-review', async () => {
    const w = world('approved', {
      local: state({ 'requirements-analysis': 'x', 'user-stories': 'x', 'refined-mockups': '-' }, { current: 'refined-mockups' }),
      branch: branchOf('refined-mockups'),
    })
    const { model } = await aload(w)
    expect(model.next).toEqual({ command: '/pr-review:address-review 33', reason: 'PR #33 approved' })
  })

  test('any review of the viewer\'s PR: address it (changes, comments only, changed since approved, approved with comments)', async () => {
    for (const name of ['changes', 'commented', 'stale', 'approvedComments'] as const) {
      const { model } = await aload(world(name))
      expect(model.next?.command).toBe('/pr-review:address-review 33')
    }
  })

  test('nobody asked yet, draft or not: send it for review', async () => {
    for (const name of ['unreviewed', 'draft'] as const) {
      const { model } = await aload(world(name))
      expect(model.next?.command).toBe('/pr-review:request-review 33')
    }
  })

  test('a PR that waits on someone else, or no pr-review plugin: the engine\'s own /aidlc', async () => {
    for (const w of [world('awaiting'), world('approved', { extra: {} })]) {
      const { model } = await aload(w)
      expect(model.next).toEqual({ command: '/aidlc', reason: 'Execute the current stage' })
    }
  })
})

describe('the Slack thread', () => {
  test('a chip after the PR chip; presence only without a domain', async () => {
    const { model } = await aload(world('awaiting'))
    expect(itemOf(model, 'refined-mockups').chips).toEqual([
      { kind: 'pr', label: '#33', tone: 'accent', href: `${REPO_URL}/pull/33` },
      { kind: 'tag', label: 'Slack thread', tone: 'neutral' },
    ])
  })

  test('a permalink with the slackDomain option', async () => {
    const { model } = await aload(world('awaiting'), { ...OPTIONS, slackDomain: 'acme' })
    expect(itemOf(model, 'refined-mockups').chips[1]).toEqual({
      kind: 'tag',
      label: 'Slack thread',
      tone: 'neutral',
      href: `https://acme.slack.com/archives/${CHANNEL}/p${TS.replace('.', '')}`,
    })
  })

  test('no marker, no chip', async () => {
    const { model } = await aload(world('unreviewed'))
    expect(itemOf(model, 'refined-mockups').chips.map(chip => chip.label)).toEqual(['#33'])
  })
})

describe('what is asked of gh', () => {
  test('the open list carries the review fields; the viewer is asked once; no review call per PR', async () => {
    const { s } = await aload(world('awaitingYou'))
    const lines = s.lines()
    expect(lines.filter(line => line.startsWith('gh pr list --state open'))).toEqual([
      'gh pr list --state open --limit 100 --json number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests,latestReviews,body,author',
    ])
    expect(lines.filter(line => /^gh api user --hostname /.test(line))).toHaveLength(1)
    // The only per-PR call is the existing changed-files one for reopens; the review rides on the list.
    expect(lines.filter(line => line.startsWith('gh pr view')).every(line => line.endsWith('--json files'))).toBe(true)
  })

  test('no open PR: the viewer is not asked', async () => {
    const { s } = await aload(world('approved', { prs: [merged(31, 'user-stories')] }))
    expect(s.lines().some(line => line.startsWith('gh api user'))).toBe(false)
  })

  test('the store keeps the Slack thread, never a PR description', async () => {
    const s = ascripted(world('awaiting'))
    const kept = new Map<string, unknown>()
    s.host.store = { get: async key => kept.get(key), set: async (key, value) => void kept.set(key, value) }
    const detection = (await aidlc.detect(s.ctx)) as Detection
    await aidlc.load(s.ctx, detection)
    const rows = (kept.get(`aidlc.prs:${REPO}`) as { rows: Record<string, unknown>[] }).rows
    const row = rows.find(one => one.number === 33)
    expect((row?.review as { slack?: unknown } | undefined)?.slack).toEqual({ channel: CHANNEL, ts: TS })
    expect(JSON.stringify(rows)).not.toContain('What it does')
  })

  test('the fingerprint moves when a review is requested, given, or the marker appears', async () => {
    const digest = async (name: ScenarioName) => {
      const s = ascripted(world(name))
      const detection = (await aidlc.detect(s.ctx)) as Detection
      return (aidlc.fingerprint as NonNullable<typeof aidlc.fingerprint>)(s.ctx, detection)
    }
    const prints = await Promise.all((['unreviewed', 'awaiting', 'approved', 'approvedComments', 'stale'] as const).map(digest))
    expect(new Set(prints).size).toBe(5)
  })
})
