// The rich look, drawn on the desktop (vscode and mobile share it: they all draw Svg): item icons and tinted current
// row, pills for words and chips, a chevron/ring/title heading, one-line plan gates with the caption in Needs attention,
// the header on one row, capital labels, a stacked Next and the stepper card. Each test draws the same model on the
// terminal too and checks that it keeps its glyphs, brackets and sentence-case labels.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { CARD_FILL, CARD_LINE, tint } from '../src/render/kit'
import { iconSource } from '../src/render/look'
import { bare, padded, ringsOf } from './rich'
import { MOUNT, foldedModel, item, section, seedModel, sideJobModel, stageModel } from './world'
import type { Chip, Gate, PanelModel } from '../types'

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'
type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }
type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }

const NARROW = 36
const MEDIUM = 60
const WIDE = 92

/** Mounts the Pane over a model held in memory; a second draw in the same test swaps the model (the hooks are registered once). */
const held = new WeakMap<object, { model: PanelModel }>()
async function draw($: Engine, on: On, model: PanelModel, surface: Surface, columns = MEDIUM) {
  const holder = held.get(on)
  if (holder) holder.model = model
  else {
    const fresh = { model }
    held.set(on, fresh)
    seedModel(on, () => fresh.model)
  }
  return $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: columns } })
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

const nodesOf = (root: Node, pred: (node: Node) => boolean): Node[] => chains(root, pred).map(chain => chain.at(-1)!)
const tree = async (ui: { drawn: () => Promise<unknown> }): Promise<Node> => (await ui.drawn()) as Node
const probe = (ui: unknown): Probe => ui as Probe

/** Every Text and Button of the drawing in document order, as shown (a pill or chip without its padding). */
async function shown(ui: unknown): Promise<string[]> {
  const all = await probe(ui).findAll({})
  return all.filter(el => el.type === 'Text' || el.type === 'Button').map(el => bare(el.text))
}

const svgs = async (ui: unknown): Promise<Found[]> => probe(ui).findAll({ type: 'Svg' })
const texts = async (ui: unknown, text: string): Promise<Found[]> => (await probe(ui).findAll({ type: 'Text' })).filter(el => bare(el.text) === text)

/** The row Box of an item on the desktop: 1 cell in, the title as one of its children. */
function rowOf(root: Node, title: string): Node {
  const hit = chains(root, node => node.type === 'Box' && node.props.paddingLeft === 1 && kids(node).some(box => textOf(box) === title))[0]
  if (hit === undefined) throw new Error(`no desktop row for ${title}`)
  return hit.at(-1)!
}

/** The section's heading Box: the one holding its title Button. */
function headingOf(root: Node, id: string): Node {
  const hit = chains(root, node => node.type === 'Button' && node.props.key === `section:${id}`)[0]
  if (hit === undefined) throw new Error(`no heading for ${id}`)
  return hit.at(-3)!
}

/** What a heading child draws, in a word: the first Text/Svg/Button inside it. */
const partOf = (box: Node): string => {
  const first = chains(box, node => node.type === 'Text' || node.type === 'Svg' || node.type === 'Button')[0]?.at(-1)
  return first === undefined ? 'none' : first.type
}

// ── item icons ───────────────────────────────────────────────────────────────

describe('the item icon', () => {
  const statuses = () =>
    stageModel({
      sections: [
        section('S', 'Work', 'active', [
          item('is-done', 'done'),
          item('is-stale', 'stale'),
          item('is-partial', 'partial'),
          item('is-open', 'open'),
          item('is-local', 'open', { landing: 'local', statusWord: '' }),
          item('is-current', 'planned', { isCurrent: true }),
          item('is-planned', 'planned'),
          item('is-skipped', 'skipped'),
          item('is-failed', 'failed'),
          item('is-awaiting', 'awaiting'),
          item('is-revising', 'revising'),
          item('is-reopened', 'reopened'),
        ]),
      ],
      gates: [],
    })

  // title -> [kind, glyph in the ring, alt]: the alt is the status word when there is one, else what the icon means.
  const expected: [string, Parameters<typeof iconSource>[0], string, string][] = [
    ['is-done', 'done', '', 'done'],
    ['is-stale', 'stale', '', 'stale'],
    ['is-partial', 'live', '◐', 'partial'],
    ['is-open', 'live', '◐', 'in progress'],
    ['is-local', 'local', '◌', 'local only'],
    ['is-current', 'current', '', 'current'],
    ['is-planned', 'planned', '', 'planned'],
    ['is-skipped', 'skipped', '', 'skipped'],
    ['is-failed', 'failed', '', 'failed'],
    ['is-awaiting', 'mark', '?', 'awaiting'],
    ['is-revising', 'mark', '↻', 'revising'],
    ['is-reopened', 'mark', '↺', 'reopened'],
  ]

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    test(`${surface}: a 14 px Svg per status instead of a glyph Text, its alt the word or the meaning`, async ($, on) => {
      const ui = await draw($, on, statuses(), surface, WIDE)
      const root = await tree(ui)
      for (const [title, kind, mark, alt] of expected) {
        const row = rowOf(root, title)
        const icon = chains(row, node => node.type === 'Svg')[0]?.at(-1)
        expect([title, icon?.props.alt, icon?.props.width, icon?.props.height]).toEqual([title, alt, 14, 14])
        expect([title, icon?.props.source]).toEqual([title, iconSource(kind, mark)])
        // The first thing in the row is the icon: no glyph Text before the title.
        expect(partOf(row)).toBe('Svg')
        expect(chains(row, node => node.type === 'Text' && ['✓', '◐', '○', '–', '✕', '↻', '?', '↺', '◌', '›'].includes(textOf(node))).length).toBe(0)
      }
      await ui.unmount()
    })
  }

  test('the terminal keeps its glyphs and draws no Svg for them', async ($, on) => {
    const ui = await draw($, on, statuses(), 'terminal', WIDE)
    expect(await svgs(ui)).toEqual([])
    const lines = await shown(ui)
    for (const glyph of ['✓', '◐', '◌', '○', '–', '✕', '↻', '?', '↺']) expect(lines).toContain(glyph)
    await ui.unmount()
  })

  test('the Now card draws the current item as the same icon', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const live = (await svgs(ui)).filter(svg => svg.props.alt === 'in progress')
    // domain-design: in the card and in its row.
    expect(live).toHaveLength(2)
    for (const svg of live) expect(svg.props.source).toBe(iconSource('live', '◐'))
    await ui.unmount()
  })
})

