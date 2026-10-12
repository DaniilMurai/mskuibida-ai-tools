import { describe, expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { ROOT, liveState, tree } from '../fixtures/real-sample'
import { noGit } from '../fixtures/scenarios'
import { en } from '../src/strings/en'
import { MOUNT, seedModel, serveSession, stageModel } from './world'

const RUN = {
  command: 'panel',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
}
/**
 * An inline plugin that closes the pane on `/close-it`: the test engine cannot raise
 * `ui.close` itself, and a person's close is the surface's (the engine stamps the
 * origin and refuses a rewrite), so only a plugin's close can be driven here.
 * (Hooks are read by source: no captured variables.)
 */
const closer: Plugin = {
  name: 'closer',
  register: on => {
    on('command.run', { command: 'close-it' }, async $ => {
      await $.ui.close({ id: 'panel' })
      return { text: 'closed' }
    })
  },
}
const start = (surface: 'terminal' | 'desktop') => ({ cwd: ROOT, surface, isInteractive: true })

describe('session start', () => {
  test('without a plan the mod stays silent: no command, no pane', async ($, on) => {
    const calls = serveSession(on, { tree: noGit, root: '/work/plain', surfaces: ['desktop'] })
    await $.session.start(start('desktop'))

    expect(calls.commands).toEqual([])
    expect(calls.opened).toEqual([])
    expect(calls.state.get('model') ?? null).toBeNull()
  })

  test('with a plan on desktop, /panel is registered and the pane opens by itself', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))

    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual(['panel'])
    expect(calls.state.get('model')).toMatchObject({ provider: 'aidlc', version: 2 })
  })

  test('on a terminal the command is registered but the pane is not opened unasked', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['terminal'] })
    await $.session.start(start('terminal'))

    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual([])
  })

  test('a desktop attached beside the terminal counts', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['terminal', 'desktop'] })
    await $.session.start(start('terminal'))

    expect(calls.opened).toEqual(['panel'])
  })

  test('panel: command - the desktop pane waits for /panel', { options: { panel: 'command' } }, async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))

    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual([])
    const ran = await $.command.run(RUN)
    expect(ran.text).toBe(en['command.opened'])
    expect(calls.opened).toEqual(['panel'])
  })

  test('panel: off - the command registers, nothing opens, /panel says why', { options: { panel: 'off' } }, async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    const ran = await $.command.run(RUN)

    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual([])
    expect(ran.text).toBe(en['command.disabled'])
  })

  test('an unknown panel value behaves as auto', { options: { panel: 'sometimes' } }, async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    expect(calls.opened).toEqual(['panel'])
  })

  test('once the person has closed the pane, auto does not reopen it; /panel does and clears it', async ($, on) => {
    // The person's close is the surface's; what it leaves in state is seeded here.
    on('state.get', async (_$, e, next) => {
      const held = await next(e)
      const isUnwritten = held.value?.value === undefined
      return e.plugin === 'project-panel' && e.key === 'isClosed' && isUnwritten
        ? { value: { value: true, version: held.value?.version ?? 0 } }
        : held
    })
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual([])

    const ran = await $.command.run(RUN)
    expect(ran.text).toBe(en['command.opened'])
    expect(calls.opened).toEqual(['panel'])
    expect(calls.state.get('isClosed')).toBe(false)

    await $.session.start(start('desktop'))
    expect(calls.opened).toEqual(['panel', 'panel'])
  })

  test('a plugin closing the pane is not the person closing it', { plugins: [closer] }, async ($, on) => {
    on('ui.close', async () => ({ value: undefined }))
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    await $.command.run({ ...RUN, command: 'close-it' })
    expect(calls.state.get('isClosed') ?? false).toBe(false)
    await $.session.start(start('desktop'))
    expect(calls.opened).toEqual(['panel', 'panel'])
  })

  test('an unreadable plan never breaks session start: nothing registered, nothing opened, no model', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    // The first start left a model, a command and a pane behind.
    expect(calls.state.get('model')).not.toBeNull()
    expect([calls.commands.length, calls.opened.length]).toEqual([1, 1])

    calls.control.isDiskFailing = true
    const started = await $.session.start(start('desktop'))

    expect(started).toEqual({ cwd: ROOT })
    // Without the guard the rejection escapes (the call rejects) and the old model would remain.
    expect(calls.state.get('model')).toBeNull()
    expect([calls.commands.length, calls.opened.length]).toEqual([1, 1])
  })

  test('a refused command registration does not stop the pane or session start', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    calls.control.isRegisterFailing = true
    const started = await $.session.start(start('desktop'))

    expect(started).toEqual({ cwd: ROOT })
    expect(calls.commands).toEqual([])
    expect(calls.opened).toEqual(['panel'])
  })

  test('a refused pane open does not break session start', async ($, on) => {
    const calls = serveSession(on, { surfaces: ['desktop'] })
    calls.control.isOpenFailing = true
    const started = await $.session.start(start('desktop'))

    expect(started).toEqual({ cwd: ROOT })
    expect(calls.commands).toEqual(['panel'])
    expect(calls.opened).toEqual([])
  })
})

