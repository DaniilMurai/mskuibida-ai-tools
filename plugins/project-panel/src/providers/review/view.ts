// Pull request review state as display: the status word an item with an open PR carries, the Slack thread chip,
// the Needs-attention rows tied to the viewer and the Next command for one PR. Both providers call it with
// their own PR rows; display text comes from src/strings/en.ts (an empty string hides the element).
//
//   your review is requested                → /pr-review:review-pr N
//   your PR: any review (changes requested,  → /pr-review:address-review N, which reads the review and picks its
//     comments only, changed since approved,   path: answer, ask re-review (an approval of an older head), merge
//     approved with comments, approved)
//   your PR: a draft, or open and nobody asked → /pr-review:request-review N (it marks a draft ready at its gate)
//
// Never a literal merge: address-review checks the approval is on the current head and merges the team's way.
// The commands are named only where the repository runs them (`commands`); without them the rows a viewer can
// act on by hand still show, and "not sent for review" is no row at all.
import { t } from '../../strings/en'
import type { Chip, Gate, Next, ReviewState } from '../../../types'
import { isViewer, reviewStateOf } from './facts'
import type { Reviewable } from './facts'

/** A PR as the review display needs it; both providers' rows fit. */
export type ReviewPr = Reviewable & { number: number; title: string; state: string; url?: string }

/**
 * Who is looking (and the teams they are in, as `org/slug`), whether the `pr-review` commands exist here, and the
 * Slack domain for thread links.
 */
export type ReviewCtx = { viewer: string; teams?: string[]; commands: boolean; slackDomain: string }

export const NO_VIEWER: ReviewCtx = { viewer: '', commands: false, slackDomain: '' }

/** True when the viewer is asked to review: by name, or through a team they are in. */
function isAskedOfViewer(pr: ReviewPr, ctx: ReviewCtx): boolean {
  if ((pr.review?.requested ?? []).some(name => isViewer(name, ctx.viewer))) return true
  const mine = new Set((ctx.teams ?? []).map(team => team.toLowerCase()))
  return (pr.review?.requestedTeams ?? []).some(team => mine.has(team.toLowerCase()))
}

export type RowKind =
  | 'review-requested'
  | 'changes-requested'
  | 'review-commented'
  | 'approval-stale'
  | 'approved-comments'
  | 'approved'
  | 'draft-not-requested'
  | 'review-not-requested'

const ORDER: RowKind[] = [
  'review-requested',
  'changes-requested',
  'review-commented',
  'approval-stale',
  'approved-comments',
  'approved',
  'draft-not-requested',
  'review-not-requested',
]
const TONE: Record<RowKind, Gate['tone']> = {
  'review-requested': 'accent',
  'changes-requested': 'warning',
  'review-commented': 'warning',
  'approval-stale': 'warning',
  'approved-comments': 'success',
  approved: 'success',
  'draft-not-requested': 'warning',
  'review-not-requested': 'warning',
}
const COMMAND: Record<RowKind, string> = {
  'review-requested': 'review.command.review',
  'changes-requested': 'review.command.address',
  'review-commented': 'review.command.address',
  'approval-stale': 'review.command.address',
  'approved-comments': 'review.command.address',
  approved: 'review.command.merge',
  'draft-not-requested': 'review.command.request',
  'review-not-requested': 'review.command.request',
}

const refOf = (number: number): string => `#${number}`

/**
 * Every reviewer asked, as GitHub lists them: people by login, teams by name, the viewer as "you" and first
 * ("you, DaniilMurai, Core"). A long list is cut on screen, never here.
 */
function whoOf(requested: readonly string[], viewer: string): string {
  const mine = requested.filter(name => isViewer(name, viewer))
  const names = [...mine.map(name => t('review.who.you') || name), ...requested.filter(name => !isViewer(name, viewer))]
  return names.join(t('review.who.separator') || ' ')
}

/**
 * The status word of an item whose open PR is in `state`. '' for a PR nobody was asked to review where the
 * `pr-review` commands are not in use: the provider keeps its own word there ("in review", "in progress").
 */
