// Which intent a session is on, mirroring the AI-DLC engine's statusline
// (resolveWorkflowSelection and the helpers it uses), plus the panel's own
// stage / side-job rule.
import { join } from '../../fsx'
import type { Fsx } from '../../fsx'
import { isArchivedState } from './parse-state'
import type { PanelMode, Selection, Workspace } from './types'

const DEFAULT_SPACE = 'default'
const SPACE_NAME = /^[a-z][a-z0-9-]*$/

export function intentsDir(ws: Workspace, space: string): string {
  return join(ws.aidlcDir, 'spaces', space, 'intents')
}

function stateFile(ws: Workspace, space: string, intent: string): string {
  return join(intentsDir(ws, space), intent, 'aidlc-state.md')
}

/** upstream knownActiveSpace: the cursor text, if it names a real space dir. */
async function activeSpace(fsx: Fsx, ws: Workspace): Promise<string> {
  const name = (await fsx.read(join(ws.aidlcDir, 'active-space')))?.trim()
  if (!name || !SPACE_NAME.test(name)) return DEFAULT_SPACE
  const spaces = await fsx.list(join(ws.aidlcDir, 'spaces'))
  return spaces.some(entry => entry.name === name && entry.kind !== 'file') ? name : DEFAULT_SPACE
}

/** upstream listIntentDirs: intent dirs that hold a state file, sorted. */
async function intentDirs(fsx: Fsx, ws: Workspace, space: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fsx.list(intentsDir(ws, space))) {
    if (entry.kind !== 'file' && (await fsx.exists(stateFile(ws, space, entry.name)))) found.push(entry.name)
  }
  return found.sort()
}

async function isArchived(fsx: Fsx, ws: Workspace, space: string, intent: string): Promise<boolean> {
  const text = await fsx.read(stateFile(ws, space, intent))
  return text !== null && isArchivedState(text)
}

// upstream validSessionId
export function validSessionId(raw: string): boolean {
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
  return safe !== '' && safe !== '.' && safe !== '..' && safe === raw
}

// upstream isBindableIntentRecordName
function isBindableIntent(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false
  if (value === '.' || value === '..' || value.includes('/')) return false
  return [...value].every(ch => {
    const code = ch.codePointAt(0) ?? 0
    return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)
  })
}

type Binding =
  | { kind: 'intent'; space: string; intent: string }
  /** `intent: null`, not archiving: bound to the space, not to a record. */
  | { kind: 'space'; space: string }
  /** Bound to an archived intent, or archived into no intent: shows no workflow. */
  | { kind: 'hidden'; space: string }

/**
 * upstream readSessionBinding (aidlc-statusline.ts). An empty or malformed file,
 * or one that fails its validation, is no binding. Past validation:
 *   - a binding to an ARCHIVED intent, or `intent: null` with `source: "archive"`,
 *     is `hidden` (upstream: `{ intent: null, hidden: true }`): this session
 *     shows no workflow, whatever the shared cursor names;
 *   - `intent: null` otherwise names only the space (upstream: `{ space, intent: null }`);
 *   - a live intent binds that intent.
 */
async function readBinding(fsx: Fsx, ws: Workspace, sessionId: string): Promise<Binding | null> {
  if (!validSessionId(sessionId)) return null
  const raw = await fsx.read(join(ws.aidlcDir, '.aidlc-sessions', `${sessionId}.binding.json`))
  if (raw === null || raw.trim() === '') return null
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    record = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const { space, intent, boundAt } = record
  if (typeof space !== 'string' || !SPACE_NAME.test(space)) return null
  if (intent !== null && !isBindableIntent(intent)) return null
  if (typeof boundAt !== 'string' || boundAt.length === 0) return null
  if (intent !== null && !(await fsx.exists(stateFile(ws, space, intent)))) return null
  if (intent !== null && (await isArchived(fsx, ws, space, intent))) return { kind: 'hidden', space }
  if (intent === null && record.source === 'archive') return { kind: 'hidden', space }
  return intent === null ? { kind: 'space', space } : { kind: 'intent', space, intent }
}

type Cursor = { intent: string | null; source: 'active-intent' | 'lone-intent' | 'none'; live: number }

/** upstream activeIntent: the cursor if usable, else the lone live intent. */
async function cursorIntent(fsx: Fsx, ws: Workspace, space: string): Promise<Cursor> {
  const live: string[] = []
  for (const dir of await intentDirs(fsx, ws, space)) {
    if (!(await isArchived(fsx, ws, space, dir))) live.push(dir)
  }
  const cursor = (await fsx.read(join(intentsDir(ws, space), 'active-intent')))?.trim()
  if (
    cursor &&
    (await fsx.exists(stateFile(ws, space, cursor))) &&
    !(await isArchived(fsx, ws, space, cursor))
  ) {
    return { intent: cursor, source: 'active-intent', live: live.length }
  }
  const [only] = live
  return live.length === 1 && only !== undefined
    ? { intent: only, source: 'lone-intent', live: 1 }
    : { intent: null, source: 'none', live: live.length }
}

