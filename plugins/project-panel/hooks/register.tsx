import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fsx, FsxEntry, ProviderContext, ProviderHost } from '../types'
import { buildModel, fingerprintOf, runAction } from '../src/model'
import { createRefreshEngine } from '../src/refresh'
import type { RefreshEngine, RefreshPorts, Snapshot } from '../src/refresh'
import { renderPane } from '../src/render'
import { t } from '../src/strings/en'
import type { PanelModel, PanelOptions } from '../types'

const PANE = 'panel'

const modelAtom = atom({ plugin: 'project-panel', key: 'model' } as const, null)
const expandedAtom = atom({ plugin: 'project-panel', key: 'expanded' } as const, {})
const closedAtom = atom({ plugin: 'project-panel', key: 'isClosed' } as const, false)

// What a missing path looks like when `$.fs` rejects (it says ENOENT); anything else is a real failure.
const MISSING = /ENOENT|ENOTDIR|EISDIR|no such file|not found|not a directory|is a directory/i

/** Counts the `$.fs` rejections that were not a plain missing path, so a read can tell "nothing there" from "could not look". */
type FsTally = { failures: number }

function tallied<T>(tally: FsTally, fallback: T): (error: unknown) => T {
  return error => {
    if (!MISSING.test(error instanceof Error ? error.message : String(error))) tally.failures++
    return fallback
  }
}

// `$.fs` as the Fsx port, adapted here: the engine follows `$`
// only into functions of this file, never across an import. The port answers rather than rejects;
// `tally` remembers the rejections that were not "missing".
function fsxOf($: EngineInterface, tally: FsTally = { failures: 0 }): Fsx {
  return {
    read: path => $.fs.read(path).catch(tallied<string | null>(tally, null)),
    exists: path => $.fs.exists(path).catch(tallied(tally, false)),
    list: path =>
      $.fs
        .list(path)
        .then(entries => entries.map(({ name, kind }) => ({ name, kind })))
        .catch(tallied<FsxEntry[]>(tally, [])),
    mtime: path =>
      $.fs
        .stat(path)
        .then(stat => stat.mtimeMs)
        .catch(tallied<number | null>(tally, null)),
  }
}

// `$.process`, `$.model`, `$.mcp`, `$.fs.write` and `$.store` as the ProviderHost port.
function hostOf($: EngineInterface): ProviderHost {
  return {
    run: (argv, init) =>
      $.process.run(argv, init).then(({ exitCode, stdout, stderr }) => ({ exitCode, stdout, stderr })),
    complete: req =>
      $.model
        .complete(req)
        .then(reply => (reply.isAnswered ? { isAnswered: true, text: reply.text } : { isAnswered: false, text: '' }))
        .catch(() => ({ isAnswered: false, text: '' })),
    mcp: (server, tool, args) =>
      $.mcp.call(server, tool, args).then(result => ({
        isError: result.isError,
        text: result.content.map(block => (typeof block.text === 'string' ? block.text : '')).join('\n'),
      })),
    write: (path, text) => $.fs.write(path, text),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
    },
  }
}

type Settings = PanelOptions & {
  /** auto: open by itself on a desktop; command: only /panel; off: never. */
  panel: 'auto' | 'command' | 'off'
  /** Seconds between mtime polls; 0 = off. */
  fsPollSeconds: number
  /** Seconds between remote-fingerprint polls; 0 = off. */
  prPollSeconds: number
  /** Which forge pull or merge requests are read from. */
  forge: 'auto' | 'github' | 'gitlab' | 'none'
}

const DEFAULT_FS_POLL = 10
const DEFAULT_PR_POLL = 180
const MIN_FS_POLL = 2
const MIN_PR_POLL = 30

/** A poll interval option: unset or garbled = the default, 0 = off, anything else at least `min`. */
function pollSeconds(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value === 0 ? 0 : Math.max(min, value)
}

async function contextOf($: EngineInterface, settings: Settings, tally?: FsTally): Promise<ProviderContext> {
  const [startDir, sessionId, now] = await Promise.all([$.session.root(), $.session.id(), $.clock.now()])
  return {
    fsx: fsxOf($, tally),
    host: hostOf($),
    startDir,
    sessionId,
    now,
    options: {
      stageBranchPattern: settings.stageBranchPattern,
      foldSeparator: settings.foldSeparator,
      forge: settings.forge,
      reviewCommands: settings.reviewCommands,
      slackDomain: settings.slackDomain,
    },
  }
}

/**
 * detect + load. A disk that fails (not a path that is merely missing) throws: the providers turn a failed
 * read into "nothing there", which must not be taken for "no plan".
 */
async function build($: EngineInterface, settings: Settings): Promise<PanelModel | null> {
  const tally: FsTally = { failures: 0 }
  const model = await buildModel(await contextOf($, settings, tally))
  if (tally.failures > 0) throw new Error('the plan could not be read')
  return model
}