// ── the current row ──────────────────────────────────────────────────────────

describe('the current row', () => {
  test('desktop: no › anywhere; the current row alone carries the accent tint', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    expect(await texts(ui, '›')).toEqual([])
    const root = await tree(ui)
    const tinted = nodesOf(root, node => node.type === 'Box' && node.props.backgroundColor === tint('claude', '1a'))
    expect(tinted).toHaveLength(1)
    expect(textOf(tinted[0]!)).toContain('domain-design')
    expect(tinted[0]).toBe(rowOf(root, 'domain-design'))
    // Another row has no fill.
    expect(rowOf(root, 'units-generation').props.backgroundColor).toBeUndefined()
    // The title is bold.
    expect((await probe(ui).findAll({ type: 'Text', text: 'domain-design' })).some(el => el.props.bold === true)).toBe(true)
    await ui.unmount()
  })

  test('terminal: the › gutter once, in the accent, and no tint', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'terminal', WIDE)
    const marks = await texts(ui, '›')
    expect(marks).toHaveLength(1)
    expect([marks[0]?.props.color, marks[0]?.props.bold]).toEqual(['claude', true])
    expect(nodesOf(await tree(ui), node => node.props.backgroundColor !== undefined)).toEqual([])
    await ui.unmount()
  })
})

// ── chips ────────────────────────────────────────────────────────────────────

