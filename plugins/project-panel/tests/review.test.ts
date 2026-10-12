// Pull request review state, the shared half (src/providers/review/): the facts read off a `gh pr list` row,
// the state they add up to, the status word, the rows tied to the viewer, the Next command, the Slack chip, and
// who the viewer is. One scenario per state lives in fixtures/review.ts.
import { describe, expect, test } from 'claude-code/testing'
import { CHANNEL, MARKER, ME, OTHER, PLAIN_APPROVAL, SCENARIOS, TEAM, TS, WITH_POINTS } from '../fixtures/review'
import type { ScenarioName } from '../fixtures/review'
import { hasCommentsIn, reviewFactsOf, reviewStateOf, slackThreadOf } from '../src/providers/review/facts'
import { reviewNext, reviewRows, reviewWord, slackChips, slackLink, viewerKind } from '../src/providers/review/view'
import type { ReviewCtx, ReviewPr } from '../src/providers/review/view'
import { enablesPrReview, resetViewer, reviewCtxOf, usesReviewCommands, viewerLogin, viewerTeams } from '../src/providers/review/viewer'
import { NOW } from './world'

const URL = 'https://example.test/acme/shop/pull/'
const WITH: ReviewCtx = { viewer: ME, commands: true, slackDomain: '' }
const WITHOUT: ReviewCtx = { viewer: ME, commands: false, slackDomain: '' }

/** A PR as a provider hands it over, built from a scenario's raw fields. */
function prOf(name: ScenarioName, number = 33): ReviewPr {
  const raw = SCENARIOS[name].raw as unknown as Record<string, unknown>
  return {
    number,
    title: 'feat(SHOP-7): domain-design',
    state: 'OPEN',
    url: `${URL}${number}`,
    isDraft: raw.isDraft === true,
    reviewDecision: String(raw.reviewDecision),
    headRefOid: String(raw.headRefOid),
    review: reviewFactsOf(raw),
  }
}

const NAMES = Object.keys(SCENARIOS) as ScenarioName[]

describe('the review state of each scenario', () => {
  for (const name of NAMES) {
    test(`${name}: ${SCENARIOS[name].state}, "${SCENARIOS[name].word}"`, () => {
      const pr = prOf(name)
      const state = reviewStateOf(pr)
      expect(state).toBe(SCENARIOS[name].state)
      expect(reviewWord(pr, state, WITH)).toBe(SCENARIOS[name].word)
    })
  }

  test('without the review commands, nobody asked keeps the provider\'s own word', () => {
    expect(reviewWord(prOf('unreviewed'), 'unreviewed', WITHOUT)).toBe('')
    expect(reviewWord(prOf('approved'), 'approved', WITHOUT)).toBe('approved')
  })

  test('a later plain approval answers an earlier one with comments', () => {
    const pr = prOf('approvedComments')
    const facts = pr.review!
    pr.review = {
      ...facts,
      reviews: [
        { author: OTHER, state: 'APPROVED', hasComments: true, submittedAt: '2026-10-10T10:00:00Z', commit: '' },
        { author: 'dev-c', state: 'APPROVED', hasComments: false, submittedAt: '2026-10-11T10:00:00Z', commit: '' },
      ],
    }
    expect(reviewStateOf(pr)).toBe('approved')
  })

  test('the decision wins over the reviews where GitHub gives one', () => {
    const pr = prOf('approved')
    pr.review = { ...pr.review!, reviews: [...pr.review!.reviews, { author: 'dev-c', state: 'CHANGES_REQUESTED', hasComments: true, submittedAt: '', commit: '' }] }
    expect(reviewStateOf(pr)).toBe('approved')
    expect(reviewStateOf({ ...pr, reviewDecision: '' })).toBe('changes')
  })

  test('an approval with no commit, or a PR with no head, is never stale', () => {
    const pr = prOf('stale')
    expect(reviewStateOf({ ...pr, headRefOid: '' })).toBe('approved')
    pr.review = { ...pr.review!, reviews: pr.review!.reviews.map(r => ({ ...r, commit: '' })) }
    expect(reviewStateOf(pr)).toBe('approved')
  })

  test('the author\'s own comments are not a review', () => {
    const pr = prOf('commented')
    pr.review = { ...pr.review!, author: OTHER }
    expect(reviewStateOf(pr)).toBe('unreviewed')
  })

  test('a row with no review fields (a merged one) reads as nobody asked', () => {
    expect(reviewStateOf({})).toBe('unreviewed')
    expect(reviewFactsOf({})).toEqual({ author: '', requested: [], requestedTeams: [], reviews: [], slack: null })
  })

  test('several asked: every one of them, the viewer first as "you"', () => {
    const pr = prOf('awaitingYou')
    pr.review = { ...pr.review!, requested: [OTHER, 'dev-c', ME] }
    expect(reviewWord(pr, 'awaiting', WITH)).toBe(`awaiting you, ${OTHER}, dev-c`)
    expect(reviewWord(pr, 'awaiting', { ...WITH, viewer: '' })).toBe(`awaiting ${OTHER}, dev-c, ${ME}`)
  })

  test('a team reads by its name as GitHub shows it, beside people', () => {
    const raw = { reviewRequests: [{ __typename: 'User', login: OTHER }, { __typename: 'Team', slug: 'core-reviewers', name: 'Core reviewers' }] }
    const facts = reviewFactsOf(raw)
    expect(facts.requested).toEqual([OTHER, 'Core reviewers'])
    expect(reviewFactsOf({ reviewRequests: [{ __typename: 'Team', slug: 'core-reviewers' }] }).requested).toEqual(['core-reviewers'])
    expect(reviewWord({ ...prOf('awaiting'), review: facts }, 'awaiting', WITH)).toBe(`awaiting ${OTHER}, Core reviewers`)
  })
})

