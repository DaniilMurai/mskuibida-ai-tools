// M3 in the renderer: an item's landing (merged ✓ / in a PR ◐ / local only ◌), its status word, a group
// bracket without a fold chip, linked gates and chips, and the Now card's base line. Drawn at S, M and L on
// the terminal's and the desktop's tables.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { renderPane } from '../src/render'
import { foldGutters, itemLook } from '../src/render/item'
import { iconSource } from '../src/render/look'
import { bare, padded } from './rich'
import { MOUNT, item, section, seedModel, stageModel } from './world'
import type { Chip, Gate, Item, PanelModel } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

/** Narrow (S < 48), medium (M 48-79), wide (L >= 80; the Now card and Attention then lay out at S in the left column). */
const WIDTHS = [
  ['narrow', 36],
  ['medium', 60],
  ['wide', 92],
] as const

const PR33 = 'https://example.com/acme/shop/pull/33'
const PR32 = 'https://example.com/acme/shop/pull/32'

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }
type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }

const held = new WeakMap<object, { model: PanelModel | null }>()
async function draw($: Engine, on: On, model: PanelModel | null, surface: string, columns = 60) {
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

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null
const kids = (node: Node): Node[] => (node.children ?? []).filter(isNode)

function textOf(node: Node | string): string {
  if (typeof node === 'string') return node
  if ((node.type === 'Button' || node.type === 'Link') && typeof node.props.label === 'string') return node.props.label
  return (node.children ?? []).map(textOf).join('')
}

function chains(root: Node, pred: (node: Node) => boolean, trail: Node[] = []): Node[][] {
  const here = [...trail, root]
  const out: Node[][] = pred(root) ? [here] : []
  for (const child of kids(root)) out.push(...chains(child, pred, here))
  return out
}

async function tree(ui: { drawn: () => Promise<unknown> }): Promise<Node> {
  return (await ui.drawn()) as Node
}

/** Every Text and Button of the drawing, in document order, as shown. */
async function shown(ui: unknown): Promise<string[]> {
  const all = await (ui as Probe).findAll({})
  return all.filter(el => el.type === 'Text' || el.type === 'Button').map(el => bare(el.text))
}

/** The drawing as lines of text: a column stacks its children, a row sets them side by side. For reading, not for asserting. */
function dump(node: Node | string): string[] {
  if (typeof node === 'string') return [node]
  if (node.type !== 'Box') return [textOf(node)]
  const parts = kids(node).map(dump).filter(lines => lines.length > 0 && lines.some(line => line !== ''))
  if (node.props.flexDirection === 'column' || parts.length <= 1) return parts.flat()
  const widths = parts.map(lines => Math.max(...lines.map(line => Array.from(line).length)))
  const rows = Math.max(...parts.map(lines => lines.length))
  return Array.from({ length: rows }, (_, at) =>
    parts
      .map((lines, i) => (lines[at] ?? '').padEnd(widths[i]!))
      .join(' ')
      .trimEnd(),
  )
}

// ── the scenario: the parked-intent regression ────────────────────────

const pr = (label: string, tone: Chip['tone'], href: string): Chip => ({ kind: 'pr', label, tone, href })

/**
 * Inception: user-stories merged (#32), refined-mockups in PR #33, domain-design only in this worktree and
 * current. The PR gate and the parked gate both sit after refined-mockups; the header says where main stands.
 */
function scenarioModel(): PanelModel {
  const inception = section('INCEPTION', 'Inception', 'active', [
    item('requirements-analysis', 'done', { landing: 'merged', chips: [pr('#30', 'success', 'https://example.com/acme/shop/pull/30')] }),
    item('user-stories', 'done', { landing: 'merged', chips: [pr('#32', 'success', PR32)] }),
    item('refined-mockups', 'open', { landing: 'in-pr', statusWord: 'in PR #33', chips: [pr('#33', 'accent', PR33)] }),
    item('domain-design', 'open', { landing: 'local', statusWord: 'local only', isCurrent: true }),
    item('units-generation', 'planned'),
    item('contract-design', 'planned'),
  ])
  // Only merged counts as done: 2 of 6 executed here.
  inception.counts = { done: 2, total: 6 }
  inception.percent = 33
  const gates: Gate[] = [
    {
      id: 'pr:33',
      kind: 'pr-not-merged',
      tone: 'warning',
      title: 'PR #33 not merged',
      caption: "domain-design can't start on main until it lands.",
      sectionId: 'INCEPTION',
      afterItemId: 'refined-mockups',
      href: PR33,
    },
    {
      id: 'parked',
      kind: 'parked',
      tone: 'warning',
      title: 'Parked at domain-design',
      caption: 'Waiting on PR #33 to merge; parked 2026-09-04 01:19. Resume with /aidlc once it lands.',
      sectionId: 'INCEPTION',
      afterItemId: 'refined-mockups',
    },
  ]
  return stageModel({
    header: {
      title: 'shop-mvp',
      mode: 'stage',
      subtitle: 'Inception · domain-design',
      badge: '',
      caption: '',
      updatedAt: '2026-09-04T01:19:27Z',
      base: 'main: refined-mockups in PR #33',
    },
    next: { command: '/aidlc', reason: 'Execute Domain Design' },
    overall: { percent: 33, counts: { done: 2, open: 2, planned: 2, total: 6 } },
    sections: [inception],
    gates,
  })
}

/** One section of these items, no gates; the first current item is the Now card's. */
function oneSection(items: Item[], extra: Partial<PanelModel> = {}): PanelModel {
  return stageModel({ sections: [section('S', 'Work', 'active', items)], gates: [], ...extra })
}

// ── itemLook ─────────────────────────────────────────────────────────────────

describe('itemLook with a landing', () => {
  test('merged is ✓ in success with no word, whatever the status', () => {
    expect(itemLook({ status: 'done', landing: 'merged' })).toMatchObject({ glyph: '✓', color: 'success', word: '', isDim: false })
    expect(itemLook({ status: 'open', landing: 'merged' })).toMatchObject({ glyph: '✓', color: 'success', word: '' })
  })

  test('in-pr is ◐ in claude, local is ◌ in warning; neither is dim', () => {
    expect(itemLook({ status: 'open', landing: 'in-pr' })).toMatchObject({ glyph: '◐', color: 'claude', wordColor: 'claude', isDim: false })
    expect(itemLook({ status: 'open', landing: 'local' })).toMatchObject({ glyph: '◌', color: 'warning', wordColor: 'warning', isDim: false })
  })

  test('statusWord replaces the status word, "" hides it, absent keeps the status word', () => {
    expect(itemLook({ status: 'open', landing: 'in-pr', statusWord: 'in PR #33' }).word).toBe('in PR #33')
    expect(itemLook({ status: 'open', landing: 'local', statusWord: '' }).word).toBe('')
    expect(itemLook({ status: 'open', landing: 'in-pr' }).word).toBe('in progress')
    expect(itemLook({ status: 'awaiting', landing: 'in-pr' }).word).toBe('awaiting')
    expect(itemLook({ status: 'open', landing: 'in-pr' }).glyph).toBe('◐')
  })

  test('without a landing the look is the status look, a statusWord still applies', () => {
    expect(itemLook({ status: 'done' })).toMatchObject({ glyph: '✓', word: '' })
    expect(itemLook({ status: 'planned' })).toMatchObject({ glyph: '○', isDim: true })
    expect(itemLook({ status: 'open', statusWord: 'x' })).toMatchObject({ glyph: '◐', word: 'x' })
  })
})

describe('foldGutters with groups', () => {
  const grouped = (id: string, group?: string, extra: Partial<Item> = {}) => item(id, 'open', { ...(group === undefined ? {} : { group }), ...extra })
  test('a group of 3 is ┐ │ ┘, a group of 2 is ┐ ┘, a lone member and an empty group get none', () => {
    expect(foldGutters([grouped('a', 'g'), grouped('b', 'g'), grouped('c', 'g')])).toEqual(['┐', '│', '┘'])
    expect(foldGutters([grouped('a', 'g'), grouped('b', 'g'), grouped('c')])).toEqual(['┐', '┘', ''])
    expect(foldGutters([grouped('a', 'g'), grouped('b'), grouped('c', 'g')])).toEqual(['', '', ''])
    expect(foldGutters([grouped('a', ''), grouped('b', '')])).toEqual(['', ''])
  })

  test('a group and a fold chip label never run together', () => {
    const fold = { kind: 'fold' as const, label: 'x', tone: 'accent' as const }
    expect(foldGutters([grouped('a', 'x'), grouped('b', undefined, { chips: [fold] })])).toEqual(['', ''])
  })
})

// ── the three landings, drawn ────────────────────────────────────────────────

describe('the three landings', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`glyphs, colours and words at ${name} on ${surface}`, async ($, on) => {
        const model = oneSection([
          item('merged-one', 'done', { landing: 'merged' }),
          item('pr-one', 'open', { landing: 'in-pr', statusWord: 'in PR #33' }),
          item('pr-plain', 'awaiting', { landing: 'in-pr' }),
          item('local-quiet', 'open', { landing: 'local', statusWord: '' }),
          item('local-worded', 'open', { landing: 'local', statusWord: 'local only' }),
          item('today', 'planned', { isCurrent: true }),
        ])
        const { ui } = await draw($, on, model, surface, columns)
        const root = await tree(ui)
        const rich = surface !== 'terminal'
        // The desktop's row is 1 cell in from the edge and starts with the icon; the terminal's is 2 in, with the › gutter first.
        const rowOf = (title: string) => {
          const hit = chains(root, node => node.type === 'Box' && node.props.paddingLeft === (rich ? 1 : 2) && kids(node).some(box => textOf(box) === title))[0]!
          return hit.at(-1)!
        }
        // The terminal's glyph and colour; the desktop's icon: its markup (the landing's kind) and its alt (the word, else the kind's meaning).
        const glyphOf = (title: string) => {
          const cells = kids(rowOf(title))
          if (rich) {
            const svg = chains(cells[0]!, node => node.type === 'Svg')[0]!.at(-1)!
            return { source: svg.props.source, alt: svg.props.alt }
          }
          const text = chains(cells[1]!, node => node.type === 'Text')[0]!.at(-1)!
          return { glyph: textOf(text), color: text.props.color }
        }

        if (rich) {
          expect(glyphOf('merged-one')).toEqual({ source: iconSource('done'), alt: 'done' })
          expect(glyphOf('pr-one')).toEqual({ source: iconSource('live', '◐'), alt: 'in PR #33' })
          expect(glyphOf('pr-plain')).toEqual({ source: iconSource('live', '◐'), alt: 'awaiting' })
          expect(glyphOf('local-quiet')).toEqual({ source: iconSource('local', '◌'), alt: 'local only' })
          expect(glyphOf('local-worded')).toEqual({ source: iconSource('local', '◌'), alt: 'local only' })
        } else {
          expect(glyphOf('merged-one')).toEqual({ glyph: '✓', color: 'success' })
          expect(glyphOf('pr-one')).toEqual({ glyph: '◐', color: 'claude' })
          expect(glyphOf('pr-plain')).toEqual({ glyph: '◐', color: 'claude' })
          expect(glyphOf('local-quiet')).toEqual({ glyph: '◌', color: 'warning' })
          expect(glyphOf('local-worded')).toEqual({ glyph: '◌', color: 'warning' })
        }

        // The word is bare on the terminal, a padded pill on the desktop; the desktop's row has no glyph Text.
        const row = (title: string) => textOf(rowOf(title))
        const mark = (glyph: string) => (rich ? '' : glyph)
        const word = (text: string) => (rich ? padded(text) : text)
        if (columns < 48) {
          // S draws no word on a row, except "local only": nothing else on a narrow row says the work is not pushed.
          for (const [title, glyph] of [['pr-one', '◐'], ['pr-plain', '◐'], ['local-quiet', '◌']] as const) expect(row(title)).toBe(`${mark(glyph)}${title}`)
          expect(row('local-worded')).toBe(`${mark('◌')}local-worded${word('local only')}`)
        } else {
          expect(row('merged-one')).toBe(`${mark('✓')}merged-one`)
          expect(row('pr-one')).toBe(`${mark('◐')}pr-one${word('in PR #33')}`)
          expect(row('pr-plain')).toBe(`${mark('◐')}pr-plain${word('awaiting')}`)
          expect(row('local-quiet')).toBe(`${mark('◌')}local-quiet`)
          expect(row('local-worded')).toBe(`${mark('◌')}local-worded${word('local only')}`)
        }
        // The word's colour follows the landing.
        if (columns >= 48) {
          expect((await ui.find({ type: 'Text', text: word('in PR #33') }))?.props.color).toBe('claude')
          expect((await ui.find({ type: 'Text', text: word('local only') }))?.props.color).toBe('warning')
        }
        await ui.unmount()
      })
    }
  }
})