// upstream recordDirMatches
function recordDirMatches(row: Record<string, unknown>, dirName: string): boolean {
  if (typeof row.dirName === 'string') return row.dirName === dirName
  if (typeof row.slug !== 'string' || typeof row.uuid !== 'string') return false
  return dirName === `${row.slug}-${row.uuid.replace(/-/g, '').slice(-16)}`
}

// upstream displaySlugFromDirName
function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName)
  return dated?.[1] ?? dirName.replace(/-[0-9a-f]+$/, '')
}

/** The registry slug (rename-stable) when intents.json has a row for the dir. */
async function slugOf(fsx: Fsx, ws: Workspace, space: string, intent: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse((await fsx.read(join(intentsDir(ws, space), 'intents.json'))) ?? '')
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row === null || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        if (recordDirMatches(record, intent) && typeof record.slug === 'string' && record.slug !== '') {
          return record.slug
        }
      }
    }
  } catch {
    // No registry: the dir name still gives a slug.
  }
  return displaySlugFromDirName(intent)
}

/**
 * The intent this session shows (upstream resolveWorkflowSelection): its own
 * binding, else the shared cursor, else the space's only live intent.
 *   - a usable binding to a live intent: that intent, `isBound`;
 *   - a binding to an archived intent (or archived into none): nothing, `isHidden`;
 *   - a binding to no intent: the cursor / lone intent of the BINDING's space,
 *     not the global active-space; the session is not `isBound`;
 *   - no binding: the cursor / lone intent of the active space.
 * Archived intents are never selected.
 */
export async function selectIntent(fsx: Fsx, ws: Workspace, sessionId: string): Promise<Selection> {
  const binding = await readBinding(fsx, ws, sessionId)

  if (binding?.kind === 'hidden') {
    return {
      space: binding.space,
      intent: null,
      source: 'none',
      slug: '',
      statePath: '',
      isBound: false,
      isHidden: true,
      liveIntents: 0,
    }
  }
  if (binding?.kind === 'intent') {
    return {
      space: binding.space,
      intent: binding.intent,
      source: 'binding',
      slug: await slugOf(fsx, ws, binding.space, binding.intent),
      statePath: stateFile(ws, binding.space, binding.intent),
      isBound: true,
      isHidden: false,
      liveIntents: 1,
    }
  }

  const space = binding?.space ?? (await activeSpace(fsx, ws))
  const picked = await cursorIntent(fsx, ws, space)
  if (picked.intent === null) {
    return {
      space,
      intent: null,
      source: 'none',
      slug: '',
      statePath: '',
      isBound: false,
      isHidden: false,
      liveIntents: picked.live,
    }
  }
  return {
    space,
    intent: picked.intent,
    source: picked.source === 'none' ? 'active-intent' : picked.source,
    slug: await slugOf(fsx, ws, space, picked.intent),
    statePath: stateFile(ws, space, picked.intent),
    isBound: false,
    isHidden: false,
    liveIntents: picked.live,
  }
}

/** A stage branch parsed by the configured pattern: its ticket and stage slugs; null when it does not match. */
export function matchStageBranch(
  branch: string,
  pattern: string,
  foldSeparator: string,
): { ticket: string; stages: string[] } | null {
  if (branch === '' || pattern === '') return null
  let match: RegExpExecArray | null
  try {
    match = new RegExp(pattern).exec(branch)
  } catch {
    return null
  }
  if (!match) return null
  const ticket = match.groups?.ticket ?? ''
  const joined = match.groups?.stages ?? ''
  // A fold names several stages after one separator with commas (`domain-design--folded--a,b`); a word that is no
  // stage (`folded`) is dropped by whoever maps the names onto the plan.
  const stages = (foldSeparator === '' ? [joined] : joined.split(foldSeparator))
    .flatMap(part => part.split(','))
    .filter(stage => stage !== '')
  return { ticket, stages }
}

/**
 * stage = bound to an intent (a usable binding), whatever the branch;
 * side-job = anything else with an intent selected; none = no intent. The
 * branch parsed by the pattern is returned whenever it matches.
 */
export function modeFor(
  sel: { intent: string | null; isBound: boolean },
  branch: string,
  stageBranchPattern: string,
  foldSeparator: string,
): { mode: PanelMode; stageBranch?: { ticket: string; stages: string[] } } {
  const stageBranch = matchStageBranch(branch, stageBranchPattern, foldSeparator)
  // The binding alone decides: the branch's name says nothing about which stage a session works on.
  const mode: PanelMode = sel.intent === null ? 'none' : sel.isBound ? 'stage' : 'side-job'
  return stageBranch ? { mode, stageBranch } : { mode }
}
