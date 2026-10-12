import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { aliasOfTier, capTier, judgeProbe, judgeProbeRejection, listedIn, reachableTier } from '../hooks/classify'
import { FABLE, HAIKU, OPUS, SONNET, endTurn, mountWorld, newWorld, settle, step, submit, unsure, verdict } from './kit'
import type { World } from './kit'

const TASK = 'Make concurrent withdrawals unable to overdraw an account'
const HOUR = 60 * 60 * 1000

const MODELS = [
  { alias: 'haiku', id: HAIKU, name: 'Haiku 5.5' },
  { alias: 'sonnet', id: SONNET, name: 'Sonnet 5.5' },
  { alias: 'opus', id: OPUS, name: 'Opus 5.5' },
  { alias: 'fable', id: FABLE, name: 'Fable 5.1' },
] as const

/** One check of TASK: the classifier says `tier`, the person is on `model`. */
async function check(on: Parameters<typeof mountWorld>[0], $: Engine, tier: string, setup: Partial<World> = {}) {
  const world = newWorld({ replies: [verdict(tier)], answer: null, ...setup })
  const seen = mountWorld(on, world)
  const result = await submit($, TASK)

  return { world, seen, result }
}

describe('four tiers: the same verdict gives the same recommendation from any model', () => {
  for (const current of MODELS) {
    for (const wanted of MODELS) {
      if (current.alias === wanted.alias) {
        test(`on ${current.alias}, a ${wanted.alias} verdict fits`, async ($, on) => {
          const { seen } = await check(on, $, wanted.alias, { model: current.id })

          expect(seen.asked).toHaveLength(0)
          expect(seen.toasts).toEqual([`${current.name} fits this task`])
        })
      } else {
        test(`on ${current.alias}, a ${wanted.alias} verdict offers ${wanted.name}`, async ($, on) => {
          const { seen } = await check(on, $, wanted.alias, { model: current.id })

          expect(seen.asked.map(a => a.options)).toEqual([[`Switch to ${wanted.name}`, `Stay on ${current.name}`]])
          expect(seen.asked[0]?.question).toBe(`Switch to ${wanted.name} for this task?`)
        })
      }
    }
  }

  test('fable is a separate tier from opus: one tier apart, so a large context holds it', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { model: OPUS, tokens: 45_000 })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Staying on Opus 5.5 — a switch now would re-read the whole context'])
  })

  test('haiku to fable is three tiers: asked even on a large context', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { model: HAIKU, tokens: 45_000 })

    expect(seen.asked).toHaveLength(1)
  })

  test('Switch to fable routes to its full id', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { answer: 'Switch to Fable 5.1' })

    await step($, SONNET)
    await endTurn($)
    await settle()

    expect(seen.steps).toEqual([{ model: FABLE }])
    expect(seen.commands).toEqual([{ command: 'model', args: 'fable' }])
  })

  test('ANTHROPIC_DEFAULT_FABLE_MODEL names the fable id', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { answer: 'Switch to Fable 6', env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-6' } })

    await step($, SONNET)

    expect(seen.steps).toEqual([{ model: 'claude-fable-6' }])
  })
})

describe('the highest model setting', () => {
  test('with a cap of opus, a fable verdict offers opus from sonnet', { options: { highestModel: 'opus' } }, async ($, on) => {
    const { seen } = await check(on, $, 'fable')

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Sonnet 5.5']])
    expect(seen.probes).toEqual([])
  })

  test('with a cap of opus, a fable verdict on opus fits', { options: { highestModel: 'opus' } }, async ($, on) => {
    const { seen } = await check(on, $, 'fable', { model: OPUS })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Opus 5.5 is the best available model for this task'])
  })

  test('with a cap of sonnet, an opus verdict on sonnet fits', { options: { highestModel: 'sonnet' } }, async ($, on) => {
    const { seen } = await check(on, $, 'opus')

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Sonnet 5.5 is the best available model for this task'])
  })

  test('with a cap of haiku, haiku is still offered from sonnet', { options: { highestModel: 'haiku' } }, async ($, on) => {
    const { seen } = await check(on, $, 'haiku')

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Haiku 5.5', 'Stay on Sonnet 5.5']])
  })

  test('a cap does not stop a downward offer from a model above it', { options: { highestModel: 'opus' } }, async ($, on) => {
    const { seen } = await check(on, $, 'opus', { model: FABLE })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Fable 5.1']])
  })

  test('a cap decides alone: no probe is ever made outside auto', { options: { highestModel: 'fable' } }, async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.probes).toEqual([])
    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Fable 5.1', 'Stay on Sonnet 5.5']])
  })

  test('a recheck honours the cap too', { options: { highestModel: 'opus' } }, async ($, on) => {
    const world = newWorld({ replies: [unsure(), verdict('fable')], toolResults: ['PROMPT.md: a ledger with races'] })
    const seen = mountWorld(on, world)

    await submit($, 'read PROMPT.md, implement')
    await step($, SONNET, { index: 0, messageCount: 1 })
    await step($, SONNET, { index: 1, messageCount: 3 })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Sonnet 5.5']])
  })
})

