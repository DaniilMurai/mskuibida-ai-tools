// The provider seam: which provider claims a repo, and what buildModel and
// runAction do with it. The second provider is a fake defined here.
import { test, expect, describe } from 'claude-code/testing'
import { PROVIDERS, detectPlan } from '../src/detect'
import { buildModel, runAction } from '../src/model'
import { aidlc } from '../src/providers/aidlc'
import * as real from '../fixtures/real-sample'
import * as s from '../fixtures/scenarios'
import type { Detection, PanelModel, Provider, ProviderId } from '../types'
import { ctxOf, stageModel } from './world'

/** A provider that finds a plan at the given root and loads a canned model. */
function fake(id: ProviderId, behaviour: 'hit' | 'miss' | 'throws', log: string[] = []): Provider {
  return {
    id,
    async detect() {
      log.push(`detect:${id}`)
      if (behaviour === 'throws') throw new Error(`${id} blew up`)
      return behaviour === 'hit' ? { provider: id, root: '/fake', detail: { from: id } } : null
    },
    async load(_ctx, detection: Detection) {
      log.push(`load:${id}`)
      return stageModel({ provider: id, root: detection.root })
    },
    async act(_ctx, _detection, actionId) {
      log.push(`act:${id}:${actionId}`)
      return stageModel({ provider: id, header: { ...stageModel().header, title: `acted-${actionId}` } })
    },
  }
}

const ctx = () => ctxOf(real.tree, real.ROOT, real.sessions.live)

describe('detectPlan', () => {
  test('the shipped providers are aidlc, then ledger', () => {
    expect(PROVIDERS.map(provider => provider.id)).toEqual(['aidlc', 'ledger'])
  })

  test('an AI-DLC workspace is detected by the aidlc provider', async () => {
    const found = await detectPlan(ctx())
    expect(found?.provider).toBe(aidlc)
    expect(found?.detection.root).toBe(real.ROOT)
  })

  test('no plan is null', async () => {
    expect(await detectPlan(ctxOf(s.v1Only, '/work/legacy', 'x'))).toBeNull()
    expect(await detectPlan(ctx(), [])).toBeNull()
  })

  test('providers are tried in order and the first hit wins', async () => {
    const log: string[] = []
    const found = await detectPlan(ctx(), [fake('docs', 'miss', log), fake('ledger', 'hit', log), fake('aidlc', 'hit', log)])
    expect(found?.provider.id).toBe('ledger')
    expect(found?.detection.detail).toEqual({ from: 'ledger' })
    expect(log).toEqual(['detect:docs', 'detect:ledger'])
  })

  test('a provider that throws counts as a miss: the next one is tried', async () => {
    const log: string[] = []
    const found = await detectPlan(ctx(), [fake('docs', 'throws', log), fake('ledger', 'hit', log)])
    expect(found?.provider.id).toBe('ledger')
    expect(log).toEqual(['detect:docs', 'detect:ledger'])
  })

  test('only throwing and missing providers: null', async () => {
    expect(await detectPlan(ctx(), [fake('docs', 'throws'), fake('ledger', 'miss')])).toBeNull()
  })

  test('aidlc stays first over a later provider that would also hit', async () => {
    const found = await detectPlan(ctx(), [aidlc, fake('ledger', 'hit')])
    expect(found?.provider.id).toBe('aidlc')
  })
})

describe('buildModel', () => {
  test('detect, then the winner loads', async () => {
    const model = await buildModel(ctx())
    expect(model?.provider).toBe('aidlc')
    expect(model?.header.title).toBe('shop-mvp-restart')
  })

  test('no plan: null', async () => {
    expect(await buildModel(ctxOf(s.v1Only, '/work/legacy', 'x'))).toBeNull()
  })

  test('only the winning provider loads', async () => {
    const log: string[] = []
    const model = await buildModel(ctx(), [fake('ledger', 'hit', log), fake('docs', 'hit', log)])
    expect(model?.provider).toBe('ledger')
    expect(log).toEqual(['detect:ledger', 'load:ledger'])
  })

  test('a load that throws propagates: the caller decides', async () => {
    const broken: Provider = { id: 'ledger', detect: async () => ({ provider: 'ledger', root: '/x', detail: {} }), load: async () => { throw new Error('bad plan') } }
    await expect(buildModel(ctx(), [broken])).rejects.toThrow('bad plan')
  })
})

describe('runAction', () => {
  test('the winning provider acts and its model comes back', async () => {
    const log: string[] = []
    const model: PanelModel | null = await runAction(ctx(), 'go', [fake('ledger', 'hit', log)])
    expect(model?.header.title).toBe('acted-go')
    expect(log).toEqual(['detect:ledger', 'act:ledger:go'])
  })

  test('a provider without act, or no plan: null', async () => {
    expect(await runAction(ctx(), 'go')).toBeNull()
    expect(await runAction(ctxOf(s.v1Only, '/work/legacy', 'x'), 'go')).toBeNull()
  })
})
