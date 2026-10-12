// The ledger's remote fingerprint (M2): what it digests, how it fails, and that a change in the scripted
// PR list reaches the refresh engine as exactly one re-load.
import { describe, expect, test } from 'claude-code/testing'
import { fingerprintOf, buildModel } from '../src/model'
import { createRefreshEngine, REMOTE_TIMEOUT_MS } from '../src/refresh'
import type { RefreshPorts, Timer } from '../src/refresh'
import { ForgeError } from '../src/forge'
import { ledger } from '../src/providers/ledger'
import * as rem from '../fixtures/ledger/reminders'
import type { Detection, PanelModel } from '../types'
import { remWorld, scripted, withUrls, world } from './ledger-world'
import type { World } from './ledger-world'

/** The fingerprint of a world, through the provider's own detection. */
async function fingerprintFor(w: World): Promise<string> {
  const s = scripted(w)
  const detection = (await ledger.detect(s.ctx)) as Detection
  expect(detection).not.toBeNull()
  return (ledger.fingerprint as NonNullable<typeof ledger.fingerprint>)(s.ctx, detection)
}

const withPr = (number: number, change: Partial<(typeof rem.prs)[number]> & { headRefOid?: string }) =>
  withUrls(rem.prs).map(p => (p.number === number ? { ...p, ...change } : p))

describe('ledger.fingerprint', () => {
  test('is on the provider', () => {
    expect(typeof ledger.fingerprint).toBe('function')
  })

  test('the same world gives the same string, twice and from separate contexts', async () => {
    const first = await fingerprintFor(remWorld())
    expect(first).not.toBe('')
    expect(await fingerprintFor(remWorld())).toBe(first)
    const s = scripted(remWorld())
    const detection = (await ledger.detect(s.ctx)) as Detection
    expect(await ledger.fingerprint?.(s.ctx, detection)).toBe(first)
    expect(await ledger.fingerprint?.(s.ctx, detection)).toBe(first)
  })

  test('the order gh lists the PRs in does not matter', async () => {
    const forward = await fingerprintFor(remWorld())
    const reversed = await fingerprintFor(remWorld({ prs: withUrls(rem.prs).reverse() }))
    expect(reversed).toBe(forward)
  })

  test('a PR going from open to merged changes it', async () => {
    const before = await fingerprintFor(remWorld())
    const after = await fingerprintFor(remWorld({ prs: withPr(67, { state: 'MERGED', mergedAt: '2026-10-01T09:00:00Z' }) }))
    expect(after).not.toBe(before)
  })

  test('a new head commit on a PR changes it', async () => {
    const before = await fingerprintFor(remWorld({ prs: withPr(67, { headRefOid: 'aaa111' }) }))
    const after = await fingerprintFor(remWorld({ prs: withPr(67, { headRefOid: 'bbb222' }) }))
    expect(after).not.toBe(before)
  })

  test('a new PR changes it', async () => {
    const before = await fingerprintFor(remWorld())
    const extra = { number: 99, title: 'feat(T99): new', state: 'OPEN' as const, headRefName: 'feat/T99', labels: [], mergedAt: null }
    const after = await fingerprintFor(remWorld({ prs: [...withUrls(rem.prs), ...withUrls([extra])] }))
    expect(after).not.toBe(before)
  })

  test('a new tip of the default branch on origin changes it', async () => {
    const before = await fingerprintFor(remWorld({ remoteSha: '1111111' }))
    const after = await fingerprintFor(remWorld({ remoteSha: '2222222' }))
    expect(after).not.toBe(before)
  })

  test('a failing `gh pr list` rejects with a ForgeError that names the cause', async () => {
    const error = await fingerprintFor(remWorld({ isPrListUp: false })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).problem).toEqual({ kind: 'failed', cli: 'gh', host: 'github.com' })
    expect((error as ForgeError).display).toBe('Could not check pull requests (gh failed); they may be stale.')
  })

  test('gh logged out: the error says so', async () => {
    const error = await fingerprintFor(remWorld({ isPrListUp: false, isGhAuthed: false })).catch((e: unknown) => e)
    expect((error as ForgeError).display).toBe('Could not check pull requests (gh not logged in to github.com); they may be stale.')
  })

  test('a failing `git ls-remote` alone resolves, with its part empty', async () => {
    const down = await fingerprintFor(remWorld({ isLsRemoteUp: false }))
    expect(down).not.toBe('')
    expect(down).not.toBe(await fingerprintFor(remWorld()))
    // The PR part still counts.
    expect(await fingerprintFor(remWorld({ isLsRemoteUp: false, prs: withPr(67, { state: 'CLOSED' }) }))).not.toBe(down)
  })

  test('it runs only the two cheap queries and never asks a model', async () => {
    const s = scripted(remWorld())
    const detection = (await ledger.detect(s.ctx)) as Detection
    s.host.runs.length = 0
    await ledger.fingerprint?.(s.ctx, detection)
    const lines = s.host.runs.map(argv => argv.join(' '))
    expect(lines.some(line => line === 'gh pr list --state all --limit 1000 --json number,state,mergedAt,headRefOid,isDraft,reviewDecision,reviewRequests,latestReviews')).toBe(true)
    expect(lines.some(line => line.includes('ls-remote origin refs/heads/main'))).toBe(true)
    expect(s.asked).toEqual([])
  })
})

