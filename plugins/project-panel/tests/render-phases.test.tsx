import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { isPhased, stepperAlt, stepperSource } from '../src/render/stepper'
import { MOUNT, item, section, seedModel, stageModel } from './world'
import type { PanelModel } from '../types'

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'
type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }

const NARROW = 36
const MEDIUM = 60
const WIDE = 92

async function draw($: Engine, on: On, model: PanelModel, surface: Surface, columns: number) {
  seedModel(on, model)
  return $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: columns } })
}

const svgs = async (ui: unknown) => (await (ui as Probe).findAll({ type: 'Svg' })) as Found[]
/** The stepper is the one Svg with no size of its own. */
const stepperOf = async (ui: unknown) => (await svgs(ui)).filter(svg => svg.props.width === undefined)
const shown = async (ui: unknown) => (await (ui as Probe).findAll({})).filter(el => el.type === 'Text' || el.type === 'Button').map(el => el.text)

/** A plan of `count` phases, the first built, the second active with the current item. */
function phasesModel(count: number): PanelModel {
  const sections = Array.from({ length: count }, (_, index) =>
    index === 0
      ? section(`P${index}`, `Phase ${index}`, 'built', [item(`a${index}`, 'done')])
      : index === 1
        ? section(`P${index}`, `Phase ${index}`, 'active', [item(`b${index}`, 'done'), item(`c${index}`, 'open', { isCurrent: true })])
        : section(`P${index}`, `Phase ${index}`, 'planned', [item(`d${index}`, 'planned')]),
  )
  return stageModel({ sections })
}

describe('the phase stepper', () => {
  for (const [name, columns] of [
    ['narrow', NARROW],
    ['medium', MEDIUM],
  ] as const) {
    test(`desktop, ${name}: one stepper under the header, before the Now card`, async ($, on) => {
      const ui = await draw($, on, stageModel(), 'desktop', columns)
      const steppers = await stepperOf(ui)
      expect(steppers).toHaveLength(1)
      const all = await svgs(ui)
      // Drawn before the plan's rings.
      expect(all[0]?.props.width).toBeUndefined()
      await ui.unmount()
    })
  }

  test('its markup: a node per phase, done as a green check, the current phase in the accent, skipped dashed', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const source = String((await stepperOf(ui))[0]?.props.source)
    expect(source.startsWith('<svg')).toBe(true)
    // Two built phases: two filled green nodes, each with its check path.
    expect(source.match(/<circle [^>]*fill="#4eba65"/g)).toHaveLength(2)
    expect(source.match(/<path /g)).toHaveLength(2)
    // The current phase's label is bold and in the accent; the others in the fixed mid-tone.
    expect(source).toMatch(/font-weight="700" fill="#d97757"[^>]*>Inception<\/text>/)
    expect(source).toMatch(/fill="#7e7e7e"[^>]*>Construction<\/text>/)
    // Operation is skipped: a dashed node and a dashed line into it.
    expect(source).toContain('stroke-dasharray="3 3"')
    expect(source).toContain('stroke-dasharray="3 4"')
    // Fixed tones only: an Svg is drawn as an image, where currentColor need not theme.
    expect(source).not.toContain('currentColor')
    await ui.unmount()
  })

  test('the terminal has none: its Plan block says the same in glyphs', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    expect(await svgs(ui)).toEqual([])
    await ui.unmount()
  })

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`${surface} draws it too`, async ($, on) => {
      const ui = await draw($, on, stageModel(), surface, MEDIUM)
      expect(await stepperOf(ui)).toHaveLength(1)
      await ui.unmount()
    })
  }

  test('the wide pane draws phase cards instead', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    expect(await stepperOf(ui)).toEqual([])
    await ui.unmount()
  })

  test('only for a handful of phases: 2 to 7', async ($, on) => {
    expect(isPhased(phasesModel(1))).toBe(false)
    expect(isPhased(phasesModel(2))).toBe(true)
    expect(isPhased(phasesModel(7))).toBe(true)
    expect(isPhased(phasesModel(8))).toBe(false)
    // Proposed sections are not phases.
    const proposed = phasesModel(2)
    proposed.sections.push(section('X', 'Suggested', 'planned', [], { isProposed: true }))
    expect(isPhased(proposed)).toBe(true)
    const ui = await draw($, on, phasesModel(8), 'desktop', MEDIUM)
    expect(await stepperOf(ui)).toEqual([])
    await ui.unmount()
  })

  test('titles are escaped and cut to the room between nodes', () => {
    const sections = [section('A', 'Build <api> & "docs"', 'active', [item('a', 'open', { isCurrent: true })]), section('B', 'B', 'planned', [item('b', 'planned')])]
    const source = stepperSource(sections, 0, 400)
    expect(source).toContain('Build &lt;api&gt; &amp; &quot;docs&quot;')
    expect(source).not.toContain('<api>')
    // Seven phases in 200 px leave about 28 px a label: four characters, the last an ellipsis.
    const tight = Array.from({ length: 7 }, (_, index) => section(`S${index}`, 'Construction', 'planned', [item(`i${index}`, 'planned')]))
    expect(stepperSource(tight, -1, 200)).toContain('>Con…</text>')
  })

  test('an empty phase reads as not included yet, and the alt names every phase', () => {
    const sections = [section('A', 'Inception', 'active', [item('a', 'done'), item('b', 'open', { isCurrent: true })]), section('B', 'Construction', 'planned', [])]
    expect(stepperAlt(sections, 0)).toBe('Phases: Inception 50% done, current, Construction not included yet')
    expect(stepperSource(sections, 0, 300)).toMatch(/stroke-dasharray="3 3"\/><text [^>]*>2<\/text>/)
  })
})

