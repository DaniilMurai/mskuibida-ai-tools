// A side job in the renderer: the Now card says what the session is on (its branch, its PR as a link, its
// distance from main) and offers no Next; the plan folds behind a toggle when the provider says so, and the
// person's press opens it (and folds it again). A model without the fold flag draws the plan open, with no toggle.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bare } from './rich'
import { MOUNT, seedModel, sideJobModel } from './world'
import type { PanelModel } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const WIDTHS = [
  ['narrow', 36],
  ['medium', 60],
  ['wide', 92],
] as const

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }

const PR_URL = 'https://example.test/acme/shop/pull/25'

/** A side job with its context, the plan folded and nothing to run next. */
function foldedSideJob(over: Partial<PanelModel> = {}): PanelModel {
  const base = sideJobModel()
  const { next: _next, ...rest } = base
  return {
    ...rest,
    header: {
      ...base.header,
      caption: "This session is not bound to a stage of shop-mvp-restart. The intent's progress is folded under Plan.",
      context: [
        { id: 'branch', text: 'on claude/side-work' },
        { id: 'pr', text: 'PR #25, awaiting dev-b', href: PR_URL },
        { id: 'distance', text: '3 ahead, 2 behind main', tone: 'warning' },
      ],
    },
    isPlanCollapsed: true,
    ...over,
  }
}

async function draw($: Engine, on: On, model: PanelModel, surface: Surface, columns: number) {
  seedModel(on, model)
  return $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: columns } })
}

async function texts(ui: unknown): Promise<string[]> {
  const all = await (ui as Probe).findAll({})
  return all.filter(el => el.type === 'Text' || el.type === 'Button').map(el => bare(el.text))
}

describe('the side job\'s Now card', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`names the branch, the PR and the distance, and no command, at ${name} on ${surface}`, async ($, on) => {
        const ui = await draw($, on, foldedSideJob(), surface, columns)
        const shown = await texts(ui)
        expect(shown).toContain('on claude/side-work')
        expect(shown).toContain('PR #25, awaiting dev-b')
        expect(shown).toContain('3 ahead, 2 behind main')
        if (surface === 'terminal') expect(shown.join('\n')).not.toContain('/aidlc')
        else {
          // The desktop's Needs attention card says why the workflow is parked (and names /aidlc there); Next's own command is not drawn.
          expect(shown).not.toContain('/aidlc')
          expect(shown.filter(line => line.includes('/aidlc'))).toEqual(['The workflow was parked 2026-09-04 01:19. Resume it with /aidlc.'])
        }
        expect(shown).not.toContain('Put in prompt')
        await ui.unmount()
      })
    }

    test(`the PR line is a link, the others are not, on ${surface}`, async ($, on) => {
      const ui = await draw($, on, foldedSideJob(), surface, 60)
      const links = (await (ui as unknown as Probe).findAll({ type: 'Link' })).filter(link => link.props.href === PR_URL)
      expect(links.length).toBe(1)
      await ui.unmount()
    })

    test(`a stage session never draws context lines, even if a model carries them, on ${surface}`, async ($, on) => {
      const base = foldedSideJob()
      const ui = await draw($, on, { ...base, header: { ...base.header, mode: 'stage', badge: '' } }, surface, 60)
      expect(await texts(ui)).not.toContain('on claude/side-work')
      await ui.unmount()
    })
  }
})

describe('the folded plan', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`is one row: ▸ Plan and its summary, no section, at ${name} on ${surface}`, async ($, on) => {
        const ui = await draw($, on, foldedSideJob(), surface, columns)
        const shown = await texts(ui)
        expect((await (ui as unknown as Probe).findAll({ key: 'plan:fold' }))[0]?.text).toBe('▸ Plan')
        expect(shown).toContain('50% done, 11 of 26')
        expect(await (ui as unknown as Probe).findAll({ key: 'section:INCEPTION' })).toHaveLength(0)
        expect(shown).not.toContain('practices-discovery')
        await ui.unmount()
      })
    }

    test(`a press opens it, a second press folds it again on ${surface}`, async ($, on) => {
      const ui = await draw($, on, foldedSideJob(), surface, 60)
      await ui.press({ key: 'plan:fold' })
      expect((await ui.find({ key: 'plan:fold' }))?.text).toBe('▾ Plan')
      let shown = await texts(ui)
      expect(shown).toContain('50% done, 11 of 26')
      expect(await (ui as unknown as Probe).findAll({ key: 'section:INCEPTION' })).not.toHaveLength(0)

      await ui.press({ key: 'plan:fold' })
      expect((await ui.find({ key: 'plan:fold' }))?.text).toBe('▸ Plan')
      shown = await texts(ui)
      expect(await (ui as unknown as Probe).findAll({ key: 'section:INCEPTION' })).toHaveLength(0)
      await ui.unmount()
    })

    test(`a plan the provider does not fold has no toggle on ${surface}`, async ($, on) => {
      const ui = await draw($, on, foldedSideJob({ isPlanCollapsed: undefined }), surface, 60)
      expect(await (ui as unknown as Probe).findAll({ key: 'plan:fold' })).toHaveLength(0)
      expect(await (ui as unknown as Probe).findAll({ key: 'section:INCEPTION' })).not.toHaveLength(0)
      await ui.unmount()
    })
  }
})