describe('chips', () => {
  const chips: Chip[] = [
    { kind: 'pr', label: '#12', tone: 'success', href: 'https://example.com/pull/12' },
    { kind: 'unit', label: 'api', tone: 'accent' },
    { kind: 'tag', label: 'x', tone: 'neutral' },
  ]
  const model = () => stageModel({ sections: [section('S', 'Work', 'active', [item('ship', 'open', { chips })])], gates: [] })

  test('desktop: a padded label on a grey fill, in its tone and dim; no brackets', async ($, on) => {
    const ui = await draw($, on, model(), 'desktop', MEDIUM)
    for (const [label, color] of [['#12', 'success'], ['api', 'claude'], ['x', undefined]] as const) {
      const chip = (await probe(ui).findAll({ type: 'Text' })).find(el => el.text === padded(label))
      expect(chip).toBeDefined()
      expect(chip?.props.color).toBe(color)
      expect(chip?.props.dimColor).toBe(true)
      expect(chip?.props.backgroundColor).toBe(tint(undefined, '24'))
    }
    expect((await shown(ui)).filter(line => line.includes('[') || line.includes(']'))).toEqual([])
    // The linked chip keeps its Link, labelled with the padded text.
    const links = await probe(ui).findAll({ type: 'Link' })
    expect(links.map(link => [link.props.href, link.props.label])).toEqual([['https://example.com/pull/12', padded('#12')]])
    await ui.unmount()
  })

  test('desktop, narrow: the first chip and a dim +N', async ($, on) => {
    const ui = await draw($, on, model(), 'desktop', NARROW)
    const lines = await shown(ui)
    expect(lines).toContain('#12')
    expect(lines).not.toContain('api')
    const more = (await probe(ui).findAll({ type: 'Text', text: '+2' }))[0]
    expect(more?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('terminal: bracketed labels, no fill', async ($, on) => {
    const ui = await draw($, on, model(), 'terminal', MEDIUM)
    expect(await shown(ui)).toEqual(expect.arrayContaining(['[#12]', '[api]', '[x]']))
    const chip = (await probe(ui).findAll({ type: 'Text', text: '[#12]' }))[0]
    expect([chip?.props.color, chip?.props.dimColor, chip?.props.backgroundColor]).toEqual(['success', true, undefined])
    await ui.unmount()
  })
})

// ── status words ─────────────────────────────────────────────────────────────

describe('the status word', () => {
  const model = () =>
    stageModel({
      sections: [section('S', 'Work', 'active', [item('going', 'open'), item('broke', 'failed'), item('left-out', 'skipped'), item('finished', 'done')])],
      gates: [],
    })

  test('desktop: a pill — padded, in the tone, on that tone\'s tint; a skipped one is a grey pill', async ($, on) => {
    const ui = await draw($, on, model(), 'desktop', MEDIUM)
    const word = async (text: string) => (await probe(ui).findAll({ type: 'Text' })).filter(el => el.text === padded(text))
    const [going] = await word('in progress')
    expect([going?.props.color, going?.props.backgroundColor]).toEqual(['claude', tint('claude', '24')])
    const [broke] = await word('failed')
    expect([broke?.props.color, broke?.props.backgroundColor]).toEqual(['error', tint('error', '24')])
    const [skipped] = await word('skipped')
    expect([skipped?.props.dimColor, skipped?.props.backgroundColor]).toEqual([true, tint(undefined, '1a')])
    // A done item says nothing in words.
    expect((await shown(ui)).filter(line => line === 'done')).toEqual([])
    await ui.unmount()
  })

  test('terminal: the bare word, coloured, with no fill', async ($, on) => {
    const ui = await draw($, on, model(), 'terminal', MEDIUM)
    const [going] = await probe(ui).findAll({ type: 'Text', text: 'in progress' })
    expect([going?.text, going?.props.color, going?.props.backgroundColor]).toEqual(['in progress', 'claude', undefined])
    await ui.unmount()
  })

  test('the Now card\'s word is a pill too', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const pills = (await probe(ui).findAll({ type: 'Text' })).filter(el => el.text === padded('in progress'))
    // Its row and the card.
    expect(pills).toHaveLength(2)
    for (const one of pills) expect(one.props.backgroundColor).toBe(tint('claude', '24'))
    await ui.unmount()
  })
})

// ── section headings ─────────────────────────────────────────────────────────

describe('the section heading', () => {
  const uncounted = () => {
    const model = stageModel()
    const construction = model.sections.find(one => one.id === 'CONSTRUCTION')!
    construction.isUncounted = true
    delete construction.counts
    delete construction.percent
    return model
  }

  test('desktop: chevron Text, then the 16 px ring, then the title Button with no chevron in it; the count stays right', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const root = await tree(ui)
    const heading = headingOf(root, 'INCEPTION')
    const parts = kids(heading)
    expect(parts.slice(0, 3).map(partOf)).toEqual(['Text', 'Svg', 'Button'])
    expect(textOf(parts[0]!)).toBe('▾')
    expect(chains(parts[0]!, node => node.type === 'Text')[0]!.at(-1)!.props.dimColor).toBe(true)
    const ring = chains(parts[1]!, node => node.type === 'Svg')[0]!.at(-1)!
    expect([ring.props.width, ring.props.height, ring.props.alt]).toEqual([16, 16, '50% done'])
    expect(textOf(parts[2]!)).toBe('Inception')
    const button = chains(parts[2]!, node => node.type === 'Button')[0]!.at(-1)!
    expect(button.props.key).toBe('section:INCEPTION')
    // The count is the tail alone: no ring beside it.
    const tail = parts.at(-1)!
    expect(textOf(tail)).toBe('4/8')
    expect(chains(tail, node => node.type === 'Svg')).toEqual([])
    // A closed section's chevron points right.
    expect(textOf(kids(headingOf(root, 'CONSTRUCTION'))[0]!)).toBe('▸')
    await ui.unmount()
  })

  test('desktop: a skipped phase and one with nothing counted get a dashed placeholder of the ring\'s size', async ($, on) => {
    const ui = await draw($, on, uncounted(), 'desktop', MEDIUM)
    const root = await tree(ui)
    const placeholder = (id: string) => chains(kids(headingOf(root, id))[1]!, node => node.type === 'Svg')[0]!.at(-1)!
    for (const [id, alt] of [['OPERATION', 'skipped'], ['CONSTRUCTION', 'not included yet']] as const) {
      expect(kids(headingOf(root, id)).slice(0, 3).map(partOf)).toEqual(['Text', 'Svg', 'Button'])
      const svg = placeholder(id)
      expect([id, svg.props.width, svg.props.height, svg.props.alt]).toEqual([id, 16, 16, alt])
      expect(String(svg.props.source)).toContain('stroke-dasharray')
    }
    // A counted one has a real ring, not a placeholder.
    expect(placeholder('INCEPTION').props.alt).toBe('50% done')
    // Their words stay on the right.
    expect((await shown(ui)).filter(line => line === 'skipped' || line === 'not included yet').sort()).toEqual(['not included yet', 'skipped'])
    await ui.unmount()
  })

  test('desktop: a section with no items and no counts has a placeholder with no alt, a dim title', async ($, on) => {
    const empty = section('E', 'Empty', 'planned', [], { percent: 0 })
    const ui = await draw($, on, stageModel({ sections: [empty, section('S', 'Work', 'planned', [item('a', 'planned')])], gates: [] }), 'desktop', MEDIUM)
    const heading = headingOf(await tree(ui), 'E')
    const svg = chains(kids(heading)[1]!, node => node.type === 'Svg')[0]!.at(-1)!
    expect([svg.props.width, svg.props.alt]).toEqual([16, ''])
    expect((await ui.find({ key: 'section:E' }))?.props.dimColor).toBe(true)
    // Rings are only for counted sections.
    expect(ringsOf(await svgs(ui), 16).map(ring => ring.props.alt)).toEqual(['0% done'])
    await ui.unmount()
  })

  test('terminal: one Button with the chevron in its text, the ring a glyph in the tail, no placeholder', async ($, on) => {
    const ui = await draw($, on, uncounted(), 'terminal', MEDIUM)
    expect(await svgs(ui)).toEqual([])
    expect((await ui.find({ key: 'section:INCEPTION' }))?.text).toBe('▾ Inception')
    expect((await ui.find({ key: 'section:CONSTRUCTION' }))?.text).toBe('▸ Construction')
    const heading = headingOf(await tree(ui), 'INCEPTION')
    expect(partOf(kids(heading)[0]!)).toBe('Button')
    await ui.unmount()
  })
})

// ── the plan ─────────────────────────────────────────────────────────────────

describe('the plan heading', () => {
  test('desktop: Plan is bold, the summary dim; the terminal keeps Plan dim and the summary bold', async ($, on) => {
    let ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    let [plan] = await texts(ui, 'Plan')
    let [summary] = await texts(ui, '50% done, 11 of 26')
    expect([plan?.props.bold, plan?.props.dimColor].map(Boolean)).toEqual([true, false])
    expect([summary?.props.bold, summary?.props.dimColor].map(Boolean)).toEqual([false, true])
    await ui.unmount()

    ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    ;[plan] = await texts(ui, 'Plan')
    ;[summary] = await texts(ui, '50% done, 11 of 26')
    expect([plan?.props.bold, plan?.props.dimColor].map(Boolean)).toEqual([true, true])
    expect([summary?.props.bold, summary?.props.dimColor].map(Boolean)).toEqual([true, false])
    await ui.unmount()
  })

  test('desktop: one 40 px ring for the plan, and the 16 px rings only for counted sections', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const all = await svgs(ui)
    expect(ringsOf(all, 40).map(svg => svg.props.alt)).toEqual(['50% done'])
    expect(ringsOf(all, 16).map(svg => svg.props.alt)).toEqual(['100% done', '100% done', '50% done', '0% done'])
    await ui.unmount()
  })
})