export function reviewWord(pr: ReviewPr, state: ReviewState, ctx: ReviewCtx): string {
  switch (state) {
    case 'draft':
      return t('review.word.draft')
    case 'awaiting':
      return t('review.word.awaiting', { who: whoOf(pr.review?.requested ?? [], ctx.viewer) })
    case 'changes':
      return t('review.word.changes')
    case 'commented':
      return t('review.word.commented')
    case 'stale':
      return t('review.word.stale')
    case 'approved':
      return t('review.word.approved')
    case 'approved-comments':
      return t('review.word.approvedComments')
    default:
      return ctx.commands ? t('review.word.unreviewed') : ''
  }
}

const DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i

/** The Slack thread's permalink, or '' without a usable domain. */
export function slackLink(channel: string, ts: string, domain: string): string {
  return DOMAIN.test(domain) ? `https://${domain}.slack.com/archives/${channel}/p${ts.replace('.', '')}` : ''
}

/** A "Slack thread" chip when the PR body carries the `pr-review` marker; a link only with the workspace's domain. */
export function slackChips(pr: ReviewPr, ctx: ReviewCtx): Chip[] {
  const thread = pr.review?.slack
  const label = t('review.chip.slack')
  if (!thread || label === '') return []
  const href = slackLink(thread.channel, thread.ts, ctx.slackDomain)
  return [{ kind: 'tag', label, tone: 'neutral', ...(href === '' ? {} : { href }) }]
}

/** What an open PR asks of the viewer, if anything. */
export function viewerKind(pr: ReviewPr, ctx: ReviewCtx): RowKind | null {
  if (ctx.viewer === '' || pr.state !== 'OPEN') return null
  const state = reviewStateOf(pr)
  if (state !== 'draft' && isAskedOfViewer(pr, ctx)) return 'review-requested'
  if (!isViewer(pr.review?.author ?? '', ctx.viewer)) return null
  switch (state) {
    case 'changes':
      return 'changes-requested'
    case 'commented':
      return 'review-commented'
    case 'stale':
      return 'approval-stale'
    case 'approved-comments':
      return 'approved-comments'
    case 'approved':
      return 'approved'
    case 'draft':
      return ctx.commands ? 'draft-not-requested' : null
    case 'unreviewed':
      return ctx.commands ? 'review-not-requested' : null
    default:
      return null
  }
}

function commandOf(kind: RowKind, number: number, ctx: ReviewCtx): string {
  return ctx.commands ? t(COMMAND[kind], { number: String(number) }) : ''
}

/** Where a row about a PR sits: the plan item the PR carries, or nowhere (a PR outside the plan). */
export type Place = { sectionId: string; afterItemId?: string }

/** The Needs-attention rows tied to the viewer, over every open PR: someone waits on them first, then their own PRs. */
export function reviewRows(prs: readonly ReviewPr[], ctx: ReviewCtx, placeOf: (pr: ReviewPr) => Place): Gate[] {
  const rows: { kind: RowKind; pr: ReviewPr }[] = []
  const seen = new Set<number>()
  for (const pr of prs) {
    if (seen.has(pr.number)) continue
    seen.add(pr.number)
    const kind = viewerKind(pr, ctx)
    if (kind !== null) rows.push({ kind, pr })
  }
  rows.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.pr.number - a.pr.number)
  return rows.flatMap(({ kind, pr }) => {
    const ref = refOf(pr.number)
    const title = t(`review.row.${kind}.title`, { ref })
    if (title === '') return []
    const caption = t(`review.row.${kind}.caption`, { title: pr.title, author: pr.review?.author ?? '' })
    const command = commandOf(kind, pr.number, ctx)
    const place = placeOf(pr)
    const gate: Gate = {
      id: `you:${kind}:${pr.number}`,
      kind,
      tone: TONE[kind],
      title,
      sectionId: place.sectionId,
      isAttentionOnly: true,
      ...(place.afterItemId === undefined ? {} : { afterItemId: place.afterItemId }),
      ...(caption === '' ? {} : { caption }),
      ...(pr.url === undefined || pr.url === '' ? {} : { href: pr.url }),
      ...(command === '' ? {} : { command }),
    }
    return [gate]
  })
}

/** The Next for the PR the current item is in, when it asks something of the viewer that a command does. */
export function reviewNext(pr: ReviewPr, ctx: ReviewCtx): Next | null {
  const kind = viewerKind(pr, ctx)
  if (kind === null) return null
  const command = commandOf(kind, pr.number, ctx)
  if (command === '') return null
  return { command, reason: t(`review.row.${kind}.title`, { ref: refOf(pr.number) }) }
}
