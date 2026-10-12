import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HAIKU, OPUS, SONNET, endTurn, mountWorld, newWorld, settle, step, submit, verdict } from './kit'
import type { World } from './kit'

const TASK = 'Design the cross-service migration for the ledger'
const PICKER = 'Pick Opus 5.5 in the model picker to keep it for the session'

async function switchedToOpus($: Engine, on: Parameters<typeof mountWorld>[0], overrides: Partial<World> = {}) {
  const world = newWorld({ replies: [verdict('opus', 'cross-service design')], answer: 'Switch to Opus 5.5', ...overrides })
  const seen = mountWorld(on, world)
  const result = await submit($, TASK)

  return { world, seen, result }
}

describe('Switch', () => {
  test('the prompt carries one context line naming the new model, and a toast says where it runs', async ($, on) => {
    const { seen, result } = await switchedToOpus($, on)

    expect(result.text).toBe(TASK)
    expect(result.context).toHaveLength(1)
    expect(result.context?.[0]).toContain('Opus 5.5')
    expect(result.context?.[0]).toContain('Sonnet 5.5')
    expect(seen.toasts).toEqual(['This task runs on Opus 5.5'])
  })

  test('context other plugins attached stays, ours is added after it', async ($, on) => {
    mountWorld(on, newWorld({ replies: [verdict('opus')], answer: 'Switch to Opus 5.5' }))

    const result = await $.prompt.submit({ text: TASK, wait: false, origin: { kind: 'composer' }, context: ['earlier note'] })

    expect(result.context?.[0]).toBe('earlier note')
    expect(result.context).toHaveLength(2)
  })

  test('the main loop is sent to the full model id, a subagent is not', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET)
    await step($, 'claude-haiku-5-5', { agentId: 'agent-7' })

    expect(seen.steps).toEqual([{ model: OPUS }, { model: 'claude-haiku-5-5', agentId: 'agent-7' }])
  })

  test('every step of the task\'s turn is routed, never an alias', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET)
    await step($, SONNET)
    await step($, SONNET)

    expect(seen.steps.map(s => s.model)).toEqual([OPUS, OPUS, OPUS])
  })

  test('the first step binds the route to its turn: another turn\'s steps are not routed', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET, { turnId: 'turn-1' })
    await step($, SONNET, { turnId: 'turn-2' })
    await step($, SONNET, { turnId: 'turn-1' })

    expect(seen.steps.map(s => s.model)).toEqual([OPUS, SONNET, OPUS])
  })

  test('the turn ending ends the routing, and a second turn is not routed', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET)
    await endTurn($)
    await step($, OPUS, { turnId: 'turn-2' })

    expect(seen.steps.map(s => s.model)).toEqual([OPUS, OPUS])
    expect(seen.commands).toEqual([{ command: 'model', args: 'opus' }])
  })

  test('another turn finishing first does not end the routing', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET, { turnId: 'turn-1' })
    await endTurn($, { turnId: 'turn-0' })
    await step($, SONNET, { turnId: 'turn-1' })

    expect(seen.steps.map(s => s.model)).toEqual([OPUS, OPUS])
    expect(seen.commands).toEqual([])
  })

  test('where /model exists, the turn ending asks for it with the alias, once, and the session model follows', async ($, on) => {
    const { world, seen } = await switchedToOpus($, on)

    await step($, SONNET)
    await endTurn($, { agentId: 'agent-7' })
    expect(seen.commands).toEqual([])

    await endTurn($)
    await endTurn($)
    await settle()

    expect(seen.commands).toEqual([{ command: 'model', args: 'opus' }])
    expect(world.model).toBe(OPUS)
    expect(seen.toasts).toEqual(['This task runs on Opus 5.5'])
  })

  test('when /model is refused the routing is still over and the picker is pointed at', async ($, on) => {
    const { seen } = await switchedToOpus($, on, { commandRejects: true })

    await step($, SONNET)
    await endTurn($)
    await settle()
    await step($, SONNET, { turnId: 'turn-2' })

    expect(seen.commands).toEqual([{ command: 'model', args: 'opus' }])
    expect(seen.toasts).toEqual(['This task runs on Opus 5.5', PICKER])
    expect(seen.steps.map(s => s.model)).toEqual([OPUS, SONNET])
  })

  test('where there is no /model (the desktop app) the turn ending points at the picker, once, and routing stops', async ($, on) => {
    const { seen } = await switchedToOpus($, on, { hasModelCommand: false })

    await step($, SONNET)
    await endTurn($)
    await endTurn($)
    await step($, SONNET, { turnId: 'turn-2' })

    expect(seen.commands).toEqual([])
    expect(seen.steps.map(s => s.model)).toEqual([OPUS, SONNET])
    expect(seen.toasts).toEqual(['This task runs on Opus 5.5', PICKER])
  })

  test('the person picking another model by hand during the turn wins over the routing', async ($, on) => {
    const { world, seen } = await switchedToOpus($, on)

    world.model = HAIKU
    await step($, HAIKU)

    expect(seen.steps.map(s => s.model)).toEqual([HAIKU])
  })

  test('another plugin dropping the prompt clears the route', async ($, on) => {
    const { seen, result } = await switchedToOpus($, on, { dropPrompt: true })

    await step($, SONNET)

    expect('drop' in result && result.drop).toBe('blocked by another plugin')
    expect(seen.steps.map(s => s.model)).toEqual([SONNET])
  })

  test('switching down routes to the cheaper model without effort; /model gets the alias', async ($, on) => {
    const world = newWorld({ model: OPUS, replies: [verdict('haiku', 'a lookup')], answer: 'Switch to Haiku 5.5' })
    const seen = mountWorld(on, world)

    await submit($, 'Find the three places that read RETRY_LIMIT')
    await step($, OPUS, { effort: 'high' })
    await endTurn($)

    expect(seen.steps).toHaveLength(1)
    expect(seen.steps[0]?.model).toBe(HAIKU)
    expect('effort' in (seen.steps[0] ?? {})).toBe(false)
    expect(seen.commands).toEqual([{ command: 'model', args: 'haiku' }])
  })

  test('switching up keeps the effort', async ($, on) => {
    const { seen } = await switchedToOpus($, on)

    await step($, SONNET, { effort: 'high' })

    expect(seen.steps).toEqual([{ model: OPUS, effort: 'high' }])
  })

  test('an ANTHROPIC_DEFAULT_*_MODEL override names the routed id and the dialog; /model still gets the alias', async ($, on) => {
    const world = newWorld({
      replies: [verdict('opus')],
      answer: 'Switch to Opus 4.1',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' },
    })
    const seen = mountWorld(on, world)

    await submit($, TASK)
    await step($, SONNET)
    await endTurn($)

    expect(seen.asked[0]?.question).toBe('Switch to Opus 4.1 for this task?')
    expect(seen.steps).toEqual([{ model: 'claude-opus-4-1' }])
    expect(seen.commands).toEqual([{ command: 'model', args: 'opus' }])
  })

  test('the override of another tier is not used, and an empty one is ignored', async ($, on) => {
    const world = newWorld({ replies: [verdict('opus')], answer: 'Switch to Opus 5.5', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: '  ' } })
    const seen = mountWorld(on, world)

    await submit($, TASK)
    await step($, SONNET)

    expect(seen.steps).toEqual([{ model: OPUS }])
  })
})

