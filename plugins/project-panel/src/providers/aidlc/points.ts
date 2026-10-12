// A Unit's story points, for Construction's progress. In order:
//
//   1. <intent>/unit-points.csv     `unit,points,source` rows: the unit by its ID (`U3`) or its name, `source` who
//                                   estimated it (`ai` or `human`; recorded, never read). The last row for a Unit wins,
//                                   and a Unit with several rows is flagged.
//   2. the Unit's Jira issue        when the file has no row for it, the repository's .mcp.json names an Atlassian
//                                   MCP server and the Unit index gives the issue key: its story points, asked
//                                   through the session's own connection (`host.mcp`), never a token of ours.
//                                   An answer is kept in the store, and in a stage session written to the file.
//   3. DEFAULT_POINTS               no row, no Jira, or no points on the issue
//
// The file sits in the intent's root, beside aidlc-state.md: outside every stage's folder, so writing it never reads
// as reopening a stage. The parse and the Jira answer's shape are pure; `resolvePoints` does the I/O.
import { join } from '../../fsx'
import type { ProviderContext } from '../../../types'
import { readIfThere } from './units'
import type { Unit } from './units'

export const POINTS_FILE = 'unit-points.csv'

/** A Unit's points when neither the file nor Jira gives any. */
export const DEFAULT_POINTS = 5

/** A Unit Jira had no points for, or could not be asked about, is asked again after this long. */
export const RETRY_MS = 60 * 60 * 1000

export type PointsSource = 'file' | 'jira' | 'default'

export type UnitPoints = { points: number; source: PointsSource }

// ── the file ─────────────────────────────────────────────────────────────────

function pointsValue(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** Who estimated a row's points; the panel records it and never reads it. */
export type EstimateSource = 'ai' | 'human'

export const POINTS_HEADER = 'unit,points,source'

/**
 * The file's rows by Unit name, the LAST row for a Unit winning, and the Units with more than one row (by name, in
 * Unit order). A header, blank lines, `#` comments and rows naming no Unit or no points are skipped.
 */
export function parsePointsCsv(text: string, units: readonly Unit[]): { points: Map<string, number>; repeated: string[] } {
  const points = new Map<string, number>()
  const rows = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const [key = '', value = ''] = line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1'))
    const parsed = pointsValue(value)
    if (parsed === null) continue
    const unit = units.find(one => one.name === key || (one.id !== '' && one.id.toLowerCase() === key.toLowerCase()))
    if (!unit) continue
    points.set(unit.name, parsed)
    rows.set(unit.name, (rows.get(unit.name) ?? 0) + 1)
  }
  return { points, repeated: units.filter(unit => (rows.get(unit.name) ?? 0) > 1).map(unit => unit.name) }
}

/**
 * The file with `rows` added at its end. A missing file starts with the header; a header without the `source` column
 * gets it (the rows already there keep an empty source).
 */
export function withRows(text: string, rows: readonly { unit: Unit; points: number; source: EstimateSource }[]): string {
  const lines = text.trim() === '' ? [POINTS_HEADER] : text.replace(/\r?\n$/, '').split(/\r?\n/)
  if (/^\s*unit\s*,\s*points\s*$/i.test(lines[0] ?? '')) lines[0] = POINTS_HEADER
  const added = rows.map(row => `${row.unit.id === '' ? row.unit.name : row.unit.id},${row.points},${row.source}`)
  return [...lines, ...added].join('\n') + '\n'
}

// ── Jira ─────────────────────────────────────────────────────────────────────

/** The repository's Atlassian MCP server, by its key in .mcp.json; null when it names none. */
export function jiraServerOf(mcpJson: string): string | null {
  try {
    const servers = (JSON.parse(mcpJson) as { mcpServers?: Record<string, { url?: unknown }> } | null)?.mcpServers
    if (!servers || typeof servers !== 'object') return null
    const entries = Object.entries(servers)
    const byUrl = entries.find(([, server]) => typeof server?.url === 'string' && /(^|\.)atlassian\.com\b/.test(hostOf(server.url)))
    return byUrl?.[0] ?? null
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const STORY_NAME = /^story ?points?( estimate)?$/i

function asPoints(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  return typeof value === 'string' ? pointsValue(value) : null
}

/**
 * The story points in a Jira issue as the Atlassian MCP returns it. The field's id differs per site
 * (`customfield_10016` is common), so it is found by name: through the `names` map an `expand: names` answer carries,
 * a field keyed by the name itself, or a `{ name, value }` entry. null when the issue has none.
 */
export function storyPointsOf(text: string): number | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const match = /"story ?points?(?: estimate)?"\s*:\s*"?(\d+(?:\.\d+)?)/i.exec(text)
    return match ? Number(match[1]) : null
  }
  const ids = new Set<string>()
  const seen: unknown[] = []
  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.includes(node)) return
    seen.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'names' && value && typeof value === 'object') {
        for (const [id, name] of Object.entries(value)) if (typeof name === 'string' && STORY_NAME.test(name)) ids.add(id)
      }
      collect(value)
    }
  }
  collect(data)
  const visited: unknown[] = []
  const find = (node: unknown): number | null => {
    if (!node || typeof node !== 'object' || visited.includes(node)) return null
    visited.push(node)
    const record = node as Record<string, unknown>
    if (typeof record['name'] === 'string' && STORY_NAME.test(record['name']) && 'value' in record) {
      const value = asPoints(record['value'])
      if (value !== null) return value
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'names') continue
      if (ids.has(key) || STORY_NAME.test(key)) {
        const points = asPoints(value)
        if (points !== null) return points
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'names') continue
      const found = find(value)
      if (found !== null) return found
    }
    return null
  }
  return find(data)
}

