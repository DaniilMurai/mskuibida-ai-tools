// Loads an AI-DLC v2 workspace into the provider-neutral PanelModel: phases
// become sections, stages become items, the Parked and awaiting-approval
// states become gates. Display text is resolved through `t()` here, so the
// renderer draws the model as it comes.
//
// Two truths (M3): inside a git work tree with `origin/<default>`, the state file in the working tree is read
// against the default branch's copy and the open PRs between (./two.ts reads, ./truths.ts decides): only a
// stage merged on the default branch is done, one in a PR is ◐, one only here is ◌. Without git it is one
// truth, the working tree's, exactly as before.
import { join, parent } from '../../fsx'
import type { Fsx } from '../../fsx'
import { t } from '../../strings/en'
import type {
  Detection,
  Gate,
  Item,
  ItemStatus,
  Next,
  PanelModel,
  ProviderContext,
  Section,
  SectionStatus,
} from '../../../types'
import { detectWorkspace } from './detect'
import { readBranch } from './git'
import { parseState } from './parse-state'
import { intentsDir, modeFor, selectIntent, validSessionId } from './select'
import { baseLine, derive, statusOfMarker } from './truths'
import { wording } from './truths'
import type { Derived, Two } from './truths'
import { hasMoreThanBranch, sessionContext } from './session'
import { readTwo } from './two'
import { PER_UNIT_STAGES, LAST_UNIT_STAGE, progressOf, readUnitFacts, readUnitList } from './units'
import { POINTS_FILE, isUncommitted, resolvePoints } from './points'
import type { UnitPoints } from './points'
import type { Unit, UnitProgress } from './units'
import { reviewNext } from '../review/view'
import type { ParsedPhase, ParsedStage, ParsedState, PhaseStatus, Selection, Workspace } from './types'

const SLUG = /^[a-z0-9][a-z0-9-]*$/
const SEP = ' · '

export async function loadAidlc(ctx: ProviderContext, detection: Detection): Promise<PanelModel> {
  const { fsx } = ctx
  const workspace = (await workspaceOf(fsx, ctx.startDir, detection)) ?? (await mustDetect(fsx, ctx.startDir))
  const selection = await selectIntent(fsx, workspace, ctx.sessionId)
  const watch = watched(workspace, selection, ctx.sessionId)

  if (selection.isHidden) return idle(ctx, workspace, watch, t('aidlc.idle.archived'))

  const branch = await readBranch(fsx, ctx.startDir)
  const { mode } = modeFor(selection, branch, ctx.options.stageBranchPattern, ctx.options.foldSeparator)
  if (mode === 'none') return idle(ctx, workspace, watch, idleCaption(selection))

  const text = await fsx.read(selection.statePath)
  const parsed = parseState(text ?? '')
  const step = text === null ? { stage: '', unit: '' } : await shownStep(fsx, selection.statePath, parsed)

  const two = text === null ? null : await readTwo(ctx, selection.statePath, parsed, branch, step.stage)
  const view = two ? derive(parsed, two) : null

  const units = text === null ? null : await unitsOf(ctx, workspace.root, selection.statePath, parsed, step, mode === 'stage')
  const sections = text === null ? [] : sectionsOf(parsed, step.stage, view, two, units)
  const gates = collectGates(parsed, sections, view, mode === 'side-job')
  if (units?.isUncommitted) gates.unshift(pointsGate())
  if (units && units.repeated.length > 0) gates.unshift(repeatedGate(units))
  for (const section of sections) {
    const holdsCurrent = section.items.some(item => item.isCurrent)
    const hasGate = gates.some(gate => gate.sectionId === section.id && gate.isAttentionOnly !== true)
    section.isCollapsed = !(section.status === 'active' || holdsCurrent || hasGate)
  }

  const phaseKey = firstToken(parsed.fields['Lifecycle Phase']).toUpperCase()
  const status = parsed.fields['Status'] ?? ''
  const subtitle = [
    phaseKey === '' ? '' : phaseLabel(phaseKey),
    step.unit === '' ? '' : t('aidlc.header.unit', { unit: step.unit }),
    step.stage,
    status === 'Running' ? '' : status,
  ]
    .filter(part => part !== '')
    .join(SEP)

  const current = sections.flatMap(section => section.items).find(item => item.isCurrent)
  const base = two && view ? baseLine(parsed, two, view, current?.id ?? '') : ''
  const isSideJob = mode === 'side-job'

  // A side job is not a stage of the plan, so `/aidlc` is not what it does next and the plan is not what it is
  // about: it gets its own context (branch, PR, distance from main), and the plan folds behind it once there is
  // more to say than the branch's name.
  const context = isSideJob ? await sessionContext(ctx, branch, two) : []
  const isFolded = isSideJob && hasMoreThanBranch(context)
  const next = isSideJob ? null : ((two && view && current ? prNext(two, view, current.id) : null) ?? nextOf(parsed).next)

  return {
    version: 2,
    provider: 'aidlc',
    root: workspace.root,
    header: {
      title: selection.slug,
      mode: isSideJob ? 'side-job' : 'stage',
      subtitle,
      badge: isSideJob ? t('header.badge.sideJob') : '',
      caption: isSideJob ? t(isFolded ? 'aidlc.sideJob.captionFolded' : 'aidlc.sideJob.caption', { intent: selection.slug }) : '',
      updatedAt: parsed.fields['Last Updated'] ?? '',
      ...(base === '' ? {} : { base }),
      ...(context.length === 0 ? {} : { context }),
    },
    ...(next ? { next } : {}),
    ...(isFolded ? { isPlanCollapsed: true } : {}),
    overall: overallOf(sections, units),
    sections,
    gates,
    drift: [],
    watch,
    readAt: ctx.now,
  }
}

