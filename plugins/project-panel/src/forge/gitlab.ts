import type { ProviderHost } from '../../types'
import { inputHash } from '../providers/ledger/hash'
import { ForgeError, runCli, runJson } from './problem'
import { hostKey, webBase } from './remote'
import type { Change, ChangeState, Forge, ForgeProblem, ForgeResult, Remote } from './types'

// GitLab (hosted or self-hosted) through `glab`, read-only: `mr list`, `mr view`, `api` GET. Every merge-
// request command gets `-R <web address>`: a full URL, which glab accepts for any host and then needs no
// GITLAB_HOST (a bare `group/repo` 404s on a custom host). `glab api` takes `--hostname` instead.

const NET_MS = 30_000
/** The remote fingerprint gives its command this long (src/refresh.ts gives the whole call 30 s). */
const FINGERPRINT_MS = 12_000
const PAGE_SIZE = 100
const DEFAULT_LIMIT = 1000
/** Open merge requests that get a pipeline and approvals lookup: the list carries neither. */
const STATUS_MAX = 20
/** Per-merge-request glab calls (view, approvals) running at once. */
const STATUS_CONCURRENCY = 5
/** `/diffs` pages of a merge request, at most (100 files each). */
const DIFF_PAGES_MAX = 30
const FINGERPRINT_ROWS = 30

/** `glab mr list` shows open requests by default; the other states are flags. */
const STATE_FLAG: Record<ChangeState | 'all', string[]> = { all: ['--all'], open: [], merged: ['--merged'], closed: ['--closed'] }

const STATES: Record<string, Change['state']> = { opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' }

const MERGE_STATE: Record<string, string> = {
  need_rebase: 'behind',
  mergeable: 'clean',
  conflict: 'dirty',
  broken_status: 'dirty',
  not_approved: 'blocked',
  blocked_status: 'blocked',
  discussions_not_resolved: 'blocked',
  draft_status: 'blocked',
  ci_must_pass: 'blocked',
  not_open: 'blocked',
  requested_changes: 'blocked',
  checking: 'unknown',
  unchecked: 'unknown',
  ci_still_running: 'unknown',
  preparing: 'unknown',
}

const PIPELINE: Record<string, Change['ci']> = {
  success: 'success',
  failed: 'failed',
  running: 'running',
  pending: 'pending',
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  scheduled: 'pending',
  manual: 'pending',
  canceled: 'canceled',
  skipped: 'skipped',
}

/** A list row as a Change, with the raw `detailed_merge_status` the status lookup needs. */
type Row = { change: Change; detail: string }

function toRow(raw: unknown): Row[] {
  if (typeof raw !== 'object' || raw === null) return []
  const p = raw as Record<string, unknown>
  const state = typeof p.state === 'string' ? STATES[p.state] : undefined
  if (typeof p.iid !== 'number' || typeof p.title !== 'string' || typeof p.source_branch !== 'string' || state === undefined) return []
  const detail = typeof p.detailed_merge_status === 'string' ? p.detailed_merge_status : ''
  return [
    {
      detail,
      change: {
        number: p.iid,
        title: p.title,
        state,
        isDraft: p.draft === true,
        sourceBranch: p.source_branch,
        url: typeof p.web_url === 'string' ? p.web_url : '',
        mergedAt: typeof p.merged_at === 'string' && p.merged_at !== '' ? p.merged_at : null,
        labels: Array.isArray(p.labels) ? p.labels.filter((l): l is string => typeof l === 'string') : [],
        headSha: typeof p.sha === 'string' ? p.sha : '',
        review: '',
        ci: '',
        failingChecks: [],
        mergeState: state === 'open' ? (MERGE_STATE[detail] ?? '') : '',
      },
    },
  ]
}

/** A semaphore: `limited(fn)` runs `fn` once fewer than `max` others are running. */
function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let live = 0
  const waiting: (() => void)[] = []
  return async fn => {
    if (live >= max) await new Promise<void>(resolve => waiting.push(resolve))
    else live++
    try {
      return await fn()
    } finally {
      // Hand the slot straight to the next waiter, so no newcomer can slip in between.
      const next = waiting.shift()
      if (next) next()
      else live--
    }
  }
}

/** A list/page answer that is nothing at all (empty output, whitespace, `null`) is an empty list: the end of paging. */
function asList(value: unknown): unknown[] | null {
  if (value === null) return []
  return Array.isArray(value) ? value : null
}