// ── the Now card ─────────────────────────────────────────────────────────────

describe('the Now card', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`a local current item says "local only, this worktree" and the base line at ${name} on ${surface}`, async ($, on) => {
        const { ui } = await draw($, on, scenarioModel(), surface, columns)
        const lines = await shown(ui)
        const rich = surface !== 'terminal'

        // The Now card names the item with the card's own wording, not the row's statusWord.
        expect(lines).toContain('local only, this worktree')
        expect(lines).toContain('main: refined-mockups in PR #33')
        const nowLines = lines.slice(0, lines.indexOf(rich ? 'NEXT' : 'Next'))
        expect(nowLines.indexOf('domain-design')).toBeLessThan(nowLines.indexOf('main: refined-mockups in PR #33'))
        // The desktop's word is a pill, and its icon says the same in its alt.
        expect((await ui.find({ type: 'Text', text: rich ? padded('local only, this worktree') : 'local only, this worktree' }))?.props.color).toBe('warning')
        if (rich) expect((await (ui as Probe).findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'local only, this worktree')).toBe(true)
        expect((await ui.find({ type: 'Text', text: 'main: refined-mockups in PR #33' }))?.props.dimColor).toBe(true)
        expect((await ui.find({ type: 'Text', text: 'main: refined-mockups in PR #33' }))?.props.wrap).toBe('wrap')
        await ui.unmount()
      })
    }

    test(`an in-pr current item uses its statusWord, no base line without header.base on ${surface}`, async ($, on) => {
      const model = oneSection([item('cur', 'open', { isCurrent: true, landing: 'in-pr', statusWord: 'in PR #33', chips: [pr('#33', 'accent', PR33)] })])
      const { ui } = await draw($, on, model, surface, 60)
      const lines = await shown(ui)
      expect(lines.filter(line => line === 'in PR #33').length).toBe(2)
      expect(lines).not.toContain('local only, this worktree')
      if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: '◐' }))?.props.color).toBe('claude')
      else {
        // The desktop draws the icon instead of the glyph: in the Now card and in the row, both worded.
        const icons = (await (ui as Probe).findAll({ type: 'Svg' })).filter(svg => svg.props.alt === 'in PR #33')
        expect(icons.length).toBe(2)
        for (const icon of icons) expect(icon.props.source).toBe(iconSource('live', '◐'))
        expect(await ui.find({ type: 'Text', text: '◐' })).toBeUndefined()
      }
      await ui.unmount()
    })

    test(`a base line of '' is hidden, an absent one too on ${surface}`, async ($, on) => {
      const withEmpty = scenarioModel()
      withEmpty.header.base = ''
      let { ui } = await draw($, on, withEmpty, surface, 60)
      expect((await shown(ui)).filter(line => line.startsWith('main:'))).toEqual([])
      await ui.unmount()
      const absent = scenarioModel()
      delete absent.header.base
      ;({ ui } = await draw($, on, absent, surface, 60))
      expect((await shown(ui)).filter(line => line.startsWith('main:'))).toEqual([])
      await ui.unmount()
    })

    test(`a merged-then-current item shows the status word rule: statusWord '' hides the word on ${surface}`, async ($, on) => {
      const model = oneSection([item('cur', 'open', { isCurrent: true, landing: 'in-pr', statusWord: '' })])
      const { ui } = await draw($, on, model, surface, 60)
      expect(await shown(ui)).not.toContain('in progress')
      await ui.unmount()
    })
  }
})