describe('the reopen bar', () => {
  const BAR = {
    plugin: 'project-panel',
    component: 'AbovePrompt' as const,
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  }
  /** The engine's own band (nothing) beneath the plugin, for when the bar yields with `next(e)`. */
  const noBand = (on: Parameters<typeof serveSession>[0]) =>
    on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', props: {}, children: [] }) as never)
  /** What the surface leaves in state when the person closes the pane (its close is the surface's, not a test's). */
  const closedByPerson = (on: Parameters<typeof serveSession>[0]) =>
    on('state.get', async (_$, e, next) => {
      const held = await next(e)
      const isUnwritten = held.value?.value === undefined
      return e.plugin === 'project-panel' && e.key === 'isClosed' && isUnwritten
        ? { value: { value: true, version: held.value?.version ?? 0 } }
        : held
    })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a closed pane shows the bar on ${surface}; its button reopens the pane and the bar goes`, async ($, on) => {
      closedByPerson(on)
      noBand(on)
      const calls = serveSession(on, { surfaces: [surface] })
      await $.session.start(start(surface))
      expect(calls.opened).toEqual([])

      const ui = await $.ui.mount({ ...BAR, surface })
      expect(await ui.find({ type: 'Text', text: en['reopen.hint'] })).toBeDefined()
      await ui.press({ key: 'reopen' })

      expect(calls.opened).toEqual(['panel'])
      expect(calls.state.get('isClosed')).toBe(false)
      expect(await ui.find({ key: 'reopen' })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('no bar while the pane has not been closed', async ($, on) => {
    noBand(on)
    const calls = serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))
    expect(calls.opened).toEqual(['panel'])

    const ui = await $.ui.mount({ ...BAR, surface: 'desktop' })
    expect(await ui.find({ key: 'reopen' })).toBeUndefined()
    await ui.unmount()
  })

  test('no bar when panel is off', { options: { panel: 'off' } }, async ($, on) => {
    closedByPerson(on)
    noBand(on)
    serveSession(on, { surfaces: ['desktop'] })
    await $.session.start(start('desktop'))

    const ui = await $.ui.mount({ ...BAR, surface: 'desktop' })
    expect(await ui.find({ key: 'reopen' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('/panel', () => {
  test('opens the pane and says so', async ($, on) => {
    const calls = serveSession(on)
    await $.session.start(start('terminal'))
    const ran = await $.command.run(RUN)

    expect(calls.opened).toEqual(['panel'])
    expect(ran.text).toBe('Project panel opened.')
  })

  test('says so when the pane waits for room', async ($, on) => {
    serveSession(on, { isPlaced: false })
    await $.session.start(start('terminal'))
    const ran = await $.command.run(RUN)

    expect(ran.text).toBe(en['command.notPlaced'])
  })

  test('without a plan it names the root it looked above', async ($, on) => {
    const calls = serveSession(on, { tree: noGit, root: '/work/plain' })
    await $.session.start(start('terminal'))
    const ran = await $.command.run(RUN)

    expect(calls.commands).toEqual([])
    expect(calls.opened).toEqual([])
    expect(ran.text).toBe('No plan found above /work/plain.')
  })

  test('a failed re-read does not claim "opened": it says so and keeps the old model', async ($, on) => {
    const calls = serveSession(on)
    await $.session.start(start('terminal'))
    const before = calls.state.get('model')
    expect(before).not.toBeNull()

    calls.control.isDiskFailing = true
    const ran = await $.command.run(RUN)

    expect(ran.text).toBe(en['command.readFailed'])
    expect(calls.opened).toEqual([])
    // The last good model stays; it now carries the error line.
    expect(calls.state.get('model')).toEqual({
      ...(before as object),
      freshness: { ...(before as { freshness: object }).freshness, error: en['refresh.failed'] },
    })
  })

  test('a pane that cannot open says so', async ($, on) => {
    const calls = serveSession(on)
    await $.session.start(start('terminal'))
    calls.control.isOpenFailing = true
    const ran = await $.command.run(RUN)

    expect(ran.text).toBe(en['command.openFailed'])
  })
})

describe('the pane over a real session', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reads the plan at session start and draws it on ${surface}`, async ($, on) => {
      serveSession(on)
      await $.session.start(start(surface))
      const ui = await $.ui.mount({ ...MOUNT, surface })

      expect((await ui.findAll({ type: 'Text', text: 'SHOP-MVP-RESTART' })).length).toBeGreaterThan(0)
      expect(await ui.find({ type: 'Text', text: 'Parked at domain-design' })).toBeDefined()
      expect(await ui.find({ key: 'section:INCEPTION' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()
      await ui.unmount()
    })

    test(`refresh re-reads the plan on ${surface}`, async ($, on) => {
      const files = { ...tree.files }
      serveSession(on, { tree: { files, mtimes: tree.mtimes } })
      await $.session.start(start(surface))
      const ui = await $.ui.mount({ ...MOUNT, surface })
      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()

      const statePath = Object.keys(files).find(path => path.endsWith('260806-shop-mvp-restart/aidlc-state.md'))!
      files[statePath] = liveState.replace('Execute Domain Design', 'Execute Units Generation')
      await ui.press({ key: 'refresh' })

      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Execute Units Generation' })).toBeDefined()
      await ui.unmount()
    })

    test(`a failing refresh keeps what is drawn on ${surface}`, async ($, on) => {
      const calls = serveSession(on)
      await $.session.start(start(surface))
      const ui = await $.ui.mount({ ...MOUNT, surface })

      calls.control.isDiskFailing = true
      await ui.press({ key: 'refresh' })

      expect(await ui.find({ type: 'Text', text: 'Execute Domain Design' })).toBeDefined()
      await ui.unmount()
    })

    test(`"put in prompt" fills the prompt with the next command on ${surface}`, async ($, on) => {
      const calls = serveSession(on)
      await $.session.start(start(surface))
      const ui = await $.ui.mount({ ...MOUNT, surface })

      await ui.press({ key: 'next:fill' })

      expect(calls.filled).toEqual(['replace:/aidlc'])
      await ui.unmount()
    })
  }

  test('an action button no provider answers changes nothing and does not throw', async ($, on) => {
    // AI-DLC declares no actions, so a stray one is answered by nobody: the model stays.
    seedModel(on, stageModel({ actions: [{ id: 'sync', label: 'Sync' }] }), { hasClock: false })
    serveSession(on)
    const ui = await $.ui.mount({ ...MOUNT, surface: 'terminal' })

    await ui.press({ key: 'action:sync' })

    expect((await ui.find({ type: 'Button', key: 'action:sync' }))?.text).toBe('Sync')
    await ui.unmount()
  })
})
