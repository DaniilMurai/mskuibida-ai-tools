// Story points per stage: 1 each, a Unit its own, and <intent>/stage-story-points.txt to override a stage or the rate.
import { test, expect, describe } from 'claude-code/testing'
import { aidlc } from '../src/providers/aidlc'
import { parseStagePoints, stagePointsOf } from '../src/providers/aidlc/stage-points'
import * as s from '../fixtures/scenarios'
import type { VirtualTree } from '../fixtures/virtual'
import type { PanelModel } from '../types'
import { ctxOf, mockHost, OPTIONS } from './world'

const INTENT_DIR = `${s.ROOT}/aidlc/spaces/default/intents/${s.INTENT}`
const FILE = `${INTENT_DIR}/stage-story-points.txt`
const KNOWN = ['requirements-analysis', 'user-stories', 'domain-design', 'units-generation']

describe('parseStagePoints', () => {
  test('no file: every stage 1, and not present', () => {
    const points = parseStagePoints(null, KNOWN)
    expect(points.isPresent).toBe(false)
    expect(stagePointsOf(points, 'domain-design')).toBe(1)
  })

  test('<stage>: <points>, with =, comma or spaces; default sets the rate; comments and blanks skipped; any case', () => {
    const points = parseStagePoints(
      ['# heavier design', '', 'default: 2', 'Domain-Design: 3', 'user-stories = 0.5', 'units-generation,4', 'requirements-analysis 1  # trailing'].join('\n'),
      KNOWN,
    )
    expect(points.isPresent).toBe(true)
    expect(points.fallback).toBe(2)
    expect([...points.byStage]).toEqual([
      ['domain-design', 3],
      ['user-stories', 0.5],
      ['units-generation', 4],
      ['requirements-analysis', 1],
    ])
    expect(points.unknown).toEqual([])
    expect(points.unreadable).toEqual([])
  })

  test('the last line for a stage wins', () => {
    expect(stagePointsOf(parseStagePoints('domain-design: 3\ndomain-design: 5\n', KNOWN), 'domain-design')).toBe(5)
  })

  test('a name that is no stage, and a line that is not <stage>: <points>, count nothing and are reported', () => {
    const points = parseStagePoints('domian-design: 3\ndomain-design three\n: 4\ndomian-design: 2\n', KNOWN)
    expect(points.byStage.size).toBe(0)
    expect(points.unknown).toEqual(['domian-design'])
    expect(points.unreadable).toEqual([2, 3])
  })
})

/** Inception: two stages done, two not; Construction not reached. */
function world(file: string | null): VirtualTree {
  const state = s.stateOf({
    lifecycle: 'INCEPTION',
    current: 'domain-design',
    progress: { Inception: 'Active' },
    phases: {
      INCEPTION: ['- [x] requirements-analysis — EXECUTE', '- [x] user-stories — EXECUTE', '- [-] domain-design — EXECUTE', '- [-] units-generation — SKIP'],
    },
  })
  return {
    files: {
      [s.paths.statePath]: state,
      [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n`,
      ...(file === null ? {} : { [FILE]: file }),
    },
  }
}

async function load(t: VirtualTree): Promise<PanelModel> {
  const ctx = ctxOf(t, s.ROOT, s.SESSION, OPTIONS, mockHost())
  const detection = await aidlc.detect(ctx)
  if (!detection) throw new Error('expected a detection')
  return aidlc.load(ctx, detection)
}

describe('the plan by stage points', () => {
  test('without the file and without Units, every stage is 1 point: the plain percent, no story-points label', async () => {
    const model = await load(world(null))
    expect(model.overall.percent).toBe(Math.round((2 / 3) * 100))
    expect(model.overall.label).toBeUndefined()
  })

  test('the file reweighs the plan and the phase ring, and the heading says it counts by story points', async () => {
    const model = await load(world('domain-design: 4\n'))
    // Done: 1 + 1. All: 1 + 1 + 4 (units-generation is skipped).
    expect(model.overall.percent).toBe(Math.round((2 / 6) * 100))
    expect(model.overall.label).toBe('33% done by story points, 2 of 6 pt')
    expect(model.sections.find(one => one.id === 'INCEPTION')?.percent).toBe(33)
  })

  test('default changes the rate of every stage the file does not name', async () => {
    const model = await load(world('default: 2\ndomain-design: 6\n'))
    expect(model.overall.label).toBe('40% done by story points, 4 of 10 pt')
  })

  test('a file with lines that count nothing says so under Needs attention', async () => {
    const model = await load(world('domian-design: 4\nbroken line here\n'))
    const gate = model.gates.find(one => one.id === 'stage-points')
    expect(gate?.title).toBe('stage-story-points.txt has lines that count nothing')
    expect(gate?.caption).toBe('No stage of this plan: domian-design. Not read, not <stage>: <points>: line 2.')
    expect(gate?.isAttentionOnly).toBe(true)
    expect((await load(world('domain-design: 4\n'))).gates.some(one => one.id === 'stage-points')).toBe(false)
  })
})