describe('review bodies', () => {
  test('the empty frame of a plain approval is no comment; points are', () => {
    expect(hasCommentsIn(PLAIN_APPROVAL)).toBe(false)
    expect(hasCommentsIn('')).toBe(false)
    expect(hasCommentsIn('### Fix in this PR\n')).toBe(false)
    expect(hasCommentsIn(WITH_POINTS)).toBe(true)
    expect(hasCommentsIn('Looks good, one nit on naming.')).toBe(true)
  })
})

describe('the Slack thread marker', () => {
  test('found anywhere in the body; the last one wins', () => {
    expect(slackThreadOf(`intro\n${MARKER}\n`)).toEqual({ channel: CHANNEL, ts: TS })
    expect(slackThreadOf(`${MARKER}\n<!-- pr-review:slack channel=C0NEW ts=1760000001.000001 -->`)).toEqual({ channel: 'C0NEW', ts: '1760000001.000001' })
    expect(slackThreadOf('no marker here')).toBeNull()
    expect(slackThreadOf('<!-- pr-review:slack channel=x;rm ts=1 -->')).toBeNull()
  })

  test('the chip: presence only without a domain, a permalink with one', () => {
    expect(slackChips(prOf('awaiting'), WITH)).toEqual([{ kind: 'tag', label: 'Slack thread', tone: 'neutral' }])
    expect(slackChips(prOf('awaiting'), { ...WITH, slackDomain: 'acme' })).toEqual([
      { kind: 'tag', label: 'Slack thread', tone: 'neutral', href: `https://acme.slack.com/archives/${CHANNEL}/p1760000000123456` },
    ])
    expect(slackChips(prOf('unreviewed'), WITH)).toEqual([])
  })

  test('a domain that is not a bare name makes no link', () => {
    expect(slackLink(CHANNEL, TS, 'evil.example/x')).toBe('')
    expect(slackLink(CHANNEL, TS, '')).toBe('')
  })
})

describe('what an open PR asks of the viewer', () => {
  const kinds: [ScenarioName, string | null][] = [
    ['draft', 'draft-not-requested'],
    ['awaiting', null],
    ['awaitingYou', 'review-requested'],
    ['awaitingTeam', null],
    ['changes', 'changes-requested'],
    ['changesUnprotected', 'changes-requested'],
    ['reReview', null],
    ['commented', 'review-commented'],
    ['stale', 'approval-stale'],
    ['approved', 'approved'],
    ['approvedComments', 'approved-comments'],
    ['unreviewed', 'review-not-requested'],
  ]
  for (const [name, kind] of kinds) {
    test(`${name}: ${kind ?? 'nothing'}`, () => {
      expect(viewerKind(prOf(name), WITH)).toBe(kind)
    })
  }

  test('nothing of somebody else\'s PR unless they ask the viewer', () => {
    const pr = prOf('approved')
    pr.review = { ...pr.review!, author: OTHER }
    expect(viewerKind(pr, WITH)).toBeNull()
  })

  test('nothing without a viewer, and nothing of a PR that is not open', () => {
    expect(viewerKind(prOf('awaitingYou'), { ...WITH, viewer: '' })).toBeNull()
    expect(viewerKind({ ...prOf('approved'), state: 'MERGED' }, WITH)).toBeNull()
  })

  test('a review asked of a team the viewer is in is asked of the viewer; another team\'s is not', () => {
    expect(viewerKind(prOf('awaitingTeam'), { ...WITH, teams: [TEAM.slug] })).toBe('review-requested')
    expect(viewerKind(prOf('awaitingTeam'), { ...WITH, teams: [TEAM.slug.toUpperCase()] })).toBe('review-requested')
    expect(viewerKind(prOf('awaitingTeam'), { ...WITH, teams: ['acme/other-team'] })).toBeNull()
    expect(reviewNext(prOf('awaitingTeam', 41), { ...WITH, teams: [TEAM.slug] })?.command).toBe('/pr-review:review-pr 41')
    expect(reviewFactsOf(SCENARIOS.awaitingTeam.raw as unknown as Record<string, unknown>).requestedTeams).toEqual([TEAM.slug])
  })

  test('logins compare without case', () => {
    expect(viewerKind(prOf('awaitingYou'), { ...WITH, viewer: ME.toUpperCase() })).toBe('review-requested')
  })

  test('without the review commands, "not sent for review" is no row, draft or not', () => {
    expect(viewerKind(prOf('unreviewed'), WITHOUT)).toBeNull()
    expect(viewerKind(prOf('draft'), WITHOUT)).toBeNull()
    expect(viewerKind(prOf('approved'), WITHOUT)).toBe('approved')
  })
})

