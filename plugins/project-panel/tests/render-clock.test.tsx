// The pane's render reads no clock. A render that reads `$.clock` is invalidated by it, and every redraw retires the
// drawn buttons' press handles: a click landing across a redraw was lost, so a fold took a second click. Here the
// clock throws on every read, so a render that asked it would fail and the engine would draw its own tree instead.
import { describe, expect, test } from 'claude-code/testing'

import { MOUNT, seedModel, stageModel } from './world'

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string }) => Promise<Found[]> }

describe('the pane and the clock', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`it draws, folds and draws again without reading the clock, on ${surface}`, async ($, on) => {
      seedModel(on, stageModel(), { hasClock: false })
      on('clock.now', async () => {
        throw new Error('the pane read the clock while drawing')
      })
      const ui = await $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: 60 } })
      const shown = async () => (await (ui as unknown as Probe).findAll({})).map(el => el.text)
      expect(await shown()).toContain('SHOP-MVP-RESTART')
      expect(await shown()).not.toContain('u1')
      await ui.press({ key: 'section:CONSTRUCTION' })
      expect(await shown()).toContain('u1')
      await ui.press({ key: 'section:CONSTRUCTION' })
      expect(await shown()).not.toContain('u1')
      await ui.unmount()
    })
  }
})
