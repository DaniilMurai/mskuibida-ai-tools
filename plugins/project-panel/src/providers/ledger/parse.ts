import { CODE_ID, WORD_ID, firstClause, isTableId, leadCitationsOf, slug, stripMarkdown } from './text'
import type { Citation, DeclaredStatus, LedgerItem, ParsedLedger, Size } from './types'

// Parses a WORKPLAN-style task ledger into items. Pure: text in, data out. Three shapes are understood
// (table rows whose first cell starts with a bold id, `#### ID — title` headings, and `- [x]` checkboxes)
// plus the ledger's own "order of play" status lines inside fenced blocks. Nothing is specific to any
// one repository: the id grammar is structural, not a list of prefixes or section names.
//
// Table rows come in two spellings: a bold id in the first cell (`**T01** …`) or a plain `ID · title` first
// cell with the status in its own column and the landing MR cited in the notes (`landed via !60`).

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/
const STATUS_LINE = /^\s*(done|open|wip|then|next|last|todo|blocked)\s+(\S+)/
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const SEPARATOR_CELL = /^:?-+:?$/

type Draft = {
  id: string
  hasRealId: boolean
  title: string
  deps: string[]
  size: Size | null
  phase: string
  line: number
  declared: DeclaredStatus
  citations: Citation[]
  kind: 'table' | 'heading' | 'checkbox'
}

type Row = { cells: string[]; line: number }

/** `task` is absent when the title lives in the id cell (`ID · title`); `status` when there is no Status column. */
type Columns = { id: number; task?: number; deps?: number; size?: number; status?: number }

// ---- Status vocabulary -------------------------------------------------------------------------------
// A Status column holds a glyph, words, or both (`✅`, `🔨 **in flight** — MR open`, `done`). What each glyph
// means is the ledger's own business, so the file's legend line comes first; built-in glyph and word lists
// only fill the gaps. Nothing here names a repository.

const ID_HEADER = /^(id|unit|task|ticket|key|item)$/
const LEGEND_LINE = /^\s*(?:>\s*)*(?:\*\*|__)?(?:Status|Legend)(?:\*\*|__)?\s*:/i
const GLYPH_RUN = /((?:\p{Extended_Pictographic}\uFE0F?)+)\s*(\p{L}(?:[\p{L} ]*\p{L})?)/gu

/** Glyphs used without being named by the legend. */
const DEFAULT_GLYPHS: [string, DeclaredStatus][] = [
  ...(['✅', '✔', '☑', '🟢'].map(g => [g, 'done']) as [string, DeclaredStatus][]),
  ...(['🔨', '🚧', '⏳', '🔄', '🟡', '🏗'].map(g => [g, 'open']) as [string, DeclaredStatus][]),
  ...(['⬜', '⬛'].map(g => [g, 'planned']) as [string, DeclaredStatus][]),
  ...(['❌', '⛔', '🔒', '🔴', '⏸'].map(g => [g, 'held']) as [string, DeclaredStatus][]),
]

