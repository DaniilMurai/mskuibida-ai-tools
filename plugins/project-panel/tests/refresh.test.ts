// The refresh engine over fake ports and a fake clock: fast and exact. The hooks that wire it to
// `$` are exercised in refresh.integration.test.ts.
import { describe, expect, test } from 'claude-code/testing'

import { en } from '../src/strings/en'
import {
  commandWordsOf,
  createRefreshEngine,
  hashText,
  isRelevantToolCall,
  modelHash,
  normalizePath,
  stableStringify,
} from '../src/refresh'
import type { RefreshConfig, RefreshEngine, RefreshPorts, Timer } from '../src/refresh'
import { agoText, checkedText } from '../src/freshness'
import { fingerprintOf } from '../src/model'
import type { PanelModel, Provider } from '../types'
import { ctxOf, stageModel } from './world'
import { tree } from '../fixtures/real-sample'

const ROOT = '/work/shop'
const STATE = `${ROOT}/aidlc/state.md`
const DIR = `${ROOT}/aidlc`

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

/** A clock that moves only when told and fires due timers in order. */
function fakeClock(start = 1_000_000) {
  type Entry = { at: number; fn: () => void; period?: number; isCancelled: boolean }
  const entries: Entry[] = []
  const clock = {
    time: start,
    after(ms: number, fn: () => void): Timer {
      const entry: Entry = { at: clock.time + ms, fn, isCancelled: false }
      entries.push(entry)
      return { cancel: () => void (entry.isCancelled = true) }
    },
    every(ms: number, fn: () => void): Timer {
      const entry: Entry = { at: clock.time + ms, fn, period: ms, isCancelled: false }
      entries.push(entry)
      return { cancel: () => void (entry.isCancelled = true) }
    },
    /** Live timers: what is still waiting. */
    pending: () => entries.filter(entry => !entry.isCancelled && (entry.period !== undefined || entry.at >= clock.time)).length,
    async advance(ms: number) {
      const target = clock.time + ms
      for (;;) {
        const due = entries
          .filter(entry => !entry.isCancelled && entry.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        clock.time = due.at
        if (due.period !== undefined) due.at += due.period
        else due.isCancelled = true
        due.fn()
        await flush()
      }
      clock.time = target
      await flush()
    },
  }
  return clock
}

type World = ReturnType<typeof makeWorld>

function makeWorld(overrides: { model?: PanelModel | null } = {}) {
  const clock = fakeClock()
  const world = {
    clock,
    /** What `load` answers; null = no plan. */
    model: (overrides.model === undefined ? stageModel({ watch: [STATE, DIR] }) : overrides.model) as PanelModel | null,
    loadError: false,
    /** A gate a test holds to keep a load in flight. */
    gate: null as null | Promise<void>,
    loads: 0,
    fingerprint: null as string | null,
    fingerprintError: false,
    /** The fingerprint never answers, as a hung gh. */
    fingerprintHang: false,
    fingerprints: 0,
    everyThrows: false,
    /** Held to keep `isVisible` pending. */
    visibleGate: null as null | Promise<void>,
    mtimes: { [STATE]: 10, [DIR]: 5 } as Record<string, number | null>,
    stats: 0,
    sha: 'aaa',
    branch: 'main',
    isGitMissing: false,
    runs: [] as (readonly string[])[],
    runCwds: [] as (string | undefined)[],
    isVisible: true,
    visibleChecks: 0,
    published: [] as (PanelModel | null)[],
    invalidations: 0,
  }
  const ports: RefreshPorts = {
    now: async () => clock.time,
    after: (ms, fn) => clock.after(ms, fn),
    every: (ms, fn) => {
      if (world.everyThrows) throw new Error('no timers')
      return clock.every(ms, fn)
    },
    load: async () => {
      world.loads++
      if (world.gate) await world.gate
      if (world.loadError) throw new Error('disk gone')
      return world.model === null ? null : { ...world.model, readAt: clock.time }
    },
    fingerprint: async () => {
      world.fingerprints++
      if (world.fingerprintHang) return new Promise<string | null>(() => undefined)
      if (world.fingerprintError) throw new Error('offline')
      return world.fingerprint
    },
    mtime: async path => {
      world.stats++
      return world.mtimes[path] ?? null
    },
    run: async (argv, init) => {
      world.runs.push(argv)
      world.runCwds.push(init?.cwd)
      if (world.isGitMissing) return { exitCode: 128, stdout: '' }
      if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: world.sha + '\n' }
      return { exitCode: 0, stdout: world.branch + '\n' }
    },
    publish: async model => void world.published.push(model),
    invalidate: async () => void world.invalidations++,
    isVisible: async () => {
      world.visibleChecks++
      if (world.visibleGate) await world.visibleGate
      return world.isVisible
    },
  }
  return { world, ports }
}

