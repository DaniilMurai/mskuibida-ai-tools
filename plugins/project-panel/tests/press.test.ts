// A press on the pane, worked out from the button's key and the state now (src/render/press.ts): what the ui.press hook
// runs, so a press lands even on a drawing whose closures the surface let go (a pane hidden and shown again).
import { describe, expect, test } from 'claude-code/testing'
import { pressAction } from '../src/render/press'
import { ledgerModel, sideJobModel, stageModel } from './world'

describe('pressAction', () => {
  test('refresh, whatever the model', () => {
    expect(pressAction(null, {}, 'refresh')).toEqual({ kind: 'refresh' })
    expect(pressAction(stageModel(), {}, 'refresh')).toEqual({ kind: 'refresh' })
  })

  test('a section flips from where it stands: its own fold, else the provider default', () => {
    const model = stageModel()
    // Inception is the active section, open by default; Construction closed.
    expect(pressAction(model, {}, 'section:INCEPTION')).toEqual({ kind: 'toggle', key: 'INCEPTION', isOpen: false })
    expect(pressAction(model, {}, 'section:CONSTRUCTION')).toEqual({ kind: 'toggle', key: 'CONSTRUCTION', isOpen: true })
    expect(pressAction(model, { CONSTRUCTION: true }, 'section:CONSTRUCTION')).toEqual({ kind: 'toggle', key: 'CONSTRUCTION', isOpen: false })
    expect(pressAction(model, {}, 'section:NOPE')).toBeNull()
  })

  test('a repeated section id is pressed under its unique key', () => {
    const model = stageModel()
    model.sections.push({ ...model.sections[0]!, isCollapsed: true })
    expect(pressAction(model, {}, `section:${model.sections[0]!.id}~${model.sections.length - 1}`)?.kind).toBe('toggle')
  })

  test('the fold rows set their own keys', () => {
    const model = stageModel()
    expect(pressAction(model, {}, 'more:INCEPTION')).toEqual({ kind: 'toggle', key: 'INCEPTION#all', isOpen: true })
    expect(pressAction(model, {}, 'less:INCEPTION')).toEqual({ kind: 'toggle', key: 'INCEPTION#all', isOpen: false })
    expect(pressAction(model, {}, 'rest:INCEPTION')).toEqual({ kind: 'toggle', key: 'INCEPTION#rest', isOpen: true })
    expect(pressAction(model, {}, 'restless:INCEPTION')).toEqual({ kind: 'toggle', key: 'INCEPTION#rest', isOpen: false })
  })

  test("the plan fold flips from the provider default, else the person's", () => {
    const folded = { ...sideJobModel(), isPlanCollapsed: true }
    expect(pressAction(folded, {}, 'plan:fold')).toEqual({ kind: 'toggle', key: '#plan', isOpen: true })
    expect(pressAction(folded, { '#plan': true }, 'plan:fold')).toEqual({ kind: 'toggle', key: '#plan', isOpen: false })
  })

  test('Next fills its command; a model without one fills nothing', () => {
    expect(pressAction(stageModel(), {}, 'next:fill')).toEqual({ kind: 'fill', command: '/aidlc' })
    const { next: _, ...bare } = stageModel()
    expect(pressAction(bare, {}, 'next:fill')).toBeNull()
  })

  test('an attention row fills its own command, by its key', () => {
    const model = stageModel({
      gates: [{ id: 'g', kind: 'review-requested', tone: 'accent', title: 'Review PR #34', sectionId: '', isAttentionOnly: true, command: '/pr-review:review-pr 34' }],
    })
    expect(pressAction(model, {}, 'attention:fill:gate:g')).toEqual({ kind: 'fill', command: '/pr-review:review-pr 34' })
    expect(pressAction(model, {}, 'attention:fill:gate:other')).toBeNull()
  })

  test('a provider action, by its key', () => {
    const model = ledgerModel()
    const id = model.actions?.[0]?.id
    expect(id).toBeDefined()
    expect(pressAction(model, {}, `action:${id}`)).toEqual({ kind: 'action', id })
  })

  test('a key the pane does not draw is left to the drawing', () => {
    expect(pressAction(stageModel(), {}, 'reopen')).toBeNull()
    expect(pressAction(null, {}, 'section:INCEPTION')).toBeNull()
  })
})
