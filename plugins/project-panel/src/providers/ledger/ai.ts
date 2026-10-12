import { countsOf, entryOf, percentOf, statusOf } from './progress'
import { firstWords } from './text'
import type { ItemMatch, ItemStatus, LedgerItem, MatchSource, SectionEntry, SectionStatus } from './types'

// "AI proposes, you pin." Layer 2 of the ledger provider: a model groups ledger items into product sections
// (Sonnet proposes once, the user pins) and later assigns items and fills gaps (Haiku, only when the inputs
// changed). Every model call is injected, every reply is validated, and deterministic PR evidence always
// wins over what a model says. The prompt text below is model-facing, not user-facing copy.

/** Injected model call; the adapter wires it to whatever completion path the mod has. */
export type Complete = (req: {
  model: 'sonnet' | 'haiku'
  system: string
  prompt: string
  maxTokens: number
}) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>

/** Section id for items no pinned section took; its title is resolved by the adapter. */
export const UNASSIGNED = 'unassigned'

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_PROSE = 600
/** One Haiku call files at most this many tasks, and judges at most `MAX_JUDGE_PER_CALL` of them. */
export const CHUNK_ITEMS = 120
export const MAX_JUDGE_PER_CALL = 40
const MAX_PROPOSAL_ITEMS = 500
const MAX_DOCS = 12
const MAX_HEADINGS_PER_DOC = 40

/** A product section as proposed and pinned. */
export type PinnedSection = { id: string; title: string; hint: string }

/** Store records, keyed by repository by the adapter. */
export type PinnedSections = { sections: PinnedSection[]; pinnedAt: number; ledgerPath: string }
/** The stored Sonnet proposal, kept until the user pins it or asks for another. */
export type ProposalRecord = { sections: PinnedSection[]; proposedAt: number }

/** What a model may judge for an item with no PR evidence. */
export type JudgedStatus = 'done' | 'partial' | 'planned'

/** Where the model filed one item, with its short title and, for evidence-free items only, a judged status. */
export type AssignedItem = { id: string; section: string; title: string | null; status: JudgedStatus | null }
/** A caption for a pinned section, or a new planned section (`planned: true`, with a title). */
export type SectionNote = { id: string; caption: string; title: string | null; planned: boolean }
/** A model-noted disagreement between an item's prose and its status; the note is model text, capped at 140 characters. */
export type AiDrift = { itemId: string; note: string }
/** A validated assignment reply: items filed, section captions and new planned sections, drift notes. */
export type AssignmentResult = { items: AssignedItem[]; sections: SectionNote[]; drift: AiDrift[] }
/** The stored assignment and the input hash it was computed for; a different hash means recompute. */
export type AssignmentRecord = {
  hash: string
  result: AssignmentResult
  at: number
  /** Which pinned sections (ids, titles, hints) the result was filed under; set by the provider. */
  pinKey?: string
}

/** The request shape `Complete` takes. */
export type ModelRequest = Parameters<Complete>[0]

type ItemRef = Pick<LedgerItem, 'id' | 'title' | 'phase'>

const PROPOSAL_SYSTEM =
  'You group the tasks of a software project ledger into the PRODUCT sections a user would recognise ' +
  '(the parts of the product, for example "Claude plugin", "MCP connector", "API", "Telegram bot", ' +
  '"Mobile apps"), never into delivery phases, milestones or process stages. ' +
  'Reply with strict JSON only: no prose, no markdown, no code fence.'

const ASSIGNMENT_SYSTEM =
  'You file ledger tasks under fixed product sections, judge tasks that have no pull-request evidence, and ' +
  'flag disagreements between prose and status. Use only the section ids you are given, except for planned ' +
  'areas that have no tasks yet. Reply with strict JSON only: no prose, no markdown, no code fence.'

// ---------------------------------------------------------------------------------------------------------
// JSON plumbing

