// The refresh engine through hooks/register.tsx, over the kit's mocked clock: the triggers a
// session raises, what the polls do, and how the pane follows.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

import { LIVE_INTENT, ROOT, liveState, sessions, tree } from '../fixtures/real-sample'
import { noGit } from '../fixtures/scenarios'
import { en } from '../src/strings/en'
import { padded } from './rich'
import { MOUNT, NOW, mutableCopy, serveSession, setFile } from './world'
import type { PaneRow } from './world'
import type { PanelModel } from '../types'

const INTENT = `${ROOT}/aidlc/spaces/default/intents/${LIVE_INTENT}`
const STATE = `${INTENT}/aidlc-state.md`
const HEAD = `${ROOT}/.git/HEAD`
const STAGE_HEAD = 'ref: refs/heads/dev/SHOP-7/refined-mockups\n'
const MAIN_HEAD = 'ref: refs/heads/main\n'

const RUN = {
  command: 'panel',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
}
const start = (surface: 'terminal' | 'desktop') => ({ cwd: ROOT, surface, isInteractive: true })
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

/** A plugin that closes the pane on `/close-it` (a plugin's close is the only one a test can raise). */
const closer: Plugin = {
  name: 'closer',
  register: on => {
    on('command.run', { command: 'close-it' }, async $ => {
      await $.ui.close({ id: 'panel' })
      return { text: 'closed' }
    })
  },
}

const BINDING = `${ROOT}/aidlc/.aidlc-sessions/${sessions.live}.binding.json`
/** How many times the plan was loaded: the session binding is read once per load (the state file twice). */
const stateReads = (calls: { reads: string[] }) => calls.reads.filter(path => path === BINDING).length
const modelOf = (calls: { state: Map<string, unknown> }) => calls.state.get('model') as PanelModel

/** A session on the real sample, time from the mock clock, a desktop pane open and placed. */
async function boot(
  $: Engine,
  on: On,
  surface: 'terminal' | 'desktop' = 'desktop',
) {
  const files = mutableCopy(tree)
  files.files[HEAD] = STAGE_HEAD
  const calls = serveSession(on, { tree: files, surfaces: [surface], mockClockAt: NOW })
  await $.session.start(start(surface))
  return { calls, files, clock: calls.clock! }
}

const write = ($: Engine, file_path: string) =>
  $.tool.call({ tool: 'Write', file_path, content: 'x' })

describe('triggers', () => {
  test('session start reads once; a quiet minute reads nothing more, only stats and git', async ($, on) => {
    const { calls, clock } = await boot($, on)
    expect(stateReads(calls)).toBe(1)
    expect(calls.panes.map(pane => pane.id)).toEqual(['panel'])

    const statsBefore = calls.stats.length
    await clock.advance(60_000)
    expect(stateReads(calls)).toBe(1)
    expect(calls.stats.length).toBeGreaterThan(statsBefore)
    expect(calls.runs.filter(run => run[1] === 'rev-parse').length).toBeGreaterThan(0)
    expect(calls.modelWrites).toHaveLength(1)
  })

  test('a Write or Edit under the plan re-reads once; elsewhere it does not; the result is untouched', async ($, on) => {
    const { calls, clock } = await boot($, on)

    const elsewhere = await write($, `${ROOT}/src/index.ts`)
    await clock.advance(600)
    expect(elsewhere.text).toBe('ok')
    expect(stateReads(calls)).toBe(1)

    const inside = await write($, STATE)
    await clock.advance(600)
    expect(inside.text).toBe('ok')
    expect(stateReads(calls)).toBe(2)

    await $.tool.call({ tool: 'Edit', file_path: `${INTENT}/new-doc.md`, old_string: 'a', new_string: 'b' })
    await clock.advance(600)
    expect(stateReads(calls)).toBe(3)
  })

  test('Bash: git, gh and aidlc re-read; look-alikes do not', async ($, on) => {
    const { calls, clock } = await boot($, on)
    const bash = async (command: string) => {
      await $.tool.call({ tool: 'Bash', command })
      await clock.advance(600)
      return stateReads(calls)
    }
    expect(await bash('echo legit')).toBe(1)
    expect(await bash('curl https://github.com/x')).toBe(1)
    expect(await bash('git checkout x')).toBe(2)
    expect(await bash('gh pr view 4')).toBe(3)
    expect(await bash('cd x && aidlc status')).toBe(4)
  })

  test('20 tool calls in one burst make exactly one re-read in the 500 ms window', async ($, on) => {
    const { calls, clock } = await boot($, on)
    for (let i = 0; i < 20; i++) {
      await write($, STATE)
      await clock.advance(10)
    }
    expect(stateReads(calls)).toBe(1)
    await clock.advance(400)
    expect(stateReads(calls)).toBe(2)
    await clock.advance(5_000)
    expect(stateReads(calls)).toBe(2)
  })

  test('the turn ending re-reads, and does not hold the turn', async ($, on) => {
    const { calls, clock } = await boot($, on)
    const done = await $.turn.complete(TURN)
    expect(done).toEqual({ text: '' })
    expect(stateReads(calls)).toBe(1)
    await clock.advance(600)
    expect(stateReads(calls)).toBe(2)
  })

  test('a changed mtime on the poll re-reads; unchanged mtimes do not', async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    await clock.advance(30_000)
    expect(stateReads(calls)).toBe(1)

    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
    await clock.advance(10_000)
    await clock.advance(600)
    expect(stateReads(calls)).toBe(2)
    expect(modelOf(calls).next?.reason).toBe('Execute Units Generation')
    await clock.advance(60_000)
    expect(stateReads(calls)).toBe(2)
  })

  test('a file added to the intent directory is seen by the poll', async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    files.files[`${INTENT}/inception/requirements.md`] = '# new\n'
    files.mtimes![INTENT] = 99
    await clock.advance(10_600)
    expect(stateReads(calls)).toBe(2)
  })

  test('a desktop attaching re-reads (and a surface that is not on screen does not wake anything)', async ($, on) => {
    const { calls, clock } = await boot($, on)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.advance(600)
    expect(stateReads(calls)).toBe(2)
  })
})