// ── gates ────────────────────────────────────────────────────────────────────

describe('gates', () => {
  const GATE: Gate = {
    id: 'pr',
    kind: 'pr-not-merged',
    tone: 'error',
    title: 'PR #31 not merged',
    caption: 'domain-design starts once #31 lands on main.',
    sectionId: 'INCEPTION',
    afterItemId: 'domain-design',
    href: 'https://example.com/pull/31',
    command: '/aidlc resume',
  }
  const model = () => stageModel({ gates: [GATE] })

  test('desktop: the plan gate is one line — glyph and title in the tone, the title a Link — with no border and no caption', async ($, on) => {
    const ui = await draw($, on, model(), 'desktop', WIDE)
    const root = await tree(ui)
    const lines = nodesOf(root, node => node.type === 'Box' && textOf(node) === '⊘PR #31 not merged' && node.props.marginLeft === 5)
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line.props.borderStyle).toBeUndefined()
    expect(kids(line).length).toBe(2)
    expect(chains(line, node => node.type === 'Link')).toHaveLength(1)
    const glyph = chains(line, node => node.type === 'Text')[0]!.at(-1)!
    expect([textOf(glyph), glyph.props.bold, glyph.props.color]).toEqual(['⊘', true, 'error'])
    const link = chains(line, node => node.type === 'Link')[0]!.at(-1)!
    expect([link.props.href, link.props.label]).toEqual(['https://example.com/pull/31', 'PR #31 not merged'])
    const title = chains(link, node => node.type === 'Text')[0]!.at(-1)!
    expect([title.props.color, title.props.bold]).toEqual(['error', undefined])
    // It sits right after its item. Its caption is drawn nowhere: the plan's line is one line, and Needs attention says
    // its PR in a word or two.
    const all = await shown(ui)
    expect(all.filter(text => text === GATE.caption)).toHaveLength(0)
    expect(all.lastIndexOf('PR #31 not merged')).toBeGreaterThan(all.lastIndexOf('domain-design'))
    expect(all[all.lastIndexOf('PR #31 not merged') + 1]).toBe('units-generation')
    await ui.unmount()
  })

  test('terminal: the plan gate keeps its bordered card with the caption under the title', async ($, on) => {
    const ui = await draw($, on, model(), 'terminal', WIDE)
    const root = await tree(ui)
    const cards = nodesOf(root, node => node.props.borderStyle === 'round' && node.props.borderColor === 'error' && node.props.marginLeft === 4)
    expect(cards).toHaveLength(1)
    expect(textOf(cards[0]!)).toContain(GATE.caption)
    // Only there: the terminal's Needs attention rows carry no caption.
    expect((await shown(ui)).filter(text => text === GATE.caption)).toHaveLength(1)
    await ui.unmount()
  })
})