// ── groups ───────────────────────────────────────────────────────────────────

describe('a group of consecutive items', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`three items in one PR draw ┐ │ ┘ without a fold chip at ${name} on ${surface}`, async ($, on) => {
        const model = oneSection([
          item('before', 'done', { landing: 'merged' }),
          item('a', 'open', { landing: 'in-pr', statusWord: 'in PR #9', group: 'pr-9', chips: [pr('#9', 'accent', 'https://example.com/pull/9')] }),
          item('b', 'open', { landing: 'in-pr', statusWord: 'in PR #9', group: 'pr-9' }),
          item('c', 'open', { landing: 'in-pr', statusWord: 'in PR #9', group: 'pr-9' }),
          item('after', 'planned', { isCurrent: true }),
        ])
        const { ui } = await draw($, on, model, surface, columns)
        const lines = await shown(ui)
        expect(lines.filter(line => line !== '' && '┐│┘'.includes(line))).toEqual(['┐', '│', '┘'])
        expect((await ui.find({ type: 'Text', text: '┐' }))?.props.color).toBe('claude')
        // The chip sits on the first member only; the others hold the bracket and the word.
        expect(lines.filter(line => line === (surface === 'terminal' ? '[#9]' : '#9')).length).toBe(1)
        expect(lines.some(line => /fold|reopen/i.test(line))).toBe(false)
        await ui.unmount()
      })
    }

    test(`two grouped items draw ┐ ┘; a lone member draws nothing on ${surface}`, async ($, on) => {
      const model = oneSection([
        item('a', 'open', { landing: 'in-pr', group: 'pr-1' }),
        item('b', 'open', { landing: 'in-pr', group: 'pr-1' }),
        item('c', 'open', { landing: 'in-pr', group: 'pr-2' }),
        item('d', 'planned', { isCurrent: true }),
      ])
      const { ui } = await draw($, on, model, surface, 60)
      expect((await shown(ui)).filter(line => line !== '' && '┐│┘'.includes(line))).toEqual(['┐', '┘'])
      await ui.unmount()
    })

    for (const [name, columns] of WIDTHS.slice(0, 2)) {
      test(`done-folding never hides a grouped item at ${name} on ${surface}`, async ($, on) => {
        const done = (id: string, extra: Partial<Item> = {}) => item(id, 'done', { landing: 'merged', ...extra })
        const model = oneSection([
          ...['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11'].map(id => done(id)),
          done('g1', { group: 'pr-7' }),
          done('g2', { group: 'pr-7' }),
          item('now', 'open', { isCurrent: true }),
          item('later', 'planned'),
        ])
        const { ui } = await draw($, on, model, surface, columns)
        const lines = await shown(ui)
        expect(lines).toContain('g1')
        expect(lines).toContain('g2')
        // The plain done items fold behind one row.
        expect(lines).not.toContain('d0')
        expect(lines.some(line => line.startsWith('✓ '))).toBe(true)
        expect(lines.filter(line => line !== '' && '┐│┘'.includes(line))).toEqual(['┐', '┘'])
        await ui.unmount()
      })
    }
  }
})