/** Phrases at the start of a status text; the not-done ones are tried first so `not built` never reads as `built`. */
const WORD_STATUS: [RegExp, DeclaredStatus][] = [
  [/^(not built|blocked|on hold|parked|out of scope|won'?t do|dropped|cancel+ed)\b/, 'held'],
  [/^(in flight|in progress|in review|pending review|wip|started|ongoing|doing|partial)\b/, 'open'],
  [/^(not started|planned|todo|to do|pending|backlog)\b/, 'planned'],
  [/^(done|merged|landed|shipped|completed?|built)\b/, 'done'],
]

/** Status of a run of words (`in flight`, `Done`), null when it is not one of the known phrases. */
function statusOfWords(words: string): DeclaredStatus {
  const w = words.trim().toLowerCase()
  for (const [re, status] of WORD_STATUS) if (re.test(w)) return status
  return null
}

const glyphKey = (g: string): string => g.replace(/\uFE0F/g, '')

/**
 * The glyphs the file's own legend line gives a meaning to: the line starting `Status:` or `Legend:` (bold
 * or quoted is fine; it may wrap onto following lines), read as `<glyph> <words>` pairs, each pair's words
 * classified by the built-in vocabulary. Words that are not a known phrase leave their glyph unmapped.
 */
export function legendOf(text: string): Map<string, DeclaredStatus> {
  const out = new Map<string, DeclaredStatus>()
  const lines = text.split(/\r?\n/)
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (FENCE_OPEN.test(line)) fence = !fence
    if (fence || !LEGEND_LINE.test(line)) continue
    let body = line
    for (let j = i + 1; j < lines.length; j++) {
      const next = (lines[j] as string).replace(/^\s*(?:>\s*)*/, '')
      if (next.trim() === '' || /^[#|`~]/.test(next.trim())) break
      body += ` ${next}`
    }
    body = body
      .replace(LEGEND_LINE, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\([^()]*\)/g, ' ')
    for (const m of body.matchAll(GLYPH_RUN)) {
      const status = statusOfWords(m[2] as string)
      if (status === null) continue
      for (const g of Array.from(glyphKey(m[1] as string))) if (!out.has(g)) out.set(g, status)
    }
    // A `Status: draft` line before the real legend gives no pairs: keep looking.
    if (out.size > 0) break
  }
  return out
}

/**
 * Declared status from a Status cell: its first recognised glyph (the legend's meaning wins over the
 * built-in one), else its first words. Null when nothing in it is recognised.
 */
export function statusOf(cell: string, legend: Map<string, DeclaredStatus>): DeclaredStatus {
  const defaults = new Map(DEFAULT_GLYPHS)
  for (const g of Array.from(glyphKey(cell))) {
    const status = legend.get(g) ?? defaults.get(g) ?? null
    if (status !== null) return status
  }
  return statusOfWords(stripMarkdown(cell).replace(/^[^\p{L}\p{N}]+/u, ''))
}

/** Lead citations (`landed via !N` opening a cell) of every cell but the id cell, without duplicates. */
function leadCitations(cells: string[], idCol: number): Citation[] {
  const out: Citation[] = []
  cells.forEach((cell, i) => {
    if (i === idCol) return
    for (const c of leadCitationsOf(cell)) {
      if (!out.some(x => x.prefix === c.prefix && x.number === c.number)) out.push(c)
    }
  })
  return out
}

/** Splits a markdown table row on unescaped pipes outside code spans. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  const cells: string[] = []
  let cur = ''
  let tick = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '`') {
      tick = !tick
      cur += c
    } else if (c === '|' && !tick) {
      cells.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '') cells.push(cur)
  return cells.map(c => c.trim())
}

/** Column positions from a header row; positional defaults when there is no (recognisable) header. */
function columnsFrom(header: string[] | null): Columns {
  const fallback: Columns = { id: 0, task: 1, deps: 2, size: 3 }
  if (!header) return fallback
  const names = header.map(h => stripMarkdown(h).toLowerCase())
  const find = (pred: (n: string) => boolean): number | undefined => {
    const i = names.findIndex(pred)
    return i >= 0 ? i : undefined
  }
  const id = find(n => n === 'id')
  const task = find(n => n === 'task' || n === 'title' || n === 'name' || n === 'description')
  const deps = find(n => /^(depends( on)?|dependencies|deps|needs)$/.test(n))
  const size = find(n => n === 'size' || n === 'estimate')
  const status = find(n => n === 'status')
  if (id === undefined && task === undefined && deps === undefined && size === undefined) {
    // A `| Unit | Status | Notes |` header names no task column: the id cell carries the title, and the
    // positional dependency and size guesses must not read the notes.
    return status === undefined ? fallback : { id: 0, status }
  }
  const idCol = id ?? 0
  const guess = idCol === 1 ? 2 : 1
  return { id: idCol, task: task ?? (guess === status ? undefined : guess), deps, size, status }
}

/**
 * Keeps only id-shaped tokens of a dependency cell; prose, dashes and ranges drop out. A slug token (which
 * prose can mimic, as in "pre-prod") counts only in backticks or when the whole cell is nothing but ids.
 */
function parseDeps(cell: string | undefined): string[] {
  if (!cell) return []
  const text = cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  const toks = text
    .split(/[\s,;+/&]+/)
    .map(raw => ({ raw, tok: raw.replace(/`/g, '').replace(/^[([]+|[)\].]+$/g, '') }))
    .filter(t => t.tok !== '')
  const clean = toks.every(t => isTableId(t.tok))
  const out: string[] = []
  for (const { raw, tok } of toks) {
    if (!isTableId(tok) || out.includes(tok)) continue
    if (!CODE_ID.test(tok) && !clean && !raw.includes('`')) continue
    out.push(tok)
  }
  return out
}

function parseSize(cell: string | undefined): Size | null {
  if (!cell) return null
  const v = stripMarkdown(cell).toUpperCase()
  return v === 'XS' || v === 'S' || v === 'M' || v === 'L' || v === 'XL' ? v : null
}

/** Separators between an id and its title in a table cell or heading (and `: `, unless told not); the earliest wins. */
function splitAtSeparator(text: string, seps: string[], isColonSeparator = true): { head: string; rest: string } {
  let best: { idx: number; len: number } | null = null
  for (const sep of seps) {
    const idx = text.indexOf(sep)
    if (idx > 0 && (!best || idx < best.idx)) best = { idx, len: sep.length }
  }
  const colon = isColonSeparator ? text.search(/:(\s|$)/) : -1
  if (colon > 0 && (!best || colon < best.idx)) best = { idx: colon, len: 1 }
  return best ? { head: text.slice(0, best.idx), rest: text.slice(best.idx + best.len) } : { head: text, rest: '' }
}

type IdCell = { id: string; declared: DeclaredStatus; title: string | null; titleFirst: boolean }

/**
 * Reads the id of a table row's first cell plus its trailing annotations. A bold id (`**T01** (done)`) is
 * the classic shape; a plain `ID · title` cell (also `—`, `–`, `-`, `:`) is the other, and then the left part
 * must be a code or word id, so `Issue customer · Wallet pass` and a bare `FIX · …` are not items.
 * `title` is the text after the id when the cell carries one; a bold id's title yields to a task column
 * (`titleFirst` false), a plain `ID · title` cell's does not.
 */
function parseIdCell(cell: string, isIdColumn: boolean): IdCell | null {
  const m = /\*\*([^*]+)\*\*/.exec(cell)
  const boldId = m ? (m[1] as string).replace(/`/g, '').trim() : ''
  // A bold span that is not an id (`T6 · Top-up — the **own accounts**`) says nothing: read the plain shape.
  if (m && isTableId(boldId)) {
    const id = boldId
    const rest = cell.slice((m.index ?? 0) + m[0].length)
    let declared: DeclaredStatus = null
    for (const g of rest.matchAll(/\(([^)]*)\)/g)) {
      if (/\b(implemented|merged|done)\b/i.test(g[1] as string)) declared = 'done'
    }
    const inline = /^\s*[·—–:-]\s*(.+)$/.exec(rest)
    return { id, declared, title: inline ? (inline[1] as string) : null, titleFirst: false }
  }
  // Prose cells (`PRE-PROD - staging`, `Q3 - launch`) are not items: a plain id needs the ` · ` of a ledger
  // row, or a first column headed as one (`ID`, `Unit`, `Task`, ...).
  const { head, rest } = splitAtSeparator(cell, isIdColumn ? [' · ', ' — ', ' – ', ' - '] : [' · '], isIdColumn)
  const id = head.replace(/`/g, '').trim()
  if (rest === '' || !(CODE_ID.test(id) || WORD_ID.test(id))) return null
  return { id, declared: null, title: rest, titleFirst: true }
}

/** `ID — title`, `ID - title`, `ID – title` or `ID: title`; the earliest separator wins. */
function splitHeading(text: string): { id: string; title: string } | null {
  const { head, rest } = splitAtSeparator(text, [' — ', ' – ', ' - '])
  const idPart = head.replace(/`/g, '').trim()
  // Word ids (`FEAT-X`) are read from table rows only: `### PRE-PROD: notes` is prose, not a task.
  if (!CODE_ID.test(idPart)) return null
  return { id: idPart, title: rest }
}

/** Optional leading id of a checkbox text: `**ID**`, `ID:`, `ID —`. */
function splitCheckbox(text: string): { id: string | null; title: string } {
  const bold = /^\*\*([^*]+?):?\*\*\s*[:—–-]?\s*(.*)$/.exec(text)
  if (bold && CODE_ID.test((bold[1] as string).replace(/`/g, '').trim())) {
    return { id: (bold[1] as string).replace(/`/g, '').trim(), title: bold[2] as string }
  }
  const plain = /^`?([A-Z][A-Za-z0-9-]*?)`?(?::|\s[—–-])\s*(.*)$/.exec(text)
  if (plain && CODE_ID.test(plain[1] as string)) return { id: plain[1] as string, title: plain[2] as string }
  return { id: null, title: text }
}

/** Folds a later occurrence of an id into the first: the first keeps `line` and `phase`, gaps get filled. */
function mergeInto(into: Draft, from: Draft): void {
  if (!into.title) into.title = from.title
  if (into.deps.length === 0) into.deps = from.deps
  if (into.size === null) into.size = from.size
  if (into.declared === null) into.declared = from.declared
  for (const c of from.citations) {
    if (!into.citations.some(x => x.prefix === c.prefix && x.number === c.number)) into.citations.push(c)
  }
  if (from.hasRealId) into.hasRealId = true
}

/**
 * Parses ledger text into items and phases. Fenced code blocks are skipped for items and phases, but
 * their `done T02 ...` order-of-play lines still set the declared status of items that have none.
 */
export function parseLedger(text: string): ParsedLedger {
  const lines = text.split(/\r?\n/)
  const drafts: Draft[] = []
  const byId = new Map<string, Draft>()
  const statusLines: { word: string; id: string }[] = []
  const syntheticPerPhase = new Map<string, number>()
  const legend = legendOf(text)
  let title = ''
  let phase = ''
  let fence: { ch: string; len: number } | null = null
  let block: Row[] = []

  const add = (d: Draft) => {
    const prev = byId.get(d.id)
    if (prev) mergeInto(prev, d)
    else {
      drafts.push(d)
      byId.set(d.id, d)
    }
  }

  const flushTable = () => {
    if (block.length === 0) return
    const sepIdx = block.findIndex((r, i) => i > 0 && r.cells.length > 0 && r.cells.every(c => SEPARATOR_CELL.test(c)))
    const header = sepIdx > 0 ? (block[sepIdx - 1] as Row) : null
    const cols = columnsFrom(header ? header.cells : null)
    const isIdColumn = header !== null && ID_HEADER.test(stripMarkdown(header.cells[cols.id] ?? '').toLowerCase())
    block.forEach((row, i) => {
      if (header && (i === sepIdx - 1 || i === sepIdx)) return
      if (row.cells.every(c => SEPARATOR_CELL.test(c))) return
      const idCell = parseIdCell(row.cells[cols.id] ?? '', isIdColumn)
      if (!idCell) return
      const taskCell = cols.task === undefined ? undefined : row.cells[cols.task]
      const statusCell = cols.status === undefined ? undefined : row.cells[cols.status]
      add({
        id: idCell.id,
        hasRealId: true,
        title: firstClause((idCell.titleFirst ? idCell.title || taskCell : taskCell || idCell.title) || ''),
        deps: parseDeps(cols.deps === undefined ? undefined : row.cells[cols.deps]),
        size: parseSize(cols.size === undefined ? undefined : row.cells[cols.size]),
        phase,
        line: row.line,
        declared: (statusCell === undefined ? null : statusOf(statusCell, legend)) ?? idCell.declared,
        citations: leadCitations(row.cells, cols.id),
        kind: 'table',
      })
    })
    block = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const lineNo = i + 1

    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (close && (close[1] as string)[0] === fence.ch && (close[1] as string).length >= fence.len) fence = null
      else {
        const st = STATUS_LINE.exec(line)
        if (st) statusLines.push({ word: st[1] as string, id: (st[2] as string).replace(/[.,;:)]+$/, '') })
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      flushTable()
      fence = { ch: (open[1] as string)[0] as string, len: (open[1] as string).length }
      continue
    }

    if (line.trimStart().startsWith('|')) {
      block.push({ cells: splitRow(line), line: lineNo })
      continue
    }
    flushTable()

    const h1 = /^#(?!#)\s+(.+?)\s*$/.exec(line)
    if (h1) {
      if (!title) title = stripMarkdown(h1[1] as string)
      continue
    }
    const h2 = /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line)
    if (h2) {
      phase = stripMarkdown(h2[1] as string)
      continue
    }
    const hn = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (hn) {
      const parts = splitHeading(hn[1] as string)
      if (parts) {
        let declared: DeclaredStatus = null
        for (let j = i + 1; j < lines.length; j++) {
          const next = (lines[j] as string).trim()
          if (next === '') continue
          if (next.startsWith('**Done**')) declared = 'done'
          break
        }
        add({
          id: parts.id,
          hasRealId: true,
          title: firstClause(parts.title),
          deps: [],
          size: null,
          phase,
          line: lineNo,
          declared,
          citations: [],
          kind: 'heading',
        })
      }
      continue
    }
    const cb = CHECKBOX.exec(line)
    if (cb) {
      const done = (cb[1] as string).toLowerCase() === 'x'
      const { id, title: t } = splitCheckbox((cb[2] as string).trim())
      let realId = id
      if (!realId) {
        const n = (syntheticPerPhase.get(phase) ?? 0) + 1
        syntheticPerPhase.set(phase, n)
        realId = `${slug(phase)}#${n}`
      }
      add({
        id: realId,
        hasRealId: id !== null,
        title: firstClause(t),
        deps: [],
        size: null,
        phase,
        line: lineNo,
        declared: done ? 'done' : 'planned',
        citations: [],
        kind: 'checkbox',
      })
    }
  }
  flushTable()

  for (const s of statusLines) {
    const d = byId.get(s.id)
    if (!d || d.declared !== null) continue
    d.declared = s.word === 'done' ? 'done' : s.word === 'open' || s.word === 'wip' ? 'open' : 'planned'
  }

  const items: LedgerItem[] = drafts.map(d => ({
    id: d.id,
    hasRealId: d.hasRealId,
    title: d.title,
    deps: d.deps,
    size: d.size,
    phase: d.phase,
    line: d.line,
    declared: d.declared,
    citations: d.citations,
  }))
  const phases: string[] = []
  for (const it of items) if (it.phase && !phases.includes(it.phase)) phases.push(it.phase)
  return { title, items, phases, checkboxCount: drafts.filter(d => d.kind === 'checkbox').length }
}