const CONFIG: RefreshConfig = { startDir: ROOT, isEnabled: true, fsPollSeconds: 10, prPollSeconds: 180 }

/** A world with a seeded, running engine (the shape a session start leaves). */
async function running(
  overrides: { model?: PanelModel | null; fingerprint?: string | null } = {},
  config: Partial<RefreshConfig> = {},
) {
  const { world, ports } = makeWorld(overrides)
  if (overrides.fingerprint !== undefined) world.fingerprint = overrides.fingerprint
  const engine = createRefreshEngine(ports, { ...CONFIG, ...config })
  const first = world.model === null ? null : { ...world.model, readAt: world.clock.time }
  await engine.seed(first)
  await engine.start()
  // The first remote check runs on the next turn of the clock.
  await world.clock.advance(0)
  // Session start's own work is not under test.
  world.loads = 0
  world.stats = 0
  world.runs.length = 0
  world.fingerprints = 0
  world.published.length = 0
  return { world, engine }
}

const changed = (model: PanelModel | null): PanelModel | null =>
  model === null ? null : { ...model, next: { command: '/aidlc', reason: 'Execute Units Generation' } }

describe('hashing', () => {
  test('equal values hash equal whatever the key order, and the hash ignores readAt and freshness', () => {
    const model = stageModel()
    const shuffled = JSON.parse(JSON.stringify(model)) as PanelModel
    const { updatedAt, ...restHeader } = shuffled.header
    shuffled.header = { updatedAt, ...restHeader }
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}')
    expect(modelHash({ ...model, readAt: 1, freshness: { checkedAt: 5, error: 'x' } })).toBe(modelHash({ ...shuffled, readAt: 2 }))
  })

  test('any other field changes the hash', () => {
    const model = stageModel()
    expect(modelHash({ ...model, watch: ['/x'] })).not.toBe(modelHash(model))
    expect(modelHash({ ...model, next: undefined })).not.toBe(modelHash(model))
    expect(hashText('a')).not.toBe(hashText('b'))
    expect(hashText('a')).toBe(hashText('a'))
  })
})

describe('tool-call classification', () => {
  const watch = [STATE, DIR + '/intent-a']
  const relevant = (tool: string, input: Record<string, unknown>) => isRelevantToolCall(tool, input, watch, ROOT)

  test('a Write, Edit, MultiEdit or NotebookEdit of a watched file counts; elsewhere it does not', () => {
    expect(relevant('Write', { file_path: STATE })).toBe(true)
    expect(relevant('Edit', { file_path: STATE })).toBe(true)
    expect(relevant('MultiEdit', { file_path: STATE })).toBe(true)
    expect(relevant('NotebookEdit', { notebook_path: DIR + '/intent-a/n.ipynb' })).toBe(true)
    expect(relevant('Write', { file_path: ROOT + '/src/index.ts' })).toBe(false)
    expect(relevant('Read', { file_path: STATE })).toBe(false)
    expect(relevant('Write', {})).toBe(false)
    expect(relevant('Write', { file_path: '' })).toBe(false)
  })

  test('a path under a watched directory counts, on a / boundary only', () => {
    expect(relevant('Write', { file_path: DIR + '/intent-a/deep/er/file.md' })).toBe(true)
    expect(relevant('Write', { file_path: DIR + '/intent-a' })).toBe(true)
    expect(relevant('Write', { file_path: DIR + '/intent-ab/file.md' })).toBe(false)
  })

  test('relative and unclean paths resolve against the session root', () => {
    expect(relevant('Write', { file_path: 'aidlc/state.md' })).toBe(true)
    expect(relevant('Write', { file_path: './aidlc//intent-a/../intent-a/x.md' })).toBe(true)
    expect(relevant('Write', { file_path: '../shop/aidlc/state.md' })).toBe(true)
    expect(relevant('Write', { file_path: '../elsewhere/aidlc/state.md' })).toBe(false)
    expect(normalizePath('a/../../b', '/x/y')).toBe('/x/b')
  })

  test('Bash counts when it runs aidlc, git, gh or glab as a command word', () => {
    for (const command of [
      'git checkout x',
      'gh pr view 12',
      'glab mr view 275',
      'cd repo && glab mr list --all',
      'aidlc status',
      'cd repo && git pull',
      'npm test; gh pr list',
      'make || git stash',
      'cat f | git apply',
      'FOO=1 BAR=2 git fetch',
      '(cd x && git log)',
      'echo $(git rev-parse HEAD)',
      '/usr/bin/git status',
      './aidlc run',
      'env GIT_DIR=x git log',
      'sudo -n git gc',
      'bash -c "cd a && git status"',
      'echo hi\ngit status',
      'if git diff --quiet; then echo ok; fi',
      'npm run build & git status',
    ]) {
      expect([command, relevant('Bash', { command })]).toEqual([command, true])
    }
  })

  test('Bash does not count for look-alikes, arguments, quotes and comments', () => {
    for (const command of [
      'echo legit',
      'echo digit',
      'curl https://github.com/x/y',
      'echo "a && git b"',
      "echo 'git status'",
      'ls gh',
      'cat aidlc.md',
      'npm install github',
      'echo hi # git status',
      'gitk',
      'ghc Main.hs',
      'FOO=git echo x',
      'grep -r git .',
      '',
    ]) {
      expect([command, relevant('Bash', { command })]).toEqual([command, false])
    }
    expect(relevant('Bash', {})).toBe(false)
    expect(relevant('Bash', { command: 3 })).toBe(false)
  })

  test('wrappers and runners do not hide the command', () => {
    for (const command of [
      'npx aidlc status',
      'npx --yes aidlc',
      'npx -p some-pkg gh pr list',
      'bunx git status',
      'pnpm exec git status',
      'pnpm dlx aidlc',
      'npm exec -- git log',
      'npm run git',
      'npm run aidlc -- next',
      'yarn aidlc',
      'yarn exec gh pr view',
      'bun x aidlc',
      'timeout 30 git fetch',
      'timeout -k 5 30 gh api x',
      'xargs git add',
      'xargs -n 1 git add',
      'xargs -I {} gh pr view {}',
      'stdbuf -oL git log',
      'nice git gc',
      'nice -n 5 git gc',
      'sudo -u bob git status',
      'sudo -n -E gh auth status',
      'env -u HOME git status',
      'env FOO=1 git status',
      'time git status',
      'nohup aidlc run',
      'bash -lc "git status"',
      "zsh -c 'cd x && gh pr list'",
      'sh -ec "aidlc next"',
      'echo "head is $(git rev-parse HEAD)"',
      'echo "x `gh pr list` y"',
      'echo "$(echo $(git status))"',
    ]) {
      expect([command, relevant('Bash', { command })]).toEqual([command, true])
    }
    for (const command of [
      'npm install git',
      'npm run build',
      'npx prettier --write .',
      'pnpm exec eslint .',
      'timeout 30 sleep 1',
      'xargs rm',
      'sudo -u bob ls',
      'env FOO=1 node x.js',
      'bash -lc "ls"',
      'bash script.sh git',
      'echo "$(echo hi)"',
      'echo "git status"',
      'yarn install',
    ]) {
      expect([command, relevant('Bash', { command })]).toEqual([command, false])
    }
  })

  test('commandWordsOf lists each simple command once', () => {
    expect(commandWordsOf('cd x && FOO=1 git pull | tee out; echo $(gh api)')).toEqual(['cd', 'git', 'tee', 'echo', 'gh'])
  })
})

