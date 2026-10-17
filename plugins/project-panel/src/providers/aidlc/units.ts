// Construction by Unit of work. Once Units Generation has cut the intent into Units, Construction is not seven
// stages: five of them run once per Unit (`for_each: unit-of-work` in upstream's stage graph) and only
// build-and-test and ci-pipeline run once. The stage checkbox of a per-unit stage flips only after EVERY Unit, so
// the panel reads the Units themselves:
//
//   the Units and their order    the ```yaml `units:` block of inception/units-generation/unit-of-work-dependency.md
//                                (name, kind, depends_on), which is what the engine parses (parseBoltDag)
//   their ID and Jira key        the `Unit ID` and `Jira` columns of the Unit index in unit-of-work.md
//   their story points           ./points.ts: <intent>/unit-points.csv, else the Unit's Jira issue, else 5
//   which (stage, Unit) is done  the UNIT_STARTED / PAUSED / RESUMED / COMPLETED rows of the intent's audit shards
//                                (audit/*.md). With Construction Checkpoints on, or once any such row exists, a
//                                UNIT_COMPLETED receipt is what settles a Unit; without them, its artifacts are.
//
// A Unit is done when code-generation, its last per-unit stage, is settled for it: code-generation applies to every
// kind of Unit, and the engine walks a Unit's stages in order under unit-major and every Unit through a stage
// before the next stage under stage-major, so either way nothing of the Unit is left after it. A Unit counts its
// whole story points once done and nothing before (the person's call: a ring that moves only on finished Units).
// The reads are `readUnitList` and `readUnitFacts`; everything else is a function of its arguments.
import { join } from '../../fsx'
import type { Fsx } from '../../fsx'
import type { ParsedState } from './types'

/** upstream's per-unit Construction stages, in walk order (stage-graph.json `for_each: unit-of-work`). */
export const PER_UNIT_STAGES: readonly string[] = [
  'functional-design',
  'nfr-requirements',
  'nfr-design',
  'infrastructure-design',
  'code-generation',
]

/** The per-unit stage whose settlement means the Unit is built. */
export const LAST_UNIT_STAGE = 'code-generation'

/** code-generation's `produces[]`, as files (`artifactFilename`): the artifact rule when no receipt is owed. */
const LAST_STAGE_FILES = ['code-generation-plan.md', 'unit-test-instructions.md', 'code-summary.md', 'traceability.json']

export type UnitEdge = { name: string; kind: string; dependsOn: string[] }

/** One Unit as the panel shows it. */
export type Unit = UnitEdge & {
  /** The index's Unit ID (`U3`), or '' when the index has no row for it. */
  id: string
  /** The index's Jira issue key (`ABC-14`), or '' when it names none. */
  jira: string
}

export type UnitEventKind = 'UNIT_STARTED' | 'UNIT_PAUSED' | 'UNIT_RESUMED' | 'UNIT_COMPLETED'

export type UnitEvent = { event: UnitEventKind; stage: string; unit: string; at: string }

/** How far one Unit has got. */
export type UnitProgress = {
  /** awaiting: its stage's work is done and waits on the person's approval ([?] in the engine's Unit Progress). */
  phase: 'done' | 'active' | 'paused' | 'awaiting' | 'revising' | 'between' | 'planned'
  /** The per-unit stage it is on (active, paused) or last finished (between); '' otherwise. */
  stage: string
}

// ── parsing ──────────────────────────────────────────────────────────────────

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A YAML scalar as the block writes it: quotes and a trailing comment dropped. */
function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, '').trim()
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

function flowList(raw: string): string[] {
  const inner = scalar(raw).replace(/^\[/, '').replace(/\]$/, '')
  return inner
    .split(',')
    .map(scalar)
    .filter(name => name !== '')
}

/**
 * The ```yaml `units:` block of unit-of-work-dependency.md, in its order. null when there is none or it does not
 * parse to at least one Unit with a valid name (the panel then keeps the stage rows).
 */
export function parseUnitDag(text: string): UnitEdge[] | null {
  const fence = /```ya?ml[^\n]*\n([\s\S]*?)```/g
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    const body = match[1] ?? ''
    if (!/^units:\s*$/m.test(body)) continue
    const units = parseUnitsBody(body)
    return units.length > 0 && units.every(unit => NAME.test(unit.name)) ? units : null
  }
  return null
}

