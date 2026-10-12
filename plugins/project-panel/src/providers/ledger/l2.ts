import type { ProviderHost } from '../../../types'
import type { AssignmentItem, AssignmentRecord, Complete, PinnedSections, ProposalRecord } from './ai'
import { isSendable } from './discover'
import { showRemote } from './host'
import { assignmentInputs, inputHash } from './hash'
import { escapeRegExp, stripMarkdown } from './text'
import type { LedgerItem } from './types'

// Layer 2 plumbing for the provider: the model ids, the persistent record, and the inputs the models read.
// Everything a model sees comes out of git-tracked, sendable files on the default branch; an untracked
// file, a `.env*` or a `*.local` never gets here because every path passes `isSendable` first.

/** Full model ids, not aliases (an alias resolves to whatever the engine's table says). */
export const SONNET = 'claude-sonnet-5-5'
export const HAIKU = 'claude-haiku-5-5'

const DOC_NAMES = /^(ARCHITECTURE|README|DESIGN)[^/]*\.md$/i
const MAX_DOCS = 6
const MAX_HEADINGS = 60
const CODE_ROOTS = ['apps', 'packages', 'services', 'workers', 'src', 'plugins']
const MAX_CODE_DIRS = 40
const MAX_TOP_DIRS = 40

/** The last failed model call of a kind, for the input it was made on; the provider does not repeat it for a while. */
export type L2Failure = { kind: 'proposal' | 'assignment'; hash: string; at: number }

/** What the provider keeps per repository. */
export type L2Record = {
  proposal?: ProposalRecord
  pinned?: PinnedSections
  assignment?: AssignmentRecord
  failure?: L2Failure
}

/** How long a failed call of one kind is not repeated for the same input. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000

/** True while `failure` says this kind of call, on this input, failed recently enough not to try again. */
export function isBackedOff(failure: L2Failure | undefined, kind: L2Failure['kind'], hash: string, now: number): boolean {
  return failure !== undefined && failure.kind === kind && failure.hash === hash && now - failure.at < RETRY_AFTER_MS
}

/** The pinned sections as one comparable string (ids, titles and hints). */
export function pinKey(sections: { id: string; title: string; hint: string }[]): string {
  return JSON.stringify(sections.map(s => [s.id, s.title, s.hint]))
}

/** The store key: one record per repository. */
export function storeKey(repoUrl: string, root: string): string {
  return `ledger:${repoUrl || root}`
}

/**
 * Reads the record: an empty record when nothing (or something that is not an object) is stored, and null
 * when the store itself failed. A failed read must never lead to a write, which would drop what was kept.
 */
export async function readRecord(host: ProviderHost, key: string): Promise<L2Record | null> {
  try {
    const raw = await host.store.get(key)
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as L2Record) : {}
  } catch {
    return null
  }
}

/** Writes the record; a store that refuses is tolerated (the view just loses its memory). */
export async function writeRecord(host: ProviderHost, key: string, record: L2Record): Promise<void> {
  try {
    await host.store.set(key, record)
  } catch {
    // Nothing to do: the next load asks the model again.
  }
}

/** Adapts the host's completion (`isAnswered`) to the core's `Complete`, mapping the core's `sonnet`/`haiku` to full ids. */
export function completeOf(host: ProviderHost): Complete {
  return async req => {
    try {
      const reply = await host.complete({
        model: req.model === 'sonnet' ? SONNET : HAIKU,
        prompt: req.prompt,
        system: req.system,
        maxTokens: req.maxTokens,
      })
      return reply.isAnswered ? { ok: true, text: reply.text } : { ok: false, reason: 'unanswered' }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }
}

/** Plan documents worth showing the proposal model: ARCHITECTURE*, README*, DESIGN* at the root or under docs/. */
export function docCandidates(tracked: string[], set: Set<string>): string[] {
  const found = tracked.filter(p => {
    const parts = p.split('/')
    const inPlace = parts.length === 1 || (parts.length === 2 && parts[0] === 'docs')
    return inPlace && DOC_NAMES.test(parts[parts.length - 1] as string) && isSendable(p, set)
  })
  return found.slice(0, MAX_DOCS)
}

/** `#`/`##`/`###` headings of the given docs, read from the default branch with `git show`. */
export async function docHeadings(
  host: ProviderHost,
  root: string,
  branch: string,
  paths: string[],
): Promise<{ path: string; headings: string[] }[]> {
  const out: { path: string; headings: string[] }[] = []
  for (const path of paths) {
    const text = await showRemote(host, root, branch, path)
    if (text === null) continue
    const headings: string[] = []
    let fence: string | null = null
    for (const line of text.split(/\r?\n/)) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)
      if (f) {
        const ch = (f[1] as string)[0] as string
        fence = fence === null ? ch : fence === ch ? null : fence
        continue
      }
      if (fence !== null) continue
      const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
      if (h) headings.push(h[1] as string)
      if (headings.length >= MAX_HEADINGS) break
    }
    if (headings.length > 0) out.push({ path, headings })
  }
  return out
}