describe('hash-gated redraw', () => {
  test('an identical re-read writes nothing and keeps checkedAt', async ($, on) => {
    const { calls, clock } = await boot($, on)
    const first = modelOf(calls)
    await clock.advance(20_000)
    await write($, STATE)
    await clock.advance(600)
    expect(stateReads(calls)).toBe(2)
    expect(calls.modelWrites).toHaveLength(1)
    expect(modelOf(calls).freshness?.checkedAt).toBe(first.freshness?.checkedAt)
  })

  test('a changed model is written exactly once, stamped with the check', async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    await clock.advance(20_000)
    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
    await write($, STATE)
    await clock.advance(600)
    await clock.advance(30_000)
    expect(calls.modelWrites).toHaveLength(2)
    // Written when the debounce fired, 500 ms after the call.
    expect(modelOf(calls).freshness?.checkedAt).toBe(NOW + 20_500)
    expect(modelOf(calls).readAt).toBe(NOW + 20_500)
  })
})

describe('branch switch', () => {
  test('HEAD changing between polls re-reads; the binding, not the branch, decides the mode', async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    expect(modelOf(calls).header.mode).toBe('stage')
    const loads = stateReads(calls)

    files.files[HEAD] = MAIN_HEAD
    calls.control.sha = 'bbbbbbb'
    calls.control.branch = 'main'
    await clock.advance(10_600)
    expect(stateReads(calls)).toBeGreaterThan(loads)
    expect(modelOf(calls).header.mode).toBe('stage')

    // The session's binding empties (bound to nothing): a side job, on the same branch.
    setFile(files, BINDING, '')
    await clock.advance(10_600)
    expect(modelOf(calls).header.mode).toBe('side-job')

    files.files[HEAD] = STAGE_HEAD
    calls.control.sha = 'ccccccc'
    calls.control.branch = 'dev/SHOP-7/refined-mockups'
    await clock.advance(10_600)
    expect(modelOf(calls).header.mode).toBe('side-job')
  })

  test('a repo without git is normal: no re-read, no error', async ($, on) => {
    const { calls, clock } = await boot($, on)
    calls.control.isGitMissing = true
    await clock.advance(10_600)
    const reads = stateReads(calls)
    await clock.advance(60_000)
    expect(stateReads(calls)).toBe(reads)
    expect(modelOf(calls).freshness?.error).toBeUndefined()
  })
})

