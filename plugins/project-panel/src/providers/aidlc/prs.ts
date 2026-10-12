// The AI-DLC provider's one forge module: every pull-request / merge-request call it makes goes through the
// forge layer (../../forge: `gh` for GitHub, `glab` for GitLab, self-hosted included), so nothing here knows a CLI's
// argv. The git helpers it shares with the ledger stay in ../ledger/host.ts. The derivation (./truths.ts) and the
// loader only see `StagePr`, `refOf` and these functions.
//
// Each helper answers rather than rejects (the one exception is `remoteFingerprint`, whose failure is the
// refresh engine's "remote check failed": a `ForgeError` carrying the cause-specific line). Nothing here
// writes to the repository or to the forge: `git fetch` only updates a remote-tracking ref.
import type { ProviderHost } from '../../../types'
import { ForgeError, detectForge, resetForgeCache } from '../../forge'
import type { Change, Forge, ForgeOverride, ForgeProblem } from '../../forge'
import { inputHash } from '../ledger/hash'
import { fetchDefault, isSafeRef, repoFacts, sh } from '../ledger/host'
import { NO_REVIEW } from '../review/facts'
import type { ReviewFacts } from '../review/facts'
import { SHORT_MS, facts, files, forgeWorked, listFailed, lists, resetCache as resetMemo } from './memo'

/** Forgets everything this module and the forge layer's detection remember; the tests call it between worlds. */
export function resetCache(): void {
  resetMemo()
  resetForgeCache()
  built = new WeakMap()
}

/**
 * The forge's own spelling of a change's number ("#33", "!275"); the copy never spells it. Without a forge (none
 * found, or none asked) it is GitHub's.
 */
export function refOf(number: number, forge?: Pick<Forge, 'refOf'> | null): string {
  return forge ? forge.refOf(number) : `#${number}`
}

/** One pull request or merge request, as the derivation needs it. */
export type StagePr = {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  headRefName: string
  /** The head commit; '' when the forge did not say. */
  headRefOid: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''. */
  reviewDecision: string
  /** The merge state, upper-cased: CLEAN, BEHIND, BLOCKED, DIRTY, UNKNOWN (GitHub also UNSTABLE, ...); '' when absent. */
  mergeStateStatus: string
  /** Names of the checks that failed, in the order the forge lists them. */
  failingChecks: string[]
  mergedAt: string | null
  url: string
  /** Who opened it, who is asked to review it, the latest reviews, the Slack thread (open changes on GitHub). */
  review?: ReviewFacts
}

/** What a GitLab pipeline that failed is called among the failing checks: its status carries no check names. */
const PIPELINE_CHECK = 'pipeline'

/** Open changes are listed with their review, merge state and checks; those cost the forge more, so merged ones do without. */
const OPEN_LIMIT = 100
const MERGED_LIMIT = 200
const FACTS_TTL_MS = 300_000
const NET_MS = 20_000
/** The remote fingerprint gives each command this long (src/refresh.ts gives the whole call 30 s). */
const FINGERPRINT_MS = 12_000

// ── the forge ────────────────────────────────────────────────────────────────

/** Forges already built, per host object (a Forge captures its host, so one is never reused with another), root and override. */
let built = new WeakMap<ProviderHost, Map<string, Forge>>()

/**
 * The repository's forge (`override` is the person's `forge` option), kept per host, root and override once found.
 * The detection layer remembers only which KIND the origin is, so a new host gets a forge of its own. null when
 * there is none (no origin, `forge: none`), which is asked again: that costs one `git remote get-url`. The "GitLab
 * anyway" fallback is not kept either, so a login is noticed once the layer's 60 s memory of it is over.
 */
export async function forgeOf(host: ProviderHost, root: string, override: ForgeOverride = 'auto'): Promise<Forge | null> {
  const key = `${root}\u0000${override}`
  let mine = built.get(host)
  const hit = mine?.get(key)
  if (hit) return hit
  const { forge, isFallback } = await detectForge(host, root, override)
  if (forge && isFallback !== true) {
    if (!mine) built.set(host, (mine = new Map()))
    mine.set(key, forge)
  }
  return forge
}

// ── the change list ──────────────────────────────────────────────────────────

const REVIEW: Record<Change['review'], string> = {
  approved: 'APPROVED',
  'changes-requested': 'CHANGES_REQUESTED',
  required: 'REVIEW_REQUIRED',
  '': '',
}

