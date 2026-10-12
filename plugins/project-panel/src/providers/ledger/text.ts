// Small text helpers shared by the ledger modules. Pure string work; nothing here is user-facing copy.
import type { Citation } from './types'

/**
 * Ids written by a human as a short code: uppercase letters, digits and internal hyphens, ending in digits
 * plus an optional lowercase suffix (`T01a`, `T-HF02`, `OPS-2`, `API-3`). Deliberately strict so prose
 * headings ("Why", "Phase") and ranges ("T11–T13") never become items. (The lookahead does the "must end in
 * a digit" work; folding it into the lazy hyphen group, as one might, rejects `OPS-2` and `API-3`.)
 */
export const CODE_ID = /^(?=.*\d[a-z]{0,2}$)[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*[a-z]{0,2}$/

/** Slug-style ids that only table rows may use (`chore-finish-the-rename`, `fix-T04a-backdate-picker`). */
export const SLUG_ID = /^[a-z][a-z0-9]*(?:-[A-Za-z0-9]+)+$/

/**
 * Word-style ids: at least one hyphen and nothing but upper-case segments (`FEAT-BCP47-LANGUAGES`,
 * `FIX-MODAL-SAFE-AREA`, `CHORE-STORE-BUILD-7`, `D15-TYPE-SCALE`). A bare word (`FIX`, `API`) is never an id,
 * which is what keeps a first cell such as `FIX · Some defect` from becoming an item.
 */
export const WORD_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/

/** True for an id a table row may carry. */
export function isTableId(s: string): boolean {
  return CODE_ID.test(s) || SLUG_ID.test(s) || WORD_ID.test(s)
}

/**
 * Citations in one table row: `landed via !60`, `merged via #12`, `landed in !7`, `merged in !7`, and
 * ``merged `498f165` (!32)``. Code spans are ignored (a `!60` in backticks is a command or a name, not a
 * citation), except for the sha in the last form. Duplicates are dropped; order of appearance is kept.
 */
export function citationsOf(row: string): Citation[] {
  const found: { index: number; cite: Citation }[] = []
  const take = (m: RegExpMatchArray) =>
    found.push({ index: m.index ?? 0, cite: { prefix: m[1] as '!' | '#', number: Number(m[2]) } })
  for (const m of row.matchAll(/\bmerged\s+`[0-9a-f]{6,40}`\s*\(\s*([!#])(\d+)\s*\)/gi)) take(m)
  const plain = row.replace(/`[^`]*`/g, m => ' '.repeat(m.length))
  for (const m of plain.matchAll(/\b(?:landed|merged)\s+(?:via|in)\s+(?:MR\s+|PR\s+)?\**([!#])(\d+)\b/gi)) take(m)
  const out: Citation[] = []
  for (const { cite } of found.sort((a, b) => a.index - b.index)) {
    if (!out.some(c => c.prefix === cite.prefix && c.number === cite.number)) out.push(cite)
  }
  return out
}

/** Lowercase, alphanumeric-only, hyphen-joined; used for section ids and synthetic item ids. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Escapes a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strips markdown down to plain text: links keep their text, code spans and emphasis lose their markers,
 * HTML tags and bare autolinks disappear. Why: titles come out of prose cells and must read as one line.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<https?:[^>]*>/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/\\([|*_`[\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first clause of a prose cell: markdown stripped, cut at the first ` — `, ` – `, `. ` or `(`, then
 * capped at `max` characters on a word boundary. Falls back to the whole stripped text when the cut
 * would leave nothing.
 */
export function firstClause(raw: string, max = 100): string {
  const plain = stripMarkdown(raw)
  const cut = plain.search(/ [—–] |\. |\(/)
  let out = (cut > 0 ? plain.slice(0, cut) : plain).trim()
  out = out.replace(/[\s:;,.]+$/, '')
  if (out.length > max) {
    const slice = out.slice(0, max)
    const sp = slice.lastIndexOf(' ')
    out = (sp > max / 2 ? slice.slice(0, sp) : slice).replace(/[\s:;,.]+$/, '')
  }
  return out
}

/** Keeps the first `n` whitespace-separated words. */
export function firstWords(s: string, n: number): string {
  return s.trim().split(/\s+/).filter(Boolean).slice(0, n).join(' ')
}

/**
 * The citation that OPENS a table cell, if any: after leading glyphs, `**`, spaces and dash or colon
 * punctuation the cell begins `landed via !N` (also `landed in`, `merged via/in`, ``merged `sha` (!N)``).
 * Only a row's lead citation says how that unit landed; later ones (`the theme that landed in !52`) point at
 * other units' merge requests.
 */
export function leadCitationsOf(cell: string): Citation[] {
  const head = cell.replace(/^[^\p{L}\p{N}`]*/u, '')
  const m =
    /^(?:landed|merged)\s+(?:via|in)\s+(?:MR\s+|PR\s+)?\**([!#])(\d+)\b/i.exec(head) ??
    /^merged\s+`[0-9a-f]{6,40}`\s*\(\s*([!#])(\d+)\s*\)/i.exec(head)
  return m ? [{ prefix: m[1] as '!' | '#', number: Number(m[2]) }] : []
}