describe('the clock text', () => {
  test('just now, seconds, minutes, hours', () => {
    expect(agoText(1000, 1000)).toBe('just now')
    expect(agoText(5000, 1000)).toBe('just now')
    expect(agoText(1000 + 12_000, 1000)).toBe('12s ago')
    expect(agoText(1000 + 3 * 60_000 + 5000, 1000)).toBe('3m ago')
    expect(agoText(1000 + 2 * 3_600_000, 1000)).toBe('2h ago')
    expect(agoText(0, 5000)).toBe('just now')
    expect(agoText(NaN, 0)).toBe('')
  })

  test('the stamp reads the freshest of the engine, the model check and the read', () => {
    const model = stageModel({ readAt: 100_000, freshness: { checkedAt: 110_000 } })
    expect(checkedText(model, { now: 130_000 })).toBe('checked 20s ago')
    expect(checkedText(model, { now: 130_000, checkedAt: 126_000 })).toBe('checked just now')
    expect(checkedText({ ...model, freshness: undefined }, { now: 130_000 })).toBe('checked 30s ago')
  })
})

describe('debounce and single flight', () => {
  test('20 requests in a burst make exactly one load, 500 ms after the first', async () => {
    const { world, engine } = await running()
    for (let i = 0; i < 20; i++) {
      engine.request('tool')
      await world.clock.advance(10)
    }
    // 200 ms in: nothing yet.
    expect(world.loads).toBe(0)
    await world.clock.advance(299)
    expect(world.loads).toBe(0)
    await world.clock.advance(1)
    expect(world.loads).toBe(1)
    await world.clock.advance(5000)
    expect(world.loads).toBe(1)
  })

  test('a request is never pushed out by later ones (no starvation)', async () => {
    const { world, engine } = await running()
    for (let i = 0; i < 100; i++) {
      engine.request('tool')
      await world.clock.advance(50)
    }
    // 5 s of constant requests: a read every 500 ms, not none.
    expect(world.loads).toBeGreaterThanOrEqual(9)
  })

  test('a burst during an in-flight load makes exactly one follow-up', async () => {
    const { world, engine } = await running()
    let release!: () => void
    world.gate = new Promise<void>(resolve => (release = resolve))
    engine.request('tool')
    await world.clock.advance(500)
    expect(world.loads).toBe(1) // in flight, blocked
    for (let i = 0; i < 20; i++) engine.request('tool')
    await world.clock.advance(500) // the debounce fires while the load is still running
    expect(world.loads).toBe(1)
    release()
    world.gate = null
    await flush()
    expect(world.loads).toBe(2)
    await world.clock.advance(10_000)
    expect(world.loads).toBe(2)
  })

  test('readNow is immediate, takes the pending debounce with it, and queues behind a running read', async () => {
    const { world, engine } = await running()
    engine.request('tool')
    const outcome = await engine.readNow()
    expect(outcome.ok).toBe(true)
    expect(world.loads).toBe(1)
    await world.clock.advance(5000)
    expect(world.loads).toBe(1)

    let release!: () => void
    world.gate = new Promise<void>(resolve => (release = resolve))
    const first = engine.readNow()
    const second = engine.readNow()
    await flush()
    expect(world.loads).toBe(2)
    release()
    world.gate = null
    await Promise.all([first, second])
    expect(world.loads).toBe(3) // the one follow-up, not two
  })

  test('only a manual readNow redraws on its own', async () => {
    const { world, engine } = await running()
    await engine.readNow()
    expect(world.invalidations).toBe(0)
    await engine.readNow({ manual: true })
    expect(world.invalidations).toBe(1)
  })
})

