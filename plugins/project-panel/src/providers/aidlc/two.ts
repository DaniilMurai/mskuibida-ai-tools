// Two truths for one intent (M3), the reading half: what the repository and the forge say about the plan's state
// file besides the copy in this working tree. Every command goes through `ctx.host.run` (argv only, refs checked
// with `isSafeRef`); the forge calls live in ./prs.ts, the rules in ./truths.ts.
//
// `null` = one truth: not inside a git work tree, or no `origin/<default>` to compare with (and none to fetch).
// The panel then draws exactly what it drew before M3: the working tree's state file, no landing, no PR chips.
//
// A load is cheap in the steady state: the repository's top level and the intent's prefix never change, the
// default branch's copy of the state file is read again only when `origin/<default>` moved, and the PR list is
// reused for a minute (./memo.ts). What is left is one `git rev-parse --verify origin/<default>`, plus a
// `git rev-list` on a stage branch.
import { join, parent } from '../../fsx'
import type { Fsx } from '../../fsx'
import type { ProviderContext } from '../../../types'
import { fetchDefault, isSafeRef, sh, showRemote } from '../ledger/host'
import { SHORT_MS, mains, missingRefs, prefixes, tops } from './memo'
import { changedFiles, defaultBranch, forgeOf, listChanges, refOf } from './prs'
import { parseState } from './parse-state'
import { reviewCtxOf } from '../review/viewer'
import { RANK, carriedBy, mapPrs, markerOn, reopenCandidates, ticketOf } from './truths'
import type { BranchOptions } from './truths'
import type { Two } from './truths'
import type { ParsedState } from './types'

/** The repository's top level for `dir`; asked once per directory (null, not being in a repository, is asked again). */
async function topOf(ctx: ProviderContext, dir: string): Promise<string | null> {
  const known = tops.get(dir)
  if (known !== undefined) return known
  const r = await sh(ctx.host, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], undefined)
  const top = r.out.trim()
  if (!r.ok || top === '') return null
  tops.set(dir, top)
  return top
}

/** Where `dir` sits in the repository (`a/b/` or ''); null when git cannot say. Static, so asked once. */
async function prefixOf(ctx: ProviderContext, dir: string): Promise<string | null> {
  const known = prefixes.get(dir)
  if (known !== undefined) return known
  const r = await sh(ctx.host, ['git', '-C', dir, 'rev-parse', '--show-prefix'], undefined)
  if (!r.ok) return null
  const prefix = r.out.trim()
  prefixes.set(dir, prefix)
  return prefix
}

/**
 * The sha of `origin/<base>` ('' when the ref is there but git printed nothing), or null when it is missing. A
 * missing ref is fetched for once, then left alone for a minute: the remote cadence (the fingerprint) fetches.
 */