const STATES: Record<Change['state'], StagePr['state']> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }

/** A forge change as the derivation's `StagePr`; a change with no source branch cannot belong to a stage. */
function fromChange(c: Change): StagePr[] {
  if (c.sourceBranch === '') return []
  return [
    {
      number: c.number,
      title: c.title,
      state: STATES[c.state],
      isDraft: c.isDraft,
      headRefName: c.sourceBranch,
      headRefOid: c.headSha,
      reviewDecision: REVIEW[c.review],
      mergeStateStatus: c.mergeState.toUpperCase(),
      // A failed pipeline names no checks (GitLab): it is still CI failing.
      failingChecks: c.failingChecks.length > 0 ? c.failingChecks : c.ci === 'failed' ? [PIPELINE_CHECK] : [],
      mergedAt: c.mergedAt,
      url: c.url,
      ...(c.reviewFacts ? { review: c.reviewFacts } : {}),
    },
  ]
}

/** Review facts as the store kept them, read back defensively (a PR body is never kept, only its Slack thread). */
function reviewOfStore(raw: unknown): ReviewFacts | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const reviews = Array.isArray(r.reviews)
    ? r.reviews.flatMap(e => {
        if (typeof e !== 'object' || e === null) return []
        const x = e as Record<string, unknown>
        return [{ author: s(x.author), state: s(x.state), hasComments: x.hasComments === true, submittedAt: s(x.submittedAt), commit: s(x.commit) }]
      })
    : []
  const slack = typeof r.slack === 'object' && r.slack !== null ? (r.slack as Record<string, unknown>) : null
  return {
    ...NO_REVIEW,
    author: s(r.author),
    requested: Array.isArray(r.requested) ? r.requested.filter((x): x is string => typeof x === 'string') : [],
    requestedTeams: Array.isArray(r.requestedTeams) ? r.requestedTeams.filter((x): x is string => typeof x === 'string') : [],
    reviews,
    slack: slack && typeof slack.channel === 'string' && typeof slack.ts === 'string' ? { channel: slack.channel, ts: slack.ts } : null,
  }
}

/** A kept row read back: the shape `StagePr` has (rows kept by an earlier version are gh's own and read the same). */
function fromStore(raw: unknown): StagePr[] {
  if (typeof raw !== 'object' || raw === null) return []
  const p = raw as Record<string, unknown>
  const state = p.state
  if (typeof p.number !== 'number' || typeof p.title !== 'string') return []
  if (typeof p.headRefName !== 'string' || p.headRefName === '') return []
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return []
  return [
    {
      number: p.number,
      title: p.title,
      state,
      isDraft: p.isDraft === true,
      headRefName: p.headRefName,
      headRefOid: typeof p.headRefOid === 'string' ? p.headRefOid : '',
      reviewDecision: typeof p.reviewDecision === 'string' ? p.reviewDecision : '',
      mergeStateStatus: typeof p.mergeStateStatus === 'string' ? p.mergeStateStatus : '',
      failingChecks: Array.isArray(p.failingChecks) ? p.failingChecks.filter((n): n is string => typeof n === 'string') : [],
      mergedAt: typeof p.mergedAt === 'string' && p.mergedAt !== '' ? p.mergedAt : null,
      url: typeof p.url === 'string' ? p.url : '',
      ...(reviewOfStore(p.review) === undefined ? {} : { review: reviewOfStore(p.review) as ReviewFacts }),
    },
  ]
}

/** A failed listing is not asked again for this long: short, since the usual cause is a network that comes back. */
const LIST_RETRY_MS = 15_000

type Fetched = { ok: true; rows: StagePr[]; raw: string } | { ok: false; problem: ForgeProblem }

/** Writes a listing to the store when it differs from the one before (best effort). */
async function keep(host: ProviderHost, root: string, raw: string, before: string | undefined, rows: StagePr[]): Promise<void> {
  if (raw === before) return
  try {
    await host.store.set(storeKey(root), { rows })
  } catch {
    // The store is a convenience for the next start; nothing depends on it now.
  }
}

