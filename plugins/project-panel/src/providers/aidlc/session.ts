// What the panel can say about a side-job session itself, as the Now card's context lines: the branch it is on,
// the open pull request that branch carries, and how far it is from the default branch. A side job is not a stage
// of the plan, so the plan says nothing about it; git and the forge do.
//
// One command at most (`git rev-list --left-right --count origin/<base>...HEAD`, argv only); the PR comes from
// the list `readTwo` already read. Without git (`two` is null) only the branch is known, and a detached HEAD
// has none: no lines at all.
import { t } from '../../strings/en'
import type { ContextLine, ProviderContext } from '../../../types'
import { isSafeRef, sh } from '../ledger/host'
import { NO_VIEWER, reviewWord } from '../review/view'
import { reviewStateOf } from '../review/facts'
import { wording } from './truths'
import type { Two } from './truths'

/** Commits the session's branch has that `origin/<base>` lacks, and the other way round; null when git cannot say. */
async function distance(ctx: ProviderContext, base: string): Promise<{ ahead: number; behind: number } | null> {
  if (!isSafeRef(base)) return null
  const r = await sh(ctx.host, ['git', '-C', ctx.startDir, 'rev-list', '--left-right', '--count', `origin/${base}...HEAD`], undefined)
  const [behind, ahead] = r.out.trim().split(/\s+/).map(part => Number.parseInt(part, 10))
  if (!r.ok || behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) return null
  return { ahead, behind }
}

/** The lines, in the order they are drawn; a line whose copy is empty is left out. */
export async function sessionContext(ctx: ProviderContext, branch: string, two: Two | null): Promise<ContextLine[]> {
  if (branch === '') return []
  const lines: ContextLine[] = []
  const on = t('aidlc.session.branch', { branch })
  if (on !== '') lines.push({ id: 'branch', text: on })
  if (two === null || branch === two.base) return lines

  // Open pull requests only: a merged one says nothing about work in flight.
  const pr = (two.open ?? []).find(open => open.headRefName === branch)
  if (pr) {
    const viewing = two.review ?? NO_VIEWER
    const state = reviewWord(pr, reviewStateOf(pr), viewing) || t('aidlc.session.pr.open')
    const text = t(wording('aidlc.session.pr', two.forgeKind), { ref: two.refOf(pr.number), state })
    if (text !== '') lines.push({ id: 'pr', text, ...(pr.url === '' ? {} : { href: pr.url }) })
  }

  const far = await distance(ctx, two.base)
  if (far !== null && (far.ahead > 0 || far.behind > 0)) {
    const key = far.ahead > 0 && far.behind > 0 ? 'aheadBehind' : far.ahead > 0 ? 'ahead' : 'behind'
    const text = t(`aidlc.session.${key}`, { ahead: String(far.ahead), behind: String(far.behind), base: two.base })
    if (text !== '') lines.push({ id: 'distance', text, ...(far.behind > 0 ? { tone: 'warning' as const } : {}) })
  }
  return lines
}

/** True when there is more to say than the branch: the plan can fold away behind it. */
export const hasMoreThanBranch = (lines: readonly ContextLine[]): boolean => lines.some(line => line.id !== 'branch')