const DESKTOP = ['desktop'] as const

describe('Switch where the session cannot change its own model', () => {
  for (const surfaces of [['desktop'], ['vscode'], ['mobile']] as const) {
    test(`${surfaces[0]}: the prompt is held and put back in the box, nothing is routed, no /model`, async ($, on) => {
      const world = newWorld({ surfaces: [...surfaces], replies: [verdict('opus')], answer: 'Switch to Opus 5.5' })
      const seen = mountWorld(on, world)

      const result = await submit($, TASK, { kind: 'sdk' })
      await step($, SONNET)
      await endTurn($)
      await settle()

      expect(result).toEqual({ drop: 'Pick Opus 5.5 in the model picker, then press Enter — your prompt is back in the box' })
      expect(seen.fills).toEqual([{ text: TASK, mode: 'replace' }])
      expect(seen.submitted).toHaveLength(0)
      expect(seen.commands).toEqual([])
      expect(seen.steps).toEqual([{ model: SONNET }])
      expect(seen.toasts).toEqual([])
    })
  }

  test('the text goes back as typed, not trimmed', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: 'Switch to Opus 5.5' })
    const seen = mountWorld(on, world)

    await submit($, `  ${TASK}\n`, { kind: 'sdk' })

    expect(seen.fills[0]?.text).toBe(`  ${TASK}\n`)
  })

  test('a box that will not take the text: still a drop, with the resend wording', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: 'Switch to Opus 5.5', fill: 'refused' })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK, { kind: 'sdk' })

    expect(result).toEqual({ drop: 'Pick Opus 5.5 in the model picker, then send your prompt again' })
    expect(seen.fills).toHaveLength(1)
    expect(seen.commands).toEqual([])
  })

  test('a fill that throws: still a drop, with the resend wording', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: 'Switch to Opus 5.5', fill: 'throws' })
    mountWorld(on, world)

    const result = await submit($, TASK, { kind: 'sdk' })

    expect(result).toEqual({ drop: 'Pick Opus 5.5 in the model picker, then send your prompt again' })
  })

  test('the session stays checked: the resent prompt goes through with no classifier call', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: 'Switch to Opus 5.5' })
    const seen = mountWorld(on, world)

    await submit($, TASK, { kind: 'sdk' })
    world.model = OPUS
    const resent = await submit($, TASK, { kind: 'sdk' })

    expect(resent).toEqual({ text: TASK })
    expect(seen.completes).toBe(1)
    expect(seen.asked).toHaveLength(1)
    expect(seen.submitted).toEqual([{ text: TASK }])
  })

  test('Stay on such a host runs the prompt on the current model, as anywhere', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: 'Stay on Sonnet 5.5' })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK, { kind: 'sdk' })

    expect(result).toEqual({ text: TASK })
    expect(seen.fills).toHaveLength(0)
  })

  test('dismissing the dialog on such a host is Stay too', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], replies: [verdict('opus')], answer: null })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK, { kind: 'sdk' })

    expect(result).toEqual({ text: TASK })
    expect(seen.fills).toHaveLength(0)
  })

  test('a fit and the cost rules behave as on a terminal', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], model: OPUS, replies: [verdict('haiku')], tokens: 45_000, answer: 'Stay on Opus 5.5' })
    const seen = mountWorld(on, world)

    await submit($, TASK, { kind: 'sdk' })

    expect(seen.asked).toHaveLength(1)
    expect(seen.asked[0]?.options).toEqual(['Switch to Haiku 5.5', 'Stay on Opus 5.5'])
  })

  test('a terminal beside the app can still switch itself: routed, and /model at the end', async ($, on) => {
    const world = newWorld({ surfaces: ['desktop', 'terminal'], replies: [verdict('opus')], answer: 'Switch to Opus 5.5' })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK)
    await step($, SONNET)
    await endTurn($)
    await settle()

    expect(result.text).toBe(TASK)
    expect(seen.steps).toEqual([{ model: OPUS }])
    expect(seen.commands).toEqual([{ command: 'model', args: 'opus' }])
    expect(seen.fills).toHaveLength(0)
  })

  test('a failing check elsewhere never turns into a drop', async ($, on) => {
    const world = newWorld({ surfaces: [...DESKTOP], modelThrows: true })
    mountWorld(on, world)

    expect(await submit($, TASK, { kind: 'sdk' })).toEqual({ text: TASK })
  })
})

