// Parses one aidlc-state.md. Pure and import-free (types excepted): CI runs it
// under `node --experimental-strip-types` against upstream's state template.
import type { ParsedPhase, ParsedStage, ParsedState, PhaseStatus, StageMarker } from './types'

const MARKERS: Record<string, StageMarker> = {
  ' ': 'pending',
  '-': 'in-progress',
  '?': 'awaiting-approval',
  R: 'revising',
  x: 'completed',
  X: 'completed',
  S: 'skipped',
}

const PHASE_STATUSES: readonly string[] = ['pending', 'active', 'verified', 'skipped']

// `- **Key**: value`, anchored at the line start like upstream's extractField.
// `[^\n]*` rather than `.`: a dot stops at U+2028, U+2029 and a stray `\r`, and
// the `$` after it would then drop the whole field.
const FIELD = /^-\s*\*\*([^*]+)\*\*:[^\S\n]*([^\n]*)$/
const PHASE_KEY = /^[A-Z][A-Z0-9_-]*$/
const SLUG = /^[a-z0-9][a-z0-9-]*$/
const PHASE_HEADING = /^###\s+(\S+)\s+PHASE\s*$/i
const PER_UNIT = /^Per unit:\s*([^\n]*?)\s*$/i
// `- [m] slug — EXECUTE|SKIP[: note]`; the dash is tolerated as `-`, `--` or `–`.
const STAGE_ROW =
  /^- \[([^\n])\]\s+(\S+)\s+(?:—|–|--|-)\s+(EXECUTE|SKIP)(?=\s|:|$)\s*:?\s*([^\n]*?)\s*$/

/** Upstream's archive test (intentIsArchived), on the file's text. */
export function isArchivedState(text: string): boolean {
  return /^- \*\*Status\*\*:\s*Archived\s*$/m.test(text)
}

export function parseState(text: string): ParsedState {
  const state: ParsedState = { fields: {}, phaseProgress: {}, phases: [], isArchived: false }
  if (typeof text !== 'string') return state
  state.isArchived = isArchivedState(text)

  let section = ''
  let phase: ParsedPhase | null = null

  for (const line of text.split(/\r?\n/)) {
    if (/^## (?!#)/.test(line)) {
      section = line.slice(3).trim()
      phase = null
      continue
    }

    if (section === 'Phase Progress') {
      readPhaseProgress(line, state.phaseProgress)
      continue
    }

    const field = FIELD.exec(line)
    if (field) {
      const key = (field[1] ?? '').trim()
      if (key !== '' && !Object.hasOwn(state.fields, key)) state.fields[key] = (field[2] ?? '').trim()
    }

    if (section === 'Stage Progress') phase = readStageLine(line, phase, state.phases)
  }
  return state
}

function readPhaseProgress(line: string, into: Record<string, PhaseStatus>): void {
  const match = FIELD.exec(line)
  if (!match) return
  const key = (match[1] ?? '').trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  const value = (match[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (PHASE_KEY.test(key) && PHASE_STATUSES.includes(value) && !Object.hasOwn(into, key)) {
    into[key] = value as PhaseStatus
  }
}

/** Handles one `## Stage Progress` line; returns the phase the next line belongs to. */
function readStageLine(line: string, phase: ParsedPhase | null, phases: ParsedPhase[]): ParsedPhase | null {
  if (line.startsWith('### ')) {
    const name = PHASE_HEADING.exec(line)?.[1]?.toUpperCase() ?? ''
    // The template's literal `### [PHASE] PHASE` fails the key test and opens nothing.
    if (!PHASE_KEY.test(name)) return null
    const opened: ParsedPhase = { key: name, perUnit: '', stages: [] }
    phases.push(opened)
    return opened
  }
  if (!phase) return phase

  const perUnit = PER_UNIT.exec(line)
  if (perUnit && phase.stages.length === 0 && phase.perUnit === '') {
    phase.perUnit = perUnit[1] ?? ''
    return phase
  }

  const row = STAGE_ROW.exec(line)
  if (!row) return phase
  const marker = MARKERS[row[1] ?? '']
  const slug = row[2] ?? ''
  if (marker === undefined || !SLUG.test(slug)) return phase
  const stage: ParsedStage = {
    slug,
    marker,
    isExecuted: row[3] === 'EXECUTE',
    note: row[4] ?? '',
  }
  phase.stages.push(stage)
  return phase
}