/** Parses a model reply as JSON, tolerating surrounding whitespace and one ```json fence; nothing else. */
function parseJsonReply(text: string): { ok: true; value: unknown } | { ok: false } {
  let body = text.trim()
  const fenced = /^```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body)
  if (fenced) body = (fenced[1] as string).trim()
  try {
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch {
    return { ok: false }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A prompt row: the non-empty fields, ` | ` apart. Empty fields are left out, never printed as blanks. */
function fields(parts: string[]): string {
  return parts.map(p => p.trim()).filter(p => p !== '').join(' | ')
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).trimEnd() : s
}

/** Keeps the first sentence of a caption, capped in length. */
function oneSentence(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim()
  const m = /^.*?[.!?](?=\s|$)/.exec(t)
  return cut(m ? m[0] : t, max)
}

// ---------------------------------------------------------------------------------------------------------
// Sonnet: propose product sections

/** Builds the one-off Sonnet request that proposes 3-8 product sections. Items go in as id, title, phase only. */
export function buildProposalRequest(input: {
  ledgerTitle: string
  items: ItemRef[]
  docHeadings: { path: string; headings: string[] }[]
  topDirs: string[]
}): ModelRequest {
  const items = input.items
    .slice(0, MAX_PROPOSAL_ITEMS)
    .map(i => fields([i.id, cut(i.title, 80), cut(i.phase, 60)]))
  const docs = input.docHeadings
    .filter(d => d.headings.length > 0)
    .slice(0, MAX_DOCS)
    .map(d => `${d.path}: ${d.headings.slice(0, MAX_HEADINGS_PER_DOC).map(h => cut(h, 60)).join(' / ')}`)
  const prompt = [
    ...(input.ledgerTitle.trim() === '' ? [] : [`Ledger: ${cut(input.ledgerTitle, 120)}`, '']),
    'Tasks (id | title | delivery phase; empty fields are left out):',
    ...items,
    '',
    'Document headings (path: headings):',
    ...(docs.length ? docs : ['(none)']),
    '',
    `Top-level directories: ${input.topDirs.length ? input.topDirs.join(', ') : '(none)'}`,
    '',
    'Propose between 3 and 8 PRODUCT sections that together cover the product, named the way a user would name',
    'its parts. Do not use delivery phases as sections.',
    'Reply with exactly this JSON and nothing else:',
    '{"sections":[{"id":"kebab-case-id","title":"at most 4 words","hint":"one line: what belongs here"}]}',
  ].join('\n')
  return { model: 'sonnet', system: PROPOSAL_SYSTEM, prompt, maxTokens: 1500 }
}

/** Why a proposal reply was rejected; structured so the adapter picks the words. */
export type ProposalError =
  | 'invalid-json'
  | 'bad-shape'
  | 'section-count'
  | 'bad-id'
  | 'duplicate-id'
  | 'empty-title'
  | 'hint-too-long'

/**
 * Validates a proposal reply: strict JSON (a ```json fence is tolerated), 2-10 sections, unique kebab ids,
 * non-empty titles (cut to 4 words), hints of at most 160 characters. No free-text salvage.
 */
export function parseProposal(
  text: string,
): { ok: true; sections: PinnedSection[] } | { ok: false; error: ProposalError } {
  const json = parseJsonReply(text)
  if (!json.ok) return { ok: false, error: 'invalid-json' }
  if (!isRecord(json.value) || !Array.isArray(json.value.sections)) return { ok: false, error: 'bad-shape' }
  const raw = json.value.sections as unknown[]
  if (raw.length < 2 || raw.length > 10) return { ok: false, error: 'section-count' }
  const sections: PinnedSection[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!isRecord(r)) return { ok: false, error: 'bad-shape' }
    if (typeof r.id !== 'string' || !KEBAB.test(r.id) || r.id === UNASSIGNED) return { ok: false, error: 'bad-id' }
    if (seen.has(r.id)) return { ok: false, error: 'duplicate-id' }
    seen.add(r.id)
    if (typeof r.title !== 'string') return { ok: false, error: 'bad-shape' }
    const title = firstWords(r.title, 4)
    if (!title) return { ok: false, error: 'empty-title' }
    if (r.hint !== undefined && typeof r.hint !== 'string') return { ok: false, error: 'bad-shape' }
    const hint = (r.hint ?? '').trim()
    if (hint.length > 160) return { ok: false, error: 'hint-too-long' }
    sections.push({ id: r.id, title, hint })
  }
  return { ok: true, sections }
}

// ---------------------------------------------------------------------------------------------------------
// Haiku: assign items, judge the evidence-free ones, caption sections

/** An item as the assignment sees it: deterministic status and where it came from. */
export type AssignmentItem = ItemRef & { status: ItemStatus; source: MatchSource }

/** True for items a model may judge: the ledger declared something, or nothing at all, but no PR spoke. */
export function isJudgeable(source: MatchSource): boolean {
  return source === 'none' || source === 'declared'
}