describe('the rows tied to the viewer', () => {
  const all = (): ReviewPr[] => [
    prOf('unreviewed', 30),
    prOf('approved', 31),
    prOf('approvedComments', 32),
    prOf('changes', 33),
    prOf('awaitingYou', 34),
    prOf('awaiting', 35),
    prOf('draft', 36),
    prOf('commented', 37),
    prOf('stale', 38),
  ]

  test('someone waiting on the viewer first, then any review of their own PRs (address-review), then the unsent ones', () => {
    const rows = reviewRows(all(), WITH, () => ({ sectionId: '' }))
    expect(rows.map(row => [row.title, row.command])).toEqual([
      ['Your review is requested on PR #34', '/pr-review:review-pr 34'],
      ['Changes requested on your PR #33', '/pr-review:address-review 33'],
      ['Comments on your PR #37', '/pr-review:address-review 37'],
      ['PR #38 changed since its approval', '/pr-review:address-review 38'],
      ['PR #32 approved with comments', '/pr-review:address-review 32'],
      ['PR #31 approved', '/pr-review:address-review 31'],
      ['Your draft PR #36 is not sent for review', '/pr-review:request-review 36'],
      ['PR #30 is not sent for review', '/pr-review:request-review 30'],
    ])
  })

  test('each row: an id per PR, its tone, a link, attention only, its place', () => {
    const [row] = reviewRows([prOf('awaitingYou', 34)], WITH, () => ({ sectionId: 'INCEPTION', afterItemId: 'domain-design' }))
    expect(row).toEqual({
      id: 'you:review-requested:34',
      kind: 'review-requested',
      tone: 'accent',
      title: 'Your review is requested on PR #34',
      caption: `feat(SHOP-7): domain-design — by ${OTHER}`,
      sectionId: 'INCEPTION',
      afterItemId: 'domain-design',
      href: `${URL}34`,
      command: '/pr-review:review-pr 34',
      isAttentionOnly: true,
    })
  })

  test('without the review commands: the same rows, no command, and none for "not sent"', () => {
    const rows = reviewRows(all(), WITHOUT, () => ({ sectionId: '' }))
    expect(rows.map(row => row.kind)).toEqual(['review-requested', 'changes-requested', 'review-commented', 'approval-stale', 'approved-comments', 'approved'])
    expect(rows.every(row => row.command === undefined)).toBe(true)
  })

  test('a PR listed twice makes one row', () => {
    expect(reviewRows([prOf('approved', 31), prOf('approved', 31)], WITH, () => ({ sectionId: '' }))).toHaveLength(1)
  })
})

describe('Next for the current item\'s PR', () => {
  test('the command and why', () => {
    expect(reviewNext(prOf('awaitingYou', 34), WITH)).toEqual({ command: '/pr-review:review-pr 34', reason: 'Your review is requested on PR #34' })
    expect(reviewNext(prOf('approved', 31), WITH)).toEqual({ command: '/pr-review:address-review 31', reason: 'PR #31 approved' })
    expect(reviewNext(prOf('unreviewed', 30), WITH)?.command).toBe('/pr-review:request-review 30')
    expect(reviewNext(prOf('draft', 36), WITH)?.command).toBe('/pr-review:request-review 36')
    expect(reviewNext(prOf('stale', 38), WITH)?.command).toBe('/pr-review:address-review 38')
  })

  test('none when the PR asks nothing of the viewer, or the commands are not in use', () => {
    expect(reviewNext(prOf('awaiting'), WITH)).toBeNull()
    expect(reviewNext(prOf('reReview'), WITH)).toBeNull()
    expect(reviewNext(prOf('approved'), WITHOUT)).toBeNull()
  })
})

