import { WORD_ID, escapeRegExp, isTableId } from './text'
import type { DeclaredStatus, ItemMatch, ItemStatus, LedgerItem, Pr, SliceHit } from './types'

// Matches pull requests to ledger items by id, without any knowledge of a particular repository.
//
// The hard part is not finding ids in PR titles and branch names, it is not finding too many:
// `T04` must not claim a PR about `T04a`, a `fix(T04a)` PR must not make T04a "done" when the real
// delivery PR is still open, and a slug id such as `fix-T04a-backdate-picker` must not also count for
// `T04a`. Tiers (how strongly a PR names the item) and a containment rule handle those.

/** Branch types whose PRs follow up on an item rather than deliver it. */
const FOLLOWUP_TYPES = new Set(['fix', 'hotfix', 'qa'])

const QA_FAILED = 'qa:failed'

/** True when the char after an id (or before it) cannot continue an identifier. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9]/.test(ch)
}

/**
 * True when `after` (the text following an id) ends the id: a boundary that is not a `-<digit>` continuation,
 * and, for a word id (`FEAT-AUTH`), not an upper-case `-WORD` one either: `FEAT-AUTH-SSO` is another id, while a
 * lower-case slug after it (`feat/FEAT-AUTH-add-login`) is a description.
 */
function endsId(after: string, id: string): boolean {
  return isBoundary(after[0]) && !/^-\d/.test(after) && !(WORD_ID.test(id) && /^-[A-Z0-9]/.test(after))
}