async function headOf(ctx: ProviderContext, root: string, base: string): Promise<string | null> {
  const ask = async () => {
    const r = await sh(ctx.host, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', `origin/${base}`], undefined)
    return r.ok ? r.out.trim() : null
  }
  const first = await ask()
  if (first !== null) return first
  const key = `${root}\0${base}`
  const missedAt = missingRefs.get(key)
  if (missedAt !== undefined && ctx.now - missedAt < SHORT_MS) return null
  await fetchDefault(ctx.host, root, base)
  const second = await ask()
  if (second === null) missingRefs.set(key, ctx.now)
  else missingRefs.delete(key)
  return second
}

/** The default branch's copy of the file: read through git only when `origin/<base>` is not at the sha it was read at. */
async function mainTextOf(ctx: ProviderContext, root: string, base: string, path: string, sha: string): Promise<string | null> {
  const key = `${root}\0${base}\0${path}`
  const hit = mains.get(key)
  if (hit && sha !== '' && hit.sha === sha) return hit.text
  const text = await showRemote(ctx.host, root, base, path)
  // A null (no such file, or a `git show` that failed for a moment) is asked again: only a real copy is kept.
  if (sha !== '' && text !== null) mains.set(key, { sha, text })
  return text
}

/** True when the folder, or a folder one level down, holds a file. A missing folder holds none. */
async function hasFiles(fsx: Fsx, dir: string): Promise<boolean> {
  for (const entry of await fsx.list(dir)) {
    if (entry.kind === 'file') return true
    if (entry.kind === 'dir' && (await fsx.list(join(dir, entry.name))).some(inner => inner.kind === 'file')) return true
  }
  return false
}

/**
 * The stages the session might be on whose artifact folder (`<intent dir>/<phase>/<stage>/`) holds no files in
 * this working tree: not started, however the box reads. Candidates are the current stage and any stage marked
 * in progress or awaiting that the default branch has not completed. A phase that works per unit keeps its
 * artifacts elsewhere, so it has no say.
 */
async function quietStages(ctx: ProviderContext, statePath: string, local: ParsedState, main: ParsedState | null, current: string) {
  const intentDir = parent(statePath) ?? ''
  const quiet = new Set<string>()
  for (const phase of local.phases) {
    if (phase.perUnit !== '') continue
    for (const stage of phase.stages) {
      if (!stage.isExecuted || markerOn(main, stage.slug) === 'completed') continue
      const isCandidate =
        stage.marker === 'in-progress' || stage.marker === 'awaiting-approval' || (stage.marker === 'pending' && stage.slug === current)
      if (!isCandidate) continue
      if (!(await hasFiles(ctx.fsx, join(intentDir, phase.key.toLowerCase(), stage.slug)))) quiet.add(stage.slug)
    }
  }
  return quiet
}

/** Reads the default branch's copy of `statePath`'s file and the PRs around it; null = one truth. */
export async function readTwo(
  ctx: ProviderContext,
  statePath: string,
  local: ParsedState,
  sessionBranch: string,
  current = '',
): Promise<Two | null> {
  const { host, now, options } = ctx
  const override = options.forge ?? 'auto'
  const root = await topOf(ctx, ctx.startDir)
  if (root === null) return null

  // Where the intent's directory sits in the repository: git knows, so /tmp against /private/tmp cannot matter.
  const dir = parent(statePath) ?? ''
  const [prefixed, base] = await Promise.all([prefixOf(ctx, dir), defaultBranch(host, root, now, override)])
  if (prefixed === null || !isSafeRef(base)) return null
  const prefix = prefixed

  const sha = await headOf(ctx, root, base)
  if (sha === null) return null

  const file = statePath.slice(statePath.lastIndexOf('/') + 1)
  const [mainText, prs] = await Promise.all([mainTextOf(ctx, root, base, prefix + file, sha), listChanges(host, root, now, sha, override)])
  const main = mainText === null ? null : parseState(mainText)

  const order = local.phases.flatMap(p => p.stages.filter(s => s.isExecuted && s.marker !== 'skipped').map(s => s.slug))
  // A phase branch (docs/inception) carries every executed stage of its phase.
  const branches: BranchOptions = {
    ...options,
    phases: Object.fromEntries(
      local.phases.map(p => [p.key.toLowerCase(), p.stages.filter(s => s.isExecuted && s.marker !== 'skipped').map(s => s.slug)]),
    ),
  }
  const startMs = Date.parse(local.fields['Start Date'] ?? '')
  // The session's branch, as the stages it carries: a stage branch (or a phase branch, which names no ticket) of this plan.
  const carried = sessionBranch === '' ? { stages: [], isPhase: false } : carriedBy(sessionBranch, order, branches)
  const mapped = prs
    ? mapPrs(prs, order, {
        ...branches,
        // Only a session on a stage branch of this plan sees just its own ticket's PRs. A branch the pattern reads but
        // that names no stage (`ms/BM-218/sprint-rules`, side work) says nothing about the plan's ticket, so every
        // ticket's stage and phase PRs count there, as anywhere else.
        ticket: carried.stages.length > 0 && !carried.isPhase ? ticketOf(sessionBranch, options) : null,
        startMs: Number.isNaN(startMs) ? null : startMs,
      })
    : []

  const asked = reopenCandidates(mapped)
  const lists = await Promise.all(asked.map(pr => changedFiles(host, root, pr, now, override)))
  const files = new Map(asked.map((pr, i) => [pr.number, lists[i] ?? []] as const))

  // How far the session's branch is behind the default branch, asked of git whatever the forge says about the PR
  // (it only reports BEHIND under strict branch protection). Nothing to ask when every stage on the branch is
  // already on the default branch, or when the PR's own BEHIND gate will say it.
  // A session on a phase branch carries the phase's stages not on main yet; one on a stage branch, every one it names.
  const sessionStages = carried.isPhase ? carried.stages.filter(slug => markerOn(main, slug) !== 'completed') : carried.stages
  // A merged stage whose box here went back (a backward jump reopened it) is unmerged work again.
  const hasUnmerged = sessionStages.some(slug => markerOn(main, slug) !== 'completed' || markerOn(local, slug) !== 'completed')
  const isPrBehind = prs?.some(pr => pr.state === 'OPEN' && pr.headRefName === sessionBranch && pr.mergeStateStatus === 'BEHIND') ?? false
  let behind = 0
  if (hasUnmerged && sessionBranch !== base && !isPrBehind) {
    const counted = await sh(host, ['git', '-C', ctx.startDir, 'rev-list', '--count', `HEAD..origin/${base}`], undefined)
    const n = counted.ok ? Number.parseInt(counted.out.trim(), 10) : 0
    behind = Number.isNaN(n) ? 0 : n
  }

  // Work on the session's branch that no open PR carries is either pushed or not: only an unpushed stage is "local
  // only". Asked of the local remote-tracking ref (nothing is fetched), and only when a stage depends on the answer.
  const isOpenPr = (slug: string) => mapped.some(m => m.pr.state === 'OPEN' && m.stages.includes(slug))
  const isAhead = (slug: string) => RANK[markerOn(local, slug)] > RANK[markerOn(main, slug)] || markerOn(local, slug) === 'revising'
  let isPushed = false
  if (sessionBranch !== base && isSafeRef(sessionBranch) && sessionStages.some(slug => isAhead(slug) && !isOpenPr(slug))) {
    isPushed = (await sh(host, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${sessionBranch}`], undefined)).ok
  }

  const quiet = await quietStages(ctx, statePath, local, main, current)

  // Found by the calls above (kept per root); how this forge spells a change, and which noun the copy uses for it.
  const forge = await forgeOf(host, root, override)
  const spelled = (number: number) => refOf(number, forge)

  const open = (prs ?? []).filter(pr => pr.state === 'OPEN')
  const review = await reviewCtxOf({
    forge,
    root,
    now,
    options,
    open,
    settings: () => ctx.fsx.read(join(root, '.claude', 'settings.json')),
  })

  return {
    refOf: spelled,
    forgeKind: forge?.kind ?? 'github',
    base,
    main,
    mapped,
    files,
    prefix,
    sessionBranch,
    sessionStages,
    behind,
    isPrsKnown: prs !== null,
    isPushed,
    current,
    quiet,
    open,
    review,
  }
}