describe('the viewer', () => {
  /** A forge whose `viewer` answers `logins` in turn and counts its calls. */
  const forgeOf = (...logins: (string | Error)[]) => {
    const calls = { n: 0 }
    return {
      calls,
      viewer: async () => {
        const next = logins[Math.min(calls.n, logins.length - 1)]
        calls.n += 1
        if (next instanceof Error) throw next
        return next ?? ''
      },
    }
  }

  test('asked once and kept', async () => {
    resetViewer()
    const forge = forgeOf(`${ME}\n`)
    expect(await viewerLogin(forge, '/repo', NOW)).toBe(ME)
    expect(await viewerLogin(forge, '/repo', NOW + 60_000)).toBe(ME)
    expect(forge.calls.n).toBe(1)
  })

  test('a failure is \'\' and asked again after a minute', async () => {
    resetViewer()
    const forge = forgeOf('', ME)
    expect(await viewerLogin(forge, '/repo', NOW)).toBe('')
    expect(await viewerLogin(forge, '/repo', NOW + 30_000)).toBe('')
    expect(await viewerLogin(forge, '/repo', NOW + 61_000)).toBe(ME)
    expect(forge.calls.n).toBe(2)
  })

  test('a throw, an answer that is not a login, a forge without viewers (GitLab) or no forge: no viewer', async () => {
    resetViewer()
    expect(await viewerLogin(forgeOf(new Error('offline')), '/a', NOW)).toBe('')
    expect(await viewerLogin(forgeOf('not a login'), '/b', NOW)).toBe('')
    expect(await viewerLogin({}, '/c', NOW)).toBe('')
    expect(await viewerLogin(null, '/d', NOW)).toBe('')
  })
})

describe('the viewer\'s teams', () => {
  const teamForge = (answer: string[] | null | Error) => {
    const calls = { teams: 0, viewer: 0 }
    return {
      calls,
      viewer: async () => (calls.viewer++, ME),
      viewerTeams: async () => {
        calls.teams += 1
        if (answer instanceof Error) throw answer
        return answer
      },
    }
  }
  const open = (name: ScenarioName) => [{ review: prOf(name).review }]

  test('asked once and kept; a failure is none, asked again after a minute', async () => {
    resetViewer()
    const forge = teamForge([TEAM.slug])
    expect(await viewerTeams(forge, '/repo', NOW)).toEqual([TEAM.slug])
    expect(await viewerTeams(forge, '/repo', NOW + 60_000)).toEqual([TEAM.slug])
    expect(forge.calls.teams).toBe(1)
    const failing = teamForge(null)
    expect(await viewerTeams(failing, '/other', NOW)).toEqual([])
    expect(await viewerTeams(failing, '/other', NOW + 30_000)).toEqual([])
    expect(await viewerTeams(failing, '/other', NOW + 61_000)).toEqual([])
    expect(failing.calls.teams).toBe(2)
    expect(await viewerTeams(teamForge(new Error('offline')), '/third', NOW)).toEqual([])
    expect(await viewerTeams({}, '/fourth', NOW)).toEqual([])
  })

  test('the review context asks for the teams only when an open PR asks a team', async () => {
    resetViewer()
    const forge = teamForge([TEAM.slug])
    const base = { forge, root: '/repo', now: NOW, options: {}, settings: async () => null }
    expect(await reviewCtxOf({ ...base, open: open('awaitingYou') })).toEqual({ viewer: ME, commands: false, slackDomain: '' })
    expect(forge.calls.teams).toBe(0)
    expect(await reviewCtxOf({ ...base, open: open('awaitingTeam') })).toEqual({ viewer: ME, teams: [TEAM.slug], commands: false, slackDomain: '' })
    expect(forge.calls.teams).toBe(1)
    expect(await reviewCtxOf({ ...base, open: [] })).toEqual({ viewer: '', commands: false, slackDomain: '' })
  })
})

describe('whether the review commands are in use', () => {
  test('a project settings file that enables a pr-review plugin', () => {
    expect(enablesPrReview(JSON.stringify({ enabledPlugins: { 'pr-review@acme': true } }))).toBe(true)
    expect(enablesPrReview(JSON.stringify({ enabledPlugins: { 'pr-review@acme': false } }))).toBe(false)
    expect(enablesPrReview(JSON.stringify({ enabledPlugins: { 'pr-reviewer@x': true } }))).toBe(false)
    expect(enablesPrReview('{ not json')).toBe(false)
    expect(enablesPrReview(null)).toBe(false)
  })

  test('the option: on and off win, auto asks the settings', () => {
    expect(usesReviewCommands('on', false)).toBe(true)
    expect(usesReviewCommands('off', true)).toBe(false)
    expect(usesReviewCommands('auto', true)).toBe(true)
    expect(usesReviewCommands(undefined, false)).toBe(false)
  })
})
