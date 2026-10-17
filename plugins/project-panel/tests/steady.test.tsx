// A button keeps its press handle across redraws (src/render/steady.ts). `<Button>` mints a fresh handle on every call
// and the host retires the old drawing's handles when the next one arrives, so a press sent from a drawing the surface
// had not replaced yet was lost and the second press worked ("ui_press not handled" in the desktop log).
import { describe, expect, test } from 'claude-code/testing'

import { steadyPresses } from '../src/render/steady'
import { MOUNT, seedModel, stageModel } from './world'

type Tree = { type?: string; props?: { key?: string }; press?: { plugin: string; handle: number }; children?: Tree[] }

const button = (key: string, handle: number): Tree => ({ type: 'Button', props: { key }, press: { plugin: '', handle } })
const box = (...children: Tree[]): Tree => ({ type: 'Box', props: {}, children })

const handlesOf = (tree: Tree): Record<string, number> => {
  const found: Record<string, number> = {}
  const walk = (node: Tree) => {
    if (node.press && typeof node.props?.key === 'string') found[node.props.key] ??= node.press.handle
    node.children?.forEach(walk)
  }
  walk(tree)
  return found
}

describe('steadyPresses', () => {
  test('a key keeps the handle it was first drawn with; a new key keeps its own', () => {
    const held = new Map<string, number>()
    expect(handlesOf(steadyPresses(box(button('a', 1), box(button('b', 2))), held))).toEqual({ a: 1, b: 2 })
    expect(handlesOf(steadyPresses(box(button('a', 3), box(button('b', 4)), button('c', 5)), held))).toEqual({ a: 1, b: 2, c: 5 })
    // A key gone for a drawing and back keeps its handle too.
    steadyPresses(box(button('c', 6)), held)
    expect(handlesOf(steadyPresses(box(button('a', 7)), held))).toEqual({ a: 1 })
  })

  test('a key drawn twice in one tree keeps its fresh handle the second time', () => {
    const held = new Map<string, number>([['a', 1]])
    const tree = steadyPresses(box(button('a', 2), button('a', 3)), held)
    expect(tree.children?.map(child => child.press?.handle)).toEqual([1, 3])
  })

  test("another plugin's press and a tree without buttons pass untouched", () => {
    const held = new Map<string, number>([['a', 1]])
    const foreign: Tree = { type: 'Button', props: { key: 'a' }, press: { plugin: 'other', handle: 9 } }
    expect(steadyPresses(box(foreign), held).children?.[0]).toBe(foreign)
    const plain = box({ type: 'Text', props: {} })
    expect(steadyPresses(plain, held)).toEqual(plain)
  })
})

describe('the pane across redraws', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`every button keeps its handle when a press redraws the pane, on ${surface}`, async ($, on) => {
      seedModel(on, stageModel())
      const ui = await $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: 60 } })
      const before = handlesOf((await ui.drawn()) as Tree)
      expect(before['section:CONSTRUCTION']).toBeDefined()
      await ui.press({ key: 'section:CONSTRUCTION' })
      const after = handlesOf((await ui.drawn()) as Tree)
      for (const [key, handle] of Object.entries(before)) if (key in after) expect(`${key}#${after[key]}`).toBe(`${key}#${handle}`)
      // The press still lands on the redrawn pane, and again.
      await ui.press({ key: 'section:CONSTRUCTION' })
      expect(handlesOf((await ui.drawn()) as Tree)['section:CONSTRUCTION']).toBe(before['section:CONSTRUCTION'])
      await ui.unmount()
    })
  }
})