describe('Needs attention', () => {
  const model = () => foldedModel({ gates: [...foldedModel().gates, { id: 'cmd', kind: 'x', tone: 'warning', title: 'Resume it', sectionId: '', command: '/aidlc resume' }] })

  test('desktop: the heading is bold words, the count a pill; cards in tinted edges; the title in the text colour; the caption dim', async ($, on) => {
    const ui = await draw($, on, model(), 'desktop', MEDIUM)
    const root = await tree(ui)
    const [heading] = await texts(ui, 'Needs attention')
    expect([heading?.props.bold, heading?.props.dimColor]).toEqual([true, undefined])
    // 3 gates + the drift flag: four rows, the count a pill in the error colour (one row is an error).
    const count = (await probe(ui).findAll({ type: 'Text' })).find(el => el.text === padded('4'))
    expect([count?.props.color, count?.props.backgroundColor]).toEqual(['error', tint('error', '24')])
    // The column: heading row first, a line above the cards, which stand two lines apart.
    const column = chains(root, node => node.type === 'Box' && node.props.gap === 1 && textOf(kids(node)[0] ?? '').startsWith('Needs attention'))[0]!.at(-1)!
    expect(kids(column).length).toBe(2)
    expect(textOf(kids(column)[0]!)).toBe(`Needs attention${padded('4')}`)
    const list = kids(column)[1]!
    expect([list.props.gap, kids(list).length]).toEqual([2, 4])
    // Each card: tinted line and fill of its row's colour (raw hex, not a theme key). One PR row stays a card of its own.
    const [questions, pr, resume, drift] = kids(list)
    expect([questions, pr, resume, drift].map(card => [card!.props.borderColor, card!.props.backgroundColor])).toEqual([
      [tint('warning', '66'), tint('warning', '17')],
      [tint('error', '66'), tint('error', '17')],
      [tint('warning', '66'), tint('warning', '17')],
      [tint('warning', '66'), tint('warning', '17')],
    ])
    // The title is in the text colour; the glyph keeps the tone.
    const title = chains(pr!, node => node.type === 'Text' && textOf(node) === 'PR #31 not merged')[0]!.at(-1)!
    expect([title.props.color, title.props.bold]).toEqual([undefined, true])
    const glyph = chains(pr!, node => node.type === 'Text' && textOf(node) === '⊘')[0]!.at(-1)!
    expect([glyph.props.color, glyph.props.bold]).toEqual(['error', true])
    // The caption under the title line: dim, wrapped.
    const caption = chains(pr!, node => node.type === 'Text' && textOf(node) === 'domain-design starts once #31 lands on main.')[0]!.at(-1)!
    expect([caption.props.dimColor, caption.props.wrap]).toEqual([true, 'wrap'])
    // A gate with no caption has none; a command is a button under the title.
    expect(chains(resume!, node => node.type === 'Text' && node.props.dimColor === true && textOf(node) !== 'Resume it').map(chain => textOf(chain.at(-1)!))).toEqual([])
    expect(chains(resume!, node => node.type === 'Button')[0]?.at(-1)?.props.key).toBe('attention:fill:gate:cmd')
    await ui.unmount()
  })

  test('desktop: the rows about pull requests are one card, a line per PR, where the first stood, in the worst tone', async ($, on) => {
    const url = (n: number) => `https://github.com/acme/shop/pull/${n}`
    const gates: Gate[] = [
      { id: 'changes-requested:60', kind: 'changes-requested', tone: 'warning', title: 'Changes requested on your PR #60', caption: 'Answer the review before it can merge.', sectionId: '', isAttentionOnly: true, href: url(60), command: '/pr-review:address-review 60' },
      { id: 'parked', kind: 'parked', tone: 'warning', title: 'Parked at contract-design', sectionId: '' },
      { id: 'pr:66', kind: 'pr-not-merged', tone: 'warning', title: 'PR #66 not merged', caption: "functional-design can't start on main until it lands.", sectionId: '', href: url(66) },
      { id: 'changes-requested:66', kind: 'changes-requested', tone: 'warning', title: 'Changes requested on your PR #66', sectionId: '', href: url(66), command: '/pr-review:address-review 66' },
      { id: 'conflicts:66', kind: 'conflicts', tone: 'error', title: 'PR #66 has conflicts with main', sectionId: '', href: url(66) },
    ]
    const ui = await draw($, on, stageModel({ gates }), 'desktop', MEDIUM)
    const root = await tree(ui)
    const column = chains(root, node => node.type === 'Box' && node.props.gap === 1 && textOf(kids(node)[0] ?? '').startsWith('Needs attention'))[0]!.at(-1)!
    // Every row still counts.
    expect(textOf(kids(column)[0]!)).toBe(`Needs attention${padded('5')}`)
    const [prs, parked] = kids(kids(column)[1]!)
    expect(kids(kids(column)[1]!).length).toBe(2)
    expect([prs!.props.borderColor, prs!.props.backgroundColor]).toEqual([tint('error', '66'), tint('error', '17')])
    // The heading counts the PRs; then one line each: the worst glyph, the PR as a link, its words worst first, its command.
    const inner = kids(prs!)[0]!
    expect(textOf(kids(inner)[0]!)).toBe('Pull requests (2)')
    const lines = kids(inner).slice(1)
    expect(lines.map(line => textOf(line))).toEqual(['‖PR #60changes requestedaddress-review', '⊘PR #66conflicts · not merged · changes requestedaddress-review'])
    const link = chains(lines[1]!, node => node.type === 'Link')[0]!.at(-1)!
    expect([link.props.href, link.props.label]).toEqual([url(66), 'PR #66'])
    const glyph = chains(lines[1]!, node => node.type === 'Text' && textOf(node) === '⊘')[0]!.at(-1)!
    expect(glyph.props.color).toBe('error')
    // No captions, no where: the line says it all.
    expect(textOf(prs!)).not.toContain("can't start")
    expect(textOf(prs!)).not.toContain('Answer the review')
    expect(textOf(parked!)).toContain('Parked at contract-design')
    // The button presses the row's command it came from.
    expect(chains(lines[1]!, node => node.type === 'Button')[0]?.at(-1)?.props.key).toBe('attention:fill:gate:changes-requested:66')
    await ui.unmount()
  })

  test('desktop: one PR row is a line in the PR card too', async ($, on) => {
    const gates: Gate[] = [{ id: 'pr:31', kind: 'pr-not-merged', tone: 'warning', title: 'PR #31 not merged', sectionId: '', href: 'https://gitlab.example.com/acme/shop/-/merge_requests/31' }]
    const ui = await draw($, on, stageModel({ gates }), 'desktop', MEDIUM)
    const texts = await shown(ui)
    expect(texts).toContain('Pull requests (1)')
    expect(texts).toContain('MR !31')
    expect(texts).toContain('not merged')
    await ui.unmount()
  })

  test('terminal: PR rows keep their places, no card', async ($, on) => {
    const url = (n: number) => `https://github.com/acme/shop/pull/${n}`
    const gates: Gate[] = [
      { id: 'pr:66', kind: 'pr-not-merged', tone: 'warning', title: 'PR #66 not merged', sectionId: '', href: url(66) },
      { id: 'parked', kind: 'parked', tone: 'warning', title: 'Parked at contract-design', sectionId: '' },
      { id: 'conflicts:66', kind: 'conflicts', tone: 'error', title: 'PR #66 has conflicts with main', sectionId: '', href: url(66) },
    ]
    const ui = await draw($, on, stageModel({ gates }), 'terminal', MEDIUM)
    const lines = await shown(ui)
    const at = (text: string) => lines.findIndex(line => line.includes(text))
    expect(at('PR #66 not merged') < at('Parked at contract-design') && at('Parked at contract-design') < at('PR #66 has conflicts')).toBe(true)
    expect(lines.some(line => line.includes('Pull requests'))).toBe(false)
    await ui.unmount()
  })

  test('desktop: the count pill is warning when no row is an error', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const count = (await probe(ui).findAll({ type: 'Text' })).find(el => el.text === padded('1'))
    expect([count?.props.color, count?.props.backgroundColor]).toEqual(['warning', tint('warning', '24')])
    await ui.unmount()
  })

  test('terminal: the dim heading with the count in its words; the title in the tone; no card', async ($, on) => {
    const ui = await draw($, on, model(), 'terminal', MEDIUM)
    const [heading] = await texts(ui, 'Needs attention (4)')
    expect([heading?.props.bold, heading?.props.dimColor]).toEqual([true, true])
    expect((await texts(ui, 'PR #31 not merged'))[0]?.props.color).toBe('error')
    // The caption is not in the attention list on the terminal (it is in the plan's card).
    const lines = await shown(ui)
    expect(lines.slice(lines.indexOf('Needs attention (4)'), lines.indexOf('Plan')).includes('domain-design starts once #31 lands on main.')).toBe(false)
    expect(nodesOf(await tree(ui), node => node.props.borderStyle === 'round' && node.props.borderColor === 'error' && node.props.marginLeft !== 4)).toEqual([])
    await ui.unmount()
  })
})

