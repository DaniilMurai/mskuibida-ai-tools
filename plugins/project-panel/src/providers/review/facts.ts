// Pull request review state, the pure half shared by both providers: what `gh pr list --json
// number,isDraft,reviewDecision,reviewRequests,latestReviews,body,author` says about one PR, and the one review
// state it adds up to. No I/O and no imports from the panel contract (the ledger core keeps that rule too);
// ./view.ts turns these into display text and ./viewer.ts asks who is looking.
//
// The review flow it was written for is a `pr-review` plugin: the author runs
// `/pr-review:request-review` (a GitHub review request, a "please review" in Slack, a marker line in the PR
// body), the reviewer `/pr-review:review-pr` (a GitHub review: APPROVE with or without comments, or
// REQUEST_CHANGES), the author `/pr-review:address-review`. Nothing here depends on that plugin being installed:
// review requests and verdicts are GitHub's own.

/**
 * draft             — a draft PR: not up for review yet;
 * awaiting          — someone is asked to review it (a first review, or again after changes);
 * changes           — a review requests changes;
 * commented         — reviewed, but only with comments (no verdict);
 * stale             — approved, but the head has moved since the latest approval (merging needs a new one);
 * approved          — approved, and the latest approval carries no comments;
 * approved-comments — approved, and the latest approval carries comments;
 * unreviewed        — open, not a draft, nobody asked and no verdict yet.
 */
export type ReviewState = 'draft' | 'awaiting' | 'changes' | 'commented' | 'stale' | 'approved' | 'approved-comments' | 'unreviewed'

/** The latest review by one person, as `latestReviews` lists it. */
export type LatestReview = {
  author: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: string
  /** The review's body says something beyond empty headers ("Add override: None"). */
  hasComments: boolean
  /** ISO time; '' when gh did not say. */
  submittedAt: string
  /** The head commit the review was given on (`commit.oid`); '' when gh did not say. */
  commit: string
}

/** The `/pr-review:request-review` thread in Slack, from the marker line in the PR body. */
export type SlackThread = { channel: string; ts: string }

/** What a PR's review looks like; every field has an empty default, so a merged row without them reads as none. */
export type ReviewFacts = {
  /** The PR author's login; '' when unknown. */
  author: string
  /** Who is asked to review, in the forge's order: people by login, teams by name (else slug). */
  requested: string[]
  /** The teams among them, as `org/slug` (gh's own spelling): matched against the viewer's teams. */
  requestedTeams: string[]
  reviews: LatestReview[]
  slack: SlackThread | null
}

export const NO_REVIEW: ReviewFacts = { author: '', requested: [], requestedTeams: [], reviews: [], slack: null }

/** The `gh pr list --json` fields the review state needs, besides the ones each provider already asks for. */
export const REVIEW_FIELDS = ['headRefOid', 'isDraft', 'reviewDecision', 'reviewRequests', 'latestReviews', 'body', 'author'] as const

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** `author` as gh gives it (`{ login }`), or a bare string. */
function loginOf(value: unknown): string {
  return typeof value === 'string' ? value : str(obj(value)?.login)
}

// `<!-- pr-review:slack channel=<channel id> ts=<message ts> -->`, written by `/pr-review:request-review`.
const MARKER = /<!--\s*pr-review:slack\s+channel=([A-Za-z0-9]+)\s+ts=(\d+\.\d+)\s*-->/

/** The Slack thread a PR body points at; the last marker wins (a re-request adds a new one). null without one. */
export function slackThreadOf(body: string): SlackThread | null {
  let found: SlackThread | null = null
  for (const line of body.split('\n')) {
    const m = MARKER.exec(line)
    if (m) found = { channel: m[1] as string, ts: m[2] as string }
  }
  return found
}

/**
 * True when a review body says something. Blank lines, headings and "label: None" lines are the empty
 * frame of a body (`/pr-review:review-pr` writes "Suggest reopening stage(s): None" and "Add override:
 * None" on a plain approval); anything else is a comment. Inline comments are not in `latestReviews`, so a
 * point made only inline without a line in the body is not seen (`/pr-review:review-pr` lists every point
 * in the body as well).
 */