describe('the availableModels setting', () => {
  test('the alias admits a tier: sonnet and opus listed, a fable verdict walks down to opus', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { availableModels: ['sonnet', 'opus'] })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Sonnet 5.5']])
    expect(seen.probes).toEqual([OPUS])
  })

  test('a full id admits that model; a prefix at a dash boundary admits its versions', async ($, on) => {
    const full = await check(on, $, 'opus', { availableModels: ['claude-opus-5-5'] })
    expect(full.seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('claude-opus-5 admits claude-opus-5-5', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: ['claude-opus-5'] })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('the display name admits it, case and spacing aside', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: [' Opus 5.5 '] })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('an entry for another version does not: claude-opus-4-1 does not admit claude-opus-5-5', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: ['sonnet', 'claude-opus-4-1'] })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Sonnet 5.5 is the best available model for this task'])
  })

  test('a name that merely contains the family does not admit it', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: ['sonnet', 'my-opus-gateway', 'opusplan'] })

    expect(seen.asked).toHaveLength(0)
  })

  test('an empty list is no list', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: [] })

    expect(seen.asked).toHaveLength(1)
  })

  test('settings that cannot be read are no list', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { settingsThrow: true })

    expect(seen.asked).toHaveLength(1)
  })

  test('a downward offer lands on the lightest listed tier between: not below what was asked', async ($, on) => {
    const { seen } = await check(on, $, 'sonnet', { model: FABLE, availableModels: ['fable', 'opus', 'haiku'] })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Fable 5.1']])
  })

  test('a downward offer with nothing listed on the way fits', async ($, on) => {
    const { seen } = await check(on, $, 'sonnet', { model: OPUS, availableModels: ['opus', 'haiku'] })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Opus 5.5 is the best available model for this task'])
  })

  test('haiku obeys the list like the rest: not listed, not offered', async ($, on) => {
    const { seen } = await check(on, $, 'haiku', { availableModels: ['opus'], model: OPUS })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Opus 5.5 is the best available model for this task'])
  })

  test('haiku listed is offered', async ($, on) => {
    const { seen } = await check(on, $, 'haiku', { availableModels: ['opus', 'haiku'], model: OPUS })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Haiku 5.5', 'Stay on Opus 5.5']])
  })

  test('with a list and no allowed tier on the path, the result is a fit', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { availableModels: ['sonnet'] })

    expect(seen.asked).toHaveLength(0)
    expect(seen.probes).toEqual([])
  })

  test('the id of an ANTHROPIC_DEFAULT_*_MODEL override is the one the list is read against', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { availableModels: ['claude-opus-4-1'], env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1' } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 4.1')
  })
})