describe('hash-gated publish', () => {
  test('an identical re-read writes nothing, but the check is still stamped', async () => {
    const { world, engine } = await running()
    const before = engine.checkedAt()
    await world.clock.advance(7000)
    await engine.readNow()
    expect(world.loads).toBe(1)
    expect(world.published).toEqual([])
    expect(engine.checkedAt()).toBe(before + 7000)
  })

  test('a changed model is written once, with the check time', async () => {
    const { world, engine } = await running()
    world.model = changed(world.model)
    await world.clock.advance(3000)
    await engine.readNow()
    expect(world.published).toHaveLength(1)
    const written = world.published[0]!
    expect(written.next?.reason).toBe('Execute Units Generation')
    expect(written.freshness).toEqual({ checkedAt: world.clock.time })
    await engine.readNow()
    expect(world.published).toHaveLength(1)
  })

  test('the plan going away is written as null, once', async () => {
    const { world, engine } = await running()
    world.model = null
    await engine.readNow()
    await engine.readNow()
    expect(world.published).toEqual([null])
  })

  test('seed: the first poll does not re-publish the model session start read', async () => {
    const { world, ports } = makeWorld()
    const engine = createRefreshEngine(ports, CONFIG)
    const stamped = await engine.seed({ ...world.model!, readAt: 7 })
    expect(stamped?.freshness).toEqual({ checkedAt: world.clock.time })
    await engine.start()
    await engine.readNow()
    expect(world.published).toEqual([])
  })
})

describe('the file poll', () => {
  test('unchanged mtimes cost stats and git, never a load', async () => {
    const { world } = await running()
    await world.clock.advance(60_000)
    expect(world.loads).toBe(0)
    expect(world.stats).toBe(6 * 2)
    expect(world.runs.length).toBe(6 * 2)
    expect(world.runCwds.every(cwd => cwd === ROOT)).toBe(true)
  })

  test('a changed mtime re-reads within the next tick plus the debounce', async () => {
    const { world } = await running()
    world.mtimes[STATE] = 11
    await world.clock.advance(10_000)
    expect(world.loads).toBe(0)
    await world.clock.advance(500)
    expect(world.loads).toBe(1)
    // The baseline moved: no read loop.
    await world.clock.advance(30_000)
    expect(world.loads).toBe(1)
  })

  test('a watched path that appears or disappears is a change', async () => {
    const { world } = await running()
    world.mtimes[DIR] = null
    await world.clock.advance(10_500)
    expect(world.loads).toBe(1)
    world.mtimes[DIR] = 9
    await world.clock.advance(10_500)
    expect(world.loads).toBe(2)
  })

  test('a changed watch list is baselined after the read', async () => {
    const { world, engine } = await running()
    world.model = { ...world.model!, watch: [STATE, DIR, `${DIR}/new`] }
    world.mtimes[`${DIR}/new`] = 3
    await engine.readNow()
    world.loads = 0
    await world.clock.advance(30_000)
    expect(world.loads).toBe(0)
    world.mtimes[`${DIR}/new`] = 4
    await world.clock.advance(10_500)
    expect(world.loads).toBe(1)
  })

  test('the poll intervals are the options', async () => {
    const { world } = await running({}, { fsPollSeconds: 2 })
    world.mtimes[STATE] = 11
    await world.clock.advance(2_500)
    expect(world.loads).toBe(1)
  })

  test('a poll of 0 never runs', async () => {
    const { world } = await running({}, { fsPollSeconds: 0, prPollSeconds: 0 })
    world.mtimes[STATE] = 11
    await world.clock.advance(600_000)
    expect(world.loads).toBe(0)
    expect(world.stats).toBe(0)
    expect(world.fingerprints).toBe(0)
  })
})

