// The forge layer's shapes: where a repository's origin lives (GitHub or a GitLab, hosted or self-hosted) and
// what the panel asks of it. Providers see only `Forge`; `gh` and `glab` stay inside github.ts and gitlab.ts.
import type { ReviewFacts } from '../providers/review/facts'

export type ForgeKind = 'github' | 'gitlab'

/** An origin URL taken apart. Credentials are never kept. */
export type Remote = {
  /** Hostname, lower-case. */
  host: string
  /** Only for http(s) remotes: an ssh port is not the web port. */
  port?: number
  /** 'group/sub/repo': no `.git`, no leading or trailing slash. */
  path: string
  scheme: 'ssh' | 'https' | 'http' | 'git'
}

export type ChangeState = 'open' | 'merged' | 'closed'

/** A pull request (GitHub) or merge request (GitLab). */
export type Change = {
  /** GitHub number, GitLab iid. */
  number: number
  title: string
  state: ChangeState
  isDraft: boolean
  sourceBranch: string
  /** '' when unknown. */
  url: string
  mergedAt: string | null
  labels: string[]
  /** '' when unknown (gh headRefOid, glab sha). */
  headSha: string
  /** Filled only with `{ withStatus: true }`, for open changes; '' otherwise. */
  review: 'approved' | 'changes-requested' | 'required' | ''
  ci: 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'skipped' | ''
  /**
   * Who opened it, who is asked to review it, the latest review per person and the `pr-review` Slack thread
   * (src/providers/review/facts.ts). Filled only with `{ withReview: true }`, for open changes, on GitHub.
   */
  reviewFacts?: ReviewFacts
  /** Names of failed checks (gh statusCheckRollup); GitLab: [] (the pipeline's status is in `ci`). */
  failingChecks: string[]
  /** 'behind' | 'clean' | 'blocked' | 'dirty' | 'unknown' | '' (gh mergeStateStatus, glab detailed_merge_status). */
  mergeState: string
}

/**
 * Why a forge call did not work, in the order the person can act on it:
 * missing (the CLI is not installed), not-logged-in, unreachable (offline, timed out), failed (anything
 * else), no-remote (the repository has no origin).
 */
export type ProblemKind = 'missing' | 'not-logged-in' | 'unreachable' | 'failed' | 'no-remote'

export type ForgeProblem = { kind: ProblemKind; cli: 'gh' | 'glab' | ''; host: string }

export type ForgeResult<T> = { ok: true; value: T } | { ok: false; problem: ForgeProblem }

export interface Forge {
  kind: ForgeKind
  remote: Remote
  /** '#' (GitHub) or '!' (GitLab): how a change number is spelled; `refOf(n)` is refPrefix + n. */
  refPrefix: '#' | '!'
  refOf(n: number): string
  /** `timeoutMs` bounds the call (the fingerprint chain gives it less than the default). */
  repoInfo(opts?: { timeoutMs?: number }): Promise<ForgeResult<{ webUrl: string; defaultBranch: string }>>
  /**
   * `state` narrows the query (default `all`), so a caller can ask for open changes with status and for merged ones
   * without; `timeoutMs` bounds each underlying call. `isLight` (with `withStatus`) skips what costs a call per change
   * and is not needed to notice a change: on GitLab the approvals lookup (`review` stays '' unless the list itself says
   * changes were requested). GitHub's status comes with the list, so it ignores `isLight`.
   */
  listChanges(opts?: {
    withStatus?: boolean
    /** Open changes also carry `review` and `reviewFacts` (GitHub; GitLab ignores it). */
    withReview?: boolean
    isLight?: boolean
    limit?: number
    state?: ChangeState | 'all'
    timeoutMs?: number
  }): Promise<ForgeResult<Change[]>>
  filesChanged(n: number): Promise<ForgeResult<string[]>>
  /** The signed-in user's login on this forge; '' when it cannot say. GitHub only (absent on GitLab). */
  viewer?(opts?: { timeoutMs?: number }): Promise<string>
  /** The teams the signed-in user is in, as `org/slug`; null when the forge cannot say. GitHub only. */
  viewerTeams?(opts?: { timeoutMs?: number }): Promise<string[] | null>
  /** Cheap digest of the remote change state; THROWS ForgeError on failure (the refresh engine turns it into one line). */
  fingerprint(): Promise<string>
  /** Web link to a line of a file on a branch; '' when `webUrl` is ''. */
  fileUrl(webUrl: string, branch: string, path: string, line: number): string
}