/**
 * The Next for the PR the current stage hangs on, when it asks something of the viewer (a review, an answer, a
 * merge): the PR the stage is in, else the open PR that holds it back (the stage comes right after it).
 */
function prNext(two: Two, view: Derived, currentId: string): Next | null {
  const pr = view.items.get(currentId)?.owner ?? view.holds.find(hold => hold.next === currentId)?.pr
  return pr && two.review ? reviewNext(pr, two.review) : null
}

/** `/aidlc` is the engine's one entry point; the Next Action field says why. */
function nextOf(parsed: ParsedState): { next?: Next } {
  const reason = (parsed.fields['Next Action'] ?? '').trim()
  return reason === '' ? {} : { next: { command: '/aidlc', reason } }
}

// ── detection detail ─────────────────────────────────────────────────────────

async function workspaceOf(fsx: Fsx, startDir: string, detection: Detection): Promise<Workspace | null> {
  const found = detection.detail['workspace'] as Partial<Workspace> | undefined
  if (found && typeof found.root === 'string' && typeof found.aidlcDir === 'string') {
    return { root: found.root, aidlcDir: found.aidlcDir, engineMarkers: found.engineMarkers ?? [] }
  }
  return detectWorkspace(fsx, detection.root || startDir)
}

async function mustDetect(fsx: Fsx, startDir: string): Promise<Workspace> {
  const found = await detectWorkspace(fsx, startDir)
  if (!found) throw new Error(`no AI-DLC workspace above ${startDir}`)
  return found
}

// ── idle ─────────────────────────────────────────────────────────────────────

function idleCaption(selection: Selection): string {
  return selection.liveIntents >= 2 ? t('aidlc.idle.noCursor') : t('aidlc.idle.noneInFlight')
}

function idle(ctx: ProviderContext, workspace: Workspace, watch: string[], caption: string): PanelModel {
  return {
    version: 2,
    provider: 'aidlc',
    root: workspace.root,
    header: {
      title: t('aidlc.name'),
      mode: 'idle',
      subtitle: '',
      badge: t('header.badge.idle'),
      caption,
      updatedAt: '',
    },
    overall: { counts: { total: 0 } },
    sections: [],
    gates: [],
    drift: [],
    watch,
    readAt: ctx.now,
  }
}

/** The files and directories whose change means "re-load" (the refresh engine polls their mtimes). */
function watched(workspace: Workspace, selection: Selection, sessionId: string): string[] {
  const files: string[] = []
  if (selection.statePath !== '') {
    files.push(selection.statePath)
    files.push(join(parent(selection.statePath) ?? '', '.aidlc-engine', 'active-directive.json'))
  }
  if (validSessionId(sessionId)) {
    files.push(join(workspace.aidlcDir, '.aidlc-sessions', `${sessionId}.binding.json`))
  }
  files.push(join(intentsDir(workspace, selection.space), 'active-intent'))
  files.push(join(workspace.aidlcDir, 'active-space'))
  // Directories: a write anywhere under `aidlc/` re-reads at once, and a file added to the
  // intent's directory or to `aidlc/` itself moves its mtime, which the poll sees.
  if (selection.statePath !== '') files.push(parent(selection.statePath) ?? '')
  files.push(workspace.aidlcDir)
  return files.filter(path => path !== '')
}