describe('git HEAD', () => {
  test('a new sha re-reads', async () => {
    const { world } = await running()
    world.sha = 'bbb'
    await world.clock.advance(10_500)
    expect(world.loads).toBe(1)
    await world.clock.advance(30_000)
    expect(world.loads).toBe(1)
  })

  test('a new branch with the same sha re-reads', async () => {
    const { world } = await running()
    world.branch = 'dev/SHOP-7/domain-design'
    await world.clock.advance(10_500)
    expect(world.loads).toBe(1)
  })

  test('no git is normal: no re-read, no error', async () => {
    const { world } = await running()
    world.isGitMissing = true
    await world.clock.advance(10_500)
    // Git going away is a (one-time) change of signature; it re-reads and publishes nothing.
    expect(world.loads).toBe(1)
    expect(world.published).toEqual([])
    await world.clock.advance(60_000)
    expect(world.loads).toBe(1)
  })

  test('a repo that never had git never re-reads for it', async () => {
    const { world, ports } = makeWorld()
    world.isGitMissing = true
    const engine = createRefreshEngine(ports, CONFIG)
    await engine.seed({ ...world.model!, readAt: 1 })
    await engine.start()
    await world.clock.advance(60_000)
    expect(world.loads).toBe(0)
    expect(world.published).toEqual([])
  })
})

describe('the remote poll', () => {
  test('the first fingerprint is a baseline; the same one does nothing; a different one re-reads', async () => {
    const { world, engine } = await running({ fingerprint: 'pr:1' })
    await world.clock.advance(180_000)
    expect(world.fingerprints).toBe(1)
    expect(world.loads).toBe(0)
    await world.clock.advance(180_000)
    expect(world.loads).toBe(0)
    world.fingerprint = 'pr:1,2'
    await world.clock.advance(180_500)
    expect(world.loads).toBe(1)
    expect(engine.isRunning()).toBe(true)
  })

  test('a provider without a fingerprint (null) is a no-op: asked once, no remote timer', async () => {
    const { world } = await running()
    await world.clock.advance(1_000_000)
    expect(world.fingerprints).toBe(0)
    expect(world.clock.pending()).toBe(1) // the file poll alone
    expect(world.loads).toBe(0)
    expect(world.published).toEqual([])
  })

  test('the first fingerprint re-reads when nothing was ever read', async () => {
    const { world, engine } = await running({ model: null })
    world.fingerprint = 'pr:1'
    world.model = stageModel({ watch: [STATE] })
    await engine.attach()
    await world.clock.advance(600)
    expect(world.loads).toBe(1)
    expect(world.published).toHaveLength(1)
  })

  test('attach checks the fingerprint at once', async () => {
    const { world, engine } = await running()
    world.fingerprint = 'a'
    await engine.attach()
    await flush()
    expect(world.fingerprints).toBe(1)
    world.fingerprint = 'b'
    await engine.attach()
    await flush()
    await world.clock.advance(600)
    expect(world.fingerprints).toBe(2)
    expect(world.loads).toBe(1)
  })
})

describe('errors never break the pane', () => {
  test('a failed load keeps the model and publishes it once with the error line; success clears it', async () => {
    const { world, engine } = await running()
    world.loadError = true
    const outcome = await engine.readNow()
    expect(outcome.ok).toBe(false)
    expect(outcome.model).not.toBeNull()
    expect(world.published).toHaveLength(1)
    expect(world.published[0]?.freshness?.error).toBe(en['refresh.failed'])
    expect(world.published[0]?.header).toEqual(world.model!.header)

    await engine.readNow()
    await engine.readNow()
    expect(world.published).toHaveLength(1) // still the same error: no churn

    world.loadError = false
    await engine.readNow()
    expect(world.published).toHaveLength(2)
    expect(world.published[1]?.freshness?.error).toBeUndefined()
  })

  test('a failed load with no model publishes nothing', async () => {
    const { world, engine } = await running({ model: null })
    world.loadError = true
    const outcome = await engine.readNow()
    expect(outcome).toEqual({ ok: false, model: null })
    expect(world.published).toEqual([])
  })

  test('a failing fingerprint keeps the model and shows the remote line once; the next success clears it', async () => {
    const { world, engine } = await running()
    world.fingerprintError = true
    await engine.attach()
    await flush()
    await world.clock.advance(180_000)
    await world.clock.advance(180_000)
    expect(world.published).toHaveLength(1)
    expect(world.published[0]?.freshness?.error).toBe(en['refresh.remoteFailed'])

    world.fingerprintError = false
    world.fingerprint = 'pr:1'
    await world.clock.advance(180_000)
    expect(world.published).toHaveLength(2)
    expect(world.published[1]?.freshness?.error).toBeUndefined()
  })

  test('a plan failure outranks the remote one, and both clear independently', async () => {
    const { world, engine } = await running()
    world.fingerprintError = true
    await engine.attach()
    await flush()
    world.loadError = true
    await engine.readNow()
    expect(world.published.at(-1)?.freshness?.error).toBe(en['refresh.failed'])
    world.loadError = false
    await engine.readNow()
    expect(world.published.at(-1)?.freshness?.error).toBe(en['refresh.remoteFailed'])
  })

  test('a failed check is not stamped as a check', async () => {
    const { world, engine } = await running()
    const before = engine.checkedAt()
    world.loadError = true
    await world.clock.advance(4000)
    await engine.readNow()
    expect(engine.checkedAt()).toBe(before)
  })
})

