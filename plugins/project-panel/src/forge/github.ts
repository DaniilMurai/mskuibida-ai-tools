import type { ProviderHost } from '../../types'
import { inputHash } from '../providers/ledger/hash'
import { reviewFactsOf } from '../providers/review/facts'
import type { ReviewFacts } from '../providers/review/facts'
import { ForgeError, runJson } from './problem'
import { hostKey, webBase } from './remote'
import type { Change, Forge, ForgeResult, Remote } from './types'

// GitHub through `gh`, read-only: repo view, pr list, pr view. Every helper answers (a ForgeResult) rather
// than rejects; only `fingerprint` throws, because the refresh engine turns its failure into one line.

const NET_MS = 30_000
/** The remote fingerprint gives its command this long (src/refresh.ts gives the whole call 30 s). */
const FINGERPRINT_MS = 12_000
const DEFAULT_LIMIT = 1000

const BASE_FIELDS = 'number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url'
const STATUS_FIELDS = 'reviewDecision,mergeStateStatus,statusCheckRollup'
/** Who opened it, who is asked, the latest reviews, the body (for the `pr-review` Slack marker only). */
const REVIEW_FIELDS = 'reviewDecision,reviewRequests,latestReviews,body,author'
/** What the fingerprint digests: what moves a change, and what moves its review (not the bodies: too big to poll). */
const FINGERPRINT_FIELDS = 'number,state,mergedAt,headRefOid,isDraft,reviewDecision,reviewRequests,latestReviews'

const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATUS = new Set(['FAILURE', 'ERROR'])
const PENDING_STATUS = new Set(['PENDING', 'EXPECTED'])

const REVIEW: Record<string, Change['review']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'required',
}