/** Construction before its Units exist: items that stand for work not defined yet, no count, no ring. */
function uncountedModel(): PanelModel {
  const model = stageModel()
  const construction = model.sections.find(one => one.id === 'CONSTRUCTION')!
  construction.isUncounted = true
  delete construction.counts
  delete construction.percent
  return model
}

describe('not included yet', () => {
  test('the stepper draws an uncounted phase dashed, as an empty one', async ($, on) => {
    const ui = await draw($, on, uncountedModel(), 'desktop', MEDIUM)
    const [found] = await stepperOf(ui)
    expect(found?.props.alt).toContain('Construction not included yet')
    expect(String(found?.props.source)).toMatch(/stroke-dasharray="3 3"\/><text [^>]*>4<\/text>/)
    await ui.unmount()
  })

  test('its card says not included yet in the warning colour, with no ring and no strip', async ($, on) => {
    const ui = await draw($, on, uncountedModel(), 'desktop', WIDE)
    const word = (await (ui as Probe).findAll({ type: 'Text' })).filter(el => el.text === 'not included yet')
    expect(word).toHaveLength(1)
    expect(word[0]?.props.color).toBe('warning')
    const all = await svgs(ui)
    // Initialization, Ideation and Inception keep theirs; Construction and Operation have none.
    expect(all.filter(svg => svg.props.width === 20)).toHaveLength(3)
    expect(all.filter(svg => svg.props.height === 6)).toHaveLength(3)
    await ui.unmount()
  })
})

describe('the wide pane: phase cards', () => {
  test('each phase is a card whose title presses as its heading did, with the same key', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    const keys = (await (ui as Probe).findAll({ type: 'Button' })).map(button => button.props.key)
    for (const id of ['INITIALIZATION', 'IDEATION', 'INCEPTION', 'CONSTRUCTION', 'OPERATION']) expect(keys).toContain(`section:${id}`)
    // The titles carry no ▾/▸: the card's border says which is open.
    expect(await shown(ui)).toContain('Inception')
    expect((await shown(ui)).some(text => /^[▾▸] /.test(text))).toBe(false)
    await ui.unmount()
  })

  test('the open phase shows its items under the cards; a press opens or closes one, the rest stay', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    // units-generation is Inception's (open, the active phase), u1 Construction's (closed).
    expect(await shown(ui)).toContain('units-generation')
    expect(await shown(ui)).not.toContain('u1')
    await ui.press({ key: 'section:CONSTRUCTION' })
    expect(await shown(ui)).toContain('units-generation')
    expect(await shown(ui)).toContain('u1')
    expect(await shown(ui)).toContain('per unit: billing, catalog')
    await ui.press({ key: 'section:INCEPTION' })
    expect(await shown(ui)).not.toContain('units-generation')
    expect(await shown(ui)).toContain('u1')
    await ui.unmount()
  })

  // The parked gate sits in Inception. Closed, its card carries a ‖ beside the Needs attention row's, as a
  // closed heading does; the same gate made attention-only (never drawn in the plan) leaves the card bare.
  const marksClosed = async ($: Engine, on: On, model: PanelModel) => {
    const ui = await draw($, on, model, 'desktop', WIDE)
    await ui.press({ key: 'section:INCEPTION' })
    const count = (await shown(ui)).filter(text => text === '‖').length
    await ui.unmount()
    return count
  }
  test('a closed phase that holds a gate marks it on its card', async ($, on) => {
    expect(await marksClosed($, on, stageModel())).toBe(2)
  })
  test('an attention-only gate leaves the card bare', async ($, on) => {
    const base = stageModel()
    expect(await marksClosed($, on, { ...base, gates: base.gates.map(gate => ({ ...gate, isAttentionOnly: true })) })).toBe(1)
  })

  test('a card holds a 20 px ring, its count and its strip; skipped has no ring', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    const all = await svgs(ui)
    // Initialization, Ideation, Inception, Construction; Operation is skipped.
    expect(all.filter(svg => svg.props.width === 20)).toHaveLength(4)
    expect(all.filter(svg => svg.props.height === 6)).toHaveLength(4)
    expect(await shown(ui)).toContain('skipped')
    await ui.unmount()
  })

  test('the terminal keeps its list of headings', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'terminal', WIDE)
    expect((await shown(ui)).some(text => text.startsWith('▾ ') && text.includes('Inception'))).toBe(true)
    await ui.unmount()
  })

  test('more than 7 phases keeps the list of headings on the desktop too', async ($, on) => {
    const ui = await draw($, on, phasesModel(8), 'desktop', WIDE)
    expect((await shown(ui)).some(text => /^[▾▸] Phase 1$/.test(text))).toBe(true)
    await ui.unmount()
  })
})