describe('stop and resume', () => {
  const holder = { panes: [] as PaneRow[] }
  const idle = async (calls: { stats: string[]; runs: string[][]; reads: string[] }, clock: { advance(ms: number): Promise<void> }) => {
    const before = [calls.stats.length, calls.runs.length, calls.reads.length]
    await clock.advance(120_000)
    return [calls.stats.length, calls.runs.length, calls.reads.length].map((n, i) => n - before[i]!)
  }

  test('closing the pane stops every timer; /panel resumes with a catch-up read', { plugins: [closer] }, async ($, on) => {
    // A close leaves the pane list (the kit's stand-in for the surface); hooks are registered before the first `$` call.
    on('ui.close', async (_$, e) => {
      const at = holder.panes.findIndex(pane => pane.id === e.id)
      if (at >= 0) holder.panes.splice(at, 1)
      return { value: undefined }
    })
    const { calls, files, clock } = await boot($, on)
    holder.panes = calls.panes
    await $.command.run({ ...RUN, command: 'close-it' })
    expect(calls.panes).toEqual([])
    expect(await idle(calls, clock)).toEqual([0, 0, 0])

    // Triggers while closed look, and find the pane gone.
    await write($, STATE)
    await $.turn.complete(TURN)
    expect(await idle(calls, clock)).toEqual([0, 0, 0])

    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
    const reads = stateReads(calls)
    const ran = await $.command.run(RUN)
    expect(ran.text).toBe(en['command.opened'])
    expect(stateReads(calls)).toBeGreaterThan(reads)
    expect(modelOf(calls).next?.reason).toBe('Execute Units Generation')

    // And the polls run again.
    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Contract Design'))
    await clock.advance(10_600)
    expect(modelOf(calls).next?.reason).toBe('Execute Contract Design')
  })

  test('closing the pane stops the timers at once, before the next tick would notice', { plugins: [closer] }, async ($, on) => {
    // The surface keeps listing the pane (a stale list): only the ui.close hook can stop the engine.
    on('ui.close', async () => ({ value: undefined }))
    const { calls, clock } = await boot($, on)
    await clock.advance(10_000)
    await $.command.run({ ...RUN, command: 'close-it' })
    expect(calls.panes).toHaveLength(1)
    expect(await idle(calls, clock)).toEqual([0, 0, 0])
  })

  test('a closed flag does not stop a placed pane (the person reopened it from the surface)', async ($, on) => {
    // The person's close is the surface's: what it leaves in state is seeded here, once the test says so.
    const person = { isClosed: false }
    on('state.get', async (_$, e, next) => {
      const held = await next(e)
      return person.isClosed && e.plugin === 'project-panel' && e.key === 'isClosed'
        ? { value: { value: true, version: held.value?.version ?? 0 } }
        : held
    })
    const { calls, clock } = await boot($, on)
    person.isClosed = true
    const [stats] = await idle(calls, clock)
    expect(stats).toBeGreaterThan(0)
  })

  test('a pane that is not placed stops the poll; drawing it resumes', async ($, on) => {
    const { calls, clock } = await boot($, on)
    const row = calls.panes[0] as PaneRow
    row.isPlaced = false
    await clock.advance(10_000)
    expect(await idle(calls, clock)).toEqual([0, 0, 0])

    row.isPlaced = true
    const ui = await $.ui.mount({ ...MOUNT, surface: 'desktop' })
    await clock.advance(600)
    const [stats] = await idle(calls, clock)
    expect(stats).toBeGreaterThan(0)
    await ui.unmount()
  })

  test('a pane that is no longer listed stops the poll', async ($, on) => {
    const { calls, clock } = await boot($, on)
    calls.panes.length = 0
    await clock.advance(10_000)
    expect(await idle(calls, clock)).toEqual([0, 0, 0])
  })

  test('on a terminal nothing polls until /panel opens the pane', async ($, on) => {
    const { calls, clock } = await boot($, on, 'terminal')
    const statsAtStart = calls.stats.length
    expect(calls.panes).toEqual([])
    await write($, STATE)
    await clock.advance(120_000)
    expect(stateReads(calls)).toBe(1)
    expect(calls.stats.length).toBe(statsAtStart)

    await $.command.run(RUN)
    const reads = stateReads(calls)
    await clock.advance(10_600)
    expect(calls.stats.length).toBeGreaterThan(statsAtStart)
    expect(stateReads(calls)).toBe(reads)
  })

  test('panel: off never polls', { options: { panel: 'off' } }, async ($, on) => {
    const { calls, clock } = await boot($, on)
    // The session-start read asks git where the repository is (AI-DLC reads two truths); nothing after it runs.
    const runsAtBoot = calls.runs.length
    await $.command.run(RUN)
    await write($, STATE)
    await $.turn.complete(TURN)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    const reads = stateReads(calls)
    const statsBefore = calls.stats.length
    await clock.advance(600_000)
    expect(stateReads(calls)).toBe(reads)
    expect(calls.stats.length).toBe(statsBefore)
    expect(calls.runs.length).toBe(runsAtBoot)
  })

  test('panel: off never polls even when a placed pane is listed', { options: { panel: 'off' } }, async ($, on) => {
    const { calls, clock } = await boot($, on)
    const runsAtBoot = calls.runs.length
    calls.panes.push({ id: 'panel', title: 'Project', isShown: true, isFocused: false, isPlaced: true })
    await $.turn.complete(TURN)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    const ui = await $.ui.mount({ ...MOUNT, surface: 'desktop' })
    const statsBefore = calls.stats.length
    const reads = stateReads(calls)
    await clock.advance(600_000)
    expect(calls.stats.length).toBe(statsBefore)
    expect(stateReads(calls)).toBe(reads)
    expect(calls.runs.length).toBe(runsAtBoot)
    await ui.unmount()
  })

  test('the poll intervals are options: fsPollSeconds 2, and 0 turns the poll off', { options: { fsPollSeconds: 2 } }, async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
    await clock.advance(3_000)
    expect(stateReads(calls)).toBe(2)
  })

  test('fsPollSeconds 0: no mtime poll', { options: { fsPollSeconds: 0 } }, async ($, on) => {
    const { calls, files, clock } = await boot($, on)
    setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
    await clock.advance(120_000)
    expect(stateReads(calls)).toBe(1)
  })
})

