import type { ProviderHost } from '../../types'
import { githubForge } from './github'
import { gitlabForge } from './gitlab'
import { hostKey, parseRemote } from './remote'
import type { Forge, ForgeKind, ForgeProblem, Remote } from './types'

// Which forge a repository's origin lives on. The order is fixed and never consults a list of known hosts:
//   1. override `none`: no forge, no problem (the person opted out);
//   2. no readable origin: the `no-remote` problem;
//   3. override `github` / `gitlab`: that forge for the origin's host, no probing;
//   4. github.com: GitHub;
//   5. `glab auth status --hostname H` succeeds: GitLab;
//   6. `gh auth status --hostname H` succeeds: GitHub Enterprise;
//   7. otherwise GitLab anyway (a self-hosted non-GitHub host is far more often GitLab), so its calls report
//      the real problem (not logged in, unreachable, missing). That fallback is remembered for 60 s, so a
//      host with no login does not pay the probes on every load and poll.

export type ForgeOverride = 'auto' | 'github' | 'gitlab' | 'none'

/** `isFallback`: GitLab only because nothing else answered (rule 7); a caller keeping the forge should not keep this one. */
export type Detected = { forge: Forge | null; problem?: ForgeProblem; isFallback?: true }

const PROBE_MS = 5_000
/** A "neither is logged in" answer is trusted this long before the two probes run again. */
const NEGATIVE_MS = 60_000

/**
 * What was detected, by root and origin URL: the KIND only. A Forge captures the ProviderHost it was built with, so
 * it is rebuilt from the current host on every call; a module reload clears this.
 */
const known = new Map<string, ForgeKind>()
/** The "GitLab anyway" fallback, with the time it was decided: until it is old, the auth probes are not repeated. */
const unproven = new Map<string, number>()

let clock: () => number = () => Date.now()

/** Forgets every cached detection (and restores the real clock); the tests call it between worlds. */
export function resetForgeCache(): void {
  known.clear()
  unproven.clear()
  clock = () => Date.now()
}

/** Replaces the clock the 60 s negative cache reads (tests only). */
export function setForgeClock(now: () => number): void {
  clock = now
}

function forgeOf(kind: ForgeKind, host: ProviderHost, root: string, remote: Remote): Forge {
  return kind === 'github' ? githubForge(host, root, remote) : gitlabForge(host, root, remote)
}

async function isLoggedIn(host: ProviderHost, cli: 'gh' | 'glab', remote: Remote): Promise<boolean> {
  try {
    return (await host.run([cli, 'auth', 'status', '--hostname', hostKey(remote)], { timeoutMs: PROBE_MS })).exitCode === 0
  } catch {
    return false
  }
}

/** The origin URL of the repository at `root`, or '' when it has none. */
async function originOf(host: ProviderHost, root: string): Promise<string> {
  try {
    const r = await host.run(['git', '-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: PROBE_MS })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

export async function detectForge(host: ProviderHost, root: string, override: ForgeOverride): Promise<Detected> {
  if (override === 'none') return { forge: null }

  const url = await originOf(host, root)
  const remote = url === '' ? null : parseRemote(url)
  if (remote === null) return { forge: null, problem: { kind: 'no-remote', cli: '', host: '' } }

  if (override === 'github' || override === 'gitlab') return { forge: forgeOf(override, host, root, remote) }
  if (remote.host === 'github.com') return { forge: forgeOf('github', host, root, remote) }

  const key = `${root}\u0000${url}`
  const kind = known.get(key)
  if (kind) return { forge: forgeOf(kind, host, root, remote) }

  const decidedAt = unproven.get(key)
  if (decidedAt !== undefined && clock() - decidedAt < NEGATIVE_MS) return { forge: forgeOf('gitlab', host, root, remote), isFallback: true }

  if (await isLoggedIn(host, 'glab', remote)) return remember(key, 'gitlab', host, root, remote)
  if (await isLoggedIn(host, 'gh', remote)) return remember(key, 'github', host, root, remote)
  // Remembered for a minute only: logging in later is picked up by a load after that.
  unproven.set(key, clock())
  return { forge: forgeOf('gitlab', host, root, remote), isFallback: true }
}

function remember(key: string, kind: ForgeKind, host: ProviderHost, root: string, remote: Remote): Detected {
  known.set(key, kind)
  unproven.delete(key)
  return { forge: forgeOf(kind, host, root, remote) }
}
