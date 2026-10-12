import { parseLedger } from './parse'

// Finds the ledger of a repository and decides what may be read. The safety rule lives here: only paths
// git tracks are ever read or sent to a model, and secrets-by-convention (`.env*`, `*.local`) never are,
// even when somebody committed them.

const DELIVERY_PATH = 'docs/DELIVERY.md'
const LEDGER_NAMES = ['workplan.md', 'roadmap.md', 'plan.md', 'todo.md']

/**
 * Reads the `key: value` lines between leading `---` fences. Quotes around values are dropped; anything
 * that is not a flat `key: value` line (lists, nesting, comments) is ignored.
 */
export function readDeliveryFrontMatter(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const out: Record<string, string> = {}
  let i = 0
  while (i < lines.length && (lines[i] as string).trim() === '') i++
  if ((lines[i] as string | undefined)?.trim() !== '---') return out
  for (i += 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '---') return out
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    out[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, '$2')
  }
  return {}
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Candidate ledger paths from `git ls-files` output, best first: root WORKPLAN, ROADMAP, PLAN, TODO
 * (case-insensitive), then the same names under `docs/`, then any `docs/**` file named `plan*.md`.
 */
export function ledgerCandidates(tracked: string[]): string[] {
  const out: string[] = []
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p)
  }
  for (const name of LEDGER_NAMES) {
    for (const p of tracked) if (!p.includes('/') && baseName(p).toLowerCase() === name) add(p)
  }
  for (const name of LEDGER_NAMES) {
    for (const p of tracked) {
      if (p.startsWith('docs/') && !p.slice(5).includes('/') && baseName(p).toLowerCase() === name) add(p)
    }
  }
  for (const p of tracked) {
    if (p.startsWith('docs/') && /^plan.*\.md$/i.test(baseName(p))) add(p)
  }
  return out
}

/**
 * True only for tracked paths that may be read and sent. Case-insensitive, on every path segment: no `.git`,
 * nothing that ends in `.local` or contains `.local.`, nothing that starts or ends with `.env`, no `..`, no
 * absolute path. (Symlinks and submodules are kept out one step earlier, when the tracked list is read.)
 */
export function isSendable(path: string, tracked: Set<string>): boolean {
  if (!tracked.has(path)) return false
  if (path.startsWith('/')) return false
  return !path.split('/').some(segment => {
    const s = segment.toLowerCase()
    return s === '..' || s === '.git' || s.endsWith('.local') || s.includes('.local.') || s.startsWith('.env') || s.endsWith('.env')
  })
}

/**
 * Chooses the ledger: the `task-ledger:` path named by `docs/DELIVERY.md` when it is tracked, otherwise the
 * first candidate that parses as a ledger (at least 3 items with real ids, or at least 5 checkboxes).
 * Untracked and unsendable paths are never read.
 */
export async function pickLedger(
  tracked: string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ path: string; via: 'delivery' | 'discovered' } | null> {
  const set = new Set(tracked)
  if (isSendable(DELIVERY_PATH, set)) {
    const text = await read(DELIVERY_PATH)
    const declared = text === null ? undefined : readDeliveryFrontMatter(text)['task-ledger']
    const path = declared?.trim().replace(/^\.\//, '')
    if (path && isSendable(path, set)) return { path, via: 'delivery' }
  }
  for (const path of ledgerCandidates(tracked)) {
    if (!isSendable(path, set)) continue
    const text = await read(path)
    if (text === null) continue
    const parsed = parseLedger(text)
    if (parsed.items.filter(i => i.hasRealId).length >= 3 || parsed.checkboxCount >= 5) {
      return { path, via: 'discovered' }
    }
  }
  return null
}