describe('desktop attaching after session start', () => {
  const attachDesktop = ($: Engine) =>
    $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  test('opens the pane once, and a second attach does not open it again', async ($, on) => {
    const { calls, clock } = await boot($, on, 'terminal')
    expect(calls.opened).toEqual([])

    await attachDesktop($)
    expect(calls.opened).toEqual(['panel'])
    await attachDesktop($)
    expect(calls.opened).toEqual(['panel'])

    // The engine woke: the pane is on screen, so the poll runs.
    const statsBefore = calls.stats.length
    await clock.advance(10_600)
    expect(calls.stats.length).toBeGreaterThan(statsBefore)
  })

  test('another surface attaching does not open it', async ($, on) => {
    const { calls } = await boot($, on, 'terminal')
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:1' })
    expect(calls.opened).toEqual([])
  })

  test('panel: command and panel: off do not open it', { options: { panel: 'command' } }, async ($, on) => {
    const { calls } = await boot($, on, 'terminal')
    await attachDesktop($)
    expect(calls.opened).toEqual([])
  })

  test('panel: off does not open it', { options: { panel: 'off' } }, async ($, on) => {
    const { calls } = await boot($, on, 'terminal')
    await attachDesktop($)
    expect(calls.opened).toEqual([])
  })

  test('a pane the person closed is not reopened', async ($, on) => {
    on('state.get', async (_$, e, next) => {
      const held = await next(e)
      return e.plugin === 'project-panel' && e.key === 'isClosed' && held.value?.value === undefined
        ? { value: { value: true, version: held.value?.version ?? 0 } }
        : held
    })
    const { calls } = await boot($, on, 'terminal')
    await attachDesktop($)
    expect(calls.opened).toEqual([])
  })

  test('without a plan nothing opens', async ($, on) => {
    const calls = serveSession(on, { tree: noGit, root: '/work/plain', surfaces: ['terminal'], mockClockAt: NOW })
    await $.session.start(start('terminal'))
    await attachDesktop($)
    expect(calls.opened).toEqual([])
  })

  test('a refused open never breaks the attach', async ($, on) => {
    const { calls } = await boot($, on, 'terminal')
    calls.control.isOpenFailing = true
    await expect(attachDesktop($)).resolves.toEqual({ clientId: 'desktop:default' })
    expect(calls.opened).toEqual([])
  })
})

/** The terminal's heading carries the count in its text; the desktop's is the words with the count as a pill after them. */
async function attentionCount(ui: { find: (query: { type: string; text: string }) => Promise<unknown> }, surface: 'terminal' | 'desktop', count: number): Promise<boolean> {
  if (surface === 'terminal') return (await ui.find({ type: 'Text', text: `Needs attention (${count})` })) !== undefined
  const heading = await ui.find({ type: 'Text', text: 'Needs attention' })
  const pill = await ui.find({ type: 'Text', text: padded(String(count)) })
  return heading !== undefined && pill !== undefined
}