// ── links ────────────────────────────────────────────────────────────────────

describe('links', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`a gate with an href links its title in the card and in Attention at ${name} on ${surface}`, async ($, on) => {
        const { ui } = await draw($, on, scenarioModel(), surface, columns)
        const links = (await (ui as Probe).findAll({ type: 'Link' })).filter(link => link.props.label === 'PR #33 not merged')
        // The plan's gate card and the Attention row.
        expect(links.length).toBe(2)
        for (const link of links) expect(link.props.href).toBe(PR33)

        const root = await tree(ui)
        const trails = chains(root, node => node.type === 'Link' && node.props.label === 'PR #33 not merged')
        expect(trails.length).toBe(2)
        // The Attention row comes first, the plan's gate after it. The terminal's both bold in the tone; the desktop's
        // Attention title is in the text colour (the card is tinted), its plan gate a quiet line in the tone.
        const looks = surface === 'terminal' ? [{ color: 'warning', bold: true }, { color: 'warning', bold: true }] : [{ color: undefined, bold: true }, { color: 'warning', bold: undefined }]
        trails.forEach((trail, at) => {
          const text = chains(trail.at(-1)!, node => node.type === 'Text')[0]!.at(-1)!
          expect(text.props.color).toBe(looks[at]!.color)
          expect(text.props.bold).toBe(looks[at]!.bold)
          expect(textOf(text)).toBe('PR #33 not merged')
        })
        // The gate with no href stays plain text.
        expect((await (ui as Probe).findAll({ type: 'Link' })).some(link => link.props.label === 'Parked at domain-design')).toBe(false)
        expect(await shown(ui)).toContain('Parked at domain-design')
        await ui.unmount()
      })

      test(`a chip with an href keeps its tone at ${name} on ${surface}`, async ($, on) => {
        const { ui } = await draw($, on, scenarioModel(), surface, columns)
        const root = await tree(ui)
        // The terminal brackets a chip; the desktop draws it as a padded pill.
        const chip = (label: string) => (surface === 'terminal' ? `[${label}]` : padded(label))
        for (const [label, tone, href] of [
          [chip('#32'), 'success', PR32],
          [chip('#33'), 'accent', PR33],
        ] as const) {
          const [trail] = chains(root, node => node.type === 'Link' && node.props.label === label)
          expect(trail).toBeDefined()
          expect(trail!.at(-1)!.props.href).toBe(href)
          const text = chains(trail!.at(-1)!, node => node.type === 'Text')[0]!.at(-1)!
          expect(text.props.color).toBe(tone === 'accent' ? 'claude' : tone)
          expect(text.props.dimColor).toBe(true)
          expect(textOf(text)).toBe(label)
        }
        await ui.unmount()
      })
    }

    test(`a gate without an href draws no Link on ${surface}`, async ($, on) => {
      const { ui } = await draw($, on, stageModel(), surface, 60)
      expect((await (ui as Probe).findAll({ type: 'Link' })).length).toBe(0)
      await ui.unmount()
    })
  }
})