// ── the header ───────────────────────────────────────────────────────────────

describe('the header', () => {
  const headerOf = (root: Node): Node => kids(root)[0]!

  for (const [name, columns, refresh] of [
    ['narrow', NARROW, '↻'],
    ['medium', MEDIUM, '↻ Refresh'],
    ['wide', WIDE, '↻ Refresh'],
  ] as const) {
    test(`desktop, ${name}: one row of title, badge pill, spacer and ${refresh}; the stamp and subtitle dim beneath`, async ($, on) => {
      const ui = await draw($, on, sideJobModel(), 'desktop', columns)
      const head = headerOf(await tree(ui))
      const [row, stamp, subtitle] = kids(head)
      expect(kids(row!).map(textOf)).toEqual(['SHOP-MVP-RESTART', padded('Side job'), '', refresh])
      // The badge is a pill: padded text on the mode's tint.
      const pill = chains(row!, node => node.type === 'Text' && textOf(node) === padded('Side job'))[0]!.at(-1)!
      expect([pill.props.color, pill.props.backgroundColor]).toEqual(['warning', tint('warning', '24')])
      expect([row!.props.gap, row!.props.alignItems]).toEqual([1, 'center'])
      expect((await ui.find({ key: 'refresh' }))?.text).toBe(refresh)
      for (const line of [stamp!, subtitle!]) {
        expect(line.type).toBe('Text')
        expect(line.props.dimColor).toBe(true)
      }
      expect([textOf(stamp!), textOf(subtitle!)]).toEqual(['checked just now', 'Inception · domain-design'])
      await ui.unmount()
    })
  }

  test('desktop: a read failure is the line under them, in the error colour', async ($, on) => {
    const ui = await draw($, on, stageModel({ freshness: { checkedAt: 1, error: 'Could not re-read the plan.' } }), 'desktop', MEDIUM)
    const head = headerOf(await tree(ui))
    expect(kids(head).map(textOf)).toEqual([expect.stringContaining('SHOP-MVP-RESTART'), 'checked just now', '!Could not re-read the plan.'])
    expect((await probe(ui).findAll({ type: 'Text', text: 'Could not re-read the plan.' }))[0]?.props.color).toBe('error')
    await ui.unmount()
  })

  test('desktop: a model with no badge draws no pill', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const [row] = kids(headerOf(await tree(ui)))
    expect(kids(row!).map(textOf)).toEqual(['SHOP-MVP-RESTART', '', '↻ Refresh'])
    await ui.unmount()
  })

  test('terminal: the badge is bare text on row 1 beside the stamp at M; on S both are on row 2', async ($, on) => {
    let ui = await draw($, on, sideJobModel(), 'terminal', MEDIUM)
    let [row] = kids(headerOf(await tree(ui)))
    expect(textOf(row!)).toContain('Side job')
    expect(textOf(row!)).toContain('checked just now')
    expect(textOf(row!)).not.toContain(padded('Side job'))
    expect((await probe(ui).findAll({ type: 'Text', text: 'Side job' }))[0]?.props.backgroundColor).toBeUndefined()
    await ui.unmount()

    ui = await draw($, on, sideJobModel(), 'terminal', NARROW)
    const rows = kids(headerOf(await tree(ui)))
    ;[row] = rows
    expect(textOf(row!)).toBe('SHOP-MVP-RESTART↻')
    expect(textOf(rows[1]!)).toContain('Side job')
    await ui.unmount()
  })
})