describe('the pane follows', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`header shows "checked ..." on ${surface}`, async ($, on) => {
      const { calls, clock } = await boot($, on, surface)
      const ui = await $.ui.mount({ ...MOUNT, surface })
      expect(await ui.find({ type: 'Text', text: 'checked just now' })).toBeDefined()
      await ui.unmount()
      expect(calls.modelWrites).toHaveLength(1)
      await clock.advance(1)
    })

    test(`a poll-driven change redraws the mounted pane on ${surface}`, async ($, on) => {
      const { files, clock } = await boot($, on, surface)
      await $.command.run(RUN)
      const ui = await $.ui.mount({ ...MOUNT, surface })
      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()

      await clock.advance(40_000)
      setFile(files, STATE, liveState.replace('Execute Domain Design', 'Execute Units Generation'))
      await clock.advance(10_600)

      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Execute Units Generation' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'checked just now' })).toBeDefined()
      await ui.unmount()
    })

    test(`a failing read keeps the pane and adds one Attention line on ${surface}; the next success clears it`, async ($, on) => {
      // The redesign draws a read failure twice: a line under the header and the first Needs attention row.
      const { calls } = await boot($, on, surface)
      const ui = await $.ui.mount({ ...MOUNT, surface })
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(0)

      calls.control.isDiskFailing = true
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(2)
      // The heading counts it: the parked gate and the failure.
      expect(await attentionCount(ui, surface, 2)).toBe(true)

      await ui.press({ key: 'refresh' })
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(2)
      expect(calls.modelWrites).toHaveLength(2)

      calls.control.isDiskFailing = false
      await ui.press({ key: 'refresh' })
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(0)
      expect(await attentionCount(ui, surface, 1)).toBe(true)
      await ui.unmount()
    })

    test(`a failing disk (fs.* only) keeps the last model and adds one Attention line on ${surface}; the next success clears it`, async ($, on) => {
      const { calls, clock } = await boot($, on, surface)
      const ui = await $.ui.mount({ ...MOUNT, surface })
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(0)

      calls.control.isFsFailing = true
      await ui.press({ key: 'refresh' })
      // The model is kept, not replaced by "No plan found".
      expect(modelOf(calls)).not.toBeNull()
      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(2)
      expect(await ui.find({ type: 'Text', text: en['pane.empty'] })).toBeUndefined()
      expect(modelOf(calls).freshness?.error).toBe(en['refresh.failed'])

      // The poll keeps trying (the mtimes read as missing) without piling up lines.
      await clock.advance(30_000)
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(2)

      calls.control.isFsFailing = false
      await ui.press({ key: 'refresh' })
      expect(await ui.findAll({ type: 'Text', text: en['refresh.failed'] })).toHaveLength(0)
      expect(modelOf(calls).freshness?.error).toBeUndefined()
      await ui.unmount()
    })

    test(`a quiet poll keeps "checked ..." recent without a model write on ${surface}`, async ($, on) => {
      const { calls, clock } = await boot($, on, surface)
      await $.command.run(RUN) // on a terminal the pane waits for /panel; polls run while it is open
      const ui = await $.ui.mount({ ...MOUNT, surface })
      await clock.advance(35_000)
      // A redraw for another reason (a fold) draws the stamp from the engine's last check, ~5 s old.
      await ui.press({ key: 'section:CONSTRUCTION' })
      const stamp = await ui.find({ type: 'Text', text: /^checked / })
      expect(stamp?.text).toMatch(/^checked (just now|[1-9]s ago)$/)
      expect(calls.modelWrites).toHaveLength(1)
      await ui.unmount()
    })

    test(`Refresh redraws "checked ..." even when nothing changed on ${surface}`, async ($, on) => {
      const { calls, clock } = await boot($, on, surface)
      const ui = await $.ui.mount({ ...MOUNT, surface })
      await clock.advance(125_000)
      await ui.press({ key: 'refresh' })
      expect(calls.modelWrites).toHaveLength(1)
      expect(await ui.find({ type: 'Text', text: 'checked just now' })).toBeDefined()
      await ui.unmount()
    })
  }
})