/** The open or the merged changes (retried once). Open ones are asked with their status; merged ones without. */
async function fetchState(forge: Forge, state: 'open' | 'merged', timeoutMs: number, isLight: boolean): Promise<Fetched> {
  const isOpen = state === 'open'
  const ask = () => forge.listChanges({ state, withStatus: isOpen, withReview: isOpen, isLight, limit: isOpen ? OPEN_LIMIT : MERGED_LIMIT, timeoutMs })
  // One retry: a connection that flaps (refused for a second, then back) is common on a laptop, and one failed
  // call would otherwise blank every change chip until the next check.
  let r = await ask()
  if (!r.ok) r = await ask()
  if (!r.ok) return { ok: false, problem: r.problem }
  const rows = r.value.flatMap(fromChange)
  return { ok: true, rows, raw: JSON.stringify(rows) }
}

/** The open and the merged changes, asked for side by side; the problem when either fails. A closed one is never of interest. */
async function fetchList(forge: Forge | null, root: string, timeoutMs: number, isLight = false): Promise<Fetched | null> {
  if (forge === null) return null
  const [open, merged] = await Promise.all([fetchState(forge, 'open', timeoutMs, isLight), fetchState(forge, 'merged', timeoutMs, isLight)])
  if (!open.ok) return open
  if (!merged.ok) return merged
  forgeWorked.add(root)
  return { ok: true, rows: [...open.rows, ...merged.rows], raw: `${open.raw}\n${merged.raw}` }
}

/** Where the last good listing of a repository is kept across sessions (`$.store`), for a start during an outage. */
const storeKey = (root: string): string => `aidlc.prs:${root}`

/** The last listing that worked: this process's, else the one kept in the store; null when there never was one. */
async function lastGood(host: ProviderHost, root: string): Promise<StagePr[] | null> {
  const hit = lists.get(root)
  if (hit) return hit.rows
  try {
    const kept = (await host.store.get(storeKey(root))) as { rows?: unknown } | undefined
    return Array.isArray(kept?.rows) ? kept.rows.flatMap(fromStore) : null
  } catch {
    return null
  }
}

/**
 * Every open and recently merged change. A listing is reused for a minute (by `now`) while the default branch's
 * sha (`sha`, the local `origin/<base>`) is the one it was read at, so a branch that moved is asked about again at
 * once. When the forge fails (often a network that drops for a few seconds), the last listing that worked stands
 * in, from this process or the store, so one failed call never blanks every chip; null only when there never was
 * one (or the repository has no forge). A failure is remembered for 15 s, so a missing CLI costs one try per poll.
 */
export async function listChanges(
  host: ProviderHost,
  root: string,
  now: number,
  sha = '',
  override: ForgeOverride = 'auto',
): Promise<StagePr[] | null> {
  const hit = lists.get(root)
  if (hit && hit.sha === sha && now - hit.at < SHORT_MS) return hit.rows
  const failedAt = listFailed.get(root)
  if (failedAt !== undefined && now - failedAt < LIST_RETRY_MS) return lastGood(host, root)
  const fresh = await fetchList(await forgeOf(host, root, override), root, NET_MS)
  if (!fresh?.ok) {
    listFailed.set(root, now)
    return lastGood(host, root)
  }
  listFailed.delete(root)
  await keep(host, root, fresh.raw, hit?.raw, fresh.rows)
  lists.set(root, { at: now, sha, rows: fresh.rows, raw: fresh.raw })
  return fresh.rows
}

/**
 * The repository's default branch (the forge, else origin/HEAD, else `main`). An answer from the forge is kept
 * for minutes; a fallback only for a minute, so a forge that failed once does not pin `main` on a repository that
 * uses another name.
 */
export async function defaultBranch(host: ProviderHost, root: string, now: number, override: ForgeOverride = 'auto'): Promise<string> {
  const hit = facts.get(root)
  if (hit && now - hit.at < hit.ttl) return hit.name
  const found = await repoFacts(host, root, () => Promise.resolve(''), undefined, await forgeOf(host, root, override))
  const isAnswered = found.repoUrl !== ''
  if (isAnswered) forgeWorked.add(root)
  facts.set(root, { at: now, ttl: isAnswered ? FACTS_TTL_MS : SHORT_MS, name: found.defaultBranch })
  return found.defaultBranch
}

/**
 * The paths a change touches, cached by number and head commit. A failure answers [] and is remembered for a
 * minute, so a failing forge is not asked again on every load.
 */