// ── labels and Next ──────────────────────────────────────────────────────────

describe('the Now card', () => {
  test('desktop: the small labels in capitals', async ($, on) => {
    const cases: [PanelModel, string[]][] = [
      [stageModel(), ['NOW', 'NEXT']],
      [sideJobModel(), ['THIS SESSION', 'NEXT']],
    ]
    for (const [model, labels] of cases) {
      const ui = await draw($, on, model, 'desktop', MEDIUM)
      const lines = await shown(ui)
      for (const label of labels) expect(lines).toContain(label)
      for (const label of labels) expect(lines).not.toContain(label[0] + label.slice(1).toLowerCase())
      await ui.unmount()
    }
  })

  test('desktop: the idle card says WORKSPACE, a plan with nothing current NEXT UP', async ($, on) => {
    const idle = stageModel({
      header: { title: 'shop', mode: 'idle', subtitle: '', badge: 'Idle', caption: 'This workspace has no intent in flight.', updatedAt: '' },
      sections: [],
      gates: [],
      overall: { counts: { total: 0 } },
    })
    let ui = await draw($, on, idle, 'desktop', MEDIUM)
    expect(await shown(ui)).toContain('WORKSPACE')
    await ui.unmount()
    const noCurrent = stageModel()
    for (const one of noCurrent.sections) for (const each of one.items) each.isCurrent = false
    ui = await draw($, on, noCurrent, 'desktop', MEDIUM)
    expect(await shown(ui)).toContain('NEXT UP')
    await ui.unmount()
  })

  test('terminal: the labels keep their case', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    const lines = await shown(ui)
    expect(lines).toEqual(expect.arrayContaining(['Now', 'Next']))
    expect(lines).not.toContain('NOW')
    expect(lines).not.toContain('NEXT')
    await ui.unmount()
  })

  test('desktop: the card is a faint line over a faint fill; a side job keeps its warning edge and takes the fill', async ($, on) => {
    let ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    const card = (root: Node, color: string) => nodesOf(root, node => node.type === 'Box' && node.props.borderStyle === 'round' && node.props.borderColor === color && textOf(node).includes('NEXT'))
    let [one] = card(await tree(ui), CARD_LINE)
    expect(one?.props.backgroundColor).toBe(CARD_FILL)
    expect(card(await tree(ui), 'claude')).toEqual([])
    await ui.unmount()

    ui = await draw($, on, sideJobModel(), 'desktop', MEDIUM)
    ;[one] = card(await tree(ui), 'warning')
    expect(one?.props.backgroundColor).toBe(CARD_FILL)
    await ui.unmount()

    // The terminal's card has the theme key and no fill.
    ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    ;[one] = nodesOf(await tree(ui), node => node.props.borderStyle === 'round' && node.props.borderColor === 'claude')
    expect(one?.props.backgroundColor).toBeUndefined()
    await ui.unmount()
  })
})