// ── the scenario ─────────────────────────────────────────────────────────────

describe('the refined-mockups-in-PR scenario', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`draws without error at ${name} on ${surface}: words, chips, gate order, base line`, async ($, on) => {
        const { ui } = await draw($, on, scenarioModel(), surface, columns)
        const lines = await shown(ui)
        const text = dump(await tree(ui)).join('\n')

        // Items in plan order, each with its glyph.
        if (surface === 'terminal') {
          expect(text).toContain('✓ user-stories')
          expect(text).toContain('◐ refined-mockups')
          expect(text).toContain('◌ domain-design')
        } else {
          // The desktop draws an icon (no glyph): the same three landings, in the icons' alts.
          for (const title of ['user-stories', 'refined-mockups', 'domain-design']) expect(text).toContain(title)
          const alts = (await (ui as Probe).findAll({ type: 'Svg' })).map(svg => svg.props.alt)
          expect(alts).toEqual(expect.arrayContaining(['done', 'in PR #33', 'local only']))
        }
        // Chips follow their titles; S keeps just the first chip (the PR chip) and none here has a second.
        expect(lines).toEqual(expect.arrayContaining(surface === 'terminal' ? ['[#32]', '[#33]'] : ['#32', '#33']))
        if (columns >= 48) expect(lines).toEqual(expect.arrayContaining(['in PR #33', 'local only']))
        else {
          expect(lines).not.toContain('in PR #33')
          expect(lines).toContain('local only')
        }
        // The PR gate precedes the parked gate, both after refined-mockups, before domain-design.
        const at = (needle: string, from = 0) => lines.indexOf(needle, from)
        const mockups = lines.lastIndexOf('refined-mockups')
        expect(at('PR #33 not merged', mockups)).toBeGreaterThan(mockups)
        expect(at('Parked at domain-design', mockups)).toBeGreaterThan(at('PR #33 not merged', mockups))
        expect(lines.lastIndexOf('domain-design')).toBeGreaterThan(at('Parked at domain-design', mockups))
        // Now card and the attention list.
        expect(lines).toContain('local only, this worktree')
        expect(lines).toContain('main: refined-mockups in PR #33')
        if (surface === 'terminal') expect(lines).toContain('Needs attention (2)')
        else {
          // The heading, then the count as a pill.
          const heading = lines.indexOf('Needs attention')
          expect(heading).toBeGreaterThanOrEqual(0)
          expect(lines[heading + 1]).toBe('2')
        }
        await ui.unmount()
      })
    }
  }
})