// ── the shown step ───────────────────────────────────────────────────────────

function firstToken(value: string | undefined): string {
  return (value ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * upstream shownStep: working one Unit at a time Current Stage stays on the
 * block's first stage, so the step shown is the Unit Stage field, else the one
 * the engine last issued (active-directive.json) when nothing has written the
 * state since, else Current Stage.
 */
async function shownStep(
  fsx: Fsx,
  statePath: string,
  parsed: ParsedState,
): Promise<{ stage: string; unit: string }> {
  const current = { stage: parsed.fields['Current Stage'] ?? '', unit: '' }
  const unitStage = parsed.fields['Unit Stage'] ?? ''
  if (SLUG.test(unitStage)) return { stage: unitStage, unit: '' }

  const directivePath = join(parent(statePath) ?? '', '.aidlc-engine', 'active-directive.json')
  const [directiveAt, stateAt] = [await fsx.mtime(directivePath), await fsx.mtime(statePath)]
  if (directiveAt === null || stateAt === null || directiveAt < stateAt) return current
  try {
    const marker = JSON.parse((await fsx.read(directivePath)) ?? '') as {
      stage?: unknown
      unit?: unknown
      delivery?: unknown
    } | null
    if (!marker || typeof marker.stage !== 'string' || !SLUG.test(marker.stage) || marker.delivery === 'superseded') {
      return current
    }
    // The file is writable, so only a real unit name gets through.
    const unit =
      typeof marker.unit === 'string' && marker.unit.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(marker.unit)
        ? marker.unit
        : ''
    return { stage: marker.stage, unit }
  } catch {
    return current
  }
}

// ── sections and items ───────────────────────────────────────────────────────

/** The sheet's label for a phase; when it has none, the key title-cased (data, not copy). */
function phaseLabel(key: string): string {
  const label = t('aidlc.phase.' + key)
  if (label !== '') return label
  return key === '' ? '' : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()
}

function itemStatus(stage: ParsedStage): ItemStatus {
  return statusOfMarker(stage.marker, stage.isExecuted)
}

const SECTION_STATUS: Record<PhaseStatus, SectionStatus> = {
  verified: 'built',
  active: 'active',
  pending: 'planned',
  skipped: 'skipped',
}

function sectionsOf(
  parsed: ParsedState,
  currentStage: string,
  view: Derived | null,
  two: Two | null,
  units: UnitView | null,
): Section[] {
  const isWaitingOnUnits = unitsPending(parsed, units)
  return parsed.phases.map((phase, index) => {
    const local = parsed.phaseProgress[phase.key] ?? 'pending'
    const progress = phaseProgressOf(local, phase.key, two)
    const known = PHASE_ORDER.indexOf(phase.key)
    const phaseNo = known >= 0 ? known : PHASE_ORDER.length + index
    const section =
      units && phase.key === 'CONSTRUCTION' && hasUnitRows(phase)
        ? unitSectionOf(phase, progress, currentStage, view, units, phaseNo)
        : sectionOf(phase, progress, currentStage, view, phaseNo)
    section.ordinal = String(phaseNo)
    if (isWaitingOnUnits && phase.key === 'CONSTRUCTION') {
      // Construction is seven stages only on paper until Units Generation has cut the intent into Units: nothing of
      // it is counted yet, in its own row or the plan's.
      delete section.counts
      delete section.percent
      section.isUncounted = true
    }
    return section
  })
}

/**
 * Construction has no size until Units Generation has produced the Units: the stage is in scope and not completed,
 * and no Unit list is readable. When the stage is skipped or absent, or the list will not parse after the stage
 * completed, Construction's own stages stand and are counted.
 */
function unitsPending(parsed: ParsedState, units: UnitView | null): boolean {
  if (units !== null) return false
  const stage = parsed.phases.flatMap(phase => phase.stages).find(row => row.slug === UNITS_STAGE)
  return stage !== undefined && stage.isExecuted && stage.marker !== 'skipped' && stage.marker !== 'completed'
}

/**
 * A phase's progress: the default branch's `## Phase Progress` when it is readable there (the working tree
 * may be ahead of it), else this working tree's. An intent not on the default branch yet has nothing built.
 */
function phaseProgressOf(local: PhaseStatus, key: string, two: Two | null): PhaseStatus {
  if (two === null) return local
  if (two.main === null) return local === 'skipped' ? 'skipped' : 'pending'
  return two.main.phaseProgress[key] ?? local
}

/** upstream's lifecycle, in order, numbered from 0 (Initialization is phase 0): a phase keeps its number even when the state file lists only some of them. */
const PHASE_ORDER: readonly string[] = ['INITIALIZATION', 'IDEATION', 'INCEPTION', 'CONSTRUCTION', 'OPERATION']

/** A stage's place in the plan: `<phase>.<stage>`, both counted from 1 in the state file's order (skipped rows count). */
const ordinalOf = (phaseNo: number, stageNo: number): string => `${phaseNo}.${stageNo}`

function stageItem(stage: ParsedStage, currentStage: string, view: Derived | null, ordinal: string): Item {
  const facts = view?.items.get(stage.slug)
  return {
    id: stage.slug,
    title: stage.slug,
    ordinal,
    status: facts?.status ?? itemStatus(stage),
    isCurrent: stage.slug === currentStage,
    chips: facts?.chips ?? [],
    ...(facts?.landing === undefined ? {} : { landing: facts.landing }),
    ...(facts?.isFinishedLocal === true ? { isFinishedLocal: true } : {}),
    ...(facts?.statusWord === undefined ? {} : { statusWord: facts.statusWord }),
    ...(facts?.group === undefined ? {} : { group: facts.group }),
    ...(facts?.review === undefined ? {} : { review: facts.review }),
  }
}

function sectionOf(phase: ParsedPhase, progress: PhaseStatus, currentStage: string, view: Derived | null, phaseNo: number): Section {
  const items = phase.stages.map((stage, at) => stageItem(stage, currentStage, view, ordinalOf(phaseNo, at + 1)))
  const perUnit = phase.perUnit === '' || phase.perUnit === '[TBD]' ? '' : t('aidlc.phase.perUnit', { units: phase.perUnit })
  return withCounts(phase, progress, items, perUnit, () => 1)
}

/** Done for the counts: merged or checked off, or finished here and not landed yet (◌ "local only"). */
const isCountedDone = (item: Item): boolean => item.status === 'done' || item.isFinishedLocal === true

/** The section's counts, ring and status from its items; `weightOf` weighs the ring (each item 1 but a Unit). */
function withCounts(
  phase: ParsedPhase,
  progress: PhaseStatus,
  items: Item[],
  caption: string,
  weightOf: (item: Item) => number,
): Section {
  const executed = items.filter(item => item.status !== 'skipped')
  const done = executed.filter(isCountedDone).length
  const total = executed.length

  // The section's status is where the default branch stands: work finished only here does not make it partial.
  const landed = executed.filter(item => item.status === 'done').length
  let status = SECTION_STATUS[progress]
  if (progress !== 'active' && landed > 0 && landed < total) status = 'partial'

  const section: Section = {
    id: phase.key,
    title: phaseLabel(phase.key),
    status,
    isCollapsed: true,
    items,
    counts: { done, total },
  }
  if (caption !== '') section.caption = caption
  const percent = weightedPercent(executed, weightOf)
  if (percent !== null) section.percent = percent
  return section
}

/** Done weight over all weight, 0-100 rounded; null when there is nothing to weigh. */
function weightedPercent(items: Item[], weightOf: (item: Item) => number): number | null {
  let done = 0
  let all = 0
  for (const item of items) {
    const weight = weightOf(item)
    all += weight
    if (isCountedDone(item)) done += weight
  }
  return all > 0 ? Math.round((done / all) * 100) : null
}

/**
 * The plan's counts and percent. Every stage weighs 1. With Units, the Units together weigh as many items as there
 * are Units, shared out by story points, so the plan counts each phase by its rows and Construction's share by
 * points; the heading says so (`overall.label`).
 */
function overallOf(sections: Section[], units: UnitView | null): PanelModel['overall'] {
  const counts: PanelModel['overall']['counts'] = { total: 0 }
  const executed = sections
    .filter(section => section.isUncounted !== true)
    .flatMap(section => section.items)
    .filter(item => item.status !== 'skipped')
  for (const item of executed) {
    const key = isCountedDone(item) ? 'done' : item.status
    counts[key] = (counts[key] ?? 0) + 1
    counts.total += 1
  }
  const overall: PanelModel['overall'] = { counts }
  const percent = weightedPercent(executed, item => units?.weights.get(item.id) ?? 1)
  if (percent === null) return overall
  overall.percent = percent
  const hasUnits = units !== null && executed.some(item => units.weights.has(item.id))
  if (hasUnits) {
    const label = t('aidlc.overall.points', { percent: String(percent), done: String(counts.done ?? 0), total: String(counts.total) })
    if (label !== '') overall.label = label
  }
  return overall
}

// ── Construction by Unit ─────────────────────────────────────────────────────

/** The Units of the intent and how far each has got, ready to become Construction's rows. */
type UnitView = {
  units: Unit[]
  progress: Map<string, UnitProgress>
  /** The Unit the session is on, by name; '' when none. */
  current: string
  /** Each Unit's story points, by name, and where they came from. */
  points: Map<string, UnitPoints>
  /**
   * Item id → weight, for the Unit rows only: the Units together weigh `units.length` items, each its share of the
   * story points.
   */
  weights: Map<string, number>
  /** unit-points.csv has changes git has not committed. */
  isUncommitted: boolean
  /** Units (by name) unit-points.csv has more than one row for. */
  repeated: string[]
}

const unitItemId = (name: string) => `unit:${name}`

/** The stage that cuts an intent into Units. */
const UNITS_STAGE = 'units-generation'

/** Unit rows replace the per-unit stage rows only while code-generation, the one that builds a Unit, is in scope. */
function hasUnitRows(phase: ParsedPhase): boolean {
  return phase.stages.some(stage => stage.slug === LAST_UNIT_STAGE && stage.isExecuted && stage.marker !== 'skipped')
}

/**
 * The Units, their progress and their story points. Only a stage session writes Jira's points to unit-points.csv: a
 * side job's branch is not where the intent's record changes.
 */
async function unitsOf(
  ctx: ProviderContext,
  root: string,
  statePath: string,
  parsed: ParsedState,
  step: { stage: string; unit: string },
  canWrite: boolean,
): Promise<UnitView | null> {
  const { fsx } = ctx
  const construction = parsed.phases.find(phase => phase.key === 'CONSTRUCTION')
  if (!construction || !hasUnitRows(construction)) return null
  const intentDir = parent(statePath) ?? ''
  const units = await readUnitList(fsx, intentDir)
  if (!units) return null
  const points = await resolvePoints(ctx, root, intentDir, units, canWrite)
  const totalPoints = units.reduce((sum, unit) => sum + (points.byUnit.get(unit.name)?.points ?? 0), 0)
  const progress = progressOf(units, parsed, await readUnitFacts(fsx, intentDir, units))
  const named = [(parsed.fields['Active Unit'] ?? '').trim(), step.unit].find(name => units.some(unit => unit.name === name))
  const working = PER_UNIT_STAGES.includes(step.stage)
    ? units.find(unit => ['active', 'paused'].includes(progress.get(unit.name)?.phase ?? ''))?.name
    : undefined
  return {
    units,
    progress,
    current: named ?? working ?? '',
    points: points.byUnit,
    weights: new Map(
      units.map(unit => {
        const own = points.byUnit.get(unit.name)?.points ?? 0
        return [unitItemId(unit.name), totalPoints > 0 ? (units.length * own) / totalPoints : 1]
      }),
    ),
    isUncommitted: points.isFilePresent && (await isUncommitted(ctx, root, points.path)),
    repeated: points.repeated,
  }
}

/** unit-points.csv has several rows for a Unit: the last one counts, which may not be the one meant. */
function repeatedGate(units: UnitView): Gate {
  const label = (name: string) => units.units.find(unit => unit.name === name)?.id || name
  return {
    id: 'points-repeated',
    kind: 'points-repeated',
    tone: 'warning',
    title: t('aidlc.gate.pointsRepeated.title', { file: POINTS_FILE }),
    caption: t('aidlc.gate.pointsRepeated.caption', { units: units.repeated.map(label).join(', ') }),
    sectionId: 'CONSTRUCTION',
    isAttentionOnly: true,
  }
}

/** unit-points.csv changed and is not committed: the panel may have added Jira's points to it. */
function pointsGate(): Gate {
  return {
    id: 'points-uncommitted',
    kind: 'points-uncommitted',
    tone: 'warning',
    title: t('aidlc.gate.pointsUncommitted.title', { file: POINTS_FILE }),
    caption: t('aidlc.gate.pointsUncommitted.caption', { file: POINTS_FILE }),
    sectionId: 'CONSTRUCTION',
    isAttentionOnly: true,
  }
}

/**
 * Construction as Units: one row per Unit in the dependency block's order (each counted once built, by its share of
 * the story points), then the stages that run once (build-and-test, ci-pipeline) as rows of their own.
 */
function unitSectionOf(
  phase: ParsedPhase,
  progress: PhaseStatus,
  currentStage: string,
  view: Derived | null,
  units: UnitView,
  phaseNo: number,
): Section {
  const label = (name: string) => {
    const unit = units.units.find(one => one.name === name)
    return unit?.id ? unit.id : name
  }
  const unitItems: Item[] = units.units.map(unit => {
    const facts = units.progress.get(unit.name) ?? { phase: 'planned', stage: '' }
    const waitsOn = unit.dependsOn.filter(dep => units.progress.get(dep)?.phase !== 'done')
    const word =
      facts.phase === 'active' && facts.stage !== ''
        ? t('aidlc.unit.atStage', { stage: facts.stage })
        : facts.phase === 'paused'
          ? t(facts.stage === '' ? 'aidlc.unit.paused' : 'aidlc.unit.pausedAt', { stage: facts.stage })
          : facts.phase === 'between'
            ? t('aidlc.unit.stageDone', { stage: facts.stage })
            : facts.phase === 'planned' && waitsOn.length > 0
              ? t('aidlc.unit.waitsOn', { units: waitsOn.map(label).join(', ') })
              : undefined
    const item: Item = {
      id: unitItemId(unit.name),
      title: unit.id === '' ? unit.name : `${unit.id} ${unit.name}`,
      status: STATUS_OF_UNIT[facts.phase],
      isCurrent: unit.name === units.current,
      chips: pointsChips(units.points.get(unit.name)),
    }
    if (word !== undefined) item.statusWord = word
    return item
  })
  const onceItems = phase.stages
    .map((stage, at) => ({ stage, ordinal: ordinalOf(phaseNo, at + 1) }))
    .filter(({ stage }) => !PER_UNIT_STAGES.includes(stage.slug))
    .map(({ stage, ordinal }) => stageItem(stage, currentStage, view, ordinal))
  const pointsOf = (unit: Unit) => units.points.get(unit.name)?.points ?? 0
  const donePoints = units.units.filter(unit => units.progress.get(unit.name)?.phase === 'done').reduce((sum, unit) => sum + pointsOf(unit), 0)
  const allPoints = units.units.reduce((sum, unit) => sum + pointsOf(unit), 0)
  return withCounts(
    phase,
    progress,
    [...unitItems, ...onceItems],
    t('aidlc.units.caption', { done: formatPoints(donePoints), total: formatPoints(allPoints), count: String(units.units.length) }),
    item => units.weights.get(item.id) ?? 1,
  )
}

/** `8` stays `8`; a fraction keeps one decimal. */
function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** A Unit's points as a chip; a default (no row, no Jira answer) says so. */
function pointsChips(points: UnitPoints | undefined): Item['chips'] {
  if (!points) return []
  const label = t(points.source === 'default' ? 'aidlc.chip.pointsDefault' : 'aidlc.chip.points', { points: formatPoints(points.points) })
  return label === '' ? [] : [{ kind: 'unit', label, tone: points.source === 'default' ? 'warning' : 'neutral' }]
}

const STATUS_OF_UNIT: Record<UnitProgress['phase'], ItemStatus> = {
  done: 'done',
  active: 'open',
  paused: 'open',
  between: 'partial',
  planned: 'planned',
}

// ── gates ────────────────────────────────────────────────────────────────────

/** `2026-09-04T01:19:27Z` → `2026-09-04 01:19` (UTC); anything unparseable stays as written. */
export function formatWhen(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * PR gates first (newest PR first, each PR's own in a fixed order), then Parked, then awaiting-approval. Parked
 * on the stage an open PR blocks (its next stage, or one of its own) hangs after that PR's gates instead,
 * and says what it waits for.
 */
function collectGates(parsed: ParsedState, sections: Section[], view: Derived | null, isSideJob: boolean): Gate[] {
  // The rows tied to the viewer first: someone (or a merge) waits on them. They are drawn under Needs attention only.
  const gates: Gate[] = [...(view?.rows ?? []), ...(view?.gates ?? [])]

  const since = parsed.fields['Parked'] ?? ''
  if (since !== '') {
    const stage = parsed.fields['Parked At Stage'] ?? ''
    const holder = sections.find(section => section.items.some(item => item.id === stage))
    // A per-unit stage drawn as Units: the section is still known, the row is the Unit being worked.
    const unitHolder = holder
      ? undefined
      : sections.find(section => parsed.phases.some(phase => phase.key === section.id && phase.stages.some(row => row.slug === stage)))
    const hold = stage === '' ? undefined : view?.holds.find(h => h.next === stage || h.stages.includes(stage))
    // A side job never resumes the workflow, so its caption names no command.
    const caption = hold
      ? t(wording(isSideJob ? 'aidlc.gate.parked.captionPrSideJob' : 'aidlc.gate.parked.captionPr', hold.forgeKind), { ref: hold.ref, since: formatWhen(since) })
      : t(isSideJob ? 'aidlc.gate.parked.captionSideJob' : 'aidlc.gate.parked.caption', { since: formatWhen(since) })
    if (stage !== '' && hold) {
      gates.push({
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: t('aidlc.gate.parked.title', { stage }),
        caption,
        sectionId: hold.sectionId,
        afterItemId: hold.last,
      })
    } else if (stage !== '' && holder) {
      gates.push({
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: t('aidlc.gate.parked.title', { stage }),
        caption,
        sectionId: holder.id,
        afterItemId: stage,
      })
    } else if (stage !== '' && unitHolder) {
      const current = unitHolder.items.find(item => item.isCurrent)
      gates.push({
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: t('aidlc.gate.parked.title', { stage }),
        caption,
        sectionId: unitHolder.id,
        ...(current ? { afterItemId: current.id } : {}),
      })
    } else {
      // Nowhere exact to hang it: the top of the section the session is in, else
      // the active one, else the first. A gate is never dropped.
      const home =
        sections.find(section => section.items.some(item => item.isCurrent)) ??
        sections.find(section => section.status === 'active') ??
        sections[0]
      gates.push({
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: t('aidlc.gate.parked.titleNoStage'),
        caption,
        sectionId: home?.id ?? '',
      })
    }
  }

  // A per-unit stage drawn as Units has no row of its own; its open gate hangs after the Unit it is on.
  for (const section of sections) {
    for (const stage of parsed.phases.find(phase => phase.key === section.id)?.stages ?? []) {
      if (section.items.some(item => item.id === stage.slug)) continue
      if ((view?.items.get(stage.slug)?.status ?? itemStatus(stage)) !== 'awaiting') continue
      const current = section.items.find(item => item.isCurrent)
      gates.push({
        id: `awaiting:${stage.slug}`,
        kind: 'awaiting-approval',
        tone: 'warning',
        title: t('aidlc.gate.awaiting-approval.title', { stage: stage.slug }),
        caption: t('aidlc.gate.awaiting-approval.caption'),
        sectionId: section.id,
        ...(current ? { afterItemId: current.id } : {}),
      })
    }
  }

  for (const section of sections) {
    for (const item of section.items) {
      if (item.status !== 'awaiting') continue
      gates.push({
        id: `awaiting:${item.id}`,
        kind: 'awaiting-approval',
        tone: 'warning',
        title: t('aidlc.gate.awaiting-approval.title', { stage: item.id }),
        caption: t('aidlc.gate.awaiting-approval.caption'),
        sectionId: section.id,
        afterItemId: item.id,
      })
    }
  }
  return gates
}
