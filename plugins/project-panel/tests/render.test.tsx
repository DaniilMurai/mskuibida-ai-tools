import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { renderPane } from '../src/render'
import { foldRow, foldedDone, openCap } from '../src/render/item'
import { MOUNT, foldedModel, idleModel, item, ledgerModel, section, seedModel, sideJobModel, stageModel } from './world'
import type { PanelModel } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

/** Narrow (S < 48), medium (M 48-79), wide (L >= 80). */
const WIDTHS = [
  ['narrow', 36],
  ['medium', 60],
  ['wide', 92],
] as const
const NARROW = 36
const MEDIUM = 60
const WIDE = 92

/** The width the left column lays out for: the pane's own below 80, 40% less the 2-column gap from 80. */
const localWidth = (columns: number) => (columns >= 80 ? Math.floor(columns * 0.4) - 2 : columns)
/** True when the Now card and Attention use their stacked (narrow) layouts. */
const isStacked = (columns: number) => localWidth(columns) < 48

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }
type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }

/** Every Text and Button of the drawing, in document order, as shown. */
async function shown(ui: Probe): Promise<string[]> {
  const all = await ui.findAll({})
  return all.filter(el => el.type === 'Text' || el.type === 'Button').map(el => el.text)
}

/** Mounts the Pane over a model held in memory, `columns` wide. */
const held = new WeakMap<object, { model: PanelModel | null }>()
async function draw($: Engine, on: On, model: PanelModel | null, surface: string, columns = MEDIUM) {
  // The hook is registered once per test (before its first `$` call); a later draw swaps the model.
  const holder = held.get(on)
  if (holder) holder.model = model
  else {
    const fresh = { model }
    held.set(on, fresh)
    seedModel(on, () => fresh.model)
  }
  const ui = await $.ui.mount({ ...MOUNT, surface: surface as Surface, props: { ...MOUNT.props, bodyColumns: columns } })
  return { ui }
}

// ── reading the drawn tree ───────────────────────────────────────────────────

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null
const kids = (node: Node): Node[] => (node.children ?? []).filter(isNode)

function textOf(node: Node | string): string {
  if (typeof node === 'string') return node
  if ((node.type === 'Button' || node.type === 'Link') && typeof node.props.label === 'string') return node.props.label
  return (node.children ?? []).map(textOf).join('')
}

/** Every chain root-to-match for the nodes `pred` accepts. */
function chains(root: Node, pred: (node: Node) => boolean, trail: Node[] = []): Node[][] {
  const here = [...trail, root]
  const out: Node[][] = pred(root) ? [here] : []
  for (const child of kids(root)) out.push(...chains(child, pred, here))
  return out
}

const isText = (text: string) => (node: Node) => node.type === 'Text' && textOf(node) === text
const isButton = (key: string) => (node: Node) => node.type === 'Button' && node.props.key === key

async function tree(ui: { drawn: () => Promise<unknown> }): Promise<Node> {
  return (await ui.drawn()) as Node
}

/** The deepest Box holding both nodes. */
function commonBox(root: Node, a: (node: Node) => boolean, b: (node: Node) => boolean): Node {
  const first = chains(root, a)[0] ?? []
  const second = chains(root, b)[0] ?? []
  let at = root
  for (let i = 0; i < Math.min(first.length, second.length) && first[i] === second[i]; i++) at = first[i]!
  return at
}

/** The header block: the first child of the pane's root. */
const headerOf = (root: Node): Node => kids(root)[0]!