export async function changedFiles(host: ProviderHost, root: string, pr: StagePr, now: number, override: ForgeOverride = 'auto'): Promise<string[]> {
  const key = `${pr.number}:${pr.headRefOid}`
  const hit = files.get(key)
  if (hit && (hit.at === null || now - hit.at < SHORT_MS)) return hit.paths
  const forge = await forgeOf(host, root, override)
  const r = forge === null ? null : await forge.filesChanged(pr.number)
  const paths = r?.ok ? r.value : null
  files.set(key, { paths: paths ?? [], at: paths === null ? now : null })
  return paths ?? []
}

// ── the remote fingerprint ───────────────────────────────────────────────────

/** Who is asked, every latest review's verdict, whether it has comments and its commit, and the Slack thread. */
function reviewPart(review: ReviewFacts | undefined): string {
  if (!review) return ''
  const reviews = review.reviews.map(r => `${r.author}=${r.state}${r.hasComments ? '+' : ''}@${r.submittedAt}#${r.commit}`)
  return [review.author, review.requested.join(','), reviews.join(','), review.slack ? review.slack.ts : ''].join('|')
}

/** What the remote state of the plan is made of: every change's state and review, and the default branch's tip. */
function prsPart(rows: readonly StagePr[]): string {
  return rows
    .slice()
    .sort((a, b) => a.number - b.number)
    .map(r =>
      [
        r.number,
        r.state,
        r.isDraft ? 1 : 0,
        r.mergedAt ?? '',
        r.headRefOid,
        r.reviewDecision,
        r.mergeStateStatus,
        r.failingChecks.join(','),
        reviewPart(r.review),
      ].join(':'),
    )
    .join('\n')
}

/**
 * A digest of the open and merged change lists (state, draft, merge time, head commit, review decision, merge
 * state, failing checks) and the default branch's tip on origin. The fresh list replaces the cache, so the
 * re-load a changed digest triggers sees it. When the tip differs from the local `origin/<branch>`, one cheap
 * `git fetch` brings the local ref up (the fetch on the remote cadence; a quiet remote costs none).
 * A failing forge THROWS a `ForgeError` (the engine turns its `display` into one Attention line and keeps the
 * model) only where the forge has answered before; where it never has (no CLI, no forge, not logged in from the
 * start) the digest is the tip alone, so the pane does not carry a permanent error. A failing `ls-remote` alone
 * leaves its part empty.
 *
 * On GitLab the fingerprint's list is "light": the pipeline of each open merge request, but not its approvals (a
 * second call each, ~40 glab calls per poll otherwise). So that list lacks the review decision and is NOT kept for
 * the load a changed digest triggers: that load asks for the full status itself. (A new approval alone moves the
 * digest only through the merge request's other fields; `requested_changes` is read from the list and does.)
 */
export async function remoteFingerprint(
  host: ProviderHost,
  root: string,
  branch: string,
  now: number,
  override: ForgeOverride = 'auto',
): Promise<string> {
  const isSafe = isSafeRef(branch)
  const forge = await forgeOf(host, root, override)
  const [list, sha, local] = await Promise.all([
    fetchList(forge, root, FINGERPRINT_MS, forge?.kind === 'gitlab'),
    (async () => {
      if (!isSafe) return ''
      const head = await sh(host, ['git', '-C', root, 'ls-remote', 'origin', `refs/heads/${branch}`], undefined, FINGERPRINT_MS)
      return head.ok ? (head.out.trim().split(/\s+/)[0] ?? '') : ''
    })(),
    (async () => {
      if (!isSafe) return ''
      const head = await sh(host, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', `origin/${branch}`], undefined, FINGERPRINT_MS)
      return head.ok ? head.out.trim() : ''
    })(),
  ])
  let localSha = local
  if (sha !== '' && local !== sha && (await fetchDefault(host, root, branch, FINGERPRINT_MS))) localSha = sha
  if (!list?.ok) {
    if (list && forge && forgeWorked.has(root)) throw new ForgeError(list.problem, forge.kind)
    return inputHash(['', sha])
  }
  listFailed.delete(root)
  if (forge?.kind !== 'gitlab') {
    await keep(host, root, list.raw, lists.get(root)?.raw, list.rows)
    lists.set(root, { at: now, sha: localSha, rows: list.rows, raw: list.raw })
  }
  return inputHash([prsPart(list.rows), sha])
}