/**
 * Builds the Haiku request. Haiku files every item under one pinned section, judges done/partial/planned only
 * for items whose deterministic source is 'none' or 'declared' (prose excerpts of at most 600 characters are
 * attached for those alone), may add planned sections for areas with no tasks, writes short titles and
 * captions, and notes drift between prose and status.
 */
export function buildAssignmentRequest(input: {
  sections: PinnedSection[]
  items: AssignmentItem[]
  proseByItem: Record<string, string>
  topDirs: string[]
  codeDirs: string[]
}): ModelRequest {
  const judgeable = input.items.filter(i => isJudgeable(i.source)).slice(0, MAX_JUDGE_PER_CALL)
  const prompt = [
    'Pinned product sections (use these ids only):',
    ...input.sections.map(s => `${s.id} | ${s.title} | ${s.hint}`),
    '',
    'Tasks (id | delivery phase | title | deterministic status/source; empty fields are left out). Status from "pr" evidence is final:',
    ...input.items.map(i => fields([i.id, cut(i.phase, 60), cut(i.title, 80), `${i.status}/${i.source}`])),
    '',
    'Judge these tasks (no PR evidence). For each, reply status done, partial or planned from the excerpt:',
    ...(judgeable.length
      ? judgeable.map(i => `${i.id}: ${cut((input.proseByItem[i.id] ?? '').replace(/\s+/g, ' ').trim(), MAX_PROSE)}`)
      : ['(none)']),
    '',
    `Top-level directories: ${input.topDirs.length ? input.topDirs.join(', ') : '(none)'}`,
    `Code directories: ${input.codeDirs.length ? input.codeDirs.join(', ') : '(none)'}`,
    '',
    'Rules: 1) file EVERY task under exactly one pinned section id; 2) set "status" only for the judge-list',
    'tasks; 3) you may add a section for a planned area that has no tasks yet, as',
    '{"id":"kebab-id","title":"at most 4 words","caption":"...","planned":true}; 4) give each task a title of at',
    'most 8 words and each section a caption of at most one sentence; 5) add a drift entry only where a task\'s',
    'prose and its status disagree.',
    'Reply with exactly this JSON and nothing else:',
    '{"items":[{"id":"","section":"","title":"","status":"done|partial|planned"}],' +
      '"sections":[{"id":"","caption":"","title":"","planned":true}],' +
      '"drift":[{"itemId":"","note":""}]}',
  ].join('\n')
  return {
    model: 'haiku',
    system: ASSIGNMENT_SYSTEM,
    prompt,
    maxTokens: Math.min(8000, 800 + 50 * input.items.length),
  }
}

/** What the assignment parser needs to know to validate a reply against the real ledger and pinned sections. */
export type AssignmentContext = { itemIds: string[]; sectionIds: string[]; judgeable: Set<string> }

/**
 * Validates an assignment reply and never throws. Unknown item ids are dropped, unknown section ids become
 * 'unassigned', a status on a non-judgeable item is ignored (PR evidence wins), titles are cut to 8 words,
 * notes to 140 characters, and new planned sections need a fresh kebab id.
 */
export function parseAssignment(
  text: string,
  ctx: AssignmentContext,
): { ok: true; result: AssignmentResult } | { ok: false; error: 'invalid-json' | 'bad-shape' } {
  try {
    const json = parseJsonReply(text)
    if (!json.ok) return { ok: false, error: 'invalid-json' }
    if (!isRecord(json.value)) return { ok: false, error: 'bad-shape' }
    const known = new Set(ctx.itemIds)
    const sectionIds = new Set(ctx.sectionIds)
    const out: AssignmentResult = { items: [], sections: [], drift: [] }

    const seenItems = new Set<string>()
    for (const r of Array.isArray(json.value.items) ? (json.value.items as unknown[]) : []) {
      if (!isRecord(r) || typeof r.id !== 'string' || !known.has(r.id) || seenItems.has(r.id)) continue
      seenItems.add(r.id)
      const section = typeof r.section === 'string' && sectionIds.has(r.section) ? r.section : UNASSIGNED
      const title = typeof r.title === 'string' ? firstWords(r.title, 8) : ''
      const status =
        ctx.judgeable.has(r.id) && (r.status === 'done' || r.status === 'partial' || r.status === 'planned')
          ? r.status
          : null
      out.items.push({ id: r.id, section, title: title || null, status })
    }

    const fresh = new Set<string>()
    for (const r of Array.isArray(json.value.sections) ? (json.value.sections as unknown[]) : []) {
      if (!isRecord(r) || typeof r.id !== 'string') continue
      const caption = typeof r.caption === 'string' ? oneSentence(r.caption) : ''
      if (sectionIds.has(r.id)) {
        if (!out.sections.some(s => s.id === r.id)) out.sections.push({ id: r.id, caption, title: null, planned: false })
        continue
      }
      const title = typeof r.title === 'string' ? firstWords(r.title, 4) : ''
      if (r.planned === true && KEBAB.test(r.id) && r.id !== UNASSIGNED && !fresh.has(r.id) && title) {
        fresh.add(r.id)
        out.sections.push({ id: r.id, caption, title, planned: true })
      }
    }

    const seenDrift = new Set<string>()
    for (const r of Array.isArray(json.value.drift) ? (json.value.drift as unknown[]) : []) {
      if (!isRecord(r) || typeof r.itemId !== 'string' || !known.has(r.itemId) || typeof r.note !== 'string') continue
      const note = cut(r.note.replace(/\s+/g, ' ').trim(), 140)
      if (!note || seenDrift.has(r.itemId)) continue
      seenDrift.add(r.itemId)
      out.drift.push({ itemId: r.itemId, note })
    }
    return { ok: true, result: out }
  } catch {
    return { ok: false, error: 'bad-shape' }
  }
}