function parseUnitsBody(body: string): UnitEdge[] {
  const units: UnitEdge[] = []
  let unit: UnitEdge | null = null
  let isInDeps = false
  for (const line of body.split(/\r?\n/)) {
    const entry = /^\s*-\s+name:\s*(.+)$/.exec(line)
    if (entry) {
      unit = { name: scalar(entry[1] ?? ''), kind: '', dependsOn: [] }
      units.push(unit)
      isInDeps = false
      continue
    }
    if (!unit) continue
    const field = /^\s+([a-z_]+):\s*(.*)$/.exec(line)
    if (field) {
      const [, key, value = ''] = field
      isInDeps = key === 'depends_on' && scalar(value) === ''
      if (key === 'kind') unit.kind = scalar(value)
      if (key === 'depends_on' && !isInDeps) unit.dependsOn = flowList(value)
      continue
    }
    const item = /^\s+-\s+(.+)$/.exec(line)
    if (item && isInDeps) unit.dependsOn.push(scalar(item[1] ?? ''))
  }
  return units
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/

/** A table row's cells, the outer pipes dropped and backticks unwrapped. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim().replace(/^`(.*)`$/, '$1'))
}

/**
 * The Unit index of unit-of-work.md, keyed by Unit name: its ID and Jira key. The index is the first table with a
 * `Unit ID` (or `ID`) column. A row belongs to a Unit when one of its cells is the name, or its Directory is the name
 * with a prefix (`u3-api-sign-in` for `api-sign-in`).
 */
export function parseUnitIndex(text: string, names: readonly string[]): Map<string, { id: string; jira: string }> {
  const found = new Map<string, { id: string; jira: string }>()
  const lines = text.split(/\r?\n/)
  for (let at = 0; at < lines.length - 1; at += 1) {
    const header = lines[at] ?? ''
    if (!header.trim().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[at + 1] ?? '')) continue
    const heads = cells(header).map(head => head.toLowerCase())
    const idAt = heads.findIndex(head => head === 'unit id' || head === 'id')
    if (idAt < 0) continue
    const jiraAt = heads.indexOf('jira')
    for (let row = at + 2; row < lines.length && (lines[row] ?? '').trim().startsWith('|'); row += 1) {
      const values = cells(lines[row] ?? '')
      const name = names.find(one => values.some(value => value === one || value.endsWith(`-${one}`)))
      if (name === undefined || found.has(name)) continue
      const jira = jiraAt < 0 ? '' : (values[jiraAt] ?? '')
      found.set(name, { id: values[idAt] ?? '', jira: JIRA_KEY.test(jira) ? jira : '' })
    }
  }
  return found
}

const UNIT_EVENTS: readonly string[] = ['UNIT_STARTED', 'UNIT_PAUSED', 'UNIT_RESUMED', 'UNIT_COMPLETED']