/** The branch as a haystack: slashes become hyphens so `fix/fix-T04a-x` reads as one run of words. */
function normaliseBranch(branch: string): string {
  return branch.replace(/\//g, '-')
}

/**
 * Case-insensitive, boundary-aware mention test for one id. An id followed by `-<digit>` is not a mention
 * (`feat/T04-2-x` is not about `T04`), unless the item itself is that longer id; nor is a word id followed by
 * an upper-case `-WORD` (see `endsId`).
 */
function mentionOf(id: string): { test(text: string): boolean } {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}`, 'gi')
  return {
    test: (text: string) => [...text.matchAll(re)].some(m => endsId(text.slice((m.index ?? 0) + m[0].length), id)),
  }
}

/** True when `outer` mentions `inner` as a whole id (the same boundary rule as PR matching). */
function containsId(outer: string, inner: string): boolean {
  return mentionOf(inner).test(outer)
}

/** Type segment of `<type>/<rest>` branches, lower-cased; null when the branch has no slash. */
function splitBranch(branch: string): { type: string; rest: string } | null {
  const slash = branch.indexOf('/')
  if (slash <= 0) return null
  return { type: branch.slice(0, slash).toLowerCase(), rest: branch.slice(slash + 1) }
}

/**
 * True for revert PRs: a title like `Revert "…"`, `revert: …` or `revert(T12): …`, or a branch starting
 * `revert/` or `revert-`. "Revert-safe migrations for T04" is not a revert.
 */
export function isRevert(pr: Pr): boolean {
  return /^\s*revert(\s+"|:|\()/i.test(pr.title) || /^revert[/-]/i.test(pr.headRefName)
}

/** True for a branch that starts `revert/` or `revert-`. */
export const isRevertBranch = (branch: string): boolean => /^revert[/-]/i.test(branch)

/** True when `rest` begins with `id` followed by a boundary (case-insensitive). */
function startsWithId(rest: string, id: string): boolean {
  return rest.slice(0, id.length).toLowerCase() === id.toLowerCase() && endsId(rest.slice(id.length), id)
}

/**
 * Tier of a PR for an item that it mentions: 1 = delivery branch `<type>/<ID>…`, 2 = follow-up branch
 * (`fix`, `hotfix`, `qa`) `<type>/<ID>…`, 3 = any other mention. A slug id that begins with the branch type
 * (`chore-x` for `chore/x-…`) is read as if the type were spelled out.
 */
export function tierOf(id: string, branch: string): 1 | 2 | 3 {
  const b = splitBranch(branch)
  if (b && b.type !== 'revert' && !isRevertBranch(branch) && (startsWithId(b.rest, id) || startsWithId(`${b.type}-${b.rest}`, id))) {
    return FOLLOWUP_TYPES.has(b.type) ? 2 : 1
  }
  return 3
}

const CONVENTIONAL_PREFIX = /^\s*[A-Za-z]+(?:\(([^)]*)\))?!?:\s*/

/**
 * True when a PR title names `id` as its subject, the only way a loose (tier-3) mention may count toward
 * status: a conventional-commit scope containing it (`feat(T04):`, `fix(app,T04):`), a leading `[T04]`,
 * `T04:`, `T04 —`, `T04 –` or `T04 -` (also right after a conventional prefix), or a trailing parenthesis whose
 * whole content is ids (`(T04)`, `(T04, T05)`).
 * Any other mention (`… not a T06`) is a follow-up chip only.
 */
export function namesAsSubject(title: string, id: string): boolean {
  const lower = id.toLowerCase()
  const prefix = CONVENTIONAL_PREFIX.exec(title)
  if (prefix?.[1] !== undefined && prefix[1].split(/[\s,/]+/).some(part => part.toLowerCase() === lower)) return true
  const heads = prefix ? [title.trimStart(), title.slice(prefix[0].length)] : [title.trimStart()]
  const escaped = escapeRegExp(id)
  const leading = new RegExp(`^(?:\\[${escaped}\\]|${escaped}(?::|\\s+[—–-](?=\\s)))`, 'i')
  if (heads.some(head => leading.test(head))) return true
  const trailing = /\(([^()]*)\)[\s.]*$/.exec(title)
  if (trailing === null) return false
  // Only a parenthetical made of nothing but ids counts: `(T04)`, `(T04, T05)`; not `(builds on T04)`.
  const parts = (trailing[1] as string).split(/[\s,/]+/).filter(part => part !== '')
  return parts.length > 0 && parts.every(isTableId) && parts.some(part => part.toLowerCase() === lower)
}

/** The item id whose tier-1 or tier-2 pattern a branch matches (longest id wins), or null. */
export function itemIdForBranch(branch: string, items: LedgerItem[]): string | null {
  const b = splitBranch(branch)
  if (!b || b.type === 'revert' || isRevertBranch(branch)) return null
  let best: string | null = null
  for (const it of items) {
    if (!it.hasRealId) continue
    if (startsWithId(b.rest, it.id) && (best === null || it.id.length > best.length)) best = it.id
  }
  return best
}

function byNumberDesc(a: Pr, b: Pr): number {
  return b.number - a.number
}

function declaredStatus(declared: DeclaredStatus): ItemStatus {
  return declared === 'done' ? 'done' : declared === 'open' ? 'open' : 'planned'
}

/** Ids an item could be a sub-slice parent of: only ids that end in a digit (`T06`, `API-3`). */
function canHaveSlices(id: string): boolean {
  return /\d$/.test(id)
}

type Hit = { pr: Pr; tier: 1 | 2 | 3 }

/** `citePrefix`: the spelling of change numbers on this forge. Row citations (`landed via !60`) with that prefix count; without it they are ignored. */
export type MatchOptions = { citePrefix?: '#' | '!' }

/**
 * Matches PRs to items. A table row that cites the change it landed in (`landed via !60`) names its primary
 * PRs outright, when `opts.citePrefix` is given and the cited change exists and is not a closed-unmerged or
 * revert one: the status comes from them, and whatever the item's id also matches becomes a follow-up chip.
 * Every item gets an entry (items without a real id never match a PR and keep their
 * declared status). Status comes from the PRs of the best tier present, then from sub-slices, then from
 * what the ledger declares. Closed-unmerged PRs never decide a status, and neither does a loose (tier-3)
 * mention unless the PR's title names the item as its subject; both stay visible as follow-ups.
 */
export function matchPrs(items: LedgerItem[], prs: Pr[], opts: MatchOptions = {}): Map<string, ItemMatch> {
  const byNumber = new Map(prs.map(p => [p.number, p]))
  const real = items.filter(i => i.hasRealId)
  const regexes = real.map(i => ({ item: i, re: mentionOf(i.id) }))
  const itemIdsLower = new Set(real.map(i => i.id.toLowerCase()))
  const sliceParents = real.filter(i => canHaveSlices(i.id))

  const hits = new Map<string, Hit[]>()
  const reverts = new Map<string, Pr[]>()
  const slices = new Map<string, SliceHit[]>()
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k)
    if (list) list.push(v)
    else m.set(k, [v])
  }

  for (const pr of prs) {
    const hay = [pr.title, normaliseBranch(pr.headRefName)]
    const matched = regexes.filter(r => hay.some(h => r.re.test(h))).map(r => r.item.id)
    // Containment: when one matched id appears, as a whole id, inside another matched id, the PR belongs only
    // to the longest (`T1` and `T10` are unrelated; `T04a` sits inside `fix-T04a-backdate-picker`).
    const kept = matched.filter(a => !matched.some(b => b !== a && b.length > a.length && containsId(b, a)))
    const revert = isRevert(pr)
    for (const id of kept) {
      if (revert) push(reverts, id, pr)
      else push(hits, id, { pr, tier: tierOf(id, pr.headRefName) })
    }
    if (revert) continue
    // Sub-slices: `T06a` in a PR where T06 is an item and T06a is not.
    for (const parent of sliceParents) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(parent.id)}([A-Za-z]{1,2})(?![A-Za-z0-9])`, 'ig')
      const seen = new Set<string>()
      for (const h of hay) {
        for (const m of h.matchAll(re)) {
          const suffix = m[2] as string
          if (suffix !== suffix.toLowerCase()) continue
          const sliceId = parent.id + suffix
          if (itemIdsLower.has(sliceId.toLowerCase()) || seen.has(sliceId)) continue
          if (tierOf(sliceId, pr.headRefName) === 3 && !namesAsSubject(pr.title, sliceId)) continue
          seen.add(sliceId)
          push(slices, parent.id, { sliceId, pr })
        }
      }
    }
  }

  const out = new Map<string, ItemMatch>()
  for (const item of items) {
    const all = (hits.get(item.id) ?? []).slice().sort((a, b) => byNumberDesc(a.pr, b.pr))
    // A loose mention (tier 3) decides nothing unless the PR's title names the item as its subject.
    const live = all.filter(h => h.pr.state !== 'CLOSED' && (h.tier < 3 || namesAsSubject(h.pr.title, item.id)))
    const itemSlices = (slices.get(item.id) ?? []).slice().sort((a, b) => byNumberDesc(a.pr, b.pr))
    const itemReverts = (reverts.get(item.id) ?? []).slice().sort(byNumberDesc)
    const best = live.length ? Math.min(...live.map(h => h.tier)) : null
    const cited = opts.citePrefix
      ? item.citations
          .filter(c => c.prefix === opts.citePrefix)
          .map(c => byNumber.get(c.number))
          .filter((p): p is Pr => p !== undefined && p.state !== 'CLOSED' && !isRevert(p))
          .sort(byNumberDesc)
      : []
    const primary = cited.length ? cited : live.filter(h => h.tier === best).map(h => h.pr)
    const followups = all.filter(h => !primary.includes(h.pr)).map(h => h.pr)

    let status: ItemStatus
    let source: ItemMatch['source']
    if (primary.length) {
      const latest = primary[0] as Pr
      source = 'pr'
      if (latest.labels.some(l => l.name === QA_FAILED)) status = 'failed'
      else if (primary.some(p => p.state === 'MERGED')) status = 'done'
      else status = 'open'
    } else {
      const liveSlices = itemSlices.filter(s => s.pr.state !== 'CLOSED')
      if (liveSlices.some(s => s.pr.state === 'MERGED')) {
        status = 'partial'
        source = 'slices'
      } else if (liveSlices.length) {
        status = 'open'
        source = 'slices'
      } else {
        status = declaredStatus(item.declared)
        source = item.declared === null ? 'none' : 'declared'
      }
    }
    out.set(item.id, { status, prs: primary, followups, slices: itemSlices, reverts: itemReverts, source })
  }
  return out
}

/**
 * The naive rule the eval compares against: an id appearing anywhere in a PR title or branch (plain
 * substring: no word boundaries, no tiers, no containment, reverts and closed PRs included) with a merged PR
 * means done, with an open PR open, otherwise the ledger's own word. Used only to show what the real matcher
 * changes.
 */
export function naiveMatch(items: LedgerItem[], prs: Pr[]): Map<string, ItemMatch> {
  const out = new Map<string, ItemMatch>()
  for (const item of items) {
    const found = item.hasRealId ? prs.filter(p => p.title.includes(item.id) || p.headRefName.includes(item.id)) : []
    const merged = found.filter(p => p.state === 'MERGED')
    const open = found.filter(p => p.state === 'OPEN')
    let status: ItemStatus
    let source: ItemMatch['source'] = 'pr'
    if (merged.length) status = 'done'
    else if (open.length) status = 'open'
    else {
      status = declaredStatus(item.declared)
      source = item.declared === null ? 'none' : 'declared'
    }
    out.set(item.id, { status, prs: found, followups: [], slices: [], reverts: [], source })
  }
  return out
}