describe('the auto probe', () => {
  test('a model that answers is available; a short question goes to the full id', async ($, on) => {
    const { seen } = await check(on, $, 'opus')

    expect(seen.probes).toEqual([OPUS])
    expect(seen.probeRequests).toEqual([{ model: OPUS, maxTokens: 16, effort: 'low', status: 'Checking model fit…' }])
    expect(seen.asked).toHaveLength(1)
  })

  test('the status line is up while it waits and is cleared after', async ($, on) => {
    const { seen } = await check(on, $, 'opus')

    // the classification, then the probe
    expect(seen.statuses).toEqual(['Checking model fit…', undefined, 'Checking model fit…', undefined])
  })

  test('only the tier about to be offered is probed, and a fit probes nothing', async ($, on) => {
    const { seen } = await check(on, $, 'sonnet')

    expect(seen.probes).toEqual([])
  })

  test('haiku is never probed', async ($, on) => {
    const { seen } = await check(on, $, 'haiku', { model: OPUS })

    expect(seen.probes).toEqual([])
    expect(seen.asked).toHaveLength(1)
  })

  test('model_not_found, at any status, means not available: fable walks down to opus', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 404, error: 'model_not_found' } } })

    expect(seen.probes).toEqual([FABLE, OPUS])
    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Sonnet 5.5']])
  })

  test('model_not_found with a 400 is still not available', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 400, error: 'model_not_found' } } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('a 403 that is not about billing, credentials or load means not available', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  for (const error of ['billing_error', 'authentication_failed', 'rate_limit', 'overloaded']) {
    test(`a 403 of kind ${error} says nothing about the model: available, not remembered`, async ($, on) => {
      const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: { status: 403, error } } })

      expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
      expect(seen.store.has('availability')).toBe(false)
    })
  }

  for (const [status, error] of [
    [400, 'invalid_request'],
    [401, 'authentication_failed'],
    [402, 'billing_error'],
    [413, 'invalid_request'],
    [429, 'rate_limit'],
    [500, 'server_error'],
    [529, 'overloaded'],
    [null, 'unknown'],
  ] as const) {
    test(`${status ?? 'no status'} (${error}) counts as available and is not remembered`, async ($, on) => {
      const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: { status, error } } })

      expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
      expect(seen.store.has('availability')).toBe(false)
    })
  }

  test('a probe that times out counts as available and is not remembered', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: 'aborted' } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
    expect(seen.store.has('availability')).toBe(false)
  })

  test('an empty reply is an answer: available, and remembered', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: 'empty' } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
    expect(seen.store.get('availability')).toEqual({ [FABLE]: { ok: true, at: 5_000 } })
  })

  test('a model the engine blocks (the call rejects naming the allowlist) is not available, and remembered', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: 'blocked' } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
    expect(seen.store.get('availability')).toMatchObject({ [FABLE]: { ok: false, at: 5_000 } })
  })

  test('a rejection that is not an allowlist block says nothing about the model: available, not remembered', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: 'reject' } })

    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
    expect(seen.store.has('availability')).toBe(false)
  })

  test('a yes is remembered per model id, with the time', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { now: 5_000 })

    expect(seen.store.get('availability')).toEqual({ [OPUS]: { ok: true, at: 5_000 } })
  })

  test('a no is remembered too', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 5_000, probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.store.get('availability')).toEqual({ [FABLE]: { ok: false, at: 5_000 }, [OPUS]: { ok: true, at: 5_000 } })
  })

  test('a remembered yes is used with no second probe, for a day', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 24 * HOUR - 1, store: { availability: { [FABLE]: { ok: true, at: 0 + 1 } } } })

    expect(seen.probes).toEqual([])
    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
  })

  test('after a day a yes is asked again', async ($, on) => {
    const { seen } = await check(on, $, 'fable', {
      now: 25 * HOUR + 2,
      store: { availability: { [FABLE]: { ok: true, at: 1 } } },
      probes: { [FABLE]: { status: 403, error: 'unknown' } },
    })

    expect(seen.probes).toEqual([FABLE, OPUS])
    expect(seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('a remembered no holds for an hour only', async ($, on) => {
    const held = await check(on, $, 'fable', {
      now: 1 * HOUR,
      store: { availability: { [FABLE]: { ok: false, at: 1 }, [OPUS]: { ok: true, at: 1 } } },
    })

    expect(held.seen.probes).toEqual([])
    expect(held.seen.asked[0]?.options[0]).toBe('Switch to Opus 5.5')
  })

  test('after an hour a no is asked again, and the model may now answer', async ($, on) => {
    const { seen } = await check(on, $, 'fable', {
      now: 1 * HOUR + 2,
      store: { availability: { [FABLE]: { ok: false, at: 1 }, [OPUS]: { ok: true, at: 1 } } },
    })

    expect(seen.probes).toEqual([FABLE, OPUS].slice(0, 1))
    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
    expect(seen.store.get('availability')).toMatchObject({ [FABLE]: { ok: true, at: 1 * HOUR + 2 } })
  })

  test('a clock that cannot be read trusts no remembered answer and writes none', async ($, on) => {
    const { seen } = await check(on, $, 'fable', {
      clockThrows: true,
      store: { availability: { [FABLE]: { ok: false, at: 1 } } },
    })

    expect(seen.probes).toEqual([FABLE])
    expect(seen.asked[0]?.options[0]).toBe('Switch to Fable 5.1')
    expect(seen.store.get('availability')).toEqual({ [FABLE]: { ok: false, at: 1 } })
  })

  test('with the clock at 0 the cache counts as expired', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { now: 0, store: { availability: { [FABLE]: { ok: false, at: 0 } } } })

    expect(seen.probes).toEqual([FABLE])
  })

  test('no probe is made outside auto', { options: { highestModel: 'fable' } }, async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.probes).toEqual([])
  })

  test('an ANTHROPIC_DEFAULT_*_MODEL override is the id that is probed', async ($, on) => {
    const { seen } = await check(on, $, 'opus', { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1' } })

    expect(seen.probes).toEqual(['claude-opus-4-1'])
  })
})