export function hasCommentsIn(body: string): boolean {
  return body.split('\n').some(raw => {
    const line = raw.trim()
    if (line === '' || /^#{1,6}(\s|$)/.test(line)) return false
    return !/^[^:]{1,80}:\s*(none|n\/a|—|-)?\.?$/i.test(line)
  })
}

/** The review facts of one raw `gh pr list` row; fields gh left out read as empty. */
export function reviewFactsOf(raw: Record<string, unknown>): ReviewFacts {
  const requested = Array.isArray(raw.reviewRequests)
    ? raw.reviewRequests.flatMap(entry => {
        const e = obj(entry)
        // A user carries `login`, a team its `name` (as GitHub shows it) and `slug`.
        const name = str(e?.login) || str(e?.name) || str(e?.slug)
        return name === '' ? [] : [name]
      })
    : []
  const reviews = Array.isArray(raw.latestReviews)
    ? raw.latestReviews.flatMap(entry => {
        const e = obj(entry)
        if (e === null || str(e.state) === '') return []
        return [
          {
            author: loginOf(e.author),
            state: str(e.state),
            hasComments: hasCommentsIn(str(e.body)),
            submittedAt: str(e.submittedAt),
            commit: str(obj(e.commit)?.oid),
          },
        ]
      })
    : []
  const requestedTeams = Array.isArray(raw.reviewRequests)
    ? raw.reviewRequests.flatMap(entry => {
        const e = obj(entry)
        return str(e?.__typename) === 'Team' && str(e?.slug) !== '' ? [str(e?.slug)] : []
      })
    : []
  return { author: loginOf(raw.author), requested, requestedTeams, reviews, slack: slackThreadOf(str(raw.body)) }
}

/** The fields a review state is read from: the PR's own (draft, decision, head commit) and its review facts. */
export type Reviewable = { isDraft?: boolean; reviewDecision?: string; headRefOid?: string; review?: ReviewFacts }

const same = (a: string, b: string): boolean => a !== '' && a.toLowerCase() === b.toLowerCase()

/**
 * The review state of an open PR. A draft is a draft. A pending request comes next: whoever is asked has the
 * ball, also after a "changes requested" (the author asked again). Then the verdict: GitHub's
 * `reviewDecision` where the repository requires reviews, else the latest APPROVED / CHANGES_REQUESTED review
 * of someone other than the author (a repository without branch protection reports no decision at all). An
 * approval given on an older head commit is stale. Reviews with only comments, and no verdict, are "commented".
 */
export function reviewStateOf(pr: Reviewable): ReviewState {
  if (pr.isDraft === true) return 'draft'
  const facts = pr.review ?? NO_REVIEW
  if (facts.requested.length > 0) return 'awaiting'
  const others = facts.reviews.filter(r => !same(r.author, facts.author))
  const verdicts = others.filter(r => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
  const decision = pr.reviewDecision ?? ''
  const isChanges = decision === 'CHANGES_REQUESTED' || (decision !== 'APPROVED' && verdicts.some(r => r.state === 'CHANGES_REQUESTED'))
  if (isChanges) return 'changes'
  const approvals = verdicts.filter(r => r.state === 'APPROVED')
  if (decision === 'APPROVED' || approvals.length > 0) {
    // The latest approval decides: a later plain approval answers an earlier one with comments, and one given on
    // an older head commit no longer covers what would be merged.
    const latest = approvals.slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
    const head = pr.headRefOid ?? ''
    if (latest && latest.commit !== '' && head !== '' && latest.commit !== head) return 'stale'
    return latest?.hasComments ? 'approved-comments' : 'approved'
  }
  return others.some(r => r.state === 'COMMENTED') ? 'commented' : 'unreviewed'
}

/** True when `login` is the viewer (logins are case-insensitive; an unknown viewer is nobody). */
export function isViewer(login: string, viewer: string): boolean {
  return same(login, viewer)
}