describe('fingerprintOf with the ledger provider', () => {
  test('returns the provider fingerprint for a ledger repo', async () => {
    const s = scripted(remWorld())
    const text = await fingerprintOf(s.ctx, [ledger])
    expect(typeof text).toBe('string')
    expect(text).toBe(await fingerprintFor(remWorld()))
  })

  test('is null outside a ledger repo, and rejects when gh fails', async () => {
    expect(await fingerprintOf(scripted(world({ tracked: ['README.md'] })).ctx, [ledger])).toBeNull()
    await expect(fingerprintOf(scripted(remWorld({ isPrListUp: false })).ctx, [ledger])).rejects.toThrow()
  })
})

// ── through the engine ───────────────────────────────────────────────────────

// The test runtime provides timers; the plugin's type environment does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

/** A real fingerprint is many awaits deep (detect, repo facts, two commands): let it settle on the real event loop. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setTimeout(resolve, 0))
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
    async advance(ms: number) {
      const target = clock.time + ms
      for (;;) {
        const due = entries.filter(entry => !entry.isCancelled && entry.at <= target).sort((a, b) => a.at - b.at)[0]
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

/** An engine whose `load` and `fingerprint` ports run the real ledger over a scripted world. */
async function engineOver(w: World) {
  const clock = fakeClock()
  const s = scripted(w)
  const counts = { loads: 0, fingerprints: 0, published: [] as (PanelModel | null)[] }
  const ports: RefreshPorts = {
    now: async () => clock.time,
    after: (ms, fn) => clock.after(ms, fn),
    every: (ms, fn) => clock.every(ms, fn),
    load: async () => {
      counts.loads++
      return buildModel(s.ctx, [ledger])
    },
    fingerprint: async () => {
      counts.fingerprints++
      return fingerprintOf(s.ctx, [ledger])
    },
    mtime: async () => null,
    run: async () => ({ exitCode: 0, stdout: 'main\n' }),
    publish: async model => void counts.published.push(model),
    invalidate: async () => undefined,
    isVisible: async () => true,
  }
  const engine = createRefreshEngine(ports, { startDir: w.root, isEnabled: true, fsPollSeconds: 0, prPollSeconds: 180 })
  await engine.seed(await buildModel(s.ctx, [ledger]))
  await engine.start()
  // The first remote check takes the baseline.
  await clock.advance(0)
  counts.loads = 0
  counts.fingerprints = 0
  counts.published.length = 0
  return { w, clock, counts, engine }
}

describe('the refresh engine over the ledger fingerprint', () => {
  test('the timeout leaves room for the two sequential 12 s commands', () => {
    expect(REMOTE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 12_000)
  })

  test('an unchanged world polls without re-loading', async () => {
    const { clock, counts } = await engineOver(remWorld())
    await clock.advance(180_500)
    expect(counts.fingerprints).toBe(1)
    expect(counts.loads).toBe(0)
  })

  test('a PR that merges between polls makes exactly one re-load, and the pane shows it', async () => {
    const { w, clock, counts } = await engineOver(remWorld())
    w.prs = withPr(67, { state: 'MERGED', mergedAt: '2026-10-01T09:00:00Z' })
    await clock.advance(180_500)
    expect(counts.fingerprints).toBe(1)
    expect(counts.loads).toBe(1)
    expect(counts.published).toHaveLength(1)
    // Adopted: the next polls see the same digest and read nothing more.
    await clock.advance(360_000)
    expect(counts.fingerprints).toBe(3)
    expect(counts.loads).toBe(1)
  })

  test('a new tip of the default branch makes exactly one re-load', async () => {
    const { w, clock, counts } = await engineOver(remWorld({ remoteSha: '1111111' }))
    w.remoteSha = '2222222'
    await clock.advance(180_500)
    expect(counts.loads).toBe(1)
    await clock.advance(180_000)
    expect(counts.loads).toBe(1)
  })

  test('a failing gh keeps the last model, adds the one remote line, and a later poll recovers', async () => {
    const { w, clock, counts } = await engineOver(remWorld())
    w.isPrListUp = false
    await clock.advance(180_500)
    expect(counts.loads).toBe(0)
    expect(counts.published).toHaveLength(1)
    expect(counts.published[0]?.freshness?.error).toBeTruthy()
    w.isPrListUp = true
    await clock.advance(180_000)
    expect(counts.published.at(-1)?.freshness?.error).toBeUndefined()
  })
})
