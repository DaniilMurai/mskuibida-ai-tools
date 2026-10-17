// Which per-unit stages a Unit owes, by its kind. units-generation tags a Unit `kind: service|spec|ui|packaging|library`
// and each Construction stage file names the kinds its artifacts are for (`produces_kinds`); a stage none of whose
// artifacts are for the Unit's kind does not apply to it. The engine's Unit Progress table writes such a stage `[x]`, the
// same as one finished, so a packaging Unit nobody has started reads as having its functional design done. The panel
// reads the stage files the engine reads, applies the engine's rule (`filterProducesByKind`, `teamUnitStageApplies`),
// and takes those cells as skipped.
import { join } from '../../fsx'
import type { Fsx } from '../../fsx'
import { PER_UNIT_STAGES } from './units'
import type { Unit, UnitCell } from './units'

/** Where a runtime installs the engine's stage files under a workspace, by agent; the first one present counts. */
const INSTALL_DIRS = ['.claude', '.aidlc', '.kiro', '.codex', '.cursor', '.github']
const STAGES_DIR = join('aidlc-common', 'stages', 'construction')

/** One stage's artifacts, and the kinds each is for where the stage names some (an artifact it does not name is for every kind). */
export type StageProduces = { produces: string[]; producesKinds: Map<string, string[]> | null }

/** By stage slug; empty when no stage file could be read (every stage then applies, as before). */
export type UnitMatrix = Map<string, StageProduces>

const listOf = (raw: string): string[] =>
  raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(item => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(item => item !== '')

/** A stage file's `produces` and `produces_kinds` from its front matter; null when it has none. */
export function parseStageProduces(text: string): StageProduces | null {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
  const front = lines.slice(1, end < 0 ? lines.length : end)
  let produces: string[] | null = null
  let producesKinds: Map<string, string[]> | null = null
  let block: 'produces' | 'kinds' | null = null
  for (const line of front) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      const [, name, rest] = top
      block = name === 'produces' ? 'produces' : name === 'produces_kinds' ? 'kinds' : null
      if (block === 'produces') produces = rest!.trim() === '' ? [] : listOf(rest!.replace(/\s+#.*$/, '').trim())
      if (block === 'kinds') producesKinds = new Map()
      continue
    }
    if (block === 'produces') {
      const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line)
      if (item) produces?.push(item[1]!.replace(/^(['"])(.*)\1$/, '$2'))
    } else if (block === 'kinds') {
      const entry = /^\s+([A-Za-z0-9][\w.-]*):\s*(\[.*\])\s*(?:#.*)?$/.exec(line)
      if (entry) producesKinds?.set(entry[1]!, listOf(entry[2]!))
    }
  }
  return produces === null ? null : { produces, producesKinds }
}

/** Whether `stage` applies to a Unit of `kind` ('' = untagged, which owes every stage). A stage the matrix lacks applies. */
export function stageApplies(matrix: UnitMatrix, stage: string, kind: string): boolean {
  const entry = matrix.get(stage)
  if (entry === undefined) return true
  if (entry.produces.length === 0) return false
  const kinds = entry.producesKinds
  if (kind === '') return true
  return kinds === null || entry.produces.some(name => kinds.get(name)?.includes(kind) ?? true)
}

/** The per-unit stage files of the workspace's engine install. */
export async function readUnitMatrix(fsx: Fsx, root: string): Promise<UnitMatrix> {
  const matrix: UnitMatrix = new Map()
  for (const dir of INSTALL_DIRS) {
    const stagesDir = join(root, dir, STAGES_DIR)
    if (!(await fsx.exists(stagesDir))) continue
    for (const stage of PER_UNIT_STAGES) {
      const path = join(stagesDir, `${stage}.md`)
      const text = (await fsx.exists(path)) ? await fsx.read(path) : null
      const parsed = text === null ? null : parseStageProduces(text)
      if (parsed !== null) matrix.set(stage, parsed)
    }
    return matrix
  }
  return matrix
}

/** The table with every `[x]` a Unit's kind does not owe read as skipped (`S`): the engine marks those done unrun. */
export function withKinds(
  table: Map<string, Map<string, UnitCell>>,
  units: readonly Unit[],
  matrix: UnitMatrix,
): Map<string, Map<string, UnitCell>> {
  if (matrix.size === 0) return table
  const kindOf = new Map(units.map(unit => [unit.name, unit.kind]))
  const out = new Map<string, Map<string, UnitCell>>()
  for (const [unit, row] of table) {
    const kind = kindOf.get(unit) ?? ''
    const next = new Map(row)
    for (const [stage, cell] of row) if (cell === 'x' && !stageApplies(matrix, stage, kind)) next.set(stage, 'S')
    out.set(unit, next)
  }
  return out
}