// The refresh engine's ports (src/refresh.ts), adapted from `$` here: the engine follows `$`
// only into functions of this file, and src/ stays `$`-free.
function refreshPortsOf($: EngineInterface, settings: Settings): RefreshPorts {
  return {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    every: (ms, fn) => $.clock.every(ms, fn),
    load: () => build($, settings),
    fingerprint: async () => fingerprintOf(await contextOf($, settings)),
    mtime: path =>
      $.fs
        .stat(path)
        .then(stat => stat.mtimeMs)
        .catch(() => null),
    run: (argv, init) => $.process.run(argv, init).then(({ exitCode, stdout }) => ({ exitCode, stdout })),
    publish: async model => {
      await update($, modelAtom, () => model)
    },
    invalidate: async () => {
      $.ui.invalidate('ui.render')
    },
    isVisible: async () => {
      // The pane list only holds open panes (a person's close removes it), so a closed flag is no veto here.
      if (settings.panel === 'off') return false
      const panes = await $.ui.panes()
      return panes.some(pane => pane.id === PANE && pane.isPlaced)
    },
  }
}

/** Where the register closure keeps its refresh engine; the helpers below take it as a plain argument. */
type EngineSlot = { engine: RefreshEngine | null }

function bindEngine($: EngineInterface, settings: Settings, slot: EngineSlot, startDir: string): RefreshEngine {
  slot.engine?.stop()
  slot.engine = createRefreshEngine(refreshPortsOf($, settings), {
    startDir,
    isEnabled: settings.panel !== 'off',
    fsPollSeconds: settings.fsPollSeconds,
    prPollSeconds: settings.prPollSeconds,
  })
  return slot.engine
}

async function engineOf($: EngineInterface, settings: Settings, slot: EngineSlot): Promise<RefreshEngine> {
  return slot.engine ?? bindEngine($, settings, slot, await $.session.root().catch(() => ''))
}

/** Opens the pane once for a desktop that attached after session start (`panel: auto`, a plan, not closed, not open). */
async function openForDesktop($: EngineInterface, settings: Settings): Promise<void> {
  if (settings.panel !== 'auto') return
  if ((await read($, modelAtom)) === null) return
  if (await read($, closedAtom)) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  await $.ui.open({ id: PANE, title: t('pane.title') })
}

/** Opens the pane on the person's ask (`/panel` or the reopen bar): clears the closed flag, opens, wakes the engine. */
async function openAsked($: EngineInterface, running: RefreshEngine): Promise<boolean> {
  await update($, closedAtom, () => false)
  const opened = await $.ui.open({ id: PANE, title: t('pane.title') })
  await running.wake().catch(() => undefined)
  return opened.isPlaced
}

