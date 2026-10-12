// Review state in the ledger provider: the status word of a task whose PR is open, the rows tied to the
// viewer, Next for the session's task, the Slack chip, and what is asked of gh and git. The reminders
// ledger (T04 is in PR #67) with the review scenarios of fixtures/review.ts on that PR.
import { describe, expect, test } from 'claude-code/testing'
import * as rem from '../fixtures/ledger/reminders'
import { ME, SCENARIOS, TEAM } from '../fixtures/review'
import type { ScenarioName } from '../fixtures/review'
import { ledger } from '../src/providers/ledger'
import type { Detection, PanelModel } from '../types'
import { OPTIONS } from './world'
import { REM_TRACKED, REPO, REPO_URL, itemOf, remWorld, load, scripted, withUrls } from './ledger-world'
import type { World } from './ledger-world'

const PHASE = 'phase-1-5-task-management-in-telegram'
const SETTINGS_PATH = '.claude/settings.json'
const SETTINGS = JSON.stringify({ enabledPlugins: { 'pr-review@acme': true } })

/** PR #67 (T04) in the given review state; the repository commits a settings file that enables pr-review. */
function world(name: ScenarioName, over: Partial<World> = {}, extra: World['prs'] = []): World {
  const base = remWorld()
  return remWorld({
    tracked: [...REM_TRACKED, SETTINGS_PATH],
    files: { ...base.files, [SETTINGS_PATH]: SETTINGS },
    prs: [...withUrls(rem.prs).map(p => (p.number === 67 ? { ...p, gh: { ...SCENARIOS[name].raw } } : p)), ...extra],
    viewer: ME,
    ...over,
  })
}

const rowsOf = (model: PanelModel) => model.gates.filter(gate => gate.isAttentionOnly === true)

describe('the status word of a task in an open PR, per review state', () => {
  for (const name of Object.keys(SCENARIOS) as ScenarioName[]) {
    test(`${name}: "${SCENARIOS[name].word}"`, async () => {
      const { model } = await load(world(name))
      expect(itemOf(model, 'T04')).toMatchObject({ status: 'open', statusWord: SCENARIOS[name].word, review: SCENARIOS[name].state })
    })
  }

  test('without the pr-review plugin, nobody asked keeps "in progress" (no word of its own)', async () => {
    const { model } = await load(world('unreviewed', { tracked: REM_TRACKED }))
    const item = itemOf(model, 'T04')
    expect(item).not.toHaveProperty('statusWord')
    expect(item).not.toHaveProperty('review')
  })

  test('done, failed and planned tasks carry no review word', async () => {
    const { model } = await load(world('approved'))
    for (const id of ['T03', 'T05', 'T06']) expect(itemOf(model, id)).not.toHaveProperty('review')
  })
})

describe('the rows tied to the viewer', () => {
  test('a review asked of the viewer sits on its task, attention only, with the command', async () => {
    const { model } = await load(world('awaitingYou'))
    expect(model.gates).toEqual([
      {
        id: 'you:review-requested:67',
        kind: 'review-requested',
        tone: 'accent',
        title: 'Your review is requested on PR #67',
        caption: 'feat(T04): act buttons on the detail card — by dev-b',
        sectionId: PHASE,
        afterItemId: 'T04',
        href: `${REPO_URL}/pull/67`,
        command: '/pr-review:review-pr 67',
        isAttentionOnly: true,
      },
    ])
  })

  test('the viewer\'s own PR: changes, comments, approved, not sent', async () => {
    const cases: [ScenarioName, string, string][] = [
      ['changes', 'Changes requested on your PR #67', '/pr-review:address-review 67'],
      ['commented', 'Comments on your PR #67', '/pr-review:address-review 67'],
      ['stale', 'PR #67 changed since its approval', '/pr-review:address-review 67'],
      ['draft', 'Your draft PR #67 is not sent for review', '/pr-review:request-review 67'],
      ['approvedComments', 'PR #67 approved with comments', '/pr-review:address-review 67'],
      ['approved', 'PR #67 approved', '/pr-review:address-review 67'],
      ['unreviewed', 'PR #67 is not sent for review', '/pr-review:request-review 67'],
    ]
    for (const [name, title, command] of cases) {
      const { model } = await load(world(name))
      expect(rowsOf(model).map(row => [row.title, row.command])).toEqual([[title, command]])
    }
  })

  test('a PR no task names still gets its row, with no place', async () => {
    const stray = { number: 80, title: 'chore: bump deps', state: 'OPEN' as const, headRefName: 'chore/bump-deps', labels: [], mergedAt: null, url: `${REPO_URL}/pull/80`, gh: { ...SCENARIOS.awaitingYou.raw } }
    const { model } = await load(world('awaiting', {}, [stray]))
    expect(rowsOf(model)).toHaveLength(1)
    expect(rowsOf(model)[0]).toMatchObject({ id: 'you:review-requested:80', sectionId: '', command: '/pr-review:review-pr 80' })
    expect(rowsOf(model)[0]).not.toHaveProperty('afterItemId')
  })

  test('a review asked of a team the viewer is in is a row for the viewer', async () => {
    const { model } = await load(world('awaitingTeam', { teams: [TEAM.slug] }))
    expect(itemOf(model, 'T04').statusWord).toBe(`awaiting ${TEAM.name}`)
    expect(model.gates.map(gate => [gate.title, gate.command])).toEqual([['Your review is requested on PR #67', '/pr-review:review-pr 67']])
    expect((await load(world('awaitingTeam', { teams: ['acme/other-team'] }))).model.gates).toEqual([])
  })

  test('no viewer, no rows', async () => {
    const { model } = await load(world('awaitingYou', { viewer: undefined }))
    expect(model.gates).toEqual([])
  })
})