describe('stop and resume', () => {
  test('stop cancels every timer and the pending debounce', async () => {
    const { world, engine } = await running()
    engine.request('tool')
    engine.stop()
    world.mtimes[STATE] = 99
    await world.clock.advance(600_000)
    expect(world.loads).toBe(0)
    expect(world.stats).toBe(0)
    expect(world.runs).toEqual([])
    expect(world.fingerprints).toBe(0)
    expect(world.clock.pending()).toBe(0)
  })

  test('while stopped and not visible, triggers do nothing but look', async () => {
    const { world, engine } = await running()
    engine.stop()
    world.isVisible = false
    engine.request('tool')
    engine.request('turn')
    engine.toolCall('Write', { file_path: STATE })
    await flush()
    await world.clock.advance(600_000)
    expect(world.loads).toBe(0)
    expect(engine.isRunning()).toBe(false)
  })

  test('wake resumes when the pane is back, with a catch-up read', async () => {
    const { world, engine } = await running()
    engine.stop()
    world.isVisible = true
    await engine.wake()
    expect(engine.isRunning()).toBe(true)
    await world.clock.advance(600)
    expect(world.loads).toBe(1)
    world.mtimes[STATE] = 42
    await world.clock.advance(10_500)
    expect(world.loads).toBe(2)
  })

  test('a trigger while stopped wakes an engine whose pane is visible again', async () => {
    const { world, engine } = await running()
    engine.stop()
    engine.request('turn')
    await flush()
    expect(engine.isRunning()).toBe(true)
    await world.clock.advance(600)
    expect(world.loads).toBe(1)
  })

  test('start with the pane not on screen runs nothing; start later does', async () => {
    const { world, ports } = makeWorld()
    world.isVisible = false
    const engine = createRefreshEngine(ports, CONFIG)
    await engine.seed({ ...world.model!, readAt: 1 })
    await engine.start()
    world.mtimes[STATE] = 99
    await world.clock.advance(600_000)
    expect(world.stats).toBe(2) // seed's baselines only
    expect(world.clock.pending()).toBe(0)

    world.isVisible = true
    await engine.wake()
    await world.clock.advance(600)
    expect(world.loads).toBe(1)
  })

  test('a poll tick that finds the pane gone stops everything', async () => {
    const { world, engine } = await running()
    world.isVisible = false
    await world.clock.advance(10_000)
    expect(engine.isRunning()).toBe(false)
    expect(world.clock.pending()).toBe(0)
    const stats = world.stats
    await world.clock.advance(600_000)
    expect(world.stats).toBe(stats)
  })

  test('wake is a cheap no-op while running: no visibility check, no new timers', async () => {
    const { world, engine } = await running()
    const checks = world.visibleChecks
    await engine.wake()
    await engine.wake()
    expect(world.visibleChecks).toBe(checks)
    expect(world.clock.pending()).toBe(1)
  })

  test('disabled (panel: off): nothing ever runs', async () => {
    const { world, ports } = makeWorld()
    const engine = createRefreshEngine(ports, { ...CONFIG, isEnabled: false })
    await engine.seed({ ...world.model!, readAt: 1 })
    await engine.start()
    await engine.wake()
    await engine.attach()
    engine.request('tool')
    engine.toolCall('Bash', { command: 'git status' })
    await engine.readNow()
    await world.clock.advance(600_000)
    expect(world.loads).toBe(0)
    expect(world.stats).toBe(0)
    expect(world.runs).toEqual([])
    expect(world.fingerprints).toBe(0)
    expect(world.clock.pending()).toBe(0)
    expect(engine.isRunning()).toBe(false)
  })
})