const STATES: Record<string, Change['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

type Check = Record<string, unknown>

function checksOf(rollup: unknown): Check[] {
  return Array.isArray(rollup) ? rollup.filter((e): e is Check => typeof e === 'object' && e !== null) : []
}

function isFailed(check: Check): boolean {
  return (
    (typeof check.conclusion === 'string' && FAILED_RUN.has(check.conclusion)) ||
    (typeof check.state === 'string' && FAILED_STATUS.has(check.state))
  )
}

/** The names of the failed entries of a `statusCheckRollup` (CheckRun `conclusion`, StatusContext `state`). */
function failingOf(rollup: unknown): string[] {
  const names: string[] = []
  for (const check of checksOf(rollup)) {
    if (!isFailed(check)) continue
    const name = typeof check.name === 'string' && check.name !== '' ? check.name : typeof check.context === 'string' ? check.context : ''
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/** Any failed → failed; any still going → running; all done and none failed → success; no checks → ''. */
function ciOf(rollup: unknown): Change['ci'] {
  const checks = checksOf(rollup)
  if (checks.length === 0) return ''
  if (checks.some(isFailed)) return 'failed'
  const isRunning = checks.some(
    c => (typeof c.status === 'string' && c.status !== 'COMPLETED') || (typeof c.state === 'string' && PENDING_STATUS.has(c.state)),
  )
  return isRunning ? 'running' : 'success'
}

function labelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(l => (typeof l === 'object' && l !== null && typeof (l as { name?: unknown }).name === 'string' ? [(l as { name: string }).name] : []))
}

function toChange(raw: unknown, isWithStatus: boolean, isWithReview = false): Change[] {
  if (typeof raw !== 'object' || raw === null) return []
  const p = raw as Record<string, unknown>
  const state = typeof p.state === 'string' ? STATES[p.state] : undefined
  if (typeof p.number !== 'number' || typeof p.title !== 'string' || typeof p.headRefName !== 'string' || state === undefined) return []
  const isOpen = state === 'open'
  return [
    {
      number: p.number,
      title: p.title,
      state,
      isDraft: p.isDraft === true,
      sourceBranch: p.headRefName,
      url: typeof p.url === 'string' ? p.url : '',
      mergedAt: typeof p.mergedAt === 'string' && p.mergedAt !== '' ? p.mergedAt : null,
      labels: labelsOf(p.labels),
      headSha: typeof p.headRefOid === 'string' ? p.headRefOid : '',
      review: (isWithStatus || isWithReview) && isOpen && typeof p.reviewDecision === 'string' ? (REVIEW[p.reviewDecision] ?? '') : '',
      ...(isWithReview && isOpen ? { reviewFacts: reviewFactsOf(p) } : {}),
      ci: isWithStatus && isOpen ? ciOf(p.statusCheckRollup) : '',
      failingChecks: isWithStatus && isOpen ? failingOf(p.statusCheckRollup) : [],
      mergeState: isWithStatus && isOpen && typeof p.mergeStateStatus === 'string' ? p.mergeStateStatus.toLowerCase() : '',
    },
  ]
}

/**
 * An open PR's review as the fingerprint digests it: draft, decision, who is asked, every latest review and its
 * commit. '' when there is no review at all, so such a row digests exactly as it did before reviews were read.
 */
function reviewDigest(row: Record<string, unknown>): string {
  const f: ReviewFacts = reviewFactsOf(row)
  const decision = typeof row.reviewDecision === 'string' ? row.reviewDecision : ''
  if (row.isDraft !== true && decision === '' && f.requested.length === 0 && f.reviews.length === 0) return ''
  const reviews = f.reviews.map(r => `${r.author}=${r.state}${r.hasComments ? '+' : ''}@${r.submittedAt}#${r.commit}`).join(';')
  return `:${row.isDraft === true ? 1 : 0}:${decision}:${f.requested.join(';')}:${reviews}`
}

export function githubForge(host: ProviderHost, root: string, remote: Remote): Forge {
  const hostName = hostKey(remote)
  const ask = (argv: string[], timeoutMs = NET_MS) => runJson(host, 'gh', hostName, argv, { cwd: root, timeoutMs })

  return {
    kind: 'github',
    remote,
    refPrefix: '#',
    refOf: n => `#${n}`,

    async repoInfo(opts = {}) {
      const r = await ask(['repo', 'view', '--json', 'url,defaultBranchRef'], opts.timeoutMs)
      if (!r.ok) return r
      const view = (typeof r.value === 'object' && r.value !== null ? r.value : {}) as { url?: unknown; defaultBranchRef?: { name?: unknown } | null }
      return {
        ok: true,
        value: {
          webUrl: typeof view.url === 'string' ? view.url.replace(/(\.git)?\/*$/, '') : webBase(remote),
          defaultBranch: typeof view.defaultBranchRef?.name === 'string' ? view.defaultBranchRef.name : '',
        },
      }
    },

    async listChanges(opts = {}): Promise<ForgeResult<Change[]>> {
      const isWithStatus = opts.withStatus === true
      const isWithReview = opts.withReview === true
      const fields = [...new Set([BASE_FIELDS, isWithStatus ? STATUS_FIELDS : '', isWithReview ? REVIEW_FIELDS : ''].join(',').split(',').filter(f => f !== ''))].join(',')
      const r = await ask(['pr', 'list', '--state', opts.state ?? 'all', '--limit', String(opts.limit ?? DEFAULT_LIMIT), '--json', fields], opts.timeoutMs)
      if (!r.ok) return r
      if (!Array.isArray(r.value)) return { ok: false, problem: { kind: 'failed', cli: 'gh', host: hostName } }
      return { ok: true, value: r.value.flatMap(row => toChange(row, isWithStatus, isWithReview)) }
    },

    async filesChanged(n) {
      const r = await ask(['pr', 'view', String(n), '--json', 'files'])
      if (!r.ok) return r
      const files = (r.value as { files?: unknown } | null)?.files
      if (!Array.isArray(files)) return { ok: false, problem: { kind: 'failed', cli: 'gh', host: hostName } }
      return {
        ok: true,
        value: files.flatMap(f => (typeof f === 'object' && f !== null && typeof (f as { path?: unknown }).path === 'string' ? [(f as { path: string }).path] : [])),
      }
    },

    async viewer(opts = {}) {
      const r = await ask(['api', 'user', '--hostname', hostName], opts.timeoutMs)
      const login = r.ok && typeof r.value === 'object' && r.value !== null ? (r.value as { login?: unknown }).login : undefined
      return typeof login === 'string' ? login : ''
    },

    async viewerTeams(opts = {}) {
      // One page of 100: a person in more teams than that is not this panel's case. Needs the token's read:org.
      const r = await ask(['api', 'user/teams?per_page=100', '--hostname', hostName], opts.timeoutMs)
      if (!r.ok || !Array.isArray(r.value)) return null
      return r.value.flatMap(team => {
        if (typeof team !== 'object' || team === null) return []
        const t = team as { slug?: unknown; organization?: { login?: unknown } | null }
        return typeof t.slug === 'string' && typeof t.organization?.login === 'string' ? [`${t.organization.login}/${t.slug}`] : []
      })
    },

    async fingerprint() {
      const r = await ask(['pr', 'list', '--state', 'all', '--limit', String(DEFAULT_LIMIT), '--json', FINGERPRINT_FIELDS], FINGERPRINT_MS)
      if (!r.ok) throw new ForgeError(r.problem, 'github')
      if (!Array.isArray(r.value)) throw new ForgeError({ kind: 'failed', cli: 'gh', host: hostName }, 'github')
      const rows = r.value as ({ number: number; state: string; mergedAt: string | null; headRefOid?: string } & Record<string, unknown>)[]
      const part = rows
        .slice()
        .sort((a, b) => a.number - b.number)
        .map(row => `${row.number}:${row.state}:${row.mergedAt ?? ''}:${row.headRefOid ?? ''}${row.state === 'OPEN' ? reviewDigest(row) : ''}`)
        .join(',')
      return inputHash([part])
    },

    fileUrl: (webUrl, branch, path, line) => (webUrl === '' ? '' : `${webUrl}/blob/${branch}/${encodeURI(path)}#L${line}`),
  }
}