/** The site ids `getAccessibleAtlassianResources` lists, in its order. */
export function cloudIdsOf(text: string): string[] {
  try {
    const data = JSON.parse(text) as unknown
    const list = Array.isArray(data) ? data : ((data as { resources?: unknown } | null)?.resources ?? [])
    return Array.isArray(list)
      ? list.map(entry => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && id !== '')
      : []
  } catch {
    return []
  }
}

type Cached = Record<string, { points: number | null; at: number }>

/** Asks Jira for one issue's points: the remembered site first, else each site the server can reach. */
async function askJira(
  ctx: ProviderContext,
  server: string,
  key: string,
  sites: { known: string | null; all: string[] | null },
): Promise<{ points: number | null; site: string | null }> {
  const mcp = ctx.host.mcp
  if (!mcp) throw new Error('no MCP')
  if (sites.all === null && sites.known === null) {
    const listed = await mcp(server, 'getAccessibleAtlassianResources', {})
    sites.all = listed.isError ? [] : cloudIdsOf(listed.text)
  }
  const tries = sites.known !== null ? [sites.known] : (sites.all ?? [])
  for (const cloudId of tries) {
    const answer = await mcp(server, 'getJiraIssue', { cloudId, issueIdOrKey: key, expand: 'names' })
    if (answer.isError) continue
    return { points: storyPointsOf(answer.text), site: cloudId }
  }
  throw new Error(`Jira did not answer for ${key}`)
}

// ── resolving ────────────────────────────────────────────────────────────────

export type ResolvedPoints = {
  byUnit: Map<string, UnitPoints>
  /** The file's path, absolute. */
  path: string
  /** Whether the file exists after this read (it may just have been written). */
  isFilePresent: boolean
  /** Units (by name) the file has more than one row for; the last one counts. */
  repeated: string[]
}

/**
 * Every Unit's points. Jira is asked only for Units the file has no row for, at most once per RETRY_MS each while
 * it has no answer; an answer is kept in the store and, when `canWrite` (a stage session), added to the file.
 */
export async function resolvePoints(
  ctx: ProviderContext,
  root: string,
  intentDir: string,
  units: readonly Unit[],
  canWrite: boolean,
): Promise<ResolvedPoints> {
  const path = join(intentDir, POINTS_FILE)
  const fileText = await readIfThere(ctx.fsx, path)
  const { points: fromFile, repeated } = parsePointsCsv(fileText, units)
  const byUnit = new Map<string, UnitPoints>()
  for (const [name, points] of fromFile) byUnit.set(name, { points, source: 'file' })

  const missing = units.filter(unit => !fromFile.has(unit.name))
  const server = missing.some(unit => unit.jira !== '') ? jiraServerOf(await readIfThere(ctx.fsx, join(root, '.mcp.json'))) : null
  const cacheKey = `aidlc.points:${intentDir}`
  const cached: Cached = { ...(((await ctx.host.store.get(cacheKey).catch(() => undefined)) as Cached | undefined) ?? {}) }
  const written: { unit: Unit; points: number; source: EstimateSource }[] = []

  if (server !== null && ctx.host.mcp) {
    const siteKey = `aidlc.jira.site:${server}`
    const known = await ctx.host.store.get(siteKey).catch(() => undefined)
    const sites = { known: typeof known === 'string' ? known : null, all: null as string[] | null }
    let isChanged = false
    for (const unit of missing) {
      if (unit.jira === '') continue
      const before = cached[unit.name]
      if (before && (before.points !== null || ctx.now - before.at < RETRY_MS)) continue
      try {
        const answer = await askJira(ctx, server, unit.jira, sites)
        if (answer.site !== null && answer.site !== sites.known) {
          sites.known = answer.site
          await ctx.host.store.set(siteKey, answer.site).catch(() => undefined)
        }
        cached[unit.name] = { points: answer.points, at: ctx.now }
      } catch {
        // Not connected, signed out or offline: the default stands, and Jira is asked again later.
        cached[unit.name] = { points: null, at: ctx.now }
      }
      isChanged = true
    }
    if (isChanged) await ctx.host.store.set(cacheKey, cached).catch(() => undefined)
  }

  for (const unit of missing) {
    const fromJira = cached[unit.name]?.points ?? null
    if (fromJira !== null) {
      byUnit.set(unit.name, { points: fromJira, source: 'jira' })
      // Jira's points were set by a person.
      written.push({ unit, points: fromJira, source: 'human' })
    } else {
      byUnit.set(unit.name, { points: DEFAULT_POINTS, source: 'default' })
    }
  }

  let isFilePresent = fileText !== '' || (await ctx.fsx.exists(path))
  if (canWrite && written.length > 0 && ctx.host.write) {
    try {
      await ctx.host.write(path, withRows(fileText, written))
      isFilePresent = true
    } catch {
      // A failed write leaves the points in the store; the next load tries again.
    }
  }
  return { byUnit, path, isFilePresent, repeated }
}

/** Whether git has the file as changed or new (not committed); false without git or when it cannot tell. */
export async function isUncommitted(ctx: ProviderContext, root: string, path: string): Promise<boolean> {
  try {
    const status = await ctx.host.run(['git', 'status', '--porcelain', '--', path], { cwd: root, timeoutMs: 5000 })
    return status.exitCode === 0 && status.stdout.trim() !== ''
  } catch {
    return false
  }
}