/** A product section after assignment: same numbers as a phase section, plus the model's caption. */
export type ProductSection = {
  id: string
  title: string
  caption: string
  isPlanned: boolean
  items: SectionEntry[]
  percent: number
  counts: { done: number; total: number }
  status: SectionStatus
}

/**
 * Applies an assignment to the deterministic picture: pinned sections in order, then planned sections the
 * model added (0%), then a trailing 'unassigned' section for items nobody filed. Judged statuses count only
 * for items with no PR evidence; everything uses the weights and credits of `progress.ts`. The unassigned
 * section carries an empty title; the adapter resolves it.
 */
export function applyAssignment(
  l1: { items: LedgerItem[]; matches: Map<string, ItemMatch> },
  pinned: { sections: PinnedSection[] },
  assignment: AssignmentResult,
): ProductSection[] {
  const byId = new Map(assignment.items.map(a => [a.id, a]))
  const notes = new Map(assignment.sections.map(s => [s.id, s]))
  const pinnedIds = new Set(pinned.sections.map(s => s.id))
  const buckets = new Map<string, SectionEntry[]>()
  for (const it of l1.items) {
    const match = l1.matches.get(it.id)
    if (!match) continue
    const a = byId.get(it.id)
    const entry = entryOf(it, match)
    if (a?.title) entry.title = a.title
    if (a?.status && isJudgeable(match.source)) entry.status = a.status
    const key = a && pinnedIds.has(a.section) ? a.section : UNASSIGNED
    const list = buckets.get(key)
    if (list) list.push(entry)
    else buckets.set(key, [entry])
  }
  const build = (id: string, title: string, caption: string, isPlanned: boolean): ProductSection => {
    const entries = buckets.get(id) ?? []
    const percent = percentOf(entries)
    return {
      id,
      title,
      caption,
      isPlanned,
      items: entries,
      percent,
      counts: countsOf(entries),
      status: isPlanned ? 'planned' : statusOf(entries, percent),
    }
  }
  const out = pinned.sections.map(s => build(s.id, s.title, notes.get(s.id)?.caption ?? '', false))
  for (const n of assignment.sections) {
    if (n.planned && !pinnedIds.has(n.id)) out.push(build(n.id, n.title ?? '', n.caption, true))
  }
  if (buckets.has(UNASSIGNED)) out.push(build(UNASSIGNED, '', '', false))
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Orchestration

/** The three stored records L2 reads (the adapter keys them per repository). */
export type L2Store = { pinned?: PinnedSections; proposal?: ProposalRecord; assignment?: AssignmentRecord }

/** Everything L2 reads: the items with their deterministic status, document context and the cache key. */
export type L2Inputs = {
  ledgerTitle: string
  items: AssignmentItem[]
  docHeadings: { path: string; headings: string[] }[]
  topDirs: string[]
  codeDirs: string[]
  proseByItem: Record<string, string>
  /** Hash of everything the assignment reads (see `assignmentInputs` + `inputHash`); the cache key. */
  hash: string
}

/** Structured L2 failure: the call failed, or the reply was not valid. */
export type L2Error = 'model-failed' | 'invalid-json'

/** What `runL2` hands back: the records to show or store, which models were called, and an error if one failed. */
export type L2Result = {
  proposal?: ProposalRecord
  assignment?: AssignmentRecord
  calls: ('sonnet' | 'haiku')[]
  error?: L2Error
}

/**
 * Runs the layer-2 calls the stored state calls for, and no more. Nothing pinned: one Sonnet proposal, only if
 * none is stored. Pinned: the Haiku assignment, in batches of at most 120 tasks (one call each), only if the
 * stored assignment's hash differs. A failed or invalid reply in any batch keeps the previous record and
 * reports a structured error; a throwing `complete` counts as 'model-failed'.
 */
export async function runL2(args: {
  complete: Complete
  store: L2Store
  inputs: L2Inputs
  now?: () => number
}): Promise<L2Result> {
  const { complete, store, inputs } = args
  const now = args.now ?? (() => Date.now())
  const calls: L2Result['calls'] = []
  const call = async (req: ModelRequest): Promise<{ ok: true; text: string } | { ok: false }> => {
    calls.push(req.model)
    try {
      const r = await complete(req)
      return r.ok ? { ok: true, text: r.text } : { ok: false }
    } catch {
      return { ok: false }
    }
  }

  if (!store.pinned) {
    if (store.proposal) return { proposal: store.proposal, calls }
    const reply = await call(
      buildProposalRequest({
        ledgerTitle: inputs.ledgerTitle,
        items: inputs.items,
        docHeadings: inputs.docHeadings,
        topDirs: inputs.topDirs,
      }),
    )
    if (!reply.ok) return { calls, error: 'model-failed' }
    const parsed = parseProposal(reply.text)
    if (!parsed.ok) return { calls, error: 'invalid-json' }
    return { proposal: { sections: parsed.sections, proposedAt: now() }, calls }
  }

  const keep = { proposal: store.proposal, assignment: store.assignment }
  if (store.assignment && store.assignment.hash === inputs.hash) return { ...keep, calls }
  // One call per chunk; every chunk must succeed or the old record is kept as it is.
  const sectionIds = store.pinned.sections.map(s => s.id)
  const results: AssignmentResult[] = []
  for (const chunk of chunkItems(inputs.items)) {
    const reply = await call(
      buildAssignmentRequest({
        sections: store.pinned.sections,
        items: chunk,
        proseByItem: inputs.proseByItem,
        topDirs: inputs.topDirs,
        codeDirs: inputs.codeDirs,
      }),
    )
    if (!reply.ok) return { ...keep, calls, error: 'model-failed' }
    const parsed = parseAssignment(reply.text, {
      itemIds: chunk.map(i => i.id),
      sectionIds,
      judgeable: new Set(chunk.filter(i => isJudgeable(i.source)).map(i => i.id)),
    })
    if (!parsed.ok) return { ...keep, calls, error: 'invalid-json' }
    results.push(parsed.result)
  }
  return { proposal: store.proposal, assignment: { hash: inputs.hash, result: mergeResults(results), at: now() }, calls }
}

/**
 * Splits the items into batches for the assignment model: at most `CHUNK_ITEMS` tasks and at most
 * `MAX_JUDGE_PER_CALL` judgeable tasks per batch, in ledger order. An empty ledger is one empty batch-less run.
 */
export function chunkItems(items: AssignmentItem[]): AssignmentItem[][] {
  const chunks: AssignmentItem[][] = []
  let current: AssignmentItem[] = []
  let judge = 0
  for (const item of items) {
    const isJ = isJudgeable(item.source)
    if (current.length >= CHUNK_ITEMS || (isJ && judge >= MAX_JUDGE_PER_CALL)) {
      chunks.push(current)
      current = []
      judge = 0
    }
    current.push(item)
    if (isJ) judge += 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Joins per-batch results: items and drift in order, the first caption per section, each new planned section once. */
function mergeResults(results: AssignmentResult[]): AssignmentResult {
  const merged: AssignmentResult = { items: [], sections: [], drift: [] }
  for (const r of results) {
    merged.items.push(...r.items)
    merged.drift.push(...r.drift)
    for (const note of r.sections) {
      const seen = merged.sections.find(s => s.id === note.id)
      if (!seen) merged.sections.push(note)
      else if (seen.caption === '' && note.caption !== '') seen.caption = note.caption
    }
  }
  return merged
}
