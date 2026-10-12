// Shared test scaffolding: a provider context over an in-memory tree, a hand-built
// PanelModel (a mid-Inception intent), a mock host, and the ops a session answers.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import { tree, ROOT, sessions } from '../fixtures/real-sample'
import { fsxOf } from '../fixtures/virtual'
import type { VirtualTree } from '../fixtures/virtual'
import type { Item, ItemStatus, PanelModel, PanelOptions, ProviderContext, ProviderHost, Section } from '../types'

export const MODEL_REF = { plugin: 'project-panel', key: 'model' } as const
export const PANE = { id: 'panel', title: 'Project' }

export const PANE_PROPS = {
  title: 'Project',
  isFocused: true,
  bodyColumns: 44,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

export const MOUNT = { plugin: 'project-panel', component: 'Pane' as const, requestId: 'panel', props: PANE_PROPS }

export const OPTIONS: PanelOptions = { stageBranchPattern: '^[^/]+/(?<ticket>[^/]+)/(?<stages>.+)$', foldSeparator: '--' }
export const NOW = 1_800_000_000_000

/** A host whose commands all fail, whose model never answers, and whose store is a Map; it records the runs. */
export function mockHost(): ProviderHost & { runs: (readonly string[])[] } {
  const stored = new Map<string, unknown>()
  const runs: (readonly string[])[] = []
  return {
    runs,
    run: async argv => {
      runs.push(argv)
      return { exitCode: 1, stdout: '', stderr: '' }
    },
    complete: async () => ({ isAnswered: false, text: '' }),
    store: {
      get: async key => stored.get(key),
      set: async (key, value) => void stored.set(key, value),
    },
  }
}

/** A provider context over a virtual tree. */
export function ctxOf(
  vtree: VirtualTree,
  startDir: string,
  sessionId: string,
  options: PanelOptions = OPTIONS,
  host: ProviderHost = mockHost(),
): ProviderContext {
  return { fsx: fsxOf(vtree), host, startDir, sessionId, now: NOW, options }
}

export function item(id: string, status: ItemStatus, extra: Partial<Item> = {}): Item {
  return { id, title: id, status, isCurrent: false, chips: [], ...extra }
}

export function section(
  id: string,
  title: string,
  status: Section['status'],
  items: Item[],
  extra: Partial<Section> = {},
): Section {
  const executed = items.filter(one => one.status !== 'skipped')
  const done = executed.filter(one => one.status === 'done').length
  return {
    id,
    title,
    status,
    isCollapsed: status !== 'active',
    items,
    counts: { done, total: executed.length },
    ...(executed.length > 0 ? { percent: Math.round((done / executed.length) * 100) } : {}),
    ...extra,
  }
}

/** The mid-Inception intent: Initialization and Ideation built, Inception parked at domain-design. */
export function stageModel(overrides: Partial<PanelModel> = {}): PanelModel {
  const inception = section('INCEPTION', 'Inception', 'active', [
    item('practices-discovery', 'done'),
    item('requirements-analysis', 'done'),
    item('user-stories', 'done'),
    item('refined-mockups', 'done'),
    item('domain-design', 'open', { isCurrent: true }),
    item('units-generation', 'planned'),
    item('contract-design', 'planned'),
    item('delivery-planning', 'planned'),
  ])
  return {
    version: 2,
    provider: 'aidlc',
    root: ROOT,
    header: {
      title: 'shop-mvp-restart',
      mode: 'stage',
      subtitle: 'Inception · domain-design',
      badge: '',
      caption: '',
      updatedAt: '2026-09-04T01:19:27Z',
    },
    next: { command: '/aidlc', reason: 'Execute Domain Design' },
    overall: { percent: 50, counts: { done: 11, open: 1, planned: 14, total: 26 } },
    sections: [
      section('INITIALIZATION', 'Initialization', 'built', ['a', 'b', 'c'].map(id => item(id, 'done'))),
      section('IDEATION', 'Ideation', 'built', ['d', 'e', 'f', 'g'].map(id => item(id, 'done'))),
      inception,
      section('CONSTRUCTION', 'Construction', 'planned', ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'].map(id => item(id, 'planned')), {
        caption: 'per unit: billing, catalog',
      }),
      section('OPERATION', 'Operation', 'skipped', [item('deployment-pipeline', 'skipped')]),
    ],
    gates: [
      {
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: 'Parked at domain-design',
        caption: 'The workflow was parked 2026-09-04 01:19. Resume it with /aidlc.',
        sectionId: 'INCEPTION',
        afterItemId: 'domain-design',
      },
    ],
    drift: [],
    watch: [],
    readAt: new Date(2026, 8, 4, 12, 3, 0).getTime(),
    ...overrides,
  }
}