describe('triggers', () => {
  const trigger = async (call: (engine: RefreshEngine) => void | Promise<void>) => {
    const { world, engine } = await running()
    await call(engine)
    await world.clock.advance(600)
    return world.loads
  }

  test('a tool call on a watched path, or git/gh/aidlc, re-reads; any other does not', async () => {
    expect(await trigger(e => e.toolCall('Write', { file_path: STATE }))).toBe(1)
    expect(await trigger(e => e.toolCall('Edit', { file_path: DIR + '/new/file.md' }))).toBe(1)
    expect(await trigger(e => e.toolCall('Bash', { command: 'git checkout x' }))).toBe(1)
    expect(await trigger(e => e.toolCall('Bash', { command: 'gh pr view' }))).toBe(1)
    expect(await trigger(e => e.toolCall('Bash', { command: 'aidlc next' }))).toBe(1)
    expect(await trigger(e => e.toolCall('Write', { file_path: ROOT + '/src/a.ts' }))).toBe(0)
    expect(await trigger(e => e.toolCall('Bash', { command: 'echo legit' }))).toBe(0)
  })

  test('the turn ending re-reads', async () => {
    expect(await trigger(e => e.request('turn'))).toBe(1)
  })
})

describe('fingerprintOf', () => {
  const ctx = ctxOf(tree, ROOT, 's')
  const fake = (extra: Partial<Provider> = {}): Provider => ({
    id: 'ledger',
    detect: async () => ({ provider: 'ledger', root: ROOT, detail: {} }),
    load: async () => stageModel(),
    ...extra,
  })

  test("is the detected provider's fingerprint", async () => {
    expect(await fingerprintOf(ctx, [fake({ fingerprint: async () => 'pr:1,2' })])).toBe('pr:1,2')
  })

  test('is null when the provider has none, or no provider detects a plan', async () => {
    expect(await fingerprintOf(ctx, [fake()])).toBeNull()
    expect(await fingerprintOf(ctx, [fake({ detect: async () => null, fingerprint: async () => 'x' })])).toBeNull()
    expect(await fingerprintOf(ctxOf({ files: {} }, ROOT, 's'))).toBeNull()
  })

  test('AI-DLC has one (M3), and outside a git work tree it is the empty string: nothing remote to watch', async () => {
    expect(await fingerprintOf(ctx)).toBe('')
  })

  test('a throwing fingerprint rejects, for the caller to turn into the remote error line', async () => {
    await expect(
      fingerprintOf(ctx, [
        fake({
          fingerprint: async () => {
            throw new Error('gh missing')
          },
        }),
      ]),
    ).rejects.toThrow('gh missing')
  })
})

describe('freshness stamp', () => {
  test('a quiet tick moves the check time without a write; it redraws only when the text on screen would change', async () => {
    const { world, engine } = await running()
    engine.noteRendered(world.clock.time)
    const before = engine.checkedAt()
    await world.clock.advance(10_000)
    expect(engine.checkedAt()).toBe(before + 10_000)
    expect(world.published).toEqual([])
    // The text drawn is "just now" and the tick keeps it so: nothing to redraw.
    expect(world.invalidations).toBe(0)

    // A redraw at +40 s (a fold toggled) drew "30s ago"; the next tick brings it back.
    await world.clock.advance(9_000)
    engine.noteRendered(world.clock.time + 30_000)
    await world.clock.advance(1_000)
    expect(world.invalidations).toBe(1)
    await world.clock.advance(10_000)
    expect(world.invalidations).toBe(1)
    expect(world.published).toEqual([])
  })

  test('a tick that finds a change, or a failing plan, does not claim a check', async () => {
    const { world, engine } = await running()
    const before = engine.checkedAt()
    world.loadError = true
    await engine.readNow()
    world.mtimes[STATE] = 99
    await world.clock.advance(10_000)
    expect(engine.checkedAt()).toBe(before)
  })

  test('a remote tick that worked counts too', async () => {
    const { world, engine } = await running({ fingerprint: 'pr:1' })
    const before = engine.checkedAt()
    engine.noteRendered(world.clock.time + 100_000)
    await world.clock.advance(180_000)
    expect(engine.checkedAt()).toBe(before + 180_000)
    expect(world.invalidations).toBeGreaterThan(0)
  })
})