export const register: Register = (on, options) => {
  const panel = options.panel
  const reviewCommands = options.reviewCommands
  const settings: Settings = {
    stageBranchPattern: String(options.stageBranchPattern ?? ''),
    foldSeparator: String(options.foldSeparator ?? ''),
    reviewCommands: reviewCommands === 'on' || reviewCommands === 'off' ? reviewCommands : 'auto',
    slackDomain: String(options.slackDomain ?? '').trim(),
    panel: panel === 'command' || panel === 'off' ? panel : 'auto',
    fsPollSeconds: pollSeconds(options.fsPollSeconds, DEFAULT_FS_POLL, MIN_FS_POLL),
    prPollSeconds: pollSeconds(options.prPollSeconds, DEFAULT_PR_POLL, MIN_PR_POLL),
    forge: options.forge === 'github' || options.forge === 'gitlab' || options.forge === 'none' ? options.forge : 'auto',
  }

  // The refresh engine, bound at session.start. A module reload re-runs session.start, which stops this one.
  const slot: EngineSlot = { engine: null }

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Bind the engine afresh (a reload re-runs this hook); the old one's timers stop.
    let bound: RefreshEngine | null = null
    let before: Snapshot | undefined
    try {
      bound = bindEngine($, settings, slot, await $.session.root().catch(() => e.cwd))
    } catch {
      bound = null
    }

    // A plan that can't be read must never break session start.
    let model: PanelModel | null = null
    try {
      // Baselines first, so a write during the read is seen by the next poll.
      before = bound === null ? undefined : await bound.snapshot().catch(() => undefined)
      model = await build($, settings)
    } catch {
      model = null
    }
    try {
      // The engine adopts this read (hash, mtimes, HEAD), so its first poll does not re-publish it.
      const seeded = bound === null ? model : await bound.seed(model, before).catch(() => model)
      await update($, modelAtom, () => seeded)
    } catch {
      return started
    }
    // Silent without a plan: no command, no pane.
    if (model === null) return started

    try {
      await $.command.register({ name: 'panel', description: t('command.description') })
    } catch {
      // The pane can still open by itself.
    }
    try {
      if (settings.panel === 'auto' && !(await read($, closedAtom))) {
        // Unasked panes are only placed from 144 columns, so only a desktop is opened by itself.
        const isDesktop = e.surface === 'desktop' || (await $.session.surfaces()).includes('desktop')
        if (isDesktop) await $.ui.open({ id: PANE, title: t('pane.title') })
      }
    } catch {
      // The command still opens it.
    }
    // Polls run only while the pane is on screen; the engine checks that itself.
    try {
      await bound?.start()
    } catch {
      // The pane works without live refresh.
    }
    return started
  })

  on('command.run', { command: 'panel' }, async $ => {
    if (settings.panel === 'off') return { text: t('command.disabled') }

    let model: PanelModel | null
    let running: RefreshEngine
    try {
      running = await engineOf($, settings, slot)
      const outcome = await running.readNow()
      if (!outcome.ok) return { text: t('command.readFailed') }
      model = outcome.model
    } catch {
      return { text: t('command.readFailed') }
    }
    if (model === null) {
      const root = await $.session.root().catch(() => '')
      return { text: t('command.noPlan', { root }) || t('command.readFailed') }
    }

    try {
      return { text: (await openAsked($, running)) ? t('command.opened') : t('command.notPlaced') }
    } catch {
      return { text: t('command.openFailed') }
    }
  })

  // A person closing the pane: remembered, so `auto` does not reopen it this session.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await update($, closedAtom, () => true).catch(() => undefined)
    // The pane is gone, whoever closed it: nothing to keep fresh.
    slot.engine?.stop()
    return closed
  }).catch(() => undefined)

  // A tool call that wrote the plan, or ran aidlc/git/gh, re-reads. The result is never altered or delayed.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      slot.engine?.toolCall(String(e.tool), e as unknown as Record<string, unknown>)
    } catch {
      // A classification failure never reaches the model.
    }
    return result
  }).catch(($, e, next) => next(e))

  // The turn ending: the model probably touched the plan. Does not hold the turn.
  on('turn.complete', async ($, e, next) => {
    try {
      slot.engine?.request('turn')
    } catch {
      // Never breaks the turn.
    }
    return next(e)
  })

  // A surface joined. The desktop app attaches after session start, so `panel: auto` opens the pane here;
  // then the engine wakes, checks the remote and asks for a read.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface === 'desktop') {
      try {
        await openForDesktop($, settings)
      } catch {
        // /panel still opens it.
      }
    }
    try {
      await slot.engine?.attach()
    } catch {
      // Polls resume on the next render.
    }
    return attached
  })

  // A pane the person closed leaves a slim bar above the prompt with a button to bring it back, so reopening
  // needs no /panel. Gone again once the pane is open (openAsked clears the flag, which redraws the bar).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (settings.panel === 'off' || e.props.hasSurvey) return next(e)
    const [model, isClosed] = await Promise.all([read($, modelAtom), read($, closedAtom)])
    if (model === null || !isClosed) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{t('reopen.hint')} </Text>
        <Button
          key="reopen"
          label={t('reopen.button')}
          onPress={async () => {
            await openAsked($, await engineOf($, settings, slot)).catch(() => undefined)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [model, expanded, now] = await Promise.all([read($, modelAtom), read($, expandedAtom), $.clock.now()])
    // A pane being drawn is a pane on screen: let a stopped engine notice (no state is written here).
    slot.engine?.noteRendered(now)
    void slot.engine?.wake().catch(() => undefined)

    return renderPane($.ui.resolve(e), e.surface, e.props.bodyColumns, model, expanded, {
      onRefresh: async () => {
        await (await engineOf($, settings, slot)).readNow({ manual: true })
      },
      onToggle: async (sectionId, isOpen) => {
        await update($, expandedAtom, folds => ({ ...folds, [sectionId]: isOpen }))
      },
      onAction: async actionId => {
        // The provider that owns the plan answers; its model replaces the drawn one.
        const running = await engineOf($, settings, slot)
        const before = await running.snapshot().catch(() => undefined)
        const acted = await runAction(await contextOf($, settings), actionId)
        if (acted === null) return
        // The engine adopts the provider's answer (a read still in flight drops its result), so the next poll does not re-publish it.
        const adopted = await running.seed(acted, before)
        await update($, modelAtom, () => adopted)
      },
      onFillNext: async command => {
        await $.prompt.fill({ text: command, mode: 'replace' })
      },
    },
    // M2 hook point data: the clock the header's "checked {ago}" reads.
    { now, checkedAt: slot.engine?.checkedAt() ?? 0 })
  })
}