/** A session that is not one of the plan's stages: the badge, the "This session" card, full sections. */
export function sideJobModel(overrides: Partial<PanelModel> = {}): PanelModel {
  return stageModel({
    header: {
      title: 'shop-mvp-restart',
      mode: 'side-job',
      subtitle: 'Inception · domain-design',
      badge: 'Side job',
      caption: 'This session is not bound to a stage of shop-mvp-restart.',
      updatedAt: '2026-09-04T01:19:27Z',
    },
    next: { command: '/aidlc', reason: 'Workflow next: Execute Domain Design' },
    ...overrides,
  })
}

/** A plan exists, nothing is in flight: no sections, no ring. */
export function idleModel(overrides: Partial<PanelModel> = {}): PanelModel {
  return stageModel({
    header: { title: 'shop', mode: 'idle', subtitle: '', badge: 'Idle', caption: 'This workspace has no intent in flight.', updatedAt: '' },
    next: { command: '/aidlc', reason: 'Start a new intent' },
    sections: [],
    gates: [],
    overall: { counts: { total: 0 } },
    ...overrides,
  })
}

/**
 * Two stages share PR #31 (the fold gutter), the first was reopened (a reopen chip), and the
 * current one holds two gates after it: a warning (questions) and an error (PR not merged). One drift flag.
 */
export function foldedModel(overrides: Partial<PanelModel> = {}): PanelModel {
  const fold = { kind: 'fold' as const, label: '#31', tone: 'accent' as const }
  const inception = section('INCEPTION', 'Inception', 'active', [
    item('practices-discovery', 'done'),
    item('requirements-analysis', 'done'),
    item('user-stories', 'done', { chips: [{ kind: 'reopen', label: 'reopened', tone: 'warning' }, fold] }),
    item('refined-mockups', 'open', { isCurrent: true, chips: [fold] }),
    item('domain-design', 'planned'),
    item('units-generation', 'planned'),
  ])
  return stageModel({
    sections: [inception, section('CONSTRUCTION', 'Construction', 'planned', ['u1', 'u2'].map(id => item(id, 'planned')))],
    gates: [
      { id: 'q', kind: 'questions-unanswered', tone: 'warning', title: '3 questions unanswered', caption: 'Answer them in the stage questions file.', sectionId: 'INCEPTION', afterItemId: 'refined-mockups' },
      { id: 'pr', kind: 'pr-not-merged', tone: 'error', title: 'PR #31 not merged', caption: 'domain-design starts once #31 lands on main.', sectionId: 'INCEPTION', afterItemId: 'refined-mockups' },
    ],
    drift: [{ id: 'd', label: 'user-stories reopened after approval', tone: 'warning' }],
    next: { command: '/aidlc', reason: 'Execute Refined Mockups' },
    ...overrides,
  })
}

