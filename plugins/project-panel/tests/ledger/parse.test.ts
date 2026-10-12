import { describe, expect, test } from 'claude-code/testing'
import { parseLedger } from '../../src/providers/ledger/parse'
import { CODE_ID, SLUG_ID, firstClause, slug } from '../../src/providers/ledger/text'
import * as checkbox from '../../fixtures/ledger/checkbox'
import * as rem from '../../fixtures/ledger/reminders'
import * as fsv from '../../fixtures/ledger/field-service'

const byId = (text: string) => new Map(parseLedger(text).items.map(i => [i.id, i]))

describe('id grammar', () => {
  test('code ids accept the shapes ledgers use and reject prose', () => {
    for (const ok of ['T01a', 'T-HF02', 'T-CL01', 'OPS-2', 'F01', 'API-3', 'B04', 'W01d']) expect(CODE_ID.test(ok)).toBe(true)
    for (const bad of ['Why', 'Phase', 'T11–T13', 'T01abc', 'a01', 'API-', '']) expect(CODE_ID.test(bad)).toBe(false)
  })
  test('slug ids need a hyphen and a lowercase start', () => {
    for (const ok of ['chore-finish-the-rename', 'fix-T04a-backdate-picker']) expect(SLUG_ID.test(ok)).toBe(true)
    for (const bad of ['Chore-x', 'plain', 'T01a']) expect(SLUG_ID.test(bad)).toBe(false)
  })
  test('firstClause cuts at the first dash, sentence end or parenthesis and strips markdown', () => {
    expect(firstClause('Conversation state — per-chat prompts')).toBe('Conversation state')
    expect(firstClause('Parser (`en`/`de`/`uk`)')).toBe('Parser')
    expect(firstClause('See [the spec](x.md). More words follow')).toBe('See the spec')
    expect(firstClause('x'.repeat(300)).length).toBe(100)
  })
  test('slug normalises phase names', () => {
    expect(slug('Phase 1.5 — Task management')).toBe('phase-1-5-task-management')
  })
})

describe('reminders fixture', () => {
  const r = parseLedger(rem.ledgerText)
  const items = byId(rem.ledgerText)

  test('counts, title and phases', () => {
    expect(r.title).toBe('Workplan')
    expect(r.items).toHaveLength(23)
    expect(r.phases).toEqual(['Phase 1.5 — Task management in Telegram', 'Process'])
    expect(r.checkboxCount).toBe(0)
  })
  test('table row: id, title, deps, size, phase', () => {
    expect(items.get('T03')).toEqual({
      id: 'T03',
      hasRealId: true,
      title: 'Browse',
      deps: ['T01a', 'T01b'],
      size: 'L',
      phase: 'Phase 1.5 — Task management in Telegram',
      line: 24,
      declared: 'done',
      citations: [],
    })
    expect(items.get('T04')?.deps).toEqual(['T01a', 'T01b', 'T02', 'T03'])
    expect(items.get('T01a')?.deps).toEqual([])
  })
  test('a table and a heading for the same id merge into one item at the first line', () => {
    expect(r.items.filter(i => i.id === 'T01a')).toHaveLength(1)
    expect(items.get('T01a')?.line).toBe(21)
    expect(items.get('T01a')?.size).toBe('M')
    expect(items.get('T04')?.title).toBe('Act')
  })
  test('a heading alone is an item; **Done** on its body declares done', () => {
    expect(items.get('T25')?.declared).toBe('done')
    expect(items.get('T25')?.size).toBeNull()
    expect(items.get('T25')?.title).toBe('An overdue thread re-armed its alarm every second')
    expect(items.get('T17')?.declared).toBeNull()
  })
  test('hyphenated heading ids work and the process section is its own phase', () => {
    expect(items.get('T-HF02')?.declared).toBe('done')
    expect(items.get('T-DL01')?.phase).toBe('Process')
    expect(items.get('T-CL01')?.title).toBe('The delivery pipeline runs in a cloud session')
  })
  test('a range heading and prose headings are not items', () => {
    expect([...items.keys()].some(id => id.includes('–'))).toBe(false)
    expect(items.has('T11–T13')).toBe(false)
    expect(r.items.some(i => i.title === 'Why this section exists')).toBe(false)
  })
  test('fenced blocks never create items or phases', () => {
    expect(items.has('T99')).toBe(false)
    expect(items.has('T98')).toBe(false)
    expect(r.phases).toHaveLength(2)
  })
  test('status lines in a fenced block set declared status only where none is declared', () => {
    expect(items.get('T16')?.declared).toBe('open')
    expect(items.get('T03')?.declared).toBe('done')
    expect(items.get('T04')?.declared).toBe('planned')
    expect(items.get('T06')?.declared).toBe('planned')
    expect(items.get('T21')?.declared).toBe('done')
    expect(items.get('T05')?.declared).toBeNull()
  })
  test('a prose title keeps the clause before the parenthesis', () => {
    expect(items.get('T02')?.title).toBe('Natural-language date and duration parser')
  })
})