describe('Next', () => {
  for (const columns of [NARROW, MEDIUM, 124, 125, 160]) {
    test(`desktop, ${columns} columns: label, command pill and reason on a wrapping row, the button in a column of its own below`, async ($, on) => {
      const ui = await draw($, on, stageModel(), 'desktop', columns)
      const root = await tree(ui)
      const next = chains(root, node => node.type === 'Box' && node.props.flexDirection === 'column' && node.props.gap === 1 && textOf(node).startsWith('NEXT'))[0]!.at(-1)!
      const [row, below] = kids(next)
      expect(row!.props.flexWrap).toBe('wrap')
      expect(kids(row!).map(textOf)).toEqual(['NEXT', padded('/aidlc'), 'Execute Domain Design'])
      // The command is a bold accent Text on a grey fill; the label dim.
      const command = chains(row!, node => node.type === 'Text' && textOf(node) === padded('/aidlc'))[0]!.at(-1)!
      expect([command.props.bold, command.props.color, command.props.backgroundColor]).toEqual([true, 'claude', tint(undefined, '24')])
      const label = chains(row!, node => node.type === 'Text' && textOf(node) === 'NEXT')[0]!.at(-1)!
      expect(label.props.dimColor).toBe(true)
      // The reason is plain text (not dim) that wraps.
      const reason = chains(row!, node => node.type === 'Text' && textOf(node) === 'Execute Domain Design')[0]!.at(-1)!
      expect([reason.props.dimColor, reason.props.wrap]).toEqual([undefined, 'wrap'])
      // The button sits below the row, alone in a column.
      expect(below!.props.flexDirection).toBe('column')
      expect(kids(below!).map(node => node.type)).toEqual(['Button'])
      const button = kids(below!)[0]!
      expect([button.props.key, button.props.variant, button.props.hotkey]).toEqual(['next:fill', 'primary', 'p'])
      await ui.unmount()
    })
  }

  test('desktop: a side job\'s button is secondary', async ($, on) => {
    const ui = await draw($, on, sideJobModel(), 'desktop', MEDIUM)
    expect((await ui.find({ key: 'next:fill' }))?.props.variant).toBe('secondary')
    await ui.unmount()
  })

  test('desktop: the button presses to fill the prompt with the command', async ($, on) => {
    const filled: string[] = []
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    const ui = await draw($, on, stageModel(), 'desktop', MEDIUM)
    await ui.press({ key: 'next:fill' })
    expect(filled).toEqual(['/aidlc'])
    await ui.unmount()
  })

  test('terminal: beside the text from 125 columns of the wide pane, below at 124 and on narrow', async ($, on) => {
    const together = async (columns: number) => {
      const ui = await draw($, on, stageModel(), 'terminal', columns)
      const root = await tree(ui)
      const box = chains(root, node => node.type === 'Box' && kids(node).some(child => child.type === 'Box' && textOf(child).startsWith('Next/aidlc')) && kids(node).some(child => textOf(child) === 'Put in prompt'))[0]!.at(-1)!
      await ui.unmount()
      return box.props.flexDirection
    }
    expect(await together(NARROW)).toBe('column')
    expect(await together(MEDIUM)).toBeUndefined()
    // The command is bare text, not a pill, on the terminal.
    const ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    const command = (await probe(ui).findAll({ type: 'Text', text: '/aidlc' }))[0]
    expect([command?.text, command?.props.backgroundColor]).toEqual(['/aidlc', undefined])
    await ui.unmount()
  })
})

// ── the stepper ──────────────────────────────────────────────────────────────

describe('the stepper card', () => {
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    test(`${surface}: the stepper's Svg is inside a round card in the card line and fill`, async ($, on) => {
      const ui = await draw($, on, stageModel(), surface, MEDIUM)
      const root = await tree(ui)
      const cards = nodesOf(root, node => node.type === 'Box' && node.props.borderStyle === 'round' && node.props.borderColor === CARD_LINE && kids(node).some(child => child.type === 'Svg'))
      expect(cards).toHaveLength(1)
      const card = cards[0]!
      expect(card.props.backgroundColor).toBe(CARD_FILL)
      const svg = kids(card)[0]!
      expect(svg.props.width).toBeUndefined()
      expect(String(svg.props.alt)).toMatch(/^Phases: Initialization done/)
      await ui.unmount()
    })
  }

  test('terminal: none', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'terminal', MEDIUM)
    expect(nodesOf(await tree(ui), node => node.props.borderColor === CARD_LINE)).toEqual([])
    await ui.unmount()
  })

  test('the wide pane draws phase cards instead; the open card is filled', async ($, on) => {
    const ui = await draw($, on, stageModel(), 'desktop', WIDE)
    const root = await tree(ui)
    expect(nodesOf(root, node => node.type === 'Box' && kids(node).some(child => child.type === 'Svg' && child.props.width === undefined))).toEqual([])
    const cards = nodesOf(root, node => node.type === 'Box' && String(node.props.key ?? '').startsWith('phase:'))
    expect(cards).toHaveLength(5)
    expect(cards.filter(card => card.props.backgroundColor === CARD_FILL).map(card => card.props.key)).toEqual(['phase:INCEPTION'])
    expect((await svgs(ui)).filter(svg => svg.props.height === 6).map(svg => svg.props.width)).toEqual([72, 72, 72, 72])
    await ui.unmount()
  })
})