describe('Next for the session\'s task', () => {
  test('on the task\'s branch, the viewer\'s approved PR: merge it through address-review', async () => {
    const { model } = await load(world('approved', { branch: 'feat/T04-act-buttons' }))
    expect(model.next).toEqual({ command: '/pr-review:address-review 67', reason: 'PR #67 approved' })
  })

  test('on the task\'s branch, a review asked of the viewer: review it', async () => {
    const { model } = await load(world('awaitingYou', { branch: 'feat/T04-act-buttons' }))
    expect(model.next?.command).toBe('/pr-review:review-pr 67')
  })

  test('on the default branch, or a PR that waits on someone else: the next task to start', async () => {
    for (const w of [world('approved'), world('awaiting', { branch: 'feat/T04-act-buttons' })]) {
      const { model } = await load(w)
      expect(model.next?.command).toBe('start T06 — Slash commands, settings, stats, help')
    }
  })
})

describe('the Slack thread', () => {
  test('a chip after the PR chip; a permalink with the slackDomain option', async () => {
    const plain = (await load(world('awaiting'))).model
    expect(itemOf(plain, 'T04').chips.map(chip => chip.label)).toEqual(['#67', 'Slack thread'])
    expect(itemOf(plain, 'T04').chips[1]).not.toHaveProperty('href')

    const s = scripted(world('awaiting'), {}, new Map(), { ...OPTIONS, slackDomain: 'acme' })
    const detection = (await ledger.detect(s.ctx)) as Detection
    const linked = await ledger.load(s.ctx, detection)
    expect(itemOf(linked, 'T04').chips[1]?.href).toMatch(/^https:\/\/acme\.slack\.com\/archives\/C0TESTCHAN\/p\d+$/)
  })
})

describe('what is asked of gh and git', () => {
  test('one PR list with the review fields, the viewer once, the settings file through git', async () => {
    const { s } = await load(world('awaitingYou'))
    const lines = s.host.runs.map(argv => argv.join(' '))
    expect(lines.filter(line => line.startsWith('gh pr list'))).toEqual([
      'gh pr list --state all --limit 1000 --json number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url,reviewDecision,reviewRequests,latestReviews,body,author',
    ])
    expect(lines.filter(line => /^gh api user --hostname /.test(line))).toHaveLength(1)
    expect(lines).toContain(`git -C ${REPO} show HEAD:${SETTINGS_PATH}`)
    expect(lines.some(line => line.startsWith('gh pr view'))).toBe(false)
  })

  test('an untracked settings file is never read; no open PR asks nothing', async () => {
    const untracked = await load(world('awaitingYou', { tracked: REM_TRACKED }))
    expect(untracked.s.host.runs.map(argv => argv.join(' '))).not.toContain(`git -C ${REPO} show HEAD:${SETTINGS_PATH}`)
    const quiet = await load(world('awaitingYou', { prs: withUrls(rem.prs.filter(p => p.state !== 'OPEN')) }))
    const lines = quiet.s.host.runs.map(argv => argv.join(' '))
    expect(lines.some(line => line.startsWith('gh api user'))).toBe(false)
    expect(lines).not.toContain(`git -C ${REPO} show HEAD:${SETTINGS_PATH}`)
  })

  test('the fingerprint asks for the review fields and moves when a review moves', async () => {
    const digest = async (name: ScenarioName) => {
      const s = scripted(world(name))
      const detection = (await ledger.detect(s.ctx)) as Detection
      const print = await (ledger.fingerprint as NonNullable<typeof ledger.fingerprint>)(s.ctx, detection)
      expect(s.host.runs.map(argv => argv.join(' '))).toContain(
        'gh pr list --state all --limit 1000 --json number,state,mergedAt,headRefOid,isDraft,reviewDecision,reviewRequests,latestReviews',
      )
      return print
    }
    const prints = await Promise.all((['unreviewed', 'awaiting', 'changes', 'approved', 'approvedComments', 'draft', 'stale', 'commented'] as const).map(digest))
    expect(new Set(prints).size).toBe(8)
  })
})