describe('Stay', () => {
  test('choosing Stay leaves the prompt and every step as they were', async ($, on) => {
    const world = newWorld({ replies: [verdict('opus')], answer: 'Stay on Sonnet 5.5' })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK)
    await step($, SONNET)
    await endTurn($)

    expect(result).toEqual({ text: TASK })
    expect(seen.steps).toEqual([{ model: SONNET }])
    expect(seen.commands).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('dismissing the dialog is Stay, and the prompt still runs', async ($, on) => {
    const world = newWorld({ replies: [verdict('opus')], answer: null })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK)
    await step($, SONNET)

    expect(seen.asked).toHaveLength(1)
    expect(result).toEqual({ text: TASK })
    expect(seen.steps).toEqual([{ model: SONNET }])
  })

  test('free text typed under Other is Stay', async ($, on) => {
    const world = newWorld({ replies: [verdict('opus')], answer: 'switch to opus please' })
    const seen = mountWorld(on, world)

    const result = await submit($, TASK)
    await step($, SONNET)

    expect(result).toEqual({ text: TASK })
    expect(seen.steps).toEqual([{ model: SONNET }])
  })
})

describe('never blocks the prompt', () => {
  test('a classifier that throws still lets the prompt through', async ($, on) => {
    const seen = mountWorld(on, newWorld({ classifierThrows: true }))

    const result = await submit($, TASK)

    expect(result).toEqual({ text: TASK })
    expect(seen.statuses).toEqual(['Checking model fit…', undefined])
    expect(seen.asked).toHaveLength(0)
  })
})