describe('field-service fixture', () => {
  const r = parseLedger(fsv.ledgerText)
  const items = byId(fsv.ledgerText)

  test('counts and phases; non-ledger tables are ignored', () => {
    expect(r.items).toHaveLength(32)
    expect(r.phases).toEqual([
      'Phase 0 — Foundation',
      'Phase 1 — Auth and tenancy',
      'Phase 2 — API surface',
      'Phase 4 — Platform admin app',
      'Phase 5 — Tenant app',
      'Chores',
    ])
    expect(items.has('1 — Foundation')).toBe(false)
  })
  test('the ⊕ QA annotation does not leak into the id', () => {
    expect(items.get('B04')?.id).toBe('B04')
    expect(items.get('B04')?.size).toBe('L')
    expect(items.get('P04')?.deps).toEqual(['P03'])
  })
  test('(implemented) and (… merged) trailing annotations declare done', () => {
    expect(items.get('fix-release-tag-push-hooks')?.declared).toBe('done')
    expect(items.get('chore-finish-the-rename')?.declared).toBe('done')
    expect(items.get('chore-rename-the-package-scope')?.declared).toBeNull()
  })
  test('annotations combine: ⊕ QA plus (implemented)', () => {
    expect(items.get('fix-T04a-backdate-picker')?.declared).toBe('done')
    expect(items.get('fix-T04a-backdate-picker')?.id).toBe('fix-T04a-backdate-picker')
    expect(items.get('fix-T04a-day-refresh-after-flush')?.declared).toBeNull()
  })
  test('slug ids with an embedded code id parse as one id', () => {
    expect(items.get('fix-T04a-backdate-picker-dst-labels')?.deps).toEqual(['fix-T04a-backdate-picker'])
    expect(items.get('chore-rename-the-package-scope')?.deps).toEqual(['chore-finish-the-rename'])
  })
  test('prose dependencies are dropped, id dependencies kept', () => {
    expect(items.get('chore-qa-tool-delete-assignment')?.deps).toEqual([])
    expect(items.get('T01')?.deps).toEqual(['B02', 'D01', 'D02'])
    expect(items.get('F01')?.deps).toEqual([])
  })
  test('sizes: XS to L, unknown stays null', () => {
    expect(items.get('fix-release-tag-push-hooks')?.size).toBe('XS')
    expect(items.get('B11')?.size).toBe('S')
    expect(items.get('T04a')?.size).toBe('M')
    expect(items.get('F03')?.size).toBe('L')
  })
  test('titles are the first clause of the task cell', () => {
    expect(items.get('F05')?.title).toBe('packages/domain')
    expect(items.get('T04a')?.title).toBe('The slice of T04 that needed no new backend surface')
  })
  test('fenced shell output with a comment is ignored', () => {
    expect(r.items.some(i => i.title.includes('618'))).toBe(false)
  })
})

