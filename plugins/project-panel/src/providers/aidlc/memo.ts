// What the AI-DLC provider remembers between loads, in one place so one call forgets it all (the tests do).
// Everything here is either static for a checkout (the repository's top level, a directory's prefix), keyed by
// the sha it was derived from (the default branch's copy of the state file, the PR list), or a short-lived
// negative answer (a failed forge call, a ref that is not there), so a steady-state load asks git one question.
import { resetViewer } from '../review/viewer'
import type { StagePr } from './prs'

/** A cached negative answer or a PR list lives this long (by the caller's clock). */
export const SHORT_MS = 60_000

/** The PR list, and the `origin/<base>` sha it was read at: a moved default branch refetches it. */
export type Listing = { at: number; sha: string; rows: StagePr[]; raw: string }

export const lists = new Map<string, Listing>()
/** When the last PR list failed, by root. */
export const listFailed = new Map<string, number>()
/** The default branch by root; `ttl` is short when the forge did not answer and the name is a fallback. */
export const facts = new Map<string, { at: number; ttl: number; name: string }>()
/** A PR's changed paths by `number:headRefOid`; `at` is null for a real answer, the failure time otherwise. */
export const files = new Map<string, { paths: string[]; at: number | null }>()
/** `git rev-parse --show-toplevel` by start dir (only real answers). */
export const tops = new Map<string, string>()
/** `git rev-parse --show-prefix` by the state file's directory (only real answers). */
export const prefixes = new Map<string, string>()
/** The default branch's copy of a state file by `root\0base\0path`, valid while `origin/<base>` is at `sha`. */
export const mains = new Map<string, { sha: string; text: string | null }>()
/** When `origin/<base>` was last found missing even after a fetch, by `root\0base`. */
export const missingRefs = new Map<string, number>()
/** Roots where the forge has answered at least once in this process. */
export const forgeWorked = new Set<string>()

/** Forgets everything; the tests call it between worlds. */
export function resetCache(): void {
  lists.clear()
  listFailed.clear()
  facts.clear()
  files.clear()
  tops.clear()
  prefixes.clear()
  mains.clear()
  missingRefs.clear()
  forgeWorked.clear()
  resetViewer()
}
