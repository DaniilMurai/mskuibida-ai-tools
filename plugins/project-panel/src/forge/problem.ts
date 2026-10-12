import type { ProviderHost } from '../../types'
import { t } from '../strings/en'
import type { ForgeKind, ForgeProblem, ForgeResult } from './types'

// Why a forge call failed, in words the person can act on. A failed `gh`/`glab` call is classified only
// after the fact (two cheap probes), so the happy path pays nothing.

const PROBE_MS = 5_000

// Real transport-error shapes, matched on stderr cleaned by `withoutAddresses`: the failed call's own stderr echoes the
// request URL and path, so a project called `acme/network-tools` must not read as a network failure.
const NETWORK = new RegExp(
  [
    'dial tcp',
    'no such host',
    'could not resolve host',
    'connection refused',
    'connection reset',
    'i_o timeout',
    'context deadline exceeded',
    'client\\.timeout exceeded',
    'tls handshake timeout',
    'network is unreachable',
    'operation timed out',
    '(?:^|\\s)EOF\\s*$',
  ].join('|'),
  'im',
)

/** stderr without anything that is an address rather than a message: URLs, quoted strings, and path-like words (`i/o` is kept). */
function withoutAddresses(stderr: string): string {
  return stderr
    .replace(/i\/o/gi, 'i_o')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ')
    .replace(/\S*(?:\/|%2f)\S*/gi, ' ')
}

/** True when `stderr` reads as a transport failure (offline, DNS, refused, timed out), never because of an address in it. */
export function looksLikeNetwork(stderr: string): boolean {
  return NETWORK.test(withoutAddresses(stderr))
}

/** A failed forge call that must surface (the remote fingerprint): `display` is the finished line for the pane. */
export class ForgeError extends Error {
  readonly problem: ForgeProblem
  /** The Attention line, resolved through `t()`; '' when no copy exists (the caller falls back). */
  readonly display: string

  constructor(problem: ForgeProblem, kind: ForgeKind) {
    const cause = problemText(problem)
    super(cause)
    this.name = 'ForgeError'
    this.problem = problem
    this.display = cause === '' ? '' : t(`refresh.remoteFailed.${kind}`, { cause })
  }
}

/** The cause as a short phrase: "glab not logged in to gitlab.example.test". '' for a problem with no copy. */
export function problemText(problem: ForgeProblem): string {
  const params = { cli: problem.cli, host: problem.host }
  switch (problem.kind) {
    case 'missing':
      return t('forge.cause.missing', params)
    case 'not-logged-in':
      return t('forge.cause.notLoggedIn', params)
    case 'unreachable':
      return t('forge.cause.unreachable', params)
    case 'failed':
      return t('forge.cause.failed', params)
    case 'no-remote':
      return t('forge.cause.noRemote', params)
  }
}

/** What a failed attempt left behind: it never started or timed out, or it exited non-zero with this stderr. */
export type Attempt = { isRejected: true } | { isRejected: false; exitCode: number; stderr: string }

/** One command through the host: `null` when it could not start or timed out. Never rejects. */
async function probe(
  host: ProviderHost,
  argv: readonly string[],
): Promise<{ exitCode: number; stderr: string } | null> {
  try {
    const r = await host.run(argv, { timeoutMs: PROBE_MS })
    return { exitCode: r.exitCode, stderr: r.stderr }
  } catch {
    return null
  }
}

/**
 * Names the problem behind a failed call. A call that never ran: ask `<cli> --version`; if that fails too
 * the CLI is missing, else the call timed out (unreachable). A non-zero exit: ask `<cli> auth status` for the
 * host; if that fails the person is not logged in (unless it failed for want of a network), else a network-
 * looking stderr is unreachable, anything else failed.
 */
export async function classify(
  host: ProviderHost,
  cli: 'gh' | 'glab',
  hostName: string,
  attempt: Attempt,
): Promise<ForgeProblem> {
  const problem = (kind: ForgeProblem['kind']): ForgeProblem => ({ kind, cli, host: hostName })
  if (attempt.isRejected) {
    const version = await probe(host, [cli, '--version'])
    return problem(version === null ? 'missing' : 'unreachable')
  }
  const auth = await probe(host, [cli, 'auth', 'status', '--hostname', hostName])
  if (auth === null) return problem('unreachable')
  if (auth.exitCode !== 0) return problem(looksLikeNetwork(auth.stderr) ? 'unreachable' : 'not-logged-in')
  return problem(looksLikeNetwork(attempt.stderr) ? 'unreachable' : 'failed')
}

/**
 * Runs one forge command and answers rather than rejects: stdout on exit 0, else the classified problem.
 * `cwd` is for gh, which reads the repository from it.
 */
export async function runCli(
  host: ProviderHost,
  cli: 'gh' | 'glab',
  hostName: string,
  argv: readonly string[],
  init: { cwd?: string; timeoutMs: number; isQuiet?: boolean },
): Promise<ForgeResult<string>> {
  let attempt: Attempt
  try {
    const r = await host.run([cli, ...argv], init.cwd === undefined ? { timeoutMs: init.timeoutMs } : { cwd: init.cwd, timeoutMs: init.timeoutMs })
    if (r.exitCode === 0) return { ok: true, value: r.stdout }
    attempt = { isRejected: false, exitCode: r.exitCode, stderr: r.stderr }
  } catch {
    attempt = { isRejected: true }
  }
  // A quiet call (a per-item lookup whose failure only leaves a field empty) pays for no probes.
  if (init.isQuiet === true) return { ok: false, problem: { kind: 'failed', cli, host: hostName } }
  return { ok: false, problem: await classify(host, cli, hostName, attempt) }
}

/** `runCli` whose stdout is JSON; unreadable output is a `failed` problem. */
export async function runJson(
  host: ProviderHost,
  cli: 'gh' | 'glab',
  hostName: string,
  argv: readonly string[],
  init: { cwd?: string; timeoutMs: number; isQuiet?: boolean },
): Promise<ForgeResult<unknown>> {
  const r = await runCli(host, cli, hostName, argv, init)
  if (!r.ok) return r
  try {
    return { ok: true, value: JSON.parse(r.value) as unknown }
  } catch {
    return { ok: false, problem: { kind: 'failed', cli, host: hostName } }
  }
}