/** The UNIT_* rows of one audit shard, in file order. */
export function parseUnitEvents(shard: string): UnitEvent[] {
  if (!shard.includes('UNIT_')) return []
  const events: UnitEvent[] = []
  for (const block of shard.split(/^---\s*$/m)) {
    const field = (key: string) => new RegExp(`^\\*\\*${key}\\*\\*:[^\\S\\n]*([^\\n]*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
    const event = field('Event')
    if (!UNIT_EVENTS.includes(event)) continue
    const stage = field('Stage')
    const unit = field('Unit')
    if (stage === '' || unit === '') continue
    events.push({ event: event as UnitEventKind, stage, unit, at: field('Timestamp') })
  }
  return events
}

// ── progress ─────────────────────────────────────────────────────────────────

/** One cell of the engine's `## Unit Progress` table, as its checkbox. */
export type UnitCell = ' ' | '-' | '?' | 'R' | 'x' | 'S'

/**
 * The engine's `## Unit Progress` table (present with `Unit Ownership: team` and `Construction Iteration: unit-major`):
 * by Unit, its marker per per-unit stage. The engine rewrites it on every `next` from receipts, artifacts and gate events,
 * so it says what a receipt alone does not: a stage whose work is done but waits on the person's approval is `[?]`,
 * though its `UNIT_COMPLETED` row is written. Empty when the state has no such table.
 */
export function parseUnitProgress(state: string): Map<string, Map<string, UnitCell>> {
  const out = new Map<string, Map<string, UnitCell>>()
  const start = state.search(/^## Unit Progress[^\S\n]*$/m)
  if (start < 0) return out
  const rest = state.slice(start).split('\n').slice(1)
  const end = rest.findIndex(line => /^## /.test(line))
  const lines = (end < 0 ? rest : rest.slice(0, end)).filter(line => line.trim().startsWith('|'))
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
  const header = lines[0] === undefined ? [] : cells(lines[0]).map(cell => cell.toLowerCase())
  if (header[0] !== 'unit') return out
  for (const line of lines.slice(1)) {
    const row = cells(line)
    const unit = row[0] ?? ''
    if (unit === '' || /^-+$/.test(unit)) continue
    const stages = new Map<string, UnitCell>()
    header.forEach((name, at) => {
      if (!PER_UNIT_STAGES.includes(name)) return
      const mark = /^\[(.)\]$/.exec(row[at] ?? '')?.[1]
      const cell = mark === 'X' ? 'x' : mark
      if (cell === ' ' || cell === '-' || cell === '?' || cell === 'R' || cell === 'x' || cell === 'S') stages.set(name, cell)
    })
    if (stages.size > 0) out.set(unit, stages)
  }
  return out
}

/**
 * The table with what the receipts say since: the engine rewrites the table only when `/aidlc` routes, so a stage that
 * started after (`UNIT_STARTED`, `UNIT_RESUMED`, `UNIT_PAUSED` as its latest receipt) can still read `[ ]` there. Such
 * a cell becomes `[-]`. A cell the table has past not started (`[x]`, `[?]`, `[R]`, `[-]`) is the table's to say:
 * an approval gate is only there.
 */
export function withReceipts(table: Map<string, Map<string, UnitCell>>, events: readonly UnitEvent[]): Map<string, Map<string, UnitCell>> {
  const latest = new Map<string, UnitEventKind>()
  for (const event of events) latest.set(`${event.stage}\n${event.unit}`, event.event)
  const out = new Map<string, Map<string, UnitCell>>()
  for (const [unit, row] of table) {
    const next = new Map(row)
    for (const stage of PER_UNIT_STAGES) {
      const kind = latest.get(`${stage}\n${unit}`)
      if ((next.get(stage) ?? ' ') === ' ' && kind !== undefined && kind !== 'UNIT_COMPLETED') next.set(stage, '-')
    }
    out.set(unit, next)
  }
  return out
}

/** A Unit's progress from its table row: built, on a stage (working, waiting, revising), between stages, or not started. */
function progressFromRow(row: Map<string, UnitCell>, isPaused: boolean): UnitProgress {
  const cellOf = (stage: string) => row.get(stage) ?? ' '
  const live = PER_UNIT_STAGES.filter(stage => cellOf(stage) !== 'S')
  if (live.length > 0 && live.every(stage => cellOf(stage) === 'x')) return { phase: 'done', stage: '' }
  const on = live.find(stage => ['-', '?', 'R'].includes(cellOf(stage)))
  if (on !== undefined) {
    const cell = cellOf(on)
    return { phase: cell === '?' ? 'awaiting' : cell === 'R' ? 'revising' : isPaused ? 'paused' : 'active', stage: on }
  }
  const last = live.filter(stage => cellOf(stage) === 'x').at(-1)
  return last === undefined ? { phase: 'planned', stage: '' } : { phase: 'between', stage: last }
}

/** What the reads found, for `progressOf`. */
export type UnitFacts = {
  /** Every shard's UNIT_* rows, oldest first (stable for one timestamp: shard order, then file order). */
  events: UnitEvent[]
  /** Units whose code-generation artifacts all exist. */
  builtByFiles: Set<string>
  /** Units with anything under construction/<unit>/, and the last per-unit stage that has a directory. */
  startedByFiles: Map<string, string>
}

/**
 * Each Unit's progress. A receipt is the authority when one is owed (Construction Checkpoints enabled, or any
 * UNIT_* row exists): the latest row per (stage, Unit) decides. Otherwise artifacts do. code-generation's own
 * checkbox at [x] means every Unit is built, whatever the rows say.
 */
export function progressOf(
  units: readonly Unit[],
  parsed: ParsedState,
  facts: UnitFacts,
  table: Map<string, Map<string, UnitCell>> = new Map(),
): Map<string, UnitProgress> {
  const stageDone = parsed.phases
    .flatMap(phase => phase.stages)
    .some(stage => stage.slug === LAST_UNIT_STAGE && stage.marker === 'completed')
  const isLedger = (parsed.fields['Construction Checkpoints'] ?? '').trim() === 'enabled' || facts.events.length > 0
  const activeUnit = (parsed.fields['Active Unit'] ?? '').trim()
  const isPaused = (parsed.fields['Unit State'] ?? '').trim() === 'paused'

  // The latest row per (stage, Unit), and per Unit.
  const latest = new Map<string, UnitEvent>()
  const lastOf = new Map<string, UnitEvent>()
  for (const event of facts.events) {
    if (!PER_UNIT_STAGES.includes(event.stage)) continue
    latest.set(`${event.stage}\n${event.unit}`, event)
    lastOf.set(event.unit, event)
  }

  const out = new Map<string, UnitProgress>()
  for (const unit of units) {
    // The engine's own Unit Progress row, where the state has one, decides: it knows the approval gates.
    const row = table.get(unit.name)
    if (row !== undefined) {
      out.set(unit.name, stageDone ? { phase: 'done', stage: '' } : progressFromRow(row, unit.name === activeUnit && isPaused))
      continue
    }
    const built = isLedger
      ? latest.get(`${LAST_UNIT_STAGE}\n${unit.name}`)?.event === 'UNIT_COMPLETED'
      : facts.builtByFiles.has(unit.name)
    if (stageDone || built) {
      out.set(unit.name, { phase: 'done', stage: '' })
      continue
    }
    const last = lastOf.get(unit.name)
    if (unit.name === activeUnit || (last && last.event !== 'UNIT_COMPLETED')) {
      const paused = unit.name === activeUnit ? isPaused : last?.event === 'UNIT_PAUSED'
      out.set(unit.name, { phase: paused ? 'paused' : 'active', stage: last?.stage ?? '' })
      continue
    }
    if (last) {
      out.set(unit.name, { phase: 'between', stage: last.stage })
      continue
    }
    const onDisk = isLedger ? undefined : facts.startedByFiles.get(unit.name)
    out.set(unit.name, onDisk === undefined ? { phase: 'planned', stage: '' } : { phase: 'active', stage: onDisk })
  }
  return out
}

/** Where one Unit stands on each per-unit stage, for the Unit this checkout has claimed. */
export type UnitStageStatus = 'done' | 'active' | 'paused' | 'awaiting' | 'revising' | 'skipped' | 'planned'

/** Each per-unit stage's status straight from the Unit's row of the engine's Unit Progress table. */
export function stageStatusesFromRow(row: Map<string, UnitCell>, isPaused: boolean): Map<string, UnitStageStatus> {
  const of: Record<UnitCell, UnitStageStatus> = { ' ': 'planned', '-': isPaused ? 'paused' : 'active', '?': 'awaiting', R: 'revising', x: 'done', S: 'skipped' }
  return new Map(PER_UNIT_STAGES.map(stage => [stage, of[row.get(stage) ?? ' ']]))
}

/**
 * Each per-unit stage's status for one Unit, from how far it has got: the stages before the one it is on are done,
 * that one is active (or paused), the rest planned; a stage it finished last ("between") is done; a built Unit has
 * every stage done. A stage the progress does not name leaves only built-or-not to go on.
 */
export function unitStageStatuses(progress: UnitProgress): Map<string, UnitStageStatus> {
  const at = PER_UNIT_STAGES.indexOf(progress.stage)
  return new Map(
    PER_UNIT_STAGES.map((stage, index): [string, UnitStageStatus] => {
      if (progress.phase === 'done') return [stage, 'done']
      if (at < 0) return [stage, 'planned']
      if (index < at) return [stage, 'done']
      if (index > at) return [stage, 'planned']
      if (progress.phase === 'between') return [stage, 'done']
      if (progress.phase === 'awaiting' || progress.phase === 'revising') return [stage, progress.phase]
      return [stage, progress.phase === 'paused' ? 'paused' : 'active']
    }),
  )
}

/** The file the engine writes in a checkout's `aidlc/` when it claims a Unit for it (`aidlc --claim`), and `unit finish` deletes. */
export const UNIT_SCOPE_FILE = '.aidlc-unit-scope.json'

/** What a checkout's claim names: the intent (space and UUID) and the Unit. */
export type UnitScope = { space: string; intentUuid: string; unit: string; owner: string }

/** The scope file's claim; null when the text is no claim the engine would read (it checks the same fields). */
export function parseUnitScope(text: string | null): UnitScope | null {
  if (text === null) return null
  try {
    const raw: unknown = JSON.parse(text)
    if (raw === null || typeof raw !== 'object') return null
    const stamp = raw as Record<string, unknown>
    if (stamp.version !== 1 || typeof stamp.space !== 'string' || typeof stamp.intent_uuid !== 'string') return null
    if (typeof stamp.unit !== 'string' || stamp.unit === '') return null
    return { space: stamp.space, intentUuid: stamp.intent_uuid, unit: stamp.unit, owner: typeof stamp.owner === 'string' ? stamp.owner : '' }
  } catch {
    return null
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

/** A file's text, '' when it is not there; asked first, since a missing file is the usual case here. */
export async function readIfThere(fsx: Fsx, path: string): Promise<string> {
  return (await fsx.exists(path)) ? ((await fsx.read(path)) ?? '') : ''
}

/** The intent's Units, or null when Units Generation has not cut any (the panel keeps the stage rows). */
export async function readUnitList(fsx: Fsx, intentDir: string): Promise<Unit[] | null> {
  const dir = join(intentDir, 'inception', 'units-generation')
  const dag = parseUnitDag(await readIfThere(fsx, join(dir, 'unit-of-work-dependency.md')))
  if (!dag) return null
  const index = parseUnitIndex(await readIfThere(fsx, join(dir, 'unit-of-work.md')), dag.map(unit => unit.name))
  return dag.map(edge => ({ ...edge, id: index.get(edge.name)?.id ?? '', jira: index.get(edge.name)?.jira ?? '' }))
}

/** The audit rows and the construction/ tree the progress is derived from. */
export async function readUnitFacts(fsx: Fsx, intentDir: string, units: readonly Unit[]): Promise<UnitFacts> {
  const auditDir = join(intentDir, 'audit')
  const shards = (await fsx.list(auditDir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
  const tagged: { event: UnitEvent; shard: number; pos: number }[] = []
  for (const [shard, entry] of shards.entries()) {
    const rows = parseUnitEvents((await fsx.read(join(auditDir, entry.name))) ?? '')
    rows.forEach((event, pos) => tagged.push({ event, shard, pos }))
  }
  tagged.sort((a, b) => (a.event.at !== b.event.at ? (a.event.at < b.event.at ? -1 : 1) : a.shard - b.shard || a.pos - b.pos))

  const builtByFiles = new Set<string>()
  const startedByFiles = new Map<string, string>()
  const constructionDir = join(intentDir, 'construction')
  const present = new Set((await fsx.list(constructionDir)).filter(entry => entry.kind === 'dir').map(entry => entry.name))
  for (const unit of units) {
    if (!present.has(unit.name)) continue
    const stages = new Set((await fsx.list(join(constructionDir, unit.name))).map(entry => entry.name))
    const reached = PER_UNIT_STAGES.filter(stage => stages.has(stage)).at(-1)
    if (reached !== undefined) startedByFiles.set(unit.name, reached)
    const lastDir = join(constructionDir, unit.name, LAST_UNIT_STAGE)
    const files = await Promise.all(LAST_STAGE_FILES.map(file => fsx.exists(join(lastDir, file))))
    if (files.every(Boolean)) builtByFiles.add(unit.name)
  }
  return { events: tagged.map(one => one.event), builtByFiles, startedByFiles }
}