describe('header', () => {
  for (const surface of SURFACES) {
    test(`narrow on ${surface}: the title, then a lone ↻; the badge and stamp take row 2`, async ($, on) => {
      const { ui } = await draw($, on, sideJobModel(), surface, NARROW)
      const root = await tree(ui)
      const head = headerOf(root)
      const [row1, row2] = kids(head)

      expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻')
      expect((await ui.find({ key: 'refresh' }))?.props.hotkey).toBe('r')
      expect((await ui.find({ key: 'refresh' }))?.props.plain).toBeUndefined()
      expect(textOf(row1!)).toContain('SHOP-MVP-RESTART')
      expect(textOf(row1!)).not.toContain('checked just now')
      expect(textOf(row1!)).not.toContain('Side job')
      expect(textOf(row2!)).toContain('Side job')
      expect(textOf(row2!)).toContain('checked just now')
      await ui.unmount()
    })

    for (const [name, columns] of WIDTHS.slice(1)) {
      test(`${name} on ${surface}: ↻ Refresh, badge and stamp on row 1`, async ($, on) => {
        const { ui } = await draw($, on, sideJobModel(), surface, columns)
        const [row1, row2] = kids(headerOf(await tree(ui)))

        expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻ Refresh')
        expect(textOf(row1!)).toContain('Side job')
        expect(textOf(row1!)).toContain('checked just now')
        // Nothing else follows row 1: the next block is the Now card.
        expect(row2 === undefined || textOf(row2).includes('Side job') === false).toBe(true)
        await ui.unmount()
      })
    }

    test(`the badge takes its colour from the mode on ${surface}`, async ($, on) => {
      let { ui } = await draw($, on, sideJobModel(), surface)
      expect((await ui.find({ type: 'Text', text: 'Side job' }))?.props.color).toBe('warning')
      await ui.unmount()
      ;({ ui } = await draw($, on, idleModel(), surface))
      expect((await ui.find({ type: 'Text', text: 'Idle' }))?.props.dimColor).toBe(true)
      await ui.unmount()
      const staged = stageModel()
      staged.header.badge = 'Stage'
      ;({ ui } = await draw($, on, staged, surface))
      expect((await ui.find({ type: 'Text', text: 'Stage' }))?.props.color).toBe('claude')
      await ui.unmount()
    })

    test(`the header never overlaps at 36 columns on ${surface}: the title gives way first`, async ($, on) => {
      const model = sideJobModel()
      model.header.title = 'a-very-long-intent-name-that-would-never-fit-in-thirty-six-columns'
      const { ui } = await draw($, on, model, surface, NARROW)
      const root = await tree(ui)
      const [row1, row2] = kids(headerOf(root))
      const title = model.header.title.toUpperCase()

      // The title is truncate-end text in a Box that shrinks...
      const [trail] = chains(row1!, node => node.type === 'Text' && textOf(node) === title)
      const text = trail!.at(-1)!
      expect(text.props.wrap).toBe('truncate-end')
      expect(trail!.at(-2)!.props.flexShrink).toBe(1)
      // ...with an explicit shrink of 1 and a small floor...
      expect(trail!.at(-2)!.props.flexShrink).toBe(1)
      expect(trail!.at(-2)!.props.minWidth).toBe(8)
      // ...and every other child of row 1 is the empty spacer or the Refresh button, which never shrinks.
      const others = kids(row1!).filter(box => !textOf(box).includes(title))
      expect(others.length).toBe(2)
      for (const box of others) {
        expect(box.props.flexGrow === 1 && textOf(box) === '' ? true : box.props.flexShrink === 0 && textOf(box) === '↻').toBe(true)
      }
      // ↻ is on row 1; the badge and the stamp are not.
      expect(textOf(row1!)).toContain('↻')
      expect(textOf(row1!)).not.toContain('Side job')
      expect(textOf(row2!)).toContain('checked just now')
      await ui.unmount()
    })

    test(`the stamp reads "checked 12s ago" with a clock, "read 12:03" without on ${surface}`, async ($, on) => {
      const model = stageModel()
      const now = 1_800_000_000_000
      const handlers = { onRefresh: () => undefined, onToggle: () => undefined, onAction: () => undefined, onFillNext: () => undefined }
      let clock: { now: number; checkedAt?: number } | undefined = { now, checkedAt: now - 12_000 }
      on('ui.render', { component: 'Pane', requestId: 'clocked' }, async ($$, e) =>
        renderPane($$.ui.resolve(e), e.surface, e.props.bodyColumns, model, {}, handlers, clock),
      )
      const stamp = async () => {
        const ui = await $.ui.mount({ ...MOUNT, requestId: 'clocked', surface: surface as Surface, props: { ...MOUNT.props, bodyColumns: MEDIUM } })
        const lines = await shown(ui as Probe)
        await ui.unmount()
        return lines.filter(line => /^(checked|read) /.test(line))
      }

      expect(await stamp()).toEqual(['checked 12s ago'])
      clock = { now, checkedAt: now - 2_000 }
      expect(await stamp()).toEqual(['checked just now'])
      clock = { now, checkedAt: now - 3 * 60_000 }
      expect(await stamp()).toEqual(['checked 3m ago'])
      clock = undefined
      expect(await stamp()).toEqual(['read 12:03'])
      // The model's own check counts when the clock has none.
      model.freshness = { checkedAt: now - 7_000 }
      clock = { now }
      expect(await stamp()).toEqual(['checked 7s ago'])
    })

    test(`a freshness error is a line under the header and the first attention row on ${surface}`, async ($, on) => {
      const model = foldedModel({ freshness: { checkedAt: 1, error: 'Could not re-read the plan. Showing the last good read.' } })
      const { ui } = await draw($, on, model, surface)
      const root = await tree(ui)

      const lines = await shown(ui as Probe)
      const error = model.freshness!.error!
      expect(lines.filter(line => line === error).length).toBe(2)
      // Under the header: in the header block, red, with a bold "!".
      const head = headerOf(root)
      expect(chains(head, isText(error)).length).toBe(1)
      expect((await (ui as Probe).findAll({ type: 'Text', text: error }))[0]?.props.color).toBe('error')
      // The first attention row, counted: error + 2 gates + 1 drift.
      expect(lines).toContain('Needs attention (4)')
      const attention = lines.slice(lines.indexOf('Needs attention (4)'))
      expect(attention.slice(0, 2)).toEqual(['Needs attention (4)', '!'])
      expect(attention[2]).toBe(error)
      await ui.unmount()
    })

    test(`no freshness error draws no error line on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      expect(await ui.find({ type: 'Text', text: '!' })).toBeUndefined()
      await ui.unmount()
    })

    test(`title is upper-cased without a locale on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.header.title = 'ünï-ıx'
      const { ui } = await draw($, on, model, surface)
      expect(await shown(ui as Probe)).toContain('ÜNÏ-IX')
      await ui.unmount()
    })

    test(`the subtitle is not drawn on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      expect(await shown(ui as Probe)).not.toContain('Inception · domain-design')
      await ui.unmount()
    })
  }
})

describe('now card and next', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`stage session ${name} on ${surface}: Now, the running stage, Next`, async ($, on) => {
        const { ui } = await draw($, on, stageModel(), surface, columns)
        const root = await tree(ui)
        const lines = await shown(ui as Probe)

        expect(lines).toContain('Now')
        expect(lines).toContain('Inception, 5 of 8')
        expect(lines).toContain('domain-design')
        expect(lines).toContain('Next')
        expect((await ui.find({ type: 'Text', text: '/aidlc' }))?.props.color).toBe('claude')
        expect((await ui.find({ type: 'Text', text: '/aidlc' }))?.props.bold).toBe(true)
        expect(lines).toContain('Execute Domain Design')
        const fill = await ui.find({ type: 'Button', key: 'next:fill' })
        expect(fill?.text).toBe('Put in prompt')
        expect(fill?.props.hotkey).toBe('p')
        expect(fill?.props.variant).toBe('primary')
        // The card is round-bordered in the mode's colour.
        const [card] = chains(root, node => node.type === 'Box' && node.props.borderStyle === 'round' && node.props.borderColor === 'claude')
        expect(card).toBeDefined()
        // A narrow column stacks the button under the text, a wider one puts it beside.
        const together = commonBox(root, isText('/aidlc'), isButton('next:fill'))
        expect(together.props.flexDirection).toBe(isStacked(columns) ? 'column' : undefined)
        await ui.unmount()
      })
    }

    test(`a running stage is the Now item with its caption on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.sections[2]!.items[4]!.caption = 'Resumed after user-stories was reopened in #31.'
      model.header.caption = 'the header caption'
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('Resumed after user-stories was reopened in #31.')
      expect(lines).not.toContain('the header caption')
      await ui.unmount()
    })

    test(`the header caption stands in when the current item has none on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.header.caption = 'the header caption'
      const { ui } = await draw($, on, model, surface)
      expect(await shown(ui as Probe)).toContain('the header caption')
      await ui.unmount()
    })

    test(`side-job mode on ${surface}: This session, the headline, a secondary button`, async ($, on) => {
      const { ui } = await draw($, on, sideJobModel(), surface)
      const root = await tree(ui)
      const lines = await shown(ui as Probe)

      expect(lines).toContain('This session')
      expect(lines).toContain('Side job, not a stage of this plan')
      expect(lines).toContain('This session is not bound to a stage of shop-mvp-restart.')
      expect(lines).not.toContain('Now')
      expect((await ui.find({ key: 'next:fill' }))?.props.variant).toBe('secondary')
      expect(chains(root, node => node.props.borderStyle === 'round' && node.props.borderColor === 'warning').length).toBeGreaterThan(0)
      await ui.unmount()
    })

    test(`side-job mode is no longer compacted on ${surface}: full sections, items and folds`, async ($, on) => {
      const { ui } = await draw($, on, sideJobModel(), surface)
      const lines = await shown(ui as Probe)

      expect((await ui.find({ key: 'section:INCEPTION' }))?.text).toBe('▾ Inception')
      expect(lines).toContain('practices-discovery')
      expect(lines).toContain('units-generation')
      expect(lines).toContain('3/3 ✓')
      expect(lines).toContain('skipped')
      await ui.press({ key: 'section:INCEPTION' })
      expect(await shown(ui as Probe)).not.toContain('practices-discovery')
      await ui.unmount()
    })

    test(`idle mode on ${surface}: Workspace, the headline, no plan`, async ($, on) => {
      const { ui } = await draw($, on, idleModel(), surface)
      const lines = await shown(ui as Probe)

      expect(lines).toContain('Workspace')
      expect(lines).toContain('Nothing in flight')
      expect(lines).toContain('This workspace has no intent in flight.')
      expect(lines).toContain('Idle')
      expect(lines).toContain('SHOP')
      expect(lines).not.toContain('Plan')
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      expect(await ui.find({ key: 'section:INCEPTION' })).toBeUndefined()
      expect(await (ui as Probe).findAll({ type: 'Svg' })).toEqual([])
      expect(lines.some(line => /%/.test(line))).toBe(false)
      expect((await ui.find({ key: 'next:fill' }))?.props.variant).toBe('primary')
      await ui.unmount()
    })

    test(`a plan with no current item says Next up, with no headline on ${surface}`, async ($, on) => {
      const model = ledgerModel()
      for (const one of model.sections) for (const each of one.items) each.isCurrent = false
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('Next up')
      expect(lines).not.toContain('Now')
      expect(lines).toContain('start T18 - Bot onboarding')
      await ui.unmount()
    })

    test(`an empty string hides its element on ${surface}`, async ($, on) => {
      const model = stageModel()
      delete model.next
      model.sections[3]!.caption = ''
      const { ui } = await draw($, on, model, surface)

      const lines = await shown(ui as Probe)
      expect(lines).not.toContain('Next')
      expect(await ui.find({ key: 'next:fill' })).toBeUndefined()
      expect(lines.some(line => line === '')).toBe(false)
      await ui.unmount()
    })

    test(`an empty reason and caption draw no blank row on ${surface}`, async ($, on) => {
      const blank = stageModel()
      blank.next = { command: '/aidlc', reason: '' }
      blank.header.caption = ''
      const { ui } = await draw($, on, blank, surface)
      expect((await shown(ui as Probe)).some(line => line === '')).toBe(false)
      await ui.unmount()
    })

    test(`no model on ${surface}: the empty card`, async ($, on) => {
      const { ui } = await draw($, on, null, surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('Project')
      expect(lines).toContain('No plan found for this session yet.')
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      await ui.unmount()
    })

    test(`actions are Buttons keyed action:<id> on ${surface}`, async ($, on) => {
      const model = stageModel({ actions: [{ id: 'sync', label: 'Sync' }, { id: 'none', label: '' }] })
      const { ui } = await draw($, on, model, surface)

      const sync = await ui.find({ type: 'Button', key: 'action:sync' })
      expect(sync?.text).toBe('Sync')
      expect(sync?.props.plain).toBeUndefined()
      expect(await ui.find({ key: 'action:none' })).toBeUndefined()
      await ui.unmount()
    })
  }
})

describe('layout', () => {
  for (const surface of SURFACES) {
    test(`two columns only from 80 columns, and only with sections on ${surface}`, async ($, on) => {
      const split = async (model: PanelModel, columns: number) => {
        const { ui } = await draw($, on, model, surface, columns)
        const root = await tree(ui)
        await ui.unmount()
        const [trail] = chains(root, node => node.type === 'Box' && node.props.width === '40%')
        return trail === undefined ? undefined : { left: trail.at(-1)!, right: kids(trail.at(-2)!)[1]! }
      }

      const wide = await split(stageModel(), WIDE)
      expect(wide).toBeDefined()
      // The left column holds the Now card, the plan is its sibling and takes the rest.
      expect(textOf(wide!.left)).toContain('Now')
      expect(textOf(wide!.left)).not.toContain('Plan')
      expect(wide!.right.props.flexGrow).toBe(1)
      expect(wide!.right.props.flexShrink).toBe(1)
      expect(textOf(wide!.right)).toContain('Plan')

      expect(await split(stageModel(), MEDIUM)).toBeUndefined()
      expect(await split(stageModel(), NARROW)).toBeUndefined()
      expect(await split(idleModel(), WIDE)).toBeUndefined()
    })

    test(`the order is header, Now, actions, attention, plan on ${surface}`, async ($, on) => {
      for (const columns of [NARROW, MEDIUM, WIDE]) {
        const { ui } = await draw($, on, ledgerModel(), surface, columns)
        const lines = await shown(ui as Probe)
        const at = (text: string) => lines.indexOf(text)
        expect(at('REMINDERS')).toBeLessThan(at('Now'))
        expect(at('Now')).toBeLessThan(at('Pin sections'))
        expect(at('Pin sections')).toBeLessThan(at('Needs attention (2)'))
        expect(at('Needs attention (2)')).toBeLessThan(at('Plan'))
        await ui.unmount()
      }
    })
  }
})

describe('sections and items', () => {
  for (const surface of SURFACES) {
    test(`folds on ${surface}: the active section is open, the rest closed, a press flips`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)

      let lines = await shown(ui as Probe)
      expect(lines).toContain('practices-discovery')
      expect(lines).toContain('units-generation')
      expect(lines).not.toContain('u1')
      expect((await ui.find({ key: 'section:INCEPTION' }))?.text).toBe('▾ Inception')
      expect((await ui.find({ key: 'section:CONSTRUCTION' }))?.text).toBe('▸ Construction')

      await ui.press({ key: 'section:INCEPTION' })
      lines = await shown(ui as Probe)
      expect(lines).not.toContain('practices-discovery')
      expect((await ui.find({ key: 'section:INCEPTION' }))?.text).toBe('▸ Inception')

      await ui.press({ key: 'section:INCEPTION' })
      expect(await shown(ui as Probe)).toContain('practices-discovery')

      await ui.press({ key: 'section:CONSTRUCTION' })
      lines = await shown(ui as Probe)
      expect(lines).toContain('u1')
      expect(lines).toContain('per unit: billing, catalog')
      expect((await ui.find({ key: 'section:CONSTRUCTION' }))?.text).toBe('▾ Construction')
      await ui.unmount()
    })

    test(`the heading is bold when the section is active, dim when skipped on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      const root = await tree(ui)
      const boldOf = (key: string) => (chains(root, isButton(key))[0]?.at(-1)?.children?.[0] as Node).props.bold
      expect(boldOf('section:INCEPTION')).toBe(true)
      expect(boldOf('section:CONSTRUCTION')).toBe(false)
      expect((await ui.find({ key: 'section:OPERATION' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ key: 'section:INCEPTION' }))?.props.dimColor).not.toBe(true)
      await ui.unmount()
    })

    test(`section counts, ✓ when built, "skipped" on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('3/3 ✓')
      expect(lines).toContain('4/4 ✓')
      expect(lines).toContain('4/8')
      expect(lines).toContain('0/7')
      expect(lines).toContain('skipped')
      expect((await ui.find({ type: 'Text', text: '3/3 ✓' }))?.props.color).toBe('success')
      await ui.unmount()
    })

    test(`the current item has the › gutter, a bold title and its glyph on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      const marks = await (ui as Probe).findAll({ type: 'Text', text: '›' })
      expect(marks.length).toBe(1)
      expect(marks[0]?.props.color).toBe('claude')
      expect(marks[0]?.props.bold).toBe(true)
      const titles = await (ui as Probe).findAll({ type: 'Text', text: 'domain-design' })
      expect(titles.some(title => title.props.bold === true)).toBe(true)
      await ui.unmount()
    })

    test(`the parked gate is a bordered card right after its item on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      const root = await tree(ui)
      const lines = await shown(ui as Probe)

      // The attention list comes first; the plan's card is the last occurrence.
      const at = lines.lastIndexOf('Parked at domain-design')
      expect(at).toBeGreaterThan(lines.lastIndexOf('domain-design'))
      expect(at).toBeLessThan(lines.indexOf('units-generation'))
      expect(lines[at + 1]).toBe('The workflow was parked 2026-09-04 01:19. Resume it with /aidlc.')
      const [card] = chains(root, node => node.props.borderStyle === 'round' && node.props.borderColor === 'warning' && node.props.marginLeft === 4)
      expect(card).toBeDefined()
      expect(textOf(card!.at(-1)!)).toContain('‖')
      expect(textOf(card!.at(-1)!)).toContain('Parked at domain-design')
      expect((await (ui as Probe).findAll({ type: 'Text', text: 'Parked at domain-design' })).every(row => row.props.color === 'warning')).toBe(true)
      await ui.unmount()
    })

    test(`a gate without afterItemId is drawn at the top of its section on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.gates = [{ id: 'g', kind: 'parked', tone: 'warning', title: 'Parked', sectionId: 'INCEPTION' }]
      const { ui } = await draw($, on, model, surface)

      const lines = await shown(ui as Probe)
      expect(lines.lastIndexOf('Parked')).toBeLessThan(lines.indexOf('practices-discovery'))
      expect(lines.lastIndexOf('Parked')).toBeGreaterThan(lines.indexOf('▾ Inception'))
      await ui.unmount()
    })

    test(`a gate naming no section is still drawn on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.gates = [{ id: 'g', kind: 'parked', tone: 'warning', title: 'Parked', sectionId: '' }]
      const { ui } = await draw($, on, model, surface)
      expect((await (ui as Probe).findAll({ type: 'Text', text: 'Parked' })).length).toBe(2)
      await ui.unmount()
    })

    test(`every item status has its glyph, colour and (from M) word on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.sections = [
        section('S', 'Work', 'active', [
          item('gate', 'awaiting', { isCurrent: true }),
          item('redo', 'revising'),
          item('left-out', 'skipped'),
          item('broke', 'failed'),
          item('half', 'partial'),
          item('going', 'open'),
          item('next-up', 'planned'),
          item('finished', 'done'),
        ]),
      ]
      model.gates = [{ id: 'ci', kind: 'ci-failing', tone: 'error', title: 'CI failing on PR #7', sectionId: 'S', afterItemId: 'redo' }]

      let { ui } = await draw($, on, model, surface, MEDIUM)
      let lines = await shown(ui as Probe)
      for (const word of ['awaiting', 'revising', 'failed', 'partial', 'in progress', 'skipped']) expect(lines).toContain(word)
      const glyph = async (title: string) => {
        const root = await tree(ui)
        const row = chains(root, node => node.type === 'Box' && node.props.paddingLeft === 2 && textOf(node).includes(title))
        const texts = chains(row[0]!.at(-1)!, node => node.type === 'Text' && textOf(node) !== '›').map(chain => chain.at(-1)!)
        return texts[0]!
      }
      const expectations: [string, string, string | undefined][] = [
        ['gate', '?', 'warning'],
        ['redo', '↻', 'warning'],
        ['left-out', '–', undefined],
        ['broke', '✕', 'error'],
        ['half', '◐', 'claude'],
        ['going', '◐', 'claude'],
        ['next-up', '○', undefined],
        ['finished', '✓', 'success'],
      ]
      for (const [title, mark, color] of expectations) {
        const look = await glyph(title)
        expect([title, textOf(look), look.props.color]).toEqual([title, mark, color])
      }
      expect((await glyph('next-up')).props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: 'left-out' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: 'finished' }))?.props.dimColor).toBe(true)
      // A tone-error gate with no kind of its own is ⊘ in red.
      const ci = (await (ui as Probe).findAll({ type: 'Text', text: 'CI failing on PR #7' }))[0]
      expect(ci?.props.color).toBe('error')
      expect(lines).toContain('⊘')
      await ui.unmount()

      // S drops the status words, keeps the glyphs.
      ;({ ui } = await draw($, on, model, surface, NARROW))
      lines = await shown(ui as Probe)
      // ('awaiting' is the current item: the Now card says it.)
      for (const word of ['revising', 'failed', 'partial', 'skipped']) expect(lines).not.toContain(word)
      expect(lines).toContain('↻')
      expect(lines).toContain('✕')
      await ui.unmount()
    })

    test(`status words show from M and not on S on ${surface}`, async ($, on) => {
      for (const [, columns] of WIDTHS) {
        const { ui } = await draw($, on, stageModel(), surface, columns)
        const words = (await shown(ui as Probe)).filter(line => line === 'in progress')
        // The Now card always says it; the item row only from M.
        expect(words.length).toBe(columns < 48 ? 1 : 2)
        await ui.unmount()
      }
    })

    test(`chips follow the title and are links when they have an href on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.sections = [
        section('S', 'Work', 'active', [
          item('ship', 'open', {
            href: 'https://example.com/ship',
            chips: [
              { kind: 'pr', label: '#12', tone: 'success' },
              { kind: 'tag', label: '', tone: 'neutral' },
              { kind: 'unit', label: 'api', tone: 'accent', href: 'https://example.com/api' },
            ],
          }),
        ]),
      ]
      const { ui } = await draw($, on, model, surface)

      const chip = await ui.find({ type: 'Text', text: '[#12]' })
      expect(chip?.props.color).toBe('success')
      expect(chip?.props.dimColor).toBe(true)
      expect(await ui.find({ type: 'Text', text: '[]' })).toBeUndefined()
      const links = await (ui as Probe).findAll({ type: 'Link' })
      expect(links.map(link => link.props.href)).toEqual(['https://example.com/ship', 'https://example.com/api'])
      expect(links.map(link => link.props.label)).toEqual(['ship', '[api]'])
      await ui.unmount()
    })

    test(`on S only the first chip shows and the rest collapse to +N on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.sections = [
        section('S', 'Work', 'active', [
          item('ship', 'open', {
            chips: [
              { kind: 'pr', label: '#12', tone: 'success' },
              { kind: 'unit', label: 'api', tone: 'accent' },
              { kind: 'tag', label: 'x', tone: 'neutral' },
            ],
          }),
        ]),
      ]
      let { ui } = await draw($, on, model, surface, NARROW)
      let lines = await shown(ui as Probe)
      expect(lines).toContain('[#12]')
      expect(lines).toContain('+2')
      expect(lines).not.toContain('[api]')
      await ui.unmount()
      ;({ ui } = await draw($, on, model, surface, MEDIUM))
      lines = await shown(ui as Probe)
      expect(lines).toEqual(expect.arrayContaining(['[#12]', '[api]', '[x]']))
      expect(lines).not.toContain('+2')
      await ui.unmount()
    })

    test(`a PR spanning two stages draws the fold gutter, a reopen chip is a chip on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, foldedModel(), surface)
      const lines = await shown(ui as Probe)

      expect(lines).toContain('┐')
      expect(lines).toContain('┘')
      expect(lines.indexOf('┐')).toBeLessThan(lines.indexOf('┘'))
      expect((await ui.find({ type: 'Text', text: '┐' }))?.props.color).toBe('claude')
      expect(lines.filter(line => line === '[#31]').length).toBe(2)
      expect((await ui.find({ type: 'Text', text: '[reopened]' }))?.props.color).toBe('warning')
      await ui.unmount()
    })

    test(`three stages in a fold get ┐ │ ┘, a lone fold chip gets nothing on ${surface}`, async ($, on) => {
      const fold = (label: string) => ({ kind: 'fold' as const, label, tone: 'accent' as const })
      const model = stageModel()
      model.sections = [
        section('S', 'Work', 'active', [
          item('a', 'done', { chips: [fold('#1')] }),
          item('b', 'done', { chips: [fold('#1')] }),
          item('c', 'open', { isCurrent: true, chips: [fold('#1')] }),
          item('d', 'planned', { chips: [fold('#2')] }),
          item('e', 'planned', { chips: [fold('#3')] }),
        ]),
      ]
      model.gates = []
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines.filter(line => '┐│┘'.includes(line) && line !== '')).toEqual(['┐', '│', '┘'])
      await ui.unmount()
    })

    test(`a collapsed section carries its gate's glyph beside the count on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.gates = [{ id: 'g', kind: 'behind', tone: 'error', title: 'Branch is behind main', sectionId: 'CONSTRUCTION' }]
      const { ui } = await draw($, on, model, surface)

      const root = await tree(ui)
      const heading = chains(root, isButton('section:CONSTRUCTION'))[0]!.at(-3)!
      expect(textOf(heading)).toContain('⊘')
      expect(chains(heading, isText('⊘'))[0]!.at(-1)!.props.color).toBe('error')
      // The gate's own card waits for the section to open (the attention list still names it).
      expect((await shown(ui as Probe)).filter(line => line === 'Branch is behind main').length).toBe(1)
      await ui.press({ key: 'section:CONSTRUCTION' })
      expect((await shown(ui as Probe)).filter(line => line === 'Branch is behind main').length).toBe(2)
      await ui.unmount()
    })

    test(`a warning gate on a collapsed section marks it ‖ on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.gates = [{ id: 'g', kind: 'x', tone: 'warning', title: 'Slow', sectionId: 'CONSTRUCTION' }]
      const { ui } = await draw($, on, model, surface)
      const root = await tree(ui)
      const heading = chains(root, isButton('section:CONSTRUCTION'))[0]!.at(-3)!
      expect(chains(heading, isText('‖'))[0]!.at(-1)!.props.color).toBe('warning')
      await ui.unmount()
    })

    test(`a proposed section is a dim bordered card under one Proposed divider on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, ledgerModel(), surface)
      const root = await tree(ui)

      expect(await ui.find({ key: 'section:web' })).toBeUndefined()
      const [card] = chains(root, node => node.props.borderStyle === 'round' && node.props.borderDimColor === true)
      expect(card).toBeDefined()
      expect(textOf(card!.at(-1)!)).toContain('Web dashboard')
      // The card carries no tag of its own; one dim divider row ahead of the first proposed card says it.
      expect(textOf(card!.at(-1)!)).not.toContain('Proposed')
      expect(textOf(card!.at(-1)!)).toContain('3 open items mention a dashboard.')
      expect((await ui.find({ type: 'Text', text: 'Web dashboard' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Text', text: 'Web dashboard' }))?.props.bold).toBe(true)
      expect((await (ui as Probe).findAll({ type: 'Text', text: 'Proposed' })).length).toBe(1)
      expect((await ui.find({ type: 'Text', text: 'Proposed' }))?.props.dimColor).toBe(true)
      const [divider] = chains(root, node => node.type === 'Box' && node.props.marginTop === 1 && textOf(node) === 'Proposed')
      expect(divider).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('needs attention', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`${name} on ${surface}: gates, then drift, with the glyph and the where`, async ($, on) => {
        const { ui } = await draw($, on, foldedModel(), surface, columns)
        const root = await tree(ui)
        const lines = await shown(ui as Probe)

        expect(lines).toContain('Needs attention (3)')
        const list = lines.slice(lines.indexOf('Needs attention (3)')).slice(0, 9)
        expect(list).toEqual([
          'Needs attention (3)',
          '?',
          '3 questions unanswered',
          'Inception, after refined-mockups',
          '⊘',
          'PR #31 not merged',
          'Inception, after refined-mockups',
          '≠',
          'user-stories reopened after approval',
        ])
        // The tone colours the title and the glyph.
        expect((await (ui as Probe).findAll({ type: 'Text', text: 'PR #31 not merged' }))[0]?.props.color).toBe('error')
        expect((await (ui as Probe).findAll({ type: 'Text', text: '3 questions unanswered' }))[0]?.props.color).toBe('warning')
        expect((await ui.find({ type: 'Text', text: 'user-stories reopened after approval' }))?.props.color).toBe('warning')
        // A narrow column: title line, then the where line; wider: one row, the where on the right.
        const pr = chains(root, isText('PR #31 not merged'))[0]!
        const where = chains(root, isText('Inception, after refined-mockups'))[1]!
        const shared = pr.filter(node => where.includes(node)).at(-1)!
        expect(shared.props.flexDirection).toBe(isStacked(columns) ? 'column' : undefined)
        await ui.unmount()
      })
    }

    test(`each row is a bordered card in its tone on desktop, a plain line on the terminal (${surface})`, async ($, on) => {
      const { ui } = await draw($, on, foldedModel(), surface)
      const root = await tree(ui)
      const cardsOf = (color: string) => chains(root, node => node.props.borderStyle === 'round' && node.props.borderColor === color && node.props.marginLeft !== 4)
      const inAttention = (color: string) => cardsOf(color).filter(chain => textOf(chain.at(-1)!).includes('PR #31 not merged') || textOf(chain.at(-1)!).includes('3 questions') || textOf(chain.at(-1)!).includes('reopened after approval'))
      if (surface === 'desktop') {
        expect(inAttention('error').length).toBe(1)
        expect(inAttention('warning').length).toBe(2)
      } else {
        expect(inAttention('error').length).toBe(0)
        expect(inAttention('warning').length).toBe(0)
      }
      await ui.unmount()
    })

    test(`glyphs per gate kind: parked ‖, awaiting-approval ?, error ⊘, warning ‖ on ${surface}`, async ($, on) => {
      const model = stageModel({
        gates: [
          { id: '1', kind: 'parked', tone: 'warning', title: 'one', sectionId: 'INCEPTION' },
          { id: '2', kind: 'awaiting-approval', tone: 'warning', title: 'two', sectionId: 'INCEPTION' },
          { id: '3', kind: 'questions-unanswered', tone: 'warning', title: 'three', sectionId: 'INCEPTION' },
          { id: '4', kind: 'guard-refusal', tone: 'error', title: 'four', sectionId: 'INCEPTION' },
          { id: '5', kind: 'other', tone: 'warning', title: 'five', sectionId: 'INCEPTION' },
          { id: '6', kind: 'parked', tone: 'error', title: 'six', sectionId: 'INCEPTION' },
        ],
      })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      const from = lines.indexOf('Needs attention (6)')
      const glyphOf = (title: string) => lines[lines.indexOf(title, from) - 1]
      expect(['one', 'two', 'three', 'four', 'five', 'six'].map(glyphOf)).toEqual(['‖', '?', '?', '⊘', '‖', '‖'])
      await ui.unmount()
    })

    test(`a gate on no known section has no where; a section without the item says only the section on ${surface}`, async ($, on) => {
      const model = stageModel({
        gates: [
          { id: '1', kind: 'x', tone: 'warning', title: 'orphan', sectionId: 'NOPE' },
          { id: '2', kind: 'x', tone: 'warning', title: 'in-section', sectionId: 'INCEPTION', afterItemId: 'no-such-item' },
        ],
      })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      const from = lines.indexOf('Needs attention (2)')
      expect(lines.slice(from, from + 5)).toEqual(['Needs attention (2)', '‖', 'orphan', '‖', 'in-section'])
      expect(lines[from + 5]).toBe('Inception')
      await ui.unmount()
    })

    test(`attention is hidden when there is nothing to flag on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel({ gates: [] }), surface)
      expect((await shown(ui as Probe)).some(line => line.startsWith('Needs attention'))).toBe(false)
      await ui.unmount()
    })

    test(`an empty drift label draws nothing on ${surface}`, async ($, on) => {
      const model = stageModel({ gates: [], drift: [{ id: 'd1', label: 'behind main', tone: 'warning' }, { id: 'd2', label: '', tone: 'neutral' }] })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('Needs attention (1)')
      expect(lines.filter(line => line === '≠').length).toBe(1)
      await ui.unmount()
    })
  }
})

describe('ledger', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`${name} on ${surface}: overall progress, sections, proposed, action, drift`, async ($, on) => {
        const { ui } = await draw($, on, ledgerModel(), surface, columns)
        const lines = await shown(ui as Probe)

        expect(lines).toContain('REMINDERS')
        expect(lines).toContain('Plan')
        expect(lines).toContain('78% done, 31 of 40')
        expect((await ui.find({ type: 'Button', key: 'action:pin' }))?.text).toBe('Pin sections')
        for (const id of ['plugin', 'mcp', 'api', 'tg', 'mobile']) expect(await ui.find({ key: `section:${id}` })).toBeDefined()
        expect(lines).toContain('8/8 ✓')
        expect(lines).toContain('11/13')
        expect(lines).toContain('6/10')
        expect(lines).toContain('0/3')
        expect(lines).toContain('Web dashboard')
        expect(lines).toContain('≠')
        expect(lines).toContain('T16 marked partial, #53 merged')
        // The failed item, its gate and where.
        expect(lines).toContain('T17 QA failed on #55')
        expect(lines).toContain('Telegram bot, after T17 Group chats')
        // Failed, partial and planned items, with chips.
        expect(lines).toContain('✕')
        expect(lines).toContain('[#52]')
        await ui.unmount()
      })
    }

    test(`done-folding on S: a section over 6 items hides its done items behind one row (${surface})`, async ($, on) => {
      const { ui } = await draw($, on, ledgerModel(), surface, NARROW)
      let lines = await shown(ui as Probe)

      const more = await ui.find({ type: 'Button', key: 'more:tg' })
      expect(more?.text).toBe('✓ 6 done, show')
      expect(more?.props.plain).toBe(true)
      expect(lines).not.toContain('T10 Link account')
      expect(lines).toContain('T15 Inline actions')
      expect(lines).toContain('T18 Bot onboarding')
      // The fold row is the first thing in the list, right after the heading.
      expect(lines.indexOf('✓ 6 done, show')).toBeGreaterThan(lines.indexOf('▾ Telegram bot'))
      expect(lines.indexOf('✓ 6 done, show')).toBeLessThan(lines.indexOf('T15 Inline actions'))

      await ui.press({ key: 'more:tg' })
      lines = await shown(ui as Probe)
      expect(lines).toContain('T10 Link account')
      expect(lines).toContain('T14 Quiet hours')
      expect(await ui.find({ key: 'more:tg' })).toBeUndefined()
      expect((await ui.find({ type: 'Button', key: 'less:tg' }))?.text).toBe('Hide done')
      // Hide done takes the place of the "show" row: at the top of the list.
      expect(lines.indexOf('Hide done')).toBeLessThan(lines.indexOf('T10 Link account'))
      expect(lines.indexOf('Hide done')).toBeGreaterThan(lines.indexOf('▾ Telegram bot'))

      await ui.press({ key: 'less:tg' })
      lines = await shown(ui as Probe)
      expect(lines).not.toContain('T10 Link account')
      expect(await ui.find({ key: 'more:tg' })).toBeDefined()
      await ui.unmount()
    })

    test(`done-folding keeps done items that are current, folded or hold a gate (${surface})`, async ($, on) => {
      const fold = { kind: 'fold' as const, label: '#9', tone: 'accent' as const }
      const model = stageModel({
        gates: [{ id: 'g', kind: 'x', tone: 'warning', title: 'Held', sectionId: 'S', afterItemId: 'held' }],
        sections: [
          section('S', 'Work', 'active', [
            item('plain-1', 'done'),
            item('plain-2', 'done'),
            item('held', 'done'),
            item('folded-a', 'done', { chips: [fold] }),
            item('folded-b', 'done', { chips: [fold] }),
            item('now-here', 'done', { isCurrent: true }),
            item('todo', 'planned'),
          ]),
        ],
      })
      const { ui } = await draw($, on, model, surface, NARROW)
      const lines = await shown(ui as Probe)
      expect((await ui.find({ key: 'more:S' }))?.text).toBe('✓ 2 done, show')
      expect(lines).not.toContain('plain-1')
      for (const kept of ['held', 'folded-a', 'folded-b', 'now-here', 'todo']) expect(lines).toContain(kept)
      await ui.unmount()
    })

    test(`done-folding caps are 6 / 10 / 16: 10 items fold on S, not on M or L (${surface})`, async ($, on) => {
      const ten = stageModel({
        sections: [section('S', 'Work', 'active', [...Array.from({ length: 6 }, (_, i) => item(`d${i}`, 'done')), ...Array.from({ length: 4 }, (_, i) => item(`p${i}`, 'planned'))])],
        gates: [],
      })
      const present = async (columns: number, model: PanelModel) => {
        const { ui } = await draw($, on, model, surface, columns)
        const found = (await ui.find({ key: 'more:S' })) !== undefined
        await ui.unmount()
        return found
      }
      expect(await present(NARROW, ten)).toBe(true)
      expect(await present(MEDIUM, ten)).toBe(false)
      expect(await present(WIDE, ten)).toBe(false)

      const twelve = stageModel({
        sections: [section('S', 'Work', 'active', [...Array.from({ length: 6 }, (_, i) => item(`d${i}`, 'done')), ...Array.from({ length: 6 }, (_, i) => item(`p${i}`, 'planned'))])],
        gates: [],
      })
      expect(await present(MEDIUM, twelve)).toBe(true)
      expect(await present(WIDE, twelve)).toBe(false)

      const seventeen = stageModel({
        sections: [section('S', 'Work', 'active', [...Array.from({ length: 6 }, (_, i) => item(`d${i}`, 'done')), ...Array.from({ length: 11 }, (_, i) => item(`p${i}`, 'planned'))])],
        gates: [],
      })
      expect(await present(WIDE, seventeen)).toBe(true)
    })

    test(`opening the long API section folds its done items on M (${surface})`, async ($, on) => {
      const { ui } = await draw($, on, ledgerModel(), surface, MEDIUM)
      expect(await ui.find({ key: 'more:api' })).toBeUndefined()
      expect(await ui.find({ key: 'more:tg' })).toBeUndefined()
      await ui.press({ key: 'section:api' })
      expect((await ui.find({ key: 'more:api' }))?.text).toBe('✓ 11 done, show')
      const lines = await shown(ui as Probe)
      expect(lines).toContain('T09b Export')
      expect(lines).toContain('T09c Audit log')
      expect(lines).not.toContain('T01 Threads CRUD')
      await ui.press({ key: 'more:api' })
      expect(await shown(ui as Probe)).toContain('T01 Threads CRUD')
      await ui.unmount()
    })

    test(`a collapsed section of 10+ items carries a status strip from M, not on S (${surface})`, async ($, on) => {
      const stripsOf = async (columns: number) => {
        const { ui } = await draw($, on, ledgerModel(), surface, columns)
        const root = await tree(ui)
        const svgs = await (ui as Probe).findAll({ type: 'Svg' })
        const texts = await shown(ui as Probe)
        await ui.unmount()
        return { root, svgs, texts }
      }

      const small = await stripsOf(NARROW)
      const medium = await stripsOf(MEDIUM)
      const wide = await stripsOf(WIDE)

      if (surface === 'desktop') {
        // The strip is the 6 px tall Svg; only the collapsed API section (13 items) has one.
        const strip = (found: Found[]) => found.filter(svg => svg.props.height === 6)
        expect(strip(small.svgs)).toEqual([])
        expect(strip(medium.svgs).map(svg => [svg.props.width, svg.props.alt])).toEqual([[64, '11 of 13 done']])
        expect(strip(wide.svgs).map(svg => [svg.props.width, svg.props.alt])).toEqual([[96, '11 of 13 done']])
        const source = String(strip(medium.svgs)[0]?.props.source)
        // done green, accent for partial, track for the rest; 2 px gaps, rounded.
        expect(source).toContain('#4eba65')
        expect(source).toContain('#d97757')
        expect(source).toContain('rx="2"')
        expect((source.match(/<rect/g) ?? []).length).toBe(3)
      } else {
        expect(small.texts.some(line => /^[█▓▒░]+$/.test(line))).toBe(false)
        for (const found of [medium, wide]) {
          // 11 done, 1 partial, 0 failed, 1 planned over 10 cells.
          expect(found.texts).toEqual(expect.arrayContaining(['████████', '▓', '░']))
          expect(found.texts.some(line => line.includes('▒'))).toBe(false)
        }
      }
    })

    test(`the strip is gone once the section is open (${surface})`, async ($, on) => {
      const { ui } = await draw($, on, ledgerModel(), surface, MEDIUM)
      await ui.press({ key: 'section:api' })
      if (surface === 'desktop') expect((await (ui as Probe).findAll({ type: 'Svg' })).filter(svg => svg.props.height === 6)).toEqual([])
      else expect((await shown(ui as Probe)).some(line => /^[█▓▒░]+$/.test(line))).toBe(false)
      await ui.unmount()
    })

    test(`the terminal strip keeps every non-zero group at one cell or more (${surface})`, async ($, on) => {
      if (surface !== 'terminal') return
      const items = [
        ...Array.from({ length: 30 }, (_, i) => item(`d${i}`, 'done')),
        item('f', 'failed'),
        item('o', 'open'),
        item('p', 'planned'),
      ]
      const model = ledgerModel({ sections: [section('big', 'Big', 'partial', items, { isCollapsed: true })] })
      const { ui } = await draw($, on, model, surface, MEDIUM)
      const cells = (await shown(ui as Probe)).filter(line => /^[█▓▒░]+$/.test(line))
      expect(cells.join('').length).toBe(10)
      expect(cells.map(line => line[0])).toEqual(['█', '▓', '▒', '░'])
      expect(cells.slice(1).every(line => line.length >= 1)).toBe(true)
      await ui.unmount()
    })

    test(`skipped items do not count in the strip (${surface})`, async ($, on) => {
      if (surface !== 'terminal') return
      const items = [...Array.from({ length: 10 }, (_, i) => item(`s${i}`, 'skipped')), item('a', 'done'), item('b', 'planned')]
      const model = ledgerModel({ sections: [section('x', 'X', 'partial', items, { isCollapsed: true })] })
      const { ui } = await draw($, on, model, surface, MEDIUM)
      expect((await shown(ui as Probe)).filter(line => /^[█▓▒░]+$/.test(line))).toEqual(['█████', '░░░░░'])
      await ui.unmount()
    })
  }
})

describe('progress rings', () => {
  test('desktop: a 40 px donut with the % inside in the plan heading, 16 px per section row', async ($, on) => {
    const { ui } = await draw($, on, stageModel(), 'desktop')

    const rings = await (ui as Probe).findAll({ type: 'Svg' })
    // Plan (overall), Initialization, Ideation, Inception, Construction; Operation is skipped.
    expect(rings.map(ring => [ring.props.width, ring.props.height, ring.props.alt])).toEqual([
      [40, 40, '50% done'],
      [16, 16, '100% done'],
      [16, 16, '100% done'],
      [16, 16, '50% done'],
      [16, 16, '0% done'],
    ])
    const source = String(rings[0]?.props.source)
    expect(source.startsWith('<svg')).toBe(true)
    expect((source.match(/<circle/g) ?? []).length).toBe(2)
    // The number is drawn inside, as SVG text.
    expect(source).toMatch(/<text [^>]*>50<\/text>/)
    // A fixed track tone and the accent arc; never currentColor, which an Svg drawn as an image need not theme.
    expect(source).toContain('stroke="#8a8a8a" stroke-opacity="0.35"')
    expect(source).toContain('stroke="#d97757"')
    expect(source).not.toContain('currentColor')
    expect(source).toContain('stroke-linecap="round"')
    expect(source).toContain('rotate(-90')
    // 100 % turns the arc green; 0 % draws only the track; a small ring has no text.
    expect(String(rings[1]?.props.source)).toContain('stroke="#4eba65"')
    expect((String(rings[4]?.props.source).match(/<circle/g) ?? []).length).toBe(1)
    expect(String(rings[1]?.props.source)).not.toContain('<text')
    // No % beside the rings as Text: the big one carries it inside.
    expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '50% done, 11 of 26' })).toBeDefined()
    await ui.unmount()
  })

  test('the terminal has no Svg at all: the plan heading is a glyph and one summary, the glyph alone per section', async ($, on) => {
    const { ui } = await draw($, on, stageModel(), 'terminal')

    expect(await (ui as Probe).findAll({ type: 'Svg' })).toEqual([])
    const lines = await shown(ui as Probe)
    expect(lines).toContain('●')
    expect(lines).toContain('○')
    // Exactly one %, in the summary; the glyph before "Plan" carries none.
    expect(lines.filter(line => line.includes('%'))).toEqual(['50% done, 11 of 26'])
    expect(lines[lines.indexOf('Plan') - 1]).toBe('◑')
    await ui.unmount()
  })

  test('the glyph follows the bands 0 / 1-37 / 38-62 / 63-99 / 100', async ($, on) => {
    const bands: [number, string][] = [[0, '○'], [1, '◔'], [37, '◔'], [38, '◑'], [62, '◑'], [63, '◕'], [99, '◕'], [100, '●']]
    // The plan heading: the glyph, then a summary that carries the %.
    for (const [percent, glyph] of bands) {
      const model = stageModel()
      model.overall = { percent, counts: { done: 0, total: 100 } }
      const { ui } = await draw($, on, model, 'terminal')
      const lines = await shown(ui as Probe)
      expect(lines[lines.indexOf('Plan') - 1]).toBe(glyph)
      expect(lines).toContain(`${percent}% done, 0 of 100`)
      expect(lines.filter(line => line.includes('%')).length).toBe(1)
      await ui.unmount()
    }
    // A section ring: the glyph alone.
    const model = stageModel()
    const make = (id: string, done: number) =>
      section(id, id, 'active', Array.from({ length: 100 }, (_, i) => item(`${id}-${i}`, i < done ? 'done' : 'planned')))
    model.sections = bands.map(([percent], i) => make(String.fromCharCode(65 + i), percent))
    model.overall = { counts: { total: 0 } }
    const { ui } = await draw($, on, model, 'terminal')
    const root = await tree(ui)
    const rings = bands.map((_, i) => {
      const heading = chains(root, isButton(`section:${String.fromCharCode(65 + i)}`))[0]!.at(-3)!
      return chains(heading, node => node.type === 'Text' && '○◔◑◕●'.includes(textOf(node)) && textOf(node) !== '').map(chain => textOf(chain.at(-1)!))
    })
    expect(rings).toEqual(bands.map(([, glyph]) => [glyph]))
    await ui.unmount()
  })

  test('the plan heading is hidden without sections, the % without a percent', async ($, on) => {
    let { ui } = await draw($, on, stageModel({ sections: [], gates: [] }), 'desktop')
    expect(await (ui as Probe).findAll({ type: 'Svg' })).toEqual([])
    expect(await shown(ui as Probe)).not.toContain('Plan')
    await ui.unmount()

    const model = stageModel()
    model.overall = { counts: { total: 26 } }
    ;({ ui } = await draw($, on, model, 'desktop'))
    const lines = await shown(ui as Probe)
    expect(lines).toContain('Plan')
    expect(lines.some(line => line.includes('% done,'))).toBe(false)
    expect((await (ui as Probe).findAll({ type: 'Svg' })).some(svg => svg.props.width === 40)).toBe(false)
    await ui.unmount()
  })

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`${surface} has Svg too`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      expect((await (ui as Probe).findAll({ type: 'Svg' })).length).toBe(5)
      await ui.unmount()
    })
  }
})

describe('breakpoint boundaries', () => {
  for (const surface of SURFACES) {
    test(`47 is narrow and 48 is medium on ${surface}`, async ($, on) => {
      let { ui } = await draw($, on, sideJobModel(), surface, 47)
      expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻')
      // Narrow: the stamp is on row 2, an in-progress item shows no status word.
      expect(textOf(kids(headerOf(await tree(ui)))[0]!)).not.toContain('checked just now')
      await ui.unmount()
      ;({ ui } = await draw($, on, stageModel(), surface, 47))
      expect((await shown(ui as Probe)).filter(line => line === 'in progress').length).toBe(1)
      await ui.unmount()

      ;({ ui } = await draw($, on, sideJobModel(), surface, 48))
      expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻ Refresh')
      expect(textOf(kids(headerOf(await tree(ui)))[0]!)).toContain('checked just now')
      await ui.unmount()
      ;({ ui } = await draw($, on, stageModel(), surface, 48))
      expect((await shown(ui as Probe)).filter(line => line === 'in progress').length).toBe(2)
      await ui.unmount()
    })

    test(`79 is one column and 80 is two on ${surface}`, async ($, on) => {
      const hasSplit = async (columns: number) => {
        const { ui } = await draw($, on, stageModel(), surface, columns)
        const root = await tree(ui)
        await ui.unmount()
        return chains(root, node => node.type === 'Box' && node.props.width === '40%').length > 0
      }
      expect(await hasSplit(79)).toBe(false)
      expect(await hasSplit(80)).toBe(true)
    })

    test(`a width that is no number reads as medium on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface, Number.NaN)
      expect((await ui.find({ key: 'refresh' }))?.text).toBe('↻ Refresh')
      await ui.unmount()
    })
  }
})