/** A WORKPLAN-style ledger: overall percent, % rings, a long section, failed/partial/planned items, a proposed section, a Pin action, drift. */
export function ledgerModel(overrides: Partial<PanelModel> = {}): PanelModel {
  const pr = (n: number, tone: 'success' | 'accent' | 'error' = 'success') => ({ kind: 'pr' as const, label: `#${n}`, tone })
  const done = (id: string, n: number) => item(id, 'done', { chips: [pr(n)] })
  const api = section(
    'api',
    'API',
    'partial',
    [
      ...[3, 5, 8, 11, 14, 17, 20, 22, 24, 27, 29].map((n, i) => done(`T${String(i + 1).padStart(2, '0')} ${['Threads CRUD', 'Comments', 'Due dates', 'Recurrence', 'Search', 'Digest feed', 'Quiet hours API', 'Snooze', 'Nag acks', 'Webhooks', 'Rate limits'][i]}`, n)),
      item('T09b Export', 'partial', { chips: [pr(33, 'accent')] }),
      item('T09c Audit log', 'planned'),
    ],
    { percent: 85, counts: { done: 11, total: 13 } },
  )
  const telegram = section(
    'tg',
    'Telegram bot',
    'active',
    [
      done('T10 Link account', 41),
      done('T11 Daily digest', 44),
      done('T11a Digest timezone', 45),
      done('T12 Snooze from chat', 47),
      done('T13 Nag re-ping', 50),
      done('T14 Quiet hours', 51),
      item('T15 Inline actions', 'open', { chips: [pr(52, 'accent')] }),
      item('T16 Voice capture', 'partial', { chips: [pr(53), { kind: 'tag', label: 'voice', tone: 'neutral' }] }),
      item('T17 Group chats', 'failed', { chips: [pr(55, 'error')] }),
      item('T18 Bot onboarding', 'planned', { isCurrent: true }),
    ],
    { percent: 60, counts: { done: 6, total: 10 }, isCollapsed: false },
  )
  return stageModel({
    header: { title: 'reminders', mode: 'stage', subtitle: '', badge: '', caption: '', updatedAt: '' },
    next: { command: 'start T18 - Bot onboarding', reason: 'T15-T17 are in flight in Telegram bot' },
    actions: [{ id: 'pin', label: 'Pin sections' }],
    overall: { percent: 78, counts: { done: 31, total: 40 } },
    sections: [
      section('plugin', 'Claude plugin', 'built', Array.from({ length: 8 }, (_, i) => item(`p${i}`, 'done'))),
      section('mcp', 'MCP connector', 'built', Array.from({ length: 6 }, (_, i) => item(`m${i}`, 'done'))),
      api,
      telegram,
      section('mobile', 'Mobile apps', 'planned', ['T20 iOS app', 'T21 Android app', 'T22 Push'].map(id => item(id, 'planned'))),
      { id: 'web', title: 'Web dashboard', caption: '3 open items mention a dashboard.', status: 'planned', isCollapsed: true, isProposed: true, items: [] },
    ],
    gates: [{ id: 'qa', kind: 'qa-failed', tone: 'error', title: 'T17 QA failed on #55', sectionId: 'tg', afterItemId: 'T17 Group chats' }],
    drift: [{ id: 'd', label: 'T16 marked partial, #53 merged', tone: 'warning' }],
    ...overrides,
  })
}

/** What a test can flip while a session runs. */
export type Control = {
  isDiskFailing: boolean
  isRegisterFailing: boolean
  isOpenFailing: boolean
  /** Every `fs.*` call fails with EIO (not a missing path); `session.root` still answers. */
  isFsFailing: boolean
  /** `git` answers non-zero everywhere, as outside a repository. */
  isGitMissing: boolean
  /** `gh` (and anything else that is not git) fails to run, as offline or not installed. */
  isGhFailing: boolean
  /** `git rev-parse HEAD` and `git branch --show-current` answer these. */
  sha: string
  branch: string
}

/** A pane as `$.ui.panes()` lists it. */
export type PaneRow = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

/** Writes a file into a virtual tree while a session runs; its mtime moves (to `mtime`, else one more than before). */
export function setFile(vtree: VirtualTree, path: string, text: string, mtime?: number): void {
  vtree.files[path] = text
  vtree.mtimes ??= {}
  vtree.mtimes[path] = mtime ?? (vtree.mtimes[path] ?? 1) + 1
}

/** A copy of a tree a test may mutate without touching the shared fixture. */
export function mutableCopy(source: VirtualTree): VirtualTree {
  return { files: { ...source.files }, mtimes: { ...(source.mtimes ?? {}) } }
}

/**
 * Answers the ops a session start touches over an in-memory workspace. `ui.open`
 * and `command.register` are recorded, so a test reads what the mod asked for;
 * `control` flips failures on while the session runs.
 */