/** Top-level directories of the tracked set (dot-directories left out as noise), sorted, at most 40. */
export function topDirs(tracked: string[]): string[] {
  const dirs = new Set<string>()
  for (const p of tracked) {
    const cut = p.indexOf('/')
    if (cut > 0 && !p.startsWith('.')) dirs.add(p.slice(0, cut))
  }
  return [...dirs].sort().slice(0, MAX_TOP_DIRS)
}

/** Second-level directories under the usual code roots that exist (`packages/core`, `apps/web`, ...), sorted. */
export function codeDirs(tracked: string[]): string[] {
  const dirs = new Set<string>()
  for (const p of tracked) {
    const parts = p.split('/')
    if (parts.length >= 3 && CODE_ROOTS.includes(parts[0] as string)) dirs.add(`${parts[0]}/${parts[1]}`)
  }
  return [...dirs].sort().slice(0, MAX_CODE_DIRS)
}

/**
 * A line of ledger text as a model should read it: no table pipes, bold, heading hashes or checkbox marks,
 * and the task's own id (already given in the prompt) dropped. Empty cells and dashes are left out.
 */
export function cleanLine(line: string, id: string): string {
  const trimmed = line.trim()
  const parts = trimmed.startsWith('|') ? trimmed.split('|') : [trimmed]
  const idRe = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`, 'g')
  return parts
    .map(part =>
      stripMarkdown(part.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ''))
        .replace(idRe, '$1')
        .replace(/^[\s:—–-]+|[\s:—–-]+$/g, ''),
    )
    .filter(part => part !== '' && !/^[-:—–]+$/.test(part))
    .join('; ')
}

/**
 * A bounded excerpt of the ledger text under each item: its own line (table row or checkbox) and, for an
 * item that also has a heading, the heading's body up to the next heading, cleaned of markup. Only items
 * whose status the model may judge are given one.
 */
export function proseByItem(ledgerText: string, items: LedgerItem[], judgeable: Set<string>): Record<string, string> {
  const lines = ledgerText.split(/\r?\n/)
  const out: Record<string, string> = {}
  for (const item of items) {
    if (!judgeable.has(item.id)) continue
    const own = item.line - 1
    const parts: string[] = [lines[own] ?? '']
    if (item.hasRealId) {
      const heading = new RegExp(`^#{3,6}\\s+${escapeRegExp(item.id)}(?![A-Za-z0-9])`)
      const at = lines.findIndex(l => heading.test(l))
      if (at >= 0) {
        // The heading's body, up to the next heading of any level.
        for (let i = at === own ? at + 1 : at; i < lines.length; i++) {
          if (i > at && /^#{1,6}\s/.test(lines[i] as string)) break
          parts.push(lines[i] as string)
        }
      }
    }
    out[item.id] = parts
      .map(l => cleanLine(l, item.id))
      .filter(l => l !== '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600)
  }
  return out
}

/** Everything `runL2` reads, plus the cache key; the pinned sections (ids, titles, hints) fold re-pinning into the hash. */
export async function buildInputs(args: {
  ledgerTitle: string
  ledgerText: string
  items: AssignmentItem[]
  lines: LedgerItem[]
  mergedPrNumbers: number[]
  tracked: string[]
  headings: { path: string; headings: string[] }[]
  pinned: { id: string; title: string; hint: string }[]
}) {
  const tops = topDirs(args.tracked)
  const judgeable = new Set(args.items.filter(i => i.source === 'none' || i.source === 'declared').map(i => i.id))
  return {
    ledgerTitle: args.ledgerTitle,
    items: args.items,
    docHeadings: args.headings,
    topDirs: tops,
    codeDirs: codeDirs(args.tracked),
    proseByItem: proseByItem(args.ledgerText, args.lines, judgeable),
    hash: await inputHash(assignmentInputs(
        args.ledgerText,
        args.mergedPrNumbers,
        tops,
        args.pinned.map(s => `${s.id}\u0001${s.title}\u0001${s.hint}`),
      )),
  }
}