describe('the wide left column lays out for its own width', () => {
  /** The Next row and the first attention row: are they stacked or on one row? */
  async function shape($: Engine, on: On, surface: string, columns: number) {
    const { ui } = await draw($, on, foldedModel(), surface, columns)
    const root = await tree(ui)
    const next = commonBox(root, isText('/aidlc'), isButton('next:fill'))
    const pr = chains(root, isText('PR #31 not merged'))[0]!
    const where = chains(root, isText('Inception, after refined-mockups'))[1]!
    const attention = pr.filter(node => where.includes(node)).at(-1)!
    await ui.unmount()
    return { next: next.props.flexDirection, attention: attention.props.flexDirection }
  }

  for (const surface of SURFACES) {
    test(`at 80 columns the 32-wide column stacks Next and uses two-line attention rows on ${surface}`, async ($, on) => {
      expect(await shape($, on, surface, 80)).toEqual({ next: 'column', attention: 'column' })
    })

    test(`the one-row variants come back at 125 columns and not at 124 on ${surface}`, async ($, on) => {
      expect(await shape($, on, surface, 124)).toEqual({ next: 'column', attention: 'column' })
      expect(await shape($, on, surface, 125)).toEqual({ next: undefined, attention: undefined })
      expect(await shape($, on, surface, 160)).toEqual({ next: undefined, attention: undefined })
    })

    test(`the plan column can shrink on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface, 80)
      const [trail] = chains(await tree(ui), node => node.props.width === '40%')
      expect(kids(trail!.at(-2)!)[1]!.props.minWidth).toBe(0)
      await ui.unmount()
    })

    test(`in an attention row the title keeps its room and the where gives way first on ${surface}`, async ($, on) => {
      for (const columns of [48, 60, 160]) {
        const { ui } = await draw($, on, stageModel(), surface, columns)
        const root = await tree(ui)
        const [titleTrail] = chains(root, isText('Parked at domain-design'))
        const [whereTrail] = chains(root, isText('Inception, after domain-design'))
        const titleBox = titleTrail!.at(-2)!
        const whereBox = whereTrail!.at(-2)!
        expect(titleBox.props.minWidth).toBe('Parked at domain-design'.length)
        expect(titleBox.props.flexShrink).toBe(1)
        expect(whereBox.props.flexShrink).toBeGreaterThan(1)
        expect(whereTrail!.at(-1)!.props.wrap).toBe('truncate-end')
        await ui.unmount()
      }
    })

    test(`a where longer than its row is cut inside the card, not drawn past its border, on ${surface}`, async ($, on) => {
      const caption = 'ABC-115 pr-review hook: react only to a gh pr create that names this repository — by dev-b'
      const model = stageModel({
        gates: [
          {
            id: 'you:review-requested:42',
            kind: 'review-requested',
            tone: 'accent',
            title: 'Your review is requested on PR #42',
            caption,
            sectionId: '',
            href: 'https://example.test/acme/shop/pull/42',
            command: '/pr-review:review-pr 42',
            isAttentionOnly: true,
          },
        ],
      })
      for (const columns of [60, 160]) {
        const { ui } = await draw($, on, model, surface, columns)
        const [trail] = chains(await tree(ui), isText(caption))
        // The row's body, its line and the where may each shrink to nothing (the desktop otherwise holds a
        // flex child at its full text length), and the where clips what is left.
        for (const box of trail!.slice(-4, -1)) expect(box.props.minWidth).toBe(0)
        expect(trail!.at(-2)!.props.overflow).toBe('hidden')
        expect(trail!.at(-1)!.props.wrap).toBe('truncate-end')
        await ui.unmount()
      }
    })
  }
})

describe('robustness', () => {
  for (const surface of SURFACES) {
    test(`a repeated item id never hides a live item or doubles a gate on ${surface}`, async ($, on) => {
      const model = stageModel({
        sections: [
          section('S', 'Work', 'active', [
            item('dup', 'done', { title: 'done-one' }),
            item('dup', 'planned', { title: 'live-one' }),
            ...Array.from({ length: 5 }, (_, i) => item(`d${i}`, 'done')),
            item('last', 'planned'),
          ]),
        ],
        gates: [{ id: 'g', kind: 'x', tone: 'warning', title: 'Held', sectionId: 'S', afterItemId: 'dup' }],
      })
      const { ui } = await draw($, on, model, surface, NARROW)
      const lines = await shown(ui as Probe)

      expect(lines).toContain('live-one')
      expect(lines).toContain('last')
      // done-one holds the gate (the first with that id), so it stays; the 5 other done items fold.
      expect(lines).toContain('done-one')
      expect((await ui.find({ key: 'more:S' }))?.text).toBe('✓ 5 done, show')
      // Once in attention, once in the plan.
      expect(lines.filter(line => line === 'Held').length).toBe(2)
      await ui.unmount()
    })

    test(`the fold gutter is by position, not id on ${surface}`, async ($, on) => {
      const fold = { kind: 'fold' as const, label: '#1', tone: 'accent' as const }
      const model = stageModel({
        gates: [],
        sections: [section('S', 'Work', 'active', [item('same', 'done', { chips: [fold] }), item('same', 'open', { chips: [fold], isCurrent: true }), item('same', 'planned')])],
      })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines.filter(line => '┐│┘'.includes(line) && line !== '')).toEqual(['┐', '┘'])
      await ui.unmount()
    })

    test(`a percent that is NaN, over 100 or under 0 draws a ring and a summary that agree on ${surface}`, async ($, on) => {
      const drawn = async (percent: number) => {
        const model = stageModel()
        model.overall = { percent, counts: { done: 3, total: 10 } }
        const { ui } = await draw($, on, model, surface)
        const lines = await shown(ui as Probe)
        const svgs = (await (ui as Probe).findAll({ type: 'Svg' })).filter(svg => svg.props.width === 40)
        await ui.unmount()
        return { lines, svgs }
      }

      const high = await drawn(150)
      expect(high.lines).toContain('100% done, 3 of 10')
      if (surface === 'desktop') expect(high.svgs.map(svg => svg.props.alt)).toEqual(['100% done'])
      else expect(high.lines[high.lines.indexOf('Plan') - 1]).toBe('●')

      const low = await drawn(-5)
      expect(low.lines).toContain('0% done, 3 of 10')
      if (surface === 'desktop') expect(low.svgs.map(svg => svg.props.alt)).toEqual(['0% done'])
      else expect(low.lines[low.lines.indexOf('Plan') - 1]).toBe('○')

      const none = await drawn(Number.NaN)
      expect(none.lines.some(line => line.includes('% done,'))).toBe(false)
      expect(none.svgs).toEqual([])
      expect(none.lines.some(line => line.includes('%'))).toBe(false)
      expect(none.lines[none.lines.indexOf('Plan') - 1]).not.toMatch(/^[○◔◑◕●]$/)
      expect(none.lines).toContain('Plan')
    })

    test(`a section whose percent is NaN draws no ring on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.sections = [section('S', 'Work', 'active', [item('a', 'planned')], { percent: Number.NaN })]
      const { ui } = await draw($, on, model, surface)
      if (surface === 'desktop') expect((await (ui as Probe).findAll({ type: 'Svg' })).filter(svg => svg.props.width === 16)).toEqual([])
      else expect((await shown(ui as Probe)).filter(line => line === '○')).toEqual(['○'])
      await ui.unmount()
    })

    test(`a skipped current item names no place on ${surface}`, async ($, on) => {
      const model = stageModel({
        sections: [section('S', 'Work', 'active', [item('a', 'done'), item('left-out', 'skipped', { isCurrent: true }), item('b', 'planned')])],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines).toContain('Now')
      expect(lines.filter(line => line === 'left-out').length).toBe(2)
      expect(lines.some(line => / of \d+$/.test(line) && line.startsWith('Work,'))).toBe(false)
      await ui.unmount()
    })

    test(`a built section with no counts and no ring still shows ✓ on ${surface}`, async ($, on) => {
      const bare: PanelModel['sections'][number] = { id: 'B', title: 'Built', status: 'built', isCollapsed: true, items: [] }
      const { ui } = await draw($, on, stageModel({ sections: [bare], gates: [] }), surface)
      const marks = await (ui as Probe).findAll({ type: 'Text', text: '✓' })
      expect(marks.length).toBe(1)
      expect(marks[0]?.props.color).toBe('success')
      await ui.unmount()
    })

    test(`the Now card is not drawn when it would hold only a label on ${surface}`, async ($, on) => {
      const model = ledgerModel()
      for (const one of model.sections) for (const each of one.items) each.isCurrent = false
      delete model.next
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines).not.toContain('Next up')
      expect(lines).not.toContain('Now')
      expect(chains(await tree(ui), node => node.props.borderStyle === 'round' && node.props.borderColor === 'claude')).toEqual([])
      await ui.unmount()
    })

    test(`repeated section and action ids get distinct keys, unique ones keep theirs on ${surface}`, async ($, on) => {
      const model = stageModel({
        gates: [{ id: 'g', kind: 'x', tone: 'warning', title: 'Held', sectionId: 'X' }],
        actions: [{ id: 'sync', label: 'Sync' }, { id: 'sync', label: 'Sync again' }, { id: 'other', label: 'Other' }],
        sections: [
          section('X', 'First', 'active', [item('a', 'planned')]),
          section('X', 'Second', 'planned', [item('b', 'planned')]),
          section('Y', 'Third', 'planned', [item('c', 'planned')]),
        ],
      })
      const { ui } = await draw($, on, model, surface)
      const keys = (await (ui as Probe).findAll({ type: 'Button' })).map(button => String(button.props.key))
      expect(keys).toEqual(expect.arrayContaining(['section:X', 'section:X~1', 'section:Y', 'action:sync', 'action:sync~1', 'action:other']))
      expect(new Set(keys).size).toBe(keys.length)
      // Each toggles on its own.
      expect((await ui.find({ key: 'section:X~1' }))?.text).toBe('▸ Second')
      await ui.press({ key: 'section:X~1' })
      expect((await ui.find({ key: 'section:X~1' }))?.text).toBe('▾ Second')
      expect((await ui.find({ key: 'section:X' }))?.text).toBe('▾ First')
      // The gate belongs to the first section only.
      expect((await shown(ui as Probe)).filter(line => line === 'Held').length).toBe(2)
      await ui.unmount()
    })

    test(`a long chip is cut and shrinks before the title at 36 columns on ${surface}`, async ($, on) => {
      const label = 'a-chip-label-that-is-far-too-long-to-sit-beside-a-title'
      const model = stageModel({
        sections: [section('S', 'Work', 'active', [item('the-title', 'planned', { chips: [{ kind: 'tag', label, tone: 'neutral' }] })])],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface, NARROW)
      const root = await tree(ui)
      const [trail] = chains(root, node => node.type === 'Text' && textOf(node).startsWith('[a-chip'))
      const chip = trail!.at(-1)!
      expect(textOf(chip).length).toBeLessThanOrEqual(22)
      expect(textOf(chip).endsWith('…]')).toBe(true)
      expect(chip.props.wrap).toBe('truncate-end')
      // It shrinks first (more than the title, which keeps its room) but never below 6 columns.
      expect(trail!.at(-2)!.props.flexShrink).toBeGreaterThan(1)
      expect(trail!.at(-2)!.props.minWidth).toBe(6)
      const [titleTrail] = chains(root, isText('the-title'))
      expect(titleTrail!.at(-2)!.props.flexShrink).toBe(1)
      expect(titleTrail!.at(-2)!.props.minWidth).toBe('the-title'.length)
      await ui.unmount()
    })

    test(`a linked title sits in a clipping wrapper on ${surface}`, async ($, on) => {
      const model = stageModel({
        sections: [section('S', 'Work', 'active', [item('ship', 'open', { href: 'https://example.com/ship', title: 'a-long-linked-title' })])],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface, NARROW)
      const [trail] = chains(await tree(ui), node => node.type === 'Link')
      expect(trail!.at(-2)!.props.overflow).toBe('hidden')
      expect(trail!.at(-2)!.props.flexShrink).toBe(1)
      await ui.unmount()
    })

    test(`on medium the badge and stamp give way after the title, the button never on ${surface}`, async ($, on) => {
      const model = sideJobModel()
      model.header.title = 'a-very-long-intent-name-that-would-never-fit-in-the-medium-pane-either'
      const { ui } = await draw($, on, model, surface, 48)
      const [row1] = kids(headerOf(await tree(ui)))
      const byText = (text: string) => kids(row1!).find(box => textOf(box) === text)!
      expect(kids(row1!)[0]!.props.flexShrink).toBe(1)
      expect(kids(row1!)[0]!.props.minWidth).toBe(8)
      for (const box of [byText('Side job'), byText('checked just now')]) {
        expect(box.props.flexShrink).toBeGreaterThan(0)
        expect(box.props.flexShrink).toBeLessThan(1)
      }
      expect(byText('↻ Refresh').props.flexShrink).toBe(0)
      await ui.unmount()
    })

    test(`the section heading truncates its tail rather than overflow on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface)
      const [trail] = chains(await tree(ui), isButton('section:INCEPTION'))
      expect(trail!.at(-2)!.props.flexShrink).toBe(1)
      expect(((trail!.at(-1)!.children ?? [])[0] as Node).props.wrap).toBe('truncate-end')
      await ui.unmount()
    })
  }

  test('foldedDone: nothing is hidden when the fold row cannot be drawn, nor under the cap, nor when all are shown', () => {
    const items = [...Array.from({ length: 8 }, (_, i) => item(`d${i}`, 'done')), item('p', 'planned')]
    const none = () => false
    expect(foldedDone(items, none, 6, false, true).size).toBe(8)
    expect(foldedDone(items, none, 6, false, false).size).toBe(0)
    expect(foldedDone(items, none, 6, true, true).size).toBe(0)
    expect(foldedDone(items, none, 9, false, true).size).toBe(0)
    expect(foldedDone(items, index => index === 0, 6, false, true).has(0)).toBe(false)
  })

  test('foldRow: an empty fold label shows every item; a label hides the done ones and counts them', () => {
    const items = [...Array.from({ length: 8 }, (_, i) => item(`d${i}`, 'done')), item('p', 'planned')]
    const none = () => false
    const blank = foldRow(items, none, 6, false, () => '')
    expect([blank.hidden.size, blank.text, blank.count]).toEqual([0, '', 8])
    const worded = foldRow(items, none, 6, false, count => `${count} done`)
    expect([worded.hidden.size, worded.text, worded.count]).toEqual([8, '8 done', 8])
    expect(foldRow(items, none, 6, true, count => `${count} done`).hidden.size).toBe(0)
  })
})

describe('the open-items cap', () => {
  /** A long, mostly-open section: `open` planned items t0.., `done` done items first. */
  const longModel = (open: number, extra: { done?: number; current?: number; gates?: PanelModel['gates']; fold?: number[] } = {}) => {
    const fold = { kind: 'fold' as const, label: '#2', tone: 'accent' as const }
    const items = [
      ...Array.from({ length: extra.done ?? 0 }, (_, i) => item(`done${i}`, 'done')),
      ...Array.from({ length: open }, (_, i) =>
        item(`t${i}`, 'planned', { isCurrent: i === extra.current, chips: extra.fold?.includes(i) ? [fold] : [] }),
      ),
    ]
    return stageModel({ sections: [section('S', 'Work', 'active', items)], gates: extra.gates ?? [], next: undefined })
  }
  // (From the section's heading on: the current item is also named by the Now card above.)
  const tasksIn = (lines: string[]) => lines.slice(Math.max(0, lines.indexOf('▾ Work'))).filter(line => /^t\d+$/.test(line))

  for (const surface of SURFACES) {
    for (const [columns, shownCount, rest] of [
      [NARROW, 8, 'Show 32 more'],
      [MEDIUM, 12, 'Show 28 more'],
      [WIDE, 20, 'Show 20 more'],
    ] as const) {
      test(`${columns} columns draw ${shownCount} of 40 open items and "${rest}" on ${surface}`, async ($, on) => {
        const { ui } = await draw($, on, longModel(40), surface, columns)
        let lines = await shown(ui as Probe)
        expect(tasksIn(lines)).toEqual(Array.from({ length: shownCount }, (_, i) => `t${i}`))
        const button = await ui.find({ type: 'Button', key: 'rest:S' })
        expect(button?.text).toBe(rest)
        expect(button?.props.plain).toBe(true)
        // The row closes the list.
        expect(lines.indexOf(rest)).toBeGreaterThan(lines.lastIndexOf(`t${shownCount - 1}`))
        expect(await ui.find({ key: 'restless:S' })).toBeUndefined()

        await ui.press({ key: 'rest:S' })
        lines = await shown(ui as Probe)
        expect(tasksIn(lines).length).toBe(40)
        expect(await ui.find({ key: 'rest:S' })).toBeUndefined()
        const fewer = await ui.find({ type: 'Button', key: 'restless:S' })
        expect(fewer?.text).toBe('Show fewer')
        expect(lines.indexOf('Show fewer')).toBeGreaterThan(lines.lastIndexOf('t39'))

        await ui.press({ key: 'restless:S' })
        expect(tasksIn(await shown(ui as Probe)).length).toBe(shownCount)
        await ui.unmount()
      })
    }

    test(`a current item past the cap stays, in plan order on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, longModel(40, { current: 30 }), surface, NARROW)
      const lines = await shown(ui as Probe)
      expect(tasksIn(lines)).toEqual([...Array.from({ length: 8 }, (_, i) => `t${i}`), 't30'])
      expect((await ui.find({ key: 'rest:S' }))?.text).toBe('Show 31 more')
      await ui.unmount()
    })

    test(`a section at the cap draws no row on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, longModel(8), surface, NARROW)
      expect(tasksIn(await shown(ui as Probe)).length).toBe(8)
      expect(await ui.find({ key: 'rest:S' })).toBeUndefined()
      await ui.unmount()
    })

    test(`the done row stays on top and the more row at the bottom, both at once on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, longModel(30, { done: 12 }), surface, MEDIUM)
      const lines = await shown(ui as Probe)
      expect(await ui.find({ key: 'more:S' })).toBeDefined()
      expect((await ui.find({ key: 'rest:S' }))?.text).toBe('Show 18 more')
      expect(lines.indexOf('✓ 12 done, show')).toBeLessThan(lines.indexOf('t0'))
      expect(lines.indexOf('Show 18 more')).toBeGreaterThan(lines.indexOf('t11'))
      expect(tasksIn(lines).length).toBe(12)
      // Independent: showing the done ones (they now take the first 12 places) leaves the cap on.
      await ui.press({ key: 'more:S' })
      const after = await shown(ui as Probe)
      expect(after.filter(line => /^done\d+$/.test(line)).length).toBe(12)
      expect(tasksIn(after).length).toBe(0)
      expect((await ui.find({ key: 'rest:S' }))?.text).toBe('Show 30 more')
      await ui.unmount()
    })

    test(`gates after hidden items are not drawn in the list but stay in attention on ${surface}`, async ($, on) => {
      const gates = [{ id: 'g', kind: 'x', tone: 'warning' as const, title: 'Held late', sectionId: 'S', afterItemId: 't20' }]
      const { ui } = await draw($, on, longModel(40, { gates }), surface, MEDIUM)
      expect((await shown(ui as Probe)).filter(line => line === 'Held late').length).toBe(1)
      await ui.press({ key: 'rest:S' })
      expect((await shown(ui as Probe)).filter(line => line === 'Held late').length).toBe(2)
      await ui.unmount()
    })

    test(`fold gutters are computed over what is drawn on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, longModel(40, { fold: [7, 8] }), surface, NARROW)
      let lines = await shown(ui as Probe)
      // t8 is past the cap of 8, so t7 is a lone fold chip and gets no gutter.
      expect(lines.filter(line => '┐│┘'.includes(line) && line !== '')).toEqual([])
      await ui.press({ key: 'rest:S' })
      lines = await shown(ui as Probe)
      expect(lines.filter(line => '┐│┘'.includes(line) && line !== '')).toEqual(['┐', '┘'])
      await ui.unmount()
    })

    test(`repeated section ids get distinct rest keys on ${surface}`, async ($, on) => {
      const open = (id: string) => section(id, id, 'active', Array.from({ length: 30 }, (_, i) => item(`${id}${i}`, 'planned')))
      const model = stageModel({ sections: [open('X'), open('X')], gates: [], next: undefined })
      const { ui } = await draw($, on, model, surface, MEDIUM)
      const keys = (await (ui as Probe).findAll({ type: 'Button' })).map(button => String(button.props.key)).filter(key => key.startsWith('rest:'))
      expect(keys).toEqual(['rest:X', 'rest:X~1'])
      await ui.unmount()
    })
  }

  test('openCap: an empty label leaves nothing out; a label leaves out the tail but never the current item', () => {
    const visible = Array.from({ length: 12 }, (_, i) => i)
    const never = () => false
    const blank = openCap(visible, never, 5, false, () => '')
    expect([blank.capped.size, blank.text, blank.count]).toEqual([0, '', 7])
    const worded = openCap(visible, index => index === 9, 5, false, count => `${count} more`)
    expect([...worded.capped]).toEqual([5, 6, 7, 8, 10, 11])
    expect(worded.text).toBe('6 more')
    expect(openCap(visible, never, 5, true, count => `${count} more`).capped.size).toBe(0)
    expect(openCap(visible, never, 12, false, count => `${count} more`).text).toBe('')
  })
})

describe('ledger-real fixes', () => {
  for (const surface of SURFACES) {
    test(`the Next reason, attention titles and drift labels wrap; the where truncates on ${surface}`, async ($, on) => {
      const reason = 'depends on T01a, T01b, T02, T03, all done and then some more words that would never fit on one line'
      const drift = 'T16 is marked partial in the ledger but PR #53 merged, so the ledger is behind the repository'
      const gateTitle = 'PR #31 is not merged yet and the next stage waits for it to land on main'
      const model = foldedModel({
        next: { command: 'start T18', reason },
        drift: [{ id: 'd', label: drift, tone: 'warning' }],
        gates: [{ id: 'g', kind: 'pr-not-merged', tone: 'error', title: gateTitle, sectionId: 'INCEPTION', afterItemId: 'refined-mockups' }],
      })
      for (const columns of [NARROW, MEDIUM, WIDE]) {
        const { ui } = await draw($, on, model, surface, columns)
        const wrapOf = async (text: string) => (await (ui as Probe).findAll({ type: 'Text', text }))[0]?.props.wrap
        expect(await wrapOf(reason)).toBe('wrap')
        expect(await wrapOf(drift)).toBe('wrap')
        expect(await wrapOf(gateTitle)).toBe('wrap')
        expect(await wrapOf('Inception, after refined-mockups')).toBe('truncate-end')
        await ui.unmount()
      }
    })

    test(`a section at 100% draws no strip, and every count shares one width on ${surface}`, async ($, on) => {
      const done = (id: string, count: number) => Array.from({ length: count }, (_, i) => item(`${id}${i}`, 'done'))
      const model = ledgerModel({
        sections: [
          section('big', 'Big', 'built', done('b', 18), { isCollapsed: true }),
          section('half', 'Half', 'partial', [...done('h', 6), ...Array.from({ length: 6 }, (_, i) => item(`p${i}`, 'planned'))], { isCollapsed: true }),
          section('few', 'Few', 'planned', [item('x', 'planned')], { isCollapsed: true }),
        ],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface, MEDIUM)
      const root = await tree(ui)
      // Only Half (12 items, not finished) has a strip.
      if (surface === 'desktop') {
        expect((await (ui as Probe).findAll({ type: 'Svg' })).filter(svg => svg.props.height === 6).length).toBe(1)
      } else {
        expect((await shown(ui as Probe)).filter(line => /^[█▓▒░]+$/.test(line)).join('').length).toBe(10)
      }
      // The widest count is "18/18 ✓": every count column is 7 wide.
      const widths = ['big', 'half', 'few'].map(id => {
        const heading = chains(root, isButton(`section:${id}`))[0]!.at(-3)!
        const [box] = chains(heading, node => node.type === 'Box' && node.props.justifyContent === 'flex-end')
        return box!.at(-1)!.props.minWidth
      })
      expect(widths).toEqual([7, 7, 7])
      await ui.unmount()
    })

    test(`a chip of 8 characters or fewer never shrinks, a longer one does on ${surface}`, async ($, on) => {
      const model = stageModel({
        sections: [
          section('S', 'Work', 'active', [
            item('a', 'planned', {
              chips: [
                { kind: 'pr', label: '#12', tone: 'success' },
                { kind: 'tag', label: '12345678', tone: 'neutral' },
                { kind: 'tag', label: '123456789', tone: 'neutral' },
              ],
            }),
          ]),
        ],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface, MEDIUM)
      const root = await tree(ui)
      const shrink = (label: string) => chains(root, isText(label))[0]!.at(-2)!.props.flexShrink
      expect(shrink('[#12]')).toBe(0)
      expect(shrink('[12345678]')).toBe(0)
      expect(shrink('[123456789]')).toBeGreaterThan(0)
      expect(chains(root, isText('[123456789]'))[0]!.at(-2)!.props.minWidth).toBe(6)
      await ui.unmount()
    })

    test(`several proposed sections share one divider on ${surface}`, async ($, on) => {
      const proposed = (id: string): PanelModel['sections'][number] => ({ id, title: `Idea ${id}`, status: 'planned', isCollapsed: true, isProposed: true, items: [] })
      const model = stageModel({ sections: [section('S', 'Work', 'active', [item('a', 'planned')]), proposed('p1'), proposed('p2')], gates: [] })
      const { ui } = await draw($, on, model, surface)
      const lines = await shown(ui as Probe)
      expect(lines.filter(line => line === 'Proposed').length).toBe(1)
      expect(lines.indexOf('Proposed')).toBeLessThan(lines.indexOf('Idea p1'))
      expect(lines.indexOf('Proposed')).toBeGreaterThan(lines.indexOf('a'))
      expect(lines).toContain('Idea p2')
      await ui.unmount()
    })

    test(`a real section with no items and no counts draws no ring and a dim title on ${surface}`, async ($, on) => {
      const empty = section('E', 'Empty', 'planned', [], { percent: 0 })
      const model = stageModel({ sections: [empty, section('S', 'Work', 'planned', [item('a', 'planned')])], gates: [] })
      const { ui } = await draw($, on, model, surface)
      const root = await tree(ui)
      const heading = chains(root, isButton('section:E'))[0]!.at(-3)!
      if (surface === 'desktop') expect(chains(heading, node => node.type === 'Svg')).toEqual([])
      else expect(chains(heading, node => node.type === 'Text' && '○◔◑◕●'.includes(textOf(node)) && textOf(node) !== '')).toEqual([])
      expect((await ui.find({ key: 'section:E' }))?.props.dimColor).toBe(true)
      expect((await ui.find({ key: 'section:S' }))?.props.dimColor).not.toBe(true)
      await ui.unmount()
    })

    test(`the subtitle is a dim truncating line, unless the Now card names the current item on ${surface}`, async ($, on) => {
      // Side job: the card says "This session", so the subtitle says where the plan stands.
      let { ui } = await draw($, on, sideJobModel(), surface, MEDIUM)
      let found = await (ui as Probe).findAll({ type: 'Text', text: 'Inception · domain-design' })
      expect(found.length).toBe(1)
      expect(found[0]?.props.dimColor).toBe(true)
      expect(found[0]?.props.wrap).toBe('wrap')
      await ui.unmount()

      // On S it sits under row 2 (the badge and stamp).
      ;({ ui } = await draw($, on, sideJobModel(), surface, NARROW))
      const rows = kids(headerOf(await tree(ui)))
      expect(textOf(rows[1]!)).toContain('Side job')
      expect(textOf(rows[2]!)).toBe('Inception · domain-design')
      await ui.unmount()

      // A stage session with a current item: hidden, the card's "where" says it.
      ;({ ui } = await draw($, on, stageModel(), surface, MEDIUM))
      expect(await (ui as Probe).findAll({ type: 'Text', text: 'Inception · domain-design' })).toEqual([])
      await ui.unmount()

      // No current item (a ledger): shown.
      const ledger = ledgerModel()
      ledger.header.subtitle = 'WORKPLAN.md · 35/40 done'
      for (const one of ledger.sections) for (const each of one.items) each.isCurrent = false
      ;({ ui } = await draw($, on, ledger, surface, MEDIUM))
      expect((await (ui as Probe).findAll({ type: 'Text', text: 'WORKPLAN.md · 35/40 done' })).length).toBe(1)
      await ui.unmount()

      // Idle: the card has a headline, not an item, so the subtitle shows.
      const idle = idleModel()
      idle.header.subtitle = 'No intent in flight'
      ;({ ui } = await draw($, on, idle, surface, MEDIUM))
      expect((await (ui as Probe).findAll({ type: 'Text', text: 'No intent in flight' })).length).toBe(1)
      await ui.unmount()
    })

    test(`a long linked title truncates: a Text child with truncate-end in a clipping, shrinking wrapper on ${surface}`, async ($, on) => {
      const model = stageModel({
        sections: [section('S', 'Work', 'active', [item('ship', 'open', { href: 'https://example.com/ship', title: 'a-very-long-linked-title-that-cannot-fit-in-thirty-six-columns' })])],
        gates: [],
      })
      const { ui } = await draw($, on, model, surface, NARROW)
      const [trail] = chains(await tree(ui), node => node.type === 'Link')
      const link = trail!.at(-1)!
      expect(link.props.href).toBe('https://example.com/ship')
      expect(kids(link)[0]!.props.wrap).toBe('truncate-end')
      expect(trail!.at(-2)!.props.overflow).toBe('hidden')
      expect(trail!.at(-2)!.props.flexShrink).toBe(1)
      await ui.unmount()
    })
  }
})

describe('the plan heading label', () => {
  const LABEL = '74% of effort · 189/287 tasks (weighted)'
  for (const surface of SURFACES) {
    test(`overall.label replaces the summary and wraps at 36 columns on ${surface}`, async ($, on) => {
      const label = '74% of effort · 189/287 tasks, weighted by size'
      expect(Array.from(label).length).toBeGreaterThanOrEqual(45)
      const model = ledgerModel()
      model.overall = { ...model.overall, percent: 74, label }
      for (const columns of [NARROW, MEDIUM, WIDE]) {
        const { ui } = await draw($, on, model, surface, columns)
        const root = await tree(ui)
        const lines = await shown(ui as Probe)
        const [trail] = chains(root, isText(label))
        expect(trail).toBeDefined()
        expect(trail!.at(-1)!.props.wrap).toBe('wrap')
        // Beside the ring, in a Box that shrinks.
        expect(trail!.at(-2)!.props.flexShrink).toBe(1)
        expect(lines.some(line => line.includes('% done,'))).toBe(false)
        expect(lines).toContain('Plan')
        // The ring is still the percent's, and never shrinks.
        if (surface === 'desktop') {
          const [ringTrail] = chains(root, node => node.type === 'Svg' && node.props.width === 40)
          expect(ringTrail!.at(-1)!.props.alt).toBe('74% done')
          expect(ringTrail!.at(-2)!.props.flexShrink).toBe(0)
        } else {
          expect(lines[lines.indexOf('Plan') - 1]).toBe('◕')
        }
        await ui.unmount()
      }
    })

    test(`an empty or absent overall.label falls back to the renderer's summary on ${surface}`, async ($, on) => {
      for (const label of [undefined, '']) {
        const model = stageModel()
        model.overall = { ...model.overall, ...(label === undefined ? {} : { label }) }
        const { ui } = await draw($, on, model, surface)
        expect(await shown(ui as Probe)).toContain('50% done, 11 of 26')
        await ui.unmount()
      }
    })

    test(`overall.label shows even without a percent, and with no ring on ${surface}`, async ($, on) => {
      const model = stageModel()
      model.overall = { label: LABEL, counts: { total: 26 } }
      const { ui } = await draw($, on, model, surface)
      expect(await shown(ui as Probe)).toContain(LABEL)
      expect((await (ui as Probe).findAll({ type: 'Svg' })).some(svg => svg.props.width === 40)).toBe(false)
      await ui.unmount()
    })

    test(`a 45-character plan label at 36 columns and the subtitle both wrap instead of being cut on ${surface}`, async ($, on) => {
      const model = sideJobModel()
      model.header.subtitle = 'WORKPLAN.md · 74% of effort · 189/287 tasks'
      const { ui } = await draw($, on, model, surface, NARROW)
      const subtitle = (await (ui as Probe).findAll({ type: 'Text', text: model.header.subtitle }))[0]
      expect(subtitle?.props.wrap).toBe('wrap')
      await ui.unmount()
    })
  }
})