export function serveSession(
  on: On,
  options: {
    tree?: VirtualTree
    root?: string
    sessionId?: string
    surfaces?: ('terminal' | 'desktop')[]
    isPlaced?: boolean
    isDiskFailing?: boolean
    /** Time comes from `mock.clock` (starting here), returned as `calls.clock`; else `clock.now` is a fixed 2026-09-04 12:03. */
    mockClockAt?: number
  } = {},
) {
  const fsx = fsxOf(options.tree ?? tree)
  const control: Control = {
    isDiskFailing: options.isDiskFailing === true,
    isRegisterFailing: false,
    isOpenFailing: false,
    isFsFailing: false,
    isGitMissing: false,
    isGhFailing: false,
    sha: 'aaaaaaa',
    branch: 'main',
  }
  const gone = () => {
    if (control.isDiskFailing) throw new Error('disk gone')
  }
  const broken = () => {
    if (control.isFsFailing) throw new Error('EIO: i/o error')
  }
  /** The last value written under each of the plugin's state keys; absent = never written. */
  const state = new Map<string, unknown>()
  /** Every value written under `model`, in order: a redraw happens once per entry. */
  const modelWrites: unknown[] = []
  /** Every command the mod ran, in order (git and gh). */
  const runs: string[][] = []
  /** The panes `$.ui.panes()` lists; `ui.open` adds, `ui.close` removes, a test may edit it. */
  const panes: PaneRow[] = []
  /** Every path `fs.stat` was asked about, in order. */
  const stats: string[] = []
  /** Every path `fs.read` was asked about, in order. */
  const reads: string[] = []
  const clock: MockClock | null = options.mockClockAt === undefined ? null : mock.clock(on, { now: options.mockClockAt })
  const calls = {
    opened: [] as string[],
    commands: [] as string[],
    filled: [] as string[],
    control,
    state,
    modelWrites,
    runs,
    panes,
    stats,
    reads,
    clock,
  }

  on('state.set', async (_$, e, next) => {
    const write = e as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'project-panel') {
      state.set(write.key, write.value)
      if (write.key === 'model') modelWrites.push(write.value)
    }
    return next(e)
  })

  on('fs.read', async (_$, e) => {
    broken()
    reads.push(e.path)
    gone()
    const text = await fsx.read(e.path)
    if (text === null) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', async (_$, e) => {
    broken()
    gone()
    return { value: await fsx.exists(e.path) }
  })
  on('fs.list', async (_$, e) => {
    broken()
    gone()
    return { value: (await fsx.list(e.path)).map(entry => ({ name: entry.name, kind: entry.kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    broken()
    stats.push(e.path)
    gone()
    const mtime = await fsx.mtime(e.path)
    if (mtime === null) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: (await fsx.read(e.path)) === null ? 'dir' : 'file', size: 0, mtimeMs: mtime, isLink: false } }
  })
  on('session.root', async () => {
    gone()
    return { value: options.root ?? ROOT }
  })
  on('session.id', async () => ({ value: options.sessionId ?? sessions.live }))
  on('session.surfaces', async () => ({ value: options.surfaces ?? ['terminal'] }))
  if (clock === null) on('clock.now', async () => ({ value: new Date(2026, 8, 4, 12, 3, 0).getTime() }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const done = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[0] !== 'git') {
      if (control.isGhFailing) throw new Error('offline')
      return done(0, '')
    }
    if (control.isGitMissing) return done(128, '')
    if (argv[1] === 'rev-parse') return done(0, `${control.sha}\n`)
    if (argv[1] === 'branch') return done(0, `${control.branch}\n`)
    return done(0, '')
  })
  on('ui.panes', async () => ({ value: panes.map(pane => ({ ...pane })) }))
  // The engine's own bottom for a tool call: the tool "ran" and answered.
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as never)
  on('command.register', async (_$, e) => {
    if (control.isRegisterFailing) throw new Error('register refused')
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    if (control.isOpenFailing) throw new Error('open refused')
    calls.opened.push(e.id)
    const isPlaced = options.isPlaced !== false
    const row: PaneRow = { id: e.id, title: e.title ?? e.id, isShown: isPlaced, isFocused: false, isPlaced }
    const at = panes.findIndex(pane => pane.id === e.id)
    if (at >= 0) panes[at] = row
    else panes.push(row)
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('prompt.fill', async (_$, e) => {
    calls.filled.push(`${e.mode}:${e.text}`)
    return { isFilled: true }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', async (_$, e) => ({ clientId: e.clientId }))
  on('turn.complete', async () => ({ text: '' }))

  return calls
}

/**
 * Stands in for the model nobody has written yet: `state.get` of the model key
 * answers `model` until a write lands, then defers to the kit's own store, which
 * redraws the pane on a write. (Hooks of the test that replace `state.set` would
 * lose that redraw, so only the read of the unwritten model is answered here.)
 */
export function seedModel(on: On, model: PanelModel | null | (() => PanelModel | null), options: { hasClock?: boolean } = {}) {
  // The renderer asks the clock for the header's "checked {ago}"; a test that also serves a session leaves it to that.
  if (options.hasClock !== false) on('clock.now', async () => ({ value: new Date(2026, 8, 4, 12, 3, 0).getTime() }))
  on('state.get', async (_$, e, next) => {
    const held = await next(e)
    if (e.plugin === 'project-panel' && e.key === 'model' && held.value?.value === undefined) {
      return { value: { value: typeof model === 'function' ? model() : model, version: held.value?.version ?? 0 } }
    }
    return held
  })
}