describe('the fallback', () => {
  test('a Pro-like plan (fable refused): a fable verdict offers opus from sonnet', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Opus 5.5', 'Stay on Sonnet 5.5']])
  })

  test('the window says why it is offering another model, not the classifier\'s reason', async ($, on) => {
    const world = newWorld({ replies: [verdict('fable', 'a brand new protocol')], probes: { [FABLE]: { status: 403, error: 'unknown' } }, answer: 'Stay on Sonnet 5.5' })
    const seen = mountWorld(on, world)

    world.whileAsking = async questions => {
      await $.ui.render({ surface: 'terminal', component: 'AskUserQuestion', requestId: 'a', props: { tool: 'AskUserQuestion', questions: [...questions] } })
    }

    await submit($, TASK)

    const options = (seen.drawn[0]?.questions[0] as { options: { description: string }[] }).options
    expect(options[0]?.description).toBe("Fable 5.1 would fit best but isn't available; Opus 5.5 is the closest")
    expect(JSON.stringify(options)).not.toContain('a brand new protocol')
  })

  test('when the verdict is offered as it is, the classifier\'s reason is shown', async ($, on) => {
    const world = newWorld({ replies: [verdict('opus', 'races across workers')], answer: 'Stay on Sonnet 5.5' })
    const seen = mountWorld(on, world)

    world.whileAsking = async questions => {
      await $.ui.render({ surface: 'terminal', component: 'AskUserQuestion', requestId: 'a', props: { tool: 'AskUserQuestion', questions: [...questions] } })
    }

    await submit($, TASK)

    expect((seen.drawn[0]?.questions[0] as { options: { description: string }[] }).options[0]?.description).toBe('races across workers')
  })

  test('on opus the same plan sees "best available", never a downgrade', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { model: OPUS, probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Opus 5.5 is the best available model for this task'])
  })

  test('nothing above sonnet is available: an opus verdict is "best available", not a downgrade', async ($, on) => {
    const { seen } = await check(on, $, 'opus', {
      probes: { [OPUS]: { status: 403, error: 'unknown' }, [FABLE]: { status: 403, error: 'unknown' } },
    })

    expect(seen.asked).toHaveLength(0)
    expect(seen.toasts).toEqual(['Sonnet 5.5 is the best available model for this task'])
  })

  test('a real fit still says it fits', async ($, on) => {
    const { seen } = await check(on, $, 'sonnet')

    expect(seen.toasts).toEqual(['Sonnet 5.5 fits this task'])
  })

  test('the fallback is the one the dialog names and Switch routes to', async ($, on) => {
    const { seen } = await check(on, $, 'fable', { probes: { [FABLE]: { status: 403, error: 'unknown' } }, answer: 'Switch to Opus 5.5' })

    await step($, SONNET)

    expect(seen.steps).toEqual([{ model: OPUS }])
  })

  test('a downward request is honoured as asked when the model it names is available', async ($, on) => {
    const { seen } = await check(on, $, 'haiku', { model: FABLE, probes: { [FABLE]: { status: 403, error: 'unknown' } } })

    expect(seen.asked.map(a => a.options)).toEqual([['Switch to Haiku 5.5', 'Stay on Fable 5.1']])
  })
})

