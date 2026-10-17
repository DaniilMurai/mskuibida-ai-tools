// Construction counted by story points, and a Unit claimed at this checkout: the section fields the renderer draws
// (countLabel, sideCount, titleTag) and the Units section that is no phase (isSupplement).
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { phasesOf } from '../src/render/stepper'
import { MOUNT, item, section, seedModel, stageModel } from './world'
import type { PanelModel, Section } from '../types'

type Surface = 'terminal' | 'desktop'
type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string }) => Promise<Found[]> }

const bare = (text: string) => text.replace(/ /g, ' ').trim()
const shown = async (ui: unknown) => (await (ui as Probe).findAll({})).filter(el => el.type === 'Text').map(el => bare(el.text))

async function draw($: Engine, on: On, model: PanelModel, surface: Surface, columns = 60) {
  seedModel(on, model)
  return $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: columns } })
}

function claimedModel(): PanelModel {
  const base = stageModel()
  const construction: Section = {
    ...section('CONSTRUCTION', 'Construction', 'active', [
      item('functional-design', 'done', { ordinal: '3.1' }),
      item('nfr-requirements', 'open', { ordinal: '3.2', isCurrent: true }),
      item('nfr-design', 'planned', { ordinal: '3.3' }),
    ]),
    ordinal: '3',
    titleTag: 'U3 u3-day-page',
    caption: 'U3 u3-day-page, 13 pt: claimed at this checkout',
    isDetail: true,
    isCollapsed: false,
  }
  const units: Section = {
    ...section('UNITS', 'Units', 'active', [item('unit:u1', 'done', { title: 'U1 u1-api-core' }), item('unit:u3', 'open', { title: 'U3 u3-day-page' })]),
    countLabel: '13/45 pt',
    sideCount: '1/6 units',
    isSupplement: true,
    isCollapsed: true,
  }
  const sections = base.sections.filter(one => one.id !== 'CONSTRUCTION' && one.id !== 'INCEPTION')
  return { ...base, sections: [...sections.slice(0, 2), construction, units, ...sections.slice(2)] }
}

describe('Construction by story points and a claimed Unit, drawn', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the points count stands in for done/total, with the Units done beside it, on ${surface}`, async ($, on) => {
      const ui = await draw($, on, claimedModel(), surface)
      const texts = await shown(ui)
      expect(texts).toContain('13/45 pt')
      expect(texts).toContain('1/6 units')
      expect(texts.indexOf('1/6 units')).toBeLessThan(texts.indexOf('13/45 pt'))
      // The claimed Unit's tag sits beside Construction's title; its stages count as rows.
      expect(texts).toContain('U3 u3-day-page')
      expect(texts).toContain('1/3')
      await ui.unmount()
    })
  }

  test('on the desktop the tag is an accent pill and the Units count a grey one', async ($, on) => {
    const ui = await draw($, on, claimedModel(), 'desktop')
    const all = (await (ui as Probe).findAll({ type: 'Text' })) as Found[]
    const tag = all.find(el => bare(el.text) === 'U3 u3-day-page')
    const side = all.find(el => bare(el.text) === '1/6 units')
    expect(tag?.props.color).toBe('claude')
    expect(typeof tag?.props.backgroundColor).toBe('string')
    expect(typeof side?.props.backgroundColor).toBe('string')
    await ui.unmount()
  })

  test('a built section keeps its ✓ after a points count', async ($, on) => {
    const model = claimedModel()
    const units = model.sections.find(one => one.id === 'UNITS')!
    units.status = 'built'
    units.countLabel = '45/45 pt'
    const ui = await draw($, on, model, 'terminal')
    expect(await shown(ui)).toContain('45/45 pt ✓')
    await ui.unmount()
  })

  test('Units is no phase: the stepper and the phase cards leave it out, the list keeps it', async ($, on) => {
    const model = claimedModel()
    expect(phasesOf(model).map(one => one.id)).not.toContain('UNITS')
    const ui = await draw($, on, model, 'desktop', 110)
    const keys = (await (ui as unknown as { findAll: (q: { type: string }) => Promise<Found[]> }).findAll({ type: 'Button' })).map(b => b.props.key)
    expect(keys).toContain('section:UNITS')
    // The cards are the phases; Units' row stays a list heading under them, with its counts.
    expect(await shown(ui)).toContain('13/45 pt')
    await ui.unmount()
  })
})
