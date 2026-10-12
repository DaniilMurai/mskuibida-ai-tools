// Pull request review scenarios: the raw `gh pr list` review fields (isDraft, reviewDecision, reviewRequests,
// latestReviews, body, author) of one open PR in each review state, as the `pr-review` flow leaves them.
// Sanitised: two developers, `dev-a` (the viewer in most tests) and `dev-b`; Slack ids are made up.

export const ME = 'dev-a'
export const OTHER = 'dev-b'

export const CHANNEL = 'C0TESTCHAN'
export const TS = '1760000000.123456'
/** The line `/pr-review:request-review` appends to the PR description. */
export const MARKER = `<!-- pr-review:slack channel=${CHANNEL} ts=${TS} -->`
export const BODY = ['## What it does', 'Adds the domain model.', '', '## Rule changes and decisions', 'None', ''].join('\n')

/** The body `/pr-review:review-pr` writes on an approval with no points: only the empty frame. */
export const PLAIN_APPROVAL = 'Suggest reopening stage(s): None\nAdd override: None\n'
/** The body of an approval (or a request for changes) with points. */
export const WITH_POINTS = 'Suggest reopening stage(s): None\nAdd override: None\n\n### Fix in this PR\n- R1 · Rename the aggregate\n'

const user = (login: string) => ({ __typename: 'User', login })
/** A team as gh exports a review request for it: its name, and `org/slug` as the slug. */
export const TEAM = { name: 'Core reviewers', slug: 'acme/core-reviewers' }
const team = () => ({ __typename: 'Team', ...TEAM })
/** The PR's head commit in these scenarios; a review on another commit predates the latest push. */
export const HEAD = 'head-sha-2'
const review = (login: string, state: string, body: string, submittedAt = '2026-10-10T10:00:00Z', commit = HEAD) => ({
  author: { login },
  state,
  body,
  submittedAt,
  commit: { oid: commit },
})

/** The raw review fields of one open PR. */
export type ReviewRaw = {
  headRefOid: string
  isDraft: boolean
  reviewDecision: string
  reviewRequests: unknown[]
  latestReviews: unknown[]
  body: string
  author: { login: string }
}

function raw(over: Partial<ReviewRaw> = {}): ReviewRaw {
  return { headRefOid: HEAD, isDraft: false, reviewDecision: '', reviewRequests: [], latestReviews: [], body: BODY, author: { login: ME }, ...over }
}

/**
 * One scenario per state the panel tells apart, with the state it reads as and its status word (the viewer
 * being `ME`, the `pr-review` commands in use).
 */
export const SCENARIOS = {
  /** A draft: not up for review, even with a request pending. */
  draft: { raw: raw({ isDraft: true, reviewRequests: [user(OTHER)] }), state: 'draft', word: 'in draft' },
  /** Sent for review: `dev-b` is asked, the Slack thread exists. */
  awaiting: {
    raw: raw({ reviewRequests: [user(OTHER)], body: `${BODY}\n${MARKER}` }),
    state: 'awaiting',
    word: `awaiting ${OTHER}`,
  },
  /** `dev-b`'s PR, and the viewer is asked to review it. */
  awaitingYou: {
    raw: raw({ author: { login: OTHER }, reviewRequests: [user(ME)], body: `${BODY}\n${MARKER}` }),
    state: 'awaiting',
    word: 'awaiting you',
  },
  /** `dev-b`'s PR, asked of a team (the viewer may be in it). */
  awaitingTeam: {
    raw: raw({ author: { login: OTHER }, reviewRequests: [team()] }),
    state: 'awaiting',
    word: `awaiting ${TEAM.name}`,
  },
  /** A request for changes where reviews are required (GitHub reports the decision). */
  changes: {
    raw: raw({ reviewDecision: 'CHANGES_REQUESTED', latestReviews: [review(OTHER, 'CHANGES_REQUESTED', WITH_POINTS)] }),
    state: 'changes',
    word: 'changes requested',
  },
  /** The same without branch protection: no decision, only the review. */
  changesUnprotected: {
    raw: raw({ latestReviews: [review(OTHER, 'CHANGES_REQUESTED', WITH_POINTS)] }),
    state: 'changes',
    word: 'changes requested',
  },
  /** After "Ask re-review": the reviewer is asked again, the old request for changes still stands. */
  reReview: {
    raw: raw({ reviewDecision: 'CHANGES_REQUESTED', reviewRequests: [user(OTHER)], latestReviews: [review(OTHER, 'CHANGES_REQUESTED', WITH_POINTS)] }),
    state: 'awaiting',
    word: `awaiting ${OTHER}`,
  },
  /** Only comments, no verdict (a COMMENTED review by the reviewer). */
  commented: {
    raw: raw({ latestReviews: [review(OTHER, 'COMMENTED', WITH_POINTS)] }),
    state: 'commented',
    word: 'commented',
  },
  /** Approved, then the author pushed: the approval is on an older head commit. */
  stale: {
    raw: raw({ reviewDecision: 'APPROVED', latestReviews: [review(OTHER, 'APPROVED', PLAIN_APPROVAL, '2026-10-10T10:00:00Z', 'head-sha-1')] }),
    state: 'stale',
    word: 'approved, new commits',
  },
  /** Approved, the body only the empty frame. */
  approved: {
    raw: raw({ reviewDecision: 'APPROVED', latestReviews: [review(OTHER, 'APPROVED', PLAIN_APPROVAL)] }),
    state: 'approved',
    word: 'approved',
  },
  /** Approved with points; the author's own reply (a COMMENTED review) does not count. */
  approvedComments: {
    raw: raw({
      latestReviews: [review(OTHER, 'APPROVED', WITH_POINTS), review(ME, 'COMMENTED', 'R1: done in abc123', '2026-10-10T11:00:00Z')],
    }),
    state: 'approved-comments',
    word: 'approved with comments',
  },
  /** Open, not a draft, nobody asked, no verdict. */
  unreviewed: { raw: raw(), state: 'unreviewed', word: 'no reviewer' },
} as const

export type ScenarioName = keyof typeof SCENARIOS
