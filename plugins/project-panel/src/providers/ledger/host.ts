import type { ProviderHost } from '../../../types'
import type { Change, Forge } from '../../forge/types'
import type { Pr } from './types'

// Everything the ledger provider asks of git (and, for the default branch, of the forge), through the host
// (`ctx.host.run`, no shell). Each helper answers rather than rejects: a missing tool, a non-zero exit or a timeout is an ordinary "no" value, so the
// provider can fall back instead of failing. Nothing here writes to the repository: `git fetch` only updates
// remote-tracking refs.

const GIT_MS = 15_000
const NET_MS = 30_000

/** Branch names safe to put into an argv: no option-looking start, no `..`, a conservative alphabet. */
export function isSafeRef(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-') && !name.includes('..')
}

/** Runs `argv`; `out` is trimmed-trailing stdout, `ok` is exit 0. Never rejects. */
export async function sh(
  host: ProviderHost,
  argv: readonly string[],
  cwd: string | undefined,
  timeoutMs = GIT_MS,
): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await host.run(argv, cwd === undefined ? { timeoutMs } : { cwd, timeoutMs })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

/** The repository's top-level directory for `dir`, or null when `dir` is not inside a git work tree. */
export async function repoRoot(host: ProviderHost, dir: string): Promise<string | null> {
  const r = await sh(host, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], undefined)
  const root = r.out.trim()
  return r.ok && root !== '' ? root : null
}

// Modes git gives symlinks and submodules; neither is ever read, listed or sent.
const SYMLINK = '120000'
const SUBMODULE = '160000'

/**
 * Regular files git tracks (`git ls-files -s -z`), symlinks and submodules dropped. The index is the
 * reference, not the working directory: a tracked symlink never counts, so whatever it points at is
 * never reached.
 */
export async function localTracked(host: ProviderHost, root: string): Promise<string[]> {
  const r = await sh(host, ['git', '-C', root, 'ls-files', '-s', '-z'], undefined)
  if (!r.ok) return []
  const paths = new Set<string>()
  for (const entry of splitNul(r.out)) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/s.exec(entry)
    if (m && m[1] !== SYMLINK && m[1] !== SUBMODULE) paths.add(m[2] as string)
  }
  return [...paths]
}

/**
 * Regular files on `origin/<branch>` (`git ls-tree -r -z`, the full form), symlinks and submodules dropped;
 * null when that ref cannot be read.
 */
export async function remoteTracked(host: ProviderHost, root: string, branch: string): Promise<string[] | null> {
  if (!isSafeRef(branch)) return null
  const r = await sh(host, ['git', '-C', root, 'ls-tree', '-r', '-z', `origin/${branch}`], undefined)
  if (!r.ok) return null
  const paths: string[] = []
  for (const entry of splitNul(r.out)) {
    const m = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/s.exec(entry)
    if (m && m[1] !== SYMLINK && m[1] !== SUBMODULE) paths.push(m[2] as string)
  }
  return paths
}

function splitNul(out: string): string[] {
  return out.split('\0').filter(p => p !== '')
}

/** Updates the remote-tracking ref of the default branch; false when offline or refused (tolerated). */
export async function fetchDefault(host: ProviderHost, root: string, branch: string, timeoutMs = NET_MS): Promise<boolean> {
  if (!isSafeRef(branch)) return false
  return (await sh(host, ['git', '-C', root, 'fetch', '--quiet', 'origin', branch], undefined, timeoutMs)).ok
}

/** One file's text on `origin/<branch>`, or null. Only call with paths that passed `isSendable`. */
export async function showRemote(host: ProviderHost, root: string, branch: string, path: string): Promise<string | null> {
  if (!isSafeRef(branch) || path.startsWith('-')) return null
  const r = await sh(host, ['git', '-C', root, 'show', `origin/${branch}:${path}`], undefined)
  return r.ok ? r.out : null
}

/**
 * One file's committed text at HEAD (`git show HEAD:<path>`), or null. Repository content is only ever read
 * through git, never through the file system, so a symlink in the working tree cannot redirect a read and
 * uncommitted edits are not sent. Only call with paths that passed `isSendable`.
 */
export async function showLocal(host: ProviderHost, root: string, path: string): Promise<string | null> {
  if (path.startsWith('-')) return null
  const r = await sh(host, ['git', '-C', root, 'show', `HEAD:${path}`], undefined)
  return r.ok ? r.out : null
}

/** The branch checked out at `dir`; '' for a detached HEAD or on any failure. */
export async function currentBranch(host: ProviderHost, dir: string): Promise<string> {
  const r = await sh(host, ['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined)
  const name = r.out.trim()
  return r.ok && name !== 'HEAD' ? name : ''
}

/**
 * What the forge and git say about the repository: its web address ('' when unknown) and default branch.
 * `forge` is the repository's forge as the caller found it with the person's `forge` option (`null` = none, e.g.
 * no origin or `forge: none`); it is required, so no caller can fall back to a detection that ignores the option.
 * The default branch falls back to `origin/HEAD`, the
 * DELIVERY file's `primary-branch`, then `main`.
 */
export async function repoFacts(
  host: ProviderHost,
  root: string,
  primaryBranchHint: () => Promise<string>,
  timeoutMs: number | undefined,
  forge: Forge | null,
): Promise<{ repoUrl: string; defaultBranch: string }> {
  let repoUrl = ''
  let branch = ''
  if (forge !== null) {
    const info = await forge.repoInfo(timeoutMs === undefined ? {} : { timeoutMs })
    if (info.ok) {
      repoUrl = info.value.webUrl
      branch = info.value.defaultBranch
    }
  }
  if (!isSafeRef(branch)) {
    const head = await sh(host, ['git', '-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], undefined, timeoutMs)
    branch = head.ok ? head.out.trim().replace(/^origin\//, '') : ''
  }
  if (!isSafeRef(branch)) branch = await primaryBranchHint()
  if (!isSafeRef(branch)) branch = 'main'
  return { repoUrl, defaultBranch: branch }
}

/** The forge's review decision in gh's spelling, as the review state reads it. */
const REVIEW_DECISION: Record<Change['review'], string> = {
  approved: 'APPROVED',
  'changes-requested': 'CHANGES_REQUESTED',
  required: 'REVIEW_REQUIRED',
  '': '',
}

/** A forge change as the matcher's `Pr`: the state in gh's upper case, labels as `{ name }`, a url only when known. */
export function toPr(change: Change): Pr {
  const pr: Pr = {
    number: change.number,
    title: change.title,
    state: change.state === 'merged' ? 'MERGED' : change.state === 'closed' ? 'CLOSED' : 'OPEN',
    headRefName: change.sourceBranch,
    labels: change.labels.map(name => ({ name })),
    mergedAt: change.mergedAt,
  }
  if (change.url !== '') pr.url = change.url
  if (change.state === 'open') {
    pr.isDraft = change.isDraft
    if (change.headSha !== '') pr.headRefOid = change.headSha
    pr.reviewDecision = REVIEW_DECISION[change.review]
    if (change.reviewFacts) pr.review = change.reviewFacts
  }
  return pr
}