describe('the remote check', () => {
  test('attach does not wait for it: a hung gh cannot hold the attach', async () => {
    const { world, engine } = await running()
    world.fingerprintHang = true
    await engine.attach()
    expect(world.fingerprints).toBe(1)
  })

  test('a fingerprint that never answers fails after 30 s, shows the remote line, and a later one works', async () => {
    const { world, engine } = await running()
    world.fingerprintHang = true
    await engine.attach()
    await world.clock.advance(29_000)
    expect(world.published).toEqual([])
    await world.clock.advance(1_500)
    expect(world.published).toHaveLength(1)
    expect(world.published[0]?.freshness?.error).toBe(en['refresh.remoteFailed'])

    // The check is not stuck "in flight": the poll tries again and recovers.
    world.fingerprintHang = false
    world.fingerprint = 'pr:1'
    await world.clock.advance(180_000)
    expect(world.published).toHaveLength(2)
    expect(world.published[1]?.freshness?.error).toBeUndefined()
  })

  test('a changed fingerprint is adopted only once a read has succeeded; a failed read retries', async () => {
    const { world } = await running({ fingerprint: 'a' })
    world.fingerprint = 'b'
    world.loadError = true
    await world.clock.advance(180_500)
    expect(world.loads).toBe(1)
    // Still 'b' on the next poll, and still different from the baseline: read again.
    world.loadError = false
    await world.clock.advance(180_500)
    expect(world.loads).toBe(2)
    // Adopted: no more reads for 'b'.
    await world.clock.advance(360_000)
    expect(world.loads).toBe(2)
  })

  test('no remote timer without a fingerprint; a read that finds one brings it back', async () => {
    const { world, engine } = await running()
    expect(world.clock.pending()).toBe(1)
    world.fingerprint = 'pr:1'
    await engine.readNow()
    await world.clock.advance(0)
    expect(world.clock.pending()).toBe(2)
    world.fingerprint = 'pr:2'
    await world.clock.advance(180_500)
    expect(world.loads).toBe(2)
  })

  test('waking never checks the remote inside the dispatch that woke it', async () => {
    const { world, engine } = await running({ fingerprint: 'pr:1' })
    engine.stop()
    world.fingerprintError = true
    await engine.wake()
    expect(world.fingerprints).toBe(0)
    expect(world.published).toEqual([])
    await world.clock.advance(0)
    expect(world.fingerprints).toBe(1)
  })
})

describe('races', () => {
  test('a write during the load is seen by the next poll (baselines are taken before the read)', async () => {
    const { world, engine } = await running()
    let release!: () => void
    world.gate = new Promise<void>(resolve => (release = resolve))
    const reading = engine.readNow()
    await flush()
    world.mtimes[STATE] = 77
    release()
    world.gate = null
    await reading
    world.loads = 0
    await world.clock.advance(10_500)
    expect(world.loads).toBe(1)
  })

  test('seed drops the result of a read that was in flight', async () => {
    const { world, engine } = await running()
    world.model = changed(world.model)
    let release!: () => void
    world.gate = new Promise<void>(resolve => (release = resolve))
    const reading = engine.readNow()
    await flush()
    const adopted = { ...stageModel({ watch: [STATE, DIR] }), next: { command: '/aidlc', reason: 'adopted' } }
    await engine.seed(adopted)
    release()
    world.gate = null
    await reading
    expect(world.published).toEqual([])
    // The seeded model is the baseline now: the next honest read differs and is published.
    world.model = adopted
    await engine.readNow()
    expect(world.published).toEqual([])
  })

  test('stop drops the read in flight and the follow-up queued behind it', async () => {
    const { world, engine } = await running()
    world.model = changed(world.model)
    let release!: () => void
    world.gate = new Promise<void>(resolve => (release = resolve))
    engine.request('tool')
    await world.clock.advance(500)
    expect(world.loads).toBe(1)
    engine.request('tool')
    await world.clock.advance(500) // queues behind the running read
    engine.stop()
    release()
    world.gate = null
    await flush()
    expect(world.loads).toBe(1)
    expect(world.published).toEqual([])
  })

  test('a stop while start is still asking whether the pane is on screen wins', async () => {
    const { world, engine } = await running()
    engine.stop()
    let release!: () => void
    world.visibleGate = new Promise<void>(resolve => (release = resolve))
    const waking = engine.wake()
    await flush()
    engine.stop()
    release()
    await waking
    expect(engine.isRunning()).toBe(false)
    expect(world.clock.pending()).toBe(0)
  })

  test('timers that cannot be made leave the engine stopped, not running without them', async () => {
    const { world, ports } = makeWorld()
    world.everyThrows = true
    const engine = createRefreshEngine(ports, CONFIG)
    await engine.seed({ ...world.model!, readAt: 1 })
    await engine.start()
    expect(engine.isRunning()).toBe(false)
    world.everyThrows = false
    await engine.wake()
    expect(engine.isRunning()).toBe(true)
  })
})

describe('a plan that went away', () => {
  test('keeps polling the last watch list, so its return is seen', async () => {
    const { world, engine } = await running()
    world.model = null
    await engine.readNow()
    expect(world.published).toEqual([null])

    world.model = stageModel({ watch: [STATE, DIR] })
    world.mtimes[DIR] = 6
    await world.clock.advance(10_600)
    expect(world.published).toHaveLength(2)
    expect(world.published[1]).not.toBeNull()
  })
})