export function gitlabForge(host: ProviderHost, root: string, remote: Remote): Forge {
  const hostName = hostKey(remote)
  const web = webBase(remote)
  const project = `projects/${encodeURIComponent(remote.path)}`
  const failed = (): { ok: false; problem: ForgeProblem } => ({ ok: false, problem: { kind: 'failed', cli: 'glab', host: hostName } })
  const ask = (argv: string[], timeoutMs = NET_MS) => runJson(host, 'glab', hostName, argv, { cwd: root, timeoutMs })
  const api = (path: string, timeoutMs = NET_MS) => ask(['api', '--hostname', hostName, path], timeoutMs)
  /** One page of rows: a body that is empty, blank or `null` is `[]`. */
  async function pageOf(argv: string[], timeoutMs = NET_MS): Promise<ForgeResult<unknown[]>> {
    const r = await runCli(host, 'glab', hostName, argv, { cwd: root, timeoutMs })
    if (!r.ok) return r
    if (r.value.trim() === '') return { ok: true, value: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(r.value)
    } catch {
      return failed()
    }
    const list = asList(parsed)
    return list === null ? failed() : { ok: true, value: list }
  }
  const mrs = (extra: string[], timeoutMs = NET_MS, state: ChangeState | 'all' = 'all') =>
    pageOf(['mr', 'list', '-R', web, ...STATE_FLAG[state], '-F', 'json', ...extra], timeoutMs)

  /**
   * Pipeline status and approval of one open merge request; an unreadable answer leaves its field empty. Lookups are
   * quiet (a failure runs no classify probes) and go through `limited`, so a long list never has more than
   * STATUS_CONCURRENCY glab calls in flight. `isLight` skips the approvals call.
   */
  async function withStatus(
    { change, detail }: Row,
    limited: ReturnType<typeof limiter>,
    isLight: boolean,
    timeoutMs: number | undefined,
  ): Promise<Change> {
    const quiet = (argv: string[]) => limited(() => runJson(host, 'glab', hostName, argv, { cwd: root, timeoutMs: timeoutMs ?? NET_MS, isQuiet: true }))
    const [view, approvals] = await Promise.all([
      quiet(['mr', 'view', String(change.number), '-R', web, '-F', 'json']),
      detail === 'requested_changes' || isLight
        ? Promise.resolve(null)
        : quiet(['api', '--hostname', hostName, `${project}/merge_requests/${change.number}/approvals`]),
    ])
    const pipeline = view.ok ? (view.value as { head_pipeline?: { status?: unknown } | null } | null)?.head_pipeline : null
    const ci = typeof pipeline?.status === 'string' ? (PIPELINE[pipeline.status] ?? '') : ''
    let review: Change['review'] = ''
    if (detail === 'requested_changes') review = 'changes-requested'
    else if (approvals?.ok) review = (approvals.value as { approved?: unknown } | null)?.approved === true ? 'approved' : 'required'
    return { ...change, ci, review }
  }

  return {
    kind: 'gitlab',
    remote,
    refPrefix: '!',
    refOf: n => `!${n}`,

    async repoInfo(opts = {}) {
      const r = await api(project, opts.timeoutMs)
      if (!r.ok) return r
      const info = (typeof r.value === 'object' && r.value !== null ? r.value : {}) as { web_url?: unknown; default_branch?: unknown }
      return {
        ok: true,
        value: {
          webUrl: typeof info.web_url === 'string' ? info.web_url.replace(/(\.git)?\/*$/, '') : web,
          defaultBranch: typeof info.default_branch === 'string' ? info.default_branch : '',
        },
      }
    },

    async listChanges(opts = {}) {
      const limit = opts.limit ?? DEFAULT_LIMIT
      const rows: Row[] = []
      // A page of fewer than 100 rows is the last one.
      for (let page = 1; page <= Math.ceil(limit / PAGE_SIZE); page++) {
        const r = await mrs(['-P', String(PAGE_SIZE), '-p', String(page)], opts.timeoutMs, opts.state)
        if (!r.ok) return r
        rows.push(...r.value.flatMap(toRow))
        if (r.value.length < PAGE_SIZE) break
      }
      const shown = rows.slice(0, limit)
      if (opts.withStatus !== true) return { ok: true, value: shown.map(row => row.change) }
      const open = new Set(shown.filter(row => row.change.state === 'open').slice(0, STATUS_MAX))
      const limited = limiter(STATUS_CONCURRENCY)
      return {
        ok: true,
        value: await Promise.all(shown.map(row => (open.has(row) ? withStatus(row, limited, opts.isLight === true, opts.timeoutMs) : row.change))),
      }
    },

    async filesChanged(n) {
      const paths = new Set<string>()
      const add = (list: unknown[]) => {
        for (const c of list) {
          if (typeof c !== 'object' || c === null) continue
          const file = c as { new_path?: unknown; old_path?: unknown; deleted_file?: unknown }
          if (typeof file.new_path === 'string' && file.new_path !== '') paths.add(file.new_path)
          if (file.deleted_file === true && typeof file.old_path === 'string' && file.old_path !== '') paths.add(file.old_path)
        }
      }
      // `/diffs` is paged and cheap; GitLab before 15.7 lacks it and answers `/changes` (one body, capped) instead.
      let result: ForgeResult<string[]> | null = null
      for (let page = 1; page <= DIFF_PAGES_MAX; page++) {
        const query = page === 1 ? 'per_page=100' : `per_page=100&page=${page}`
        const r = await pageOf(['api', '--hostname', hostName, `${project}/merge_requests/${n}/diffs?${query}`])
        if (!r.ok) {
          result = r.problem.kind === 'failed' ? null : r
          break
        }
        add(r.value)
        if (r.value.length < PAGE_SIZE) {
          result = { ok: true, value: [...paths] }
          break
        }
        if (page === DIFF_PAGES_MAX) result = { ok: true, value: [...paths] }
      }
      if (result) return result
      paths.clear()
      const r = await api(`${project}/merge_requests/${n}/changes`)
      if (!r.ok) return r
      const changes = (r.value as { changes?: unknown } | null)?.changes
      if (!Array.isArray(changes)) return failed()
      add(changes)
      return { ok: true, value: [...paths] }
    },

    async fingerprint() {
      // A new merge request, a state change or a push moves its merge request to the top by updated_at.
      const r = await mrs(['-P', String(FINGERPRINT_ROWS), '-o', 'updated_at', '-S', 'desc'], FINGERPRINT_MS)
      if (!r.ok) throw new ForgeError(r.problem, 'gitlab')
      const part = r.value
        .flatMap(raw => {
          const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
          return typeof p.iid === 'number' ? [`${p.iid}:${String(p.state ?? '')}:${String(p.sha ?? '')}:${String(p.updated_at ?? '')}`] : []
        })
        .join(',')
      return inputHash([part])
    },

    fileUrl: (webUrl, branch, path, line) => (webUrl === '' ? '' : `${webUrl}/-/blob/${branch}/${encodeURI(path)}#L${line}`),
  }
}
