// Review state in the renderer: the status word of an item whose PR is open (coloured by the review, kept on a
// narrow row, a long one cut rather than pushing the title out), the rows tied to the viewer under Needs
// attention only (their glyph, the "Section, item" place, the command button that fills the prompt), and the
// Slack thread chip. Drawn at S, M and L on the terminal's and the desktop's tables.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { itemLook } from '../src/render/item'
import { gateGlyph } from '../src/render/kit'
import { bare, padded } from './rich'
import { MOUNT, item, section, seedModel, stageModel } from './world'
import type { Chip, Gate, PanelModel, ReviewState } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const WIDTHS = [
  ['narrow', 36],
  ['medium', 60],
  ['wide', 92],
] as const

type Found = { type?: string; text: string; props: Record<string, unknown> }
type Probe = { findAll: (query: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found[]> }

const URL = 'https://example.test/acme/shop/pull/'
const pr = (n: number): Chip => ({ kind: 'pr', label: `#${n}`, tone: 'accent', href: `${URL}${n}` })
const slack: Chip = { kind: 'tag', label: 'Slack thread', tone: 'neutral' }

const WORDS: [string, ReviewState, string][] = [
  ['stage-draft', 'draft', 'in draft'],
  ['stage-other', 'awaiting', 'awaiting dev-b'],
  ['stage-you', 'awaiting', 'awaiting you'],
  ['stage-many', 'awaiting', 'awaiting you, dev-b, Core reviewers'],
  ['stage-changes', 'changes', 'changes requested'],
  ['stage-commented', 'commented', 'commented'],
  ['stage-stale', 'stale', 'approved, new commits'],
  ['stage-approved', 'approved', 'approved'],
  ['stage-comments', 'approved-comments', 'approved with comments'],
  ['stage-unreviewed', 'unreviewed', 'no reviewer'],
]

const rows: Gate[] = [
  {
    id: 'you:review-requested:34',
    kind: 'review-requested',
    tone: 'accent',
    title: 'Your review is requested on PR #34',
    caption: 'feat(SHOP-7): stage-you — by dev-b',
    sectionId: 'INCEPTION',
    afterItemId: 'stage-you',
    href: `${URL}34`,
    command: '/pr-review:review-pr 34',
    isAttentionOnly: true,
  },
  {
    id: 'you:approved:36',
    kind: 'approved',
    tone: 'success',
    title: 'PR #36 approved',
    caption: 'Ready to merge.',
    sectionId: 'INCEPTION',
    afterItemId: 'stage-approved',
    href: `${URL}36`,
    command: '/pr-review:address-review 36',
    isAttentionOnly: true,
  },
  {
    id: 'you:review-requested:80',
    kind: 'review-requested',
    tone: 'accent',
    title: 'Your review is requested on PR #80',
    caption: 'SHOP-9 Fix the login redirect — by dev-b',
    sectionId: '',
    href: `${URL}80`,
    command: '/pr-review:review-pr 80',
    isAttentionOnly: true,
  },
]

/** One item per review state in Inception, the viewer's rows, and one plan gate for contrast. */
function reviewModel(): PanelModel {
  const items = WORDS.map(([id, review, word], index) =>
    item(id, 'open', { landing: 'in-pr', statusWord: word, review, chips: index === 1 ? [pr(30 + index), slack] : [pr(30 + index)] }),
  )
  items.push(item('domain-design', 'planned', { isCurrent: true }))
  // Two open sections, so a narrow pane's open-items cap (8) leaves every word drawn.
  const later = items.splice(6)
  const plan: Gate = {
    id: 'pr:35',
    kind: 'pr-not-merged',
    tone: 'warning',
    title: 'PR #35 not merged',
    caption: "domain-design can't start on main until it lands.",
    sectionId: 'INCEPTION',
    afterItemId: 'stage-changes',
    href: `${URL}35`,
  }
  return stageModel({
    sections: [section('INCEPTION', 'Inception', 'active', items), section('CONSTRUCTION', 'Construction', 'active', later)],
    gates: [...rows, plan],
    next: { command: '/pr-review:review-pr 34', reason: 'Review PR #34 first' },
  })
}

/** The plugin's own Pane over `model`; what "put in prompt" fills lands in `filled`. */
async function draw($: Engine, on: On, model: PanelModel, surface: Surface, columns: number, filled: string[] = []) {
  seedModel(on, model)
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  return $.ui.mount({ ...MOUNT, surface, props: { ...MOUNT.props, bodyColumns: columns } })
}

async function shown(ui: unknown): Promise<Found[]> {
  const all = await (ui as Probe).findAll({})
  return all.filter(el => el.type === 'Text' || el.type === 'Button')
}

describe('itemLook with a review state', () => {
  test('the review colours the word: accent while reviewed, warning on changes or nobody asked, green once approved', () => {
    const look = (review: ReviewState) => itemLook({ status: 'open', landing: 'in-pr', statusWord: 'w', review }).wordColor
    expect(look('awaiting')).toBe('claude')
    expect(look('changes')).toBe('warning')
    expect(look('unreviewed')).toBe('warning')
    expect(look('approved')).toBe('success')
    expect(look('approved-comments')).toBe('success')
    expect(look('draft')).toBeUndefined()
  })

  test('the glyph stays the landing\'s', () => {
    expect(itemLook({ status: 'open', landing: 'in-pr', review: 'approved' }).glyph).toBe('◐')
  })
})

describe('gate glyphs for the viewer\'s rows', () => {
  test('? a review asked of you, ✓ approved (with or without comments), ‖ the rest', () => {
    expect(gateGlyph({ kind: 'review-requested', tone: 'accent' })).toBe('?')
    expect(gateGlyph({ kind: 'approved', tone: 'success' })).toBe('✓')
    expect(gateGlyph({ kind: 'approved-comments', tone: 'success' })).toBe('✓')
    expect(gateGlyph({ kind: 'changes-requested', tone: 'warning' })).toBe('‖')
    expect(gateGlyph({ kind: 'review-not-requested', tone: 'warning' })).toBe('‖')
  })
})

describe('review state, drawn', () => {
  for (const surface of SURFACES) {
    for (const [name, columns] of WIDTHS) {
      test(`every review word shows, coloured, at ${name} on ${surface}`, async ($, on) => {
        const ui = await draw($, on, reviewModel(), surface, columns)
        const texts = await shown(ui)
        for (const [, review, word] of WORDS) {
          // The desktop's status word is a pill: padded, in the same colour.
          const hit = texts.find(el => el.type === 'Text' && el.text === (surface === 'terminal' ? word : padded(word)))
          expect(hit).toBeDefined()
          expect(hit?.props.color).toBe(itemLook({ status: 'open', landing: 'in-pr', statusWord: word, review }).wordColor)
        }
        await ui.unmount()
      })

      test(`the viewer's rows are under Needs attention only, the plan gate in both, at ${name} on ${surface}`, async ($, on) => {
        const ui = await draw($, on, reviewModel(), surface, columns)
        const texts = (await shown(ui)).map(el => bare(el.text))
        for (const row of rows) expect(texts.filter(text => text === row.title)).toHaveLength(1)
        expect(texts.filter(text => text === 'PR #35 not merged')).toHaveLength(2)
        // The desktop's heading is the words alone with the count as a pill after it.
        if (surface === 'terminal') expect(texts).toContain('Needs attention (4)')
        else expect(texts.slice(texts.indexOf('Needs attention'), texts.indexOf('Needs attention') + 2)).toEqual(['Needs attention', '4'])
        // A row about an item names the item itself, not what comes after it.
        expect(texts).toContain('Inception, stage-you')
        expect(texts).toContain('Inception, after stage-changes')
        // A PR outside the plan has no place: the row says what the PR is instead.
        expect(texts).toContain('SHOP-9 Fix the login redirect — by dev-b')
        expect(texts.indexOf('Your review is requested on PR #34')).toBeLessThan(texts.indexOf('PR #35 not merged'))
        await ui.unmount()
      })

      test(`each row's command is a button that fills the prompt, at ${name} on ${surface}`, async ($, on) => {
        const filled: string[] = []
        const ui = await draw($, on, reviewModel(), surface, columns, filled)
        const buttons = (await shown(ui)).filter(el => el.type === 'Button').map(el => el.text)
        expect(buttons).toContain('/pr-review:review-pr 34')
        expect(buttons).toContain('/pr-review:address-review 36')
        expect(buttons).toContain('/pr-review:review-pr 80')
        await ui.press({ key: 'attention:fill:gate:you:approved:36' })
        await ui.press({ key: 'next:fill' })
        expect(filled).toEqual(['/pr-review:address-review 36', '/pr-review:review-pr 34'])
        await ui.unmount()
      })

      test(`the Slack thread chip shows beside the PR chip from medium up, at ${name} on ${surface}`, async ($, on) => {
        const ui = await draw($, on, reviewModel(), surface, columns)
        const texts = (await shown(ui)).map(el => bare(el.text))
        if (columns < 48) expect(texts).toContain('+1')
        else expect(texts).toContain(surface === 'terminal' ? '[Slack thread]' : 'Slack thread')
        await ui.unmount()
      })
    }
  }
})