describe('checkbox fixture', () => {
  const r = parseLedger(checkbox.ledgerText)
  const items = byId(checkbox.ledgerText)

  test('phases and counts; an empty phase is not listed', () => {
    expect(r.title).toBe('Roadmap')
    expect(r.items).toHaveLength(10)
    expect(r.checkboxCount).toBe(10)
    expect(r.phases).toEqual(['Phase 1 — Foundations', 'Phase 2 — Launch'])
  })
  test('ids in bold, with a colon, or with a dash are recognised', () => {
    expect(items.get('API-3')).toMatchObject({ hasRealId: true, title: 'Rate limiting', declared: 'done' })
    expect(items.get('API-4')).toMatchObject({ hasRealId: true, title: 'Pagination', declared: 'planned' })
    expect(items.get('DOC-1')).toMatchObject({ title: 'Write the README', declared: 'done' })
    expect(items.get('WEB-12')).toMatchObject({ title: 'Landing page', declared: 'planned' })
  })
  test('capital X counts as checked; star bullets are items', () => {
    expect(items.get('DOC-1')?.declared).toBe('done')
    expect(r.items.find(i => i.title === 'Star bullet item')?.declared).toBe('planned')
  })
  test('items without an id get a synthetic id and are never PR-matched', () => {
    const scaffold = r.items.find(i => i.title === 'Project scaffolding')
    expect(scaffold?.id).toBe('phase-1-foundations#1')
    expect(scaffold?.hasRealId).toBe(false)
    expect(items.get('phase-2-launch#1')?.title).toBe('Beta signup form')
    expect(items.get('phase-2-launch#2')?.title).toBe('Pricing page')
  })
  test('a nested item is its own item', () => {
    const nested = r.items.find(i => i.title === 'Nested sub-item without an id')
    expect(nested?.declared).toBe('done')
    expect(nested?.phase).toBe('Phase 1 — Foundations')
  })
  test('a fenced block hides its checkbox and its heading', () => {
    expect(r.items.some(i => i.title === 'not an item')).toBe(false)
    expect(r.phases.some(p => p === 'not a phase')).toBe(false)
  })
  test('line numbers are 1-based positions in the text', () => {
    const lines = checkbox.ledgerText.split('\n')
    for (const i of r.items) expect(lines[i.line - 1]).toContain('[')
  })
})

describe('edge cases', () => {
  test('empty text parses to nothing', () => {
    expect(parseLedger('')).toEqual({ title: '', items: [], phases: [], checkboxCount: 0 })
  })
  test('table columns are found by header name in any order', () => {
    const text = ['## P', '| Size | Depends on | Id | Task |', '|---|---|---|---|', '| M | A01 | **X1** | Do the thing — now |'].join('\n')
    expect(parseLedger(text).items[0]).toMatchObject({ id: 'X1', title: 'Do the thing', deps: ['A01'], size: 'M' })
  })
  test('a table without a header falls back to positions', () => {
    const text = ['| **X2** | Plain row | X1 | L |'].join('\n')
    expect(parseLedger(text).items[0]).toMatchObject({ id: 'X2', title: 'Plain row', deps: ['X1'], size: 'L' })
  })
  test('a ~~~ fence hides content like a ``` fence, and the closer must match', () => {
    const text = ['~~~', '- [ ] hidden', '```', '- [ ] still hidden', '~~~', '- [ ] shown'].join('\n')
    expect(parseLedger(text).items.map(i => i.title)).toEqual(['shown'])
  })
  test('heading separators: dash, en dash, hyphen and colon', () => {
    const text = ['#### A1 — one', '#### A2 – two', '#### A3 - three', '### A4: four', '#### A5'].join('\n')
    expect(parseLedger(text).items.map(i => [i.id, i.title])).toEqual([
      ['A1', 'one'],
      ['A2', 'two'],
      ['A3', 'three'],
      ['A4', 'four'],
      ['A5', ''],
    ])
  })
  test('a trailing (done) in the id cell declares done', () => {
    expect(parseLedger('| **X3** (done) | t | — | S |').items[0]?.declared).toBe('done')
  })
  test('pipes inside code spans do not split cells', () => {
    expect(parseLedger('| **X4** | uses `a | b` pipes | — | S |').items[0]).toMatchObject({ title: 'uses a | b pipes', size: 'S' })
  })
  test('size text outside the scale is null', () => {
    expect(parseLedger('| **X5** | t | — | huge |').items[0]?.size).toBeNull()
  })
})