describe('the tier arithmetic', () => {
  test('capTier: auto and anything unknown cap nothing', () => {
    expect(['auto', 'fable', 'opus', 'sonnet', 'haiku', 'nonsense'].map(capTier)).toEqual([3, 3, 2, 1, 0, 3])
  })

  test('listedIn: an empty or missing list admits all; else the alias, the id (or a prefix of it at a dash), or the display name', () => {
    expect(listedIn('fable', 'claude-fable-5-1', undefined)).toBe(true)
    expect(listedIn('fable', 'claude-fable-5-1', [])).toBe(true)
    expect(listedIn('fable', 'claude-fable-5-1', 'fable')).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['opus'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['OPUS'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus-5-5'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus-5'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['Opus 5.5'])).toBe(true)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus-4-1'])).toBe(false)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus-5-', 'claude-opus-55'])).toBe(false)
    expect(listedIn('opus', 'claude-opus-5-5', ['claude-opus-5-55'])).toBe(false)
    expect(listedIn('opus', 'claude-opus-5-5', ['opusplan', 'my-opus'])).toBe(false)
    expect(listedIn('fable', 'claude-fable-5-1', ['claude-opus-4-1', 'sonnet'])).toBe(false)
    expect(listedIn('opus', 'claude-opus-5-5', [3, null, ''])).toBe(false)
  })

  test('judgeProbe: only a clear answer about the model is definite', () => {
    const api = (status: number | null, error: string) => ({ isAnswered: false as const, reason: 'api-error' as const, status, error })

    expect(judgeProbe({ isAnswered: true })).toEqual({ ok: true, isDefinite: true })
    expect(judgeProbe({ isAnswered: false, reason: 'empty-reply' })).toEqual({ ok: true, isDefinite: true })
    expect(judgeProbe(api(404, 'model_not_found'))).toEqual({ ok: false, isDefinite: true })
    expect(judgeProbe(api(200, 'model_not_found'))).toEqual({ ok: false, isDefinite: true })
    expect(judgeProbe(api(403, 'unknown'))).toEqual({ ok: false, isDefinite: true })
    expect(judgeProbe(api(403, 'overloaded'))).toEqual({ ok: true, isDefinite: false })
    expect(judgeProbe(api(400, 'invalid_request'))).toEqual({ ok: true, isDefinite: false })
    expect(judgeProbe(api(null, 'unknown'))).toEqual({ ok: true, isDefinite: false })
    expect(judgeProbe(api(529, 'overloaded'))).toEqual({ ok: true, isDefinite: false })
    expect(judgeProbe({ isAnswered: false, reason: 'aborted' })).toEqual({ ok: true, isDefinite: false })
  })

  test('judgeProbeRejection: an allowlist block is definite, anything else is not', () => {
    expect(judgeProbeRejection('model claude-fable-5-1 is blocked by the availableModels setting')).toEqual({ ok: false, isDefinite: true })
    expect(judgeProbeRejection('Model not allowed')).toEqual({ ok: false, isDefinite: true })
    expect(judgeProbeRejection('maxTokens must be a positive integer')).toEqual({ ok: true, isDefinite: false })
  })

  test('reachableTier walks from the wanted tier toward the current one and stops at it', async () => {
    const only = (...tiers: number[]) => async (tier: number) => tiers.includes(tier)

    expect(await reachableTier(3, 1, only(3, 2))).toBe(3)
    expect(await reachableTier(3, 1, only(2))).toBe(2)
    expect(await reachableTier(3, 1, only())).toBe(1)
    expect(await reachableTier(3, 2, only(1))).toBe(2)
    expect(await reachableTier(0, 3, only(0))).toBe(0)
    expect(await reachableTier(0, 3, only(2))).toBe(2)
    expect(await reachableTier(0, 3, only())).toBe(3)
    expect(await reachableTier(2, 2, only(2))).toBe(2)
    expect(aliasOfTier(await reachableTier(3, 0, only(1, 2)))).toBe('opus')
  })
})
