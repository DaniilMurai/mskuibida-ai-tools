import { describe, expect, test } from 'claude-code/testing'
import {
  UNASSIGNED,
  applyAssignment,
  buildAssignmentRequest,
  buildProposalRequest,
  parseAssignment,
  parseProposal,
  runL2,
} from '../../src/providers/ledger/ai'
import type { AssignmentItem, AssignmentRecord, AssignmentResult, Complete, L2Inputs, PinnedSection } from '../../src/providers/ledger/ai'
import { matchPrs } from '../../src/providers/ledger/match'
import { percentOf } from '../../src/providers/ledger/progress'
import type { ItemMatch } from '../../src/providers/ledger/types'
import { item, pr, sized } from './helpers'

const SECTIONS = [
  { id: 'api', title: 'API', hint: 'HTTP endpoints' },
  { id: 'bot', title: 'Telegram bot', hint: 'chat surface' },
]
const proposalJson = JSON.stringify({ sections: SECTIONS })

describe('buildProposalRequest', () => {
  const req = buildProposalRequest({
    ledgerTitle: 'Workplan',
    items: [{ id: 'T01', title: 'Conversation state', phase: 'Phase 1' }],
    docHeadings: [{ path: 'docs/ARCH.md', headings: ['Overview', 'Data flow'] }],
    topDirs: ['packages', 'docs'],
  })
  test('asks Sonnet for strict JSON product sections, not phases', () => {
    expect(req.model).toBe('sonnet')
    expect(req.system).toContain('PRODUCT')
    expect(req.system).toContain('strict JSON')
    expect(req.prompt).toContain('{"sections":[{"id"')
    expect(req.prompt).toContain('between 3 and 8')
  })
  test('items go in compactly: id, title, phase', () => {
    expect(req.prompt).toContain('T01 | Conversation state | Phase 1')
    expect(req.prompt).toContain('docs/ARCH.md: Overview / Data flow')
    expect(req.prompt).toContain('packages, docs')
  })
  test('very long ledgers are capped', () => {
    const items = Array.from({ length: 900 }, (_, i) => ({ id: `T${i}`, title: 't', phase: 'p' }))
    const big = buildProposalRequest({ ledgerTitle: 'x', items, docHeadings: [], topDirs: [] })
    expect(big.prompt.split('\n').filter(l => /^T\d+ \| t \| p$/.test(l)).length).toBe(500)
  })
})

describe('parseProposal', () => {
  test('plain JSON is accepted', () => {
    const r = parseProposal(proposalJson)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sections.map(s => s.id)).toEqual(['api', 'bot'])
  })
  test('a ```json fence and surrounding whitespace are tolerated', () => {
    expect(parseProposal('\n  ```json\n' + proposalJson + '\n```  \n').ok).toBe(true)
    expect(parseProposal('```\n' + proposalJson + '\n```').ok).toBe(true)
  })
  test('prose around the JSON is rejected, with no salvage', () => {
    expect(parseProposal('Here you go: ' + proposalJson)).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseProposal(proposalJson + '\nHope that helps!')).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseProposal('```json\n' + proposalJson + '\n```\nThanks')).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseProposal('')).toEqual({ ok: false, error: 'invalid-json' })
  })
  test('duplicate ids are rejected', () => {
    const dup = JSON.stringify({ sections: [SECTIONS[0], { ...SECTIONS[1], id: 'api' }] })
    expect(parseProposal(dup)).toEqual({ ok: false, error: 'duplicate-id' })
  })
  test('ids must be kebab-case and not the reserved unassigned id', () => {
    for (const id of ['Api', 'my_id', 'two words', '', UNASSIGNED]) {
      const bad = JSON.stringify({ sections: [{ ...SECTIONS[0], id }, SECTIONS[1]] })
      expect(parseProposal(bad)).toEqual({ ok: false, error: 'bad-id' })
    }
  })
  test('2 to 10 sections', () => {
    expect(parseProposal(JSON.stringify({ sections: [SECTIONS[0]] }))).toEqual({ ok: false, error: 'section-count' })
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, title: 'T', hint: '' }))
    expect(parseProposal(JSON.stringify({ sections: eleven }))).toEqual({ ok: false, error: 'section-count' })
    expect(parseProposal(JSON.stringify({ sections: eleven.slice(0, 10) })).ok).toBe(true)
  })
  test('titles are trimmed to four words and may not be empty', () => {
    const long = JSON.stringify({ sections: [{ id: 'a', title: ' one two three four five six ', hint: 'h' }, SECTIONS[1]] })
    const r = parseProposal(long)
    expect(r.ok && r.sections[0]?.title).toBe('one two three four')
    const empty = JSON.stringify({ sections: [{ id: 'a', title: '   ', hint: 'h' }, SECTIONS[1]] })
    expect(parseProposal(empty)).toEqual({ ok: false, error: 'empty-title' })
  })
  test('hints are at most 160 characters', () => {
    const ok = JSON.stringify({ sections: [{ id: 'a', title: 'A', hint: 'x'.repeat(160) }, SECTIONS[1]] })
    const bad = JSON.stringify({ sections: [{ id: 'a', title: 'A', hint: 'x'.repeat(161) }, SECTIONS[1]] })
    expect(parseProposal(ok).ok).toBe(true)
    expect(parseProposal(bad)).toEqual({ ok: false, error: 'hint-too-long' })
  })
  test('wrong shapes are rejected', () => {
    for (const s of ['[]', '{}', '{"sections":"x"}', '{"sections":[1,2]}', 'null', '{"sections":[{"id":1,"title":"a"},{"id":"b","title":"b"}]}']) {
      expect(parseProposal(s).ok).toBe(false)
    }
  })
})

const AITEMS: AssignmentItem[] = [
  { id: 'A1', title: 'Done by PR', phase: 'P', status: 'done', source: 'pr' },
  { id: 'A2', title: 'Declared only', phase: 'P', status: 'open', source: 'declared' },
  { id: 'A3', title: 'No evidence', phase: 'P', status: 'planned', source: 'none' },
]
const CTX = { itemIds: ['A1', 'A2', 'A3'], sectionIds: ['api', 'bot'], judgeable: new Set(['A2', 'A3']) }

describe('buildAssignmentRequest', () => {
  const req = buildAssignmentRequest({
    sections: SECTIONS,
    items: AITEMS,
    proseByItem: { A1: 'must not appear', A2: 'x'.repeat(2000), A3: 'short  prose\nhere' },
    topDirs: ['packages'],
    codeDirs: ['packages/core', 'packages/api'],
  })
  test('asks Haiku, with the pinned section ids, deterministic statuses and strict JSON', () => {
    expect(req.model).toBe('haiku')
    expect(req.prompt).toContain('api | API | HTTP endpoints')
    expect(req.prompt).toContain('A1 | P | Done by PR | done/pr')
    expect(req.prompt).toContain('"drift"')
    expect(req.system).toContain('strict JSON')
  })
  test('prose goes only with judgeable items and is bounded to 600 characters', () => {
    expect(req.prompt).not.toContain('must not appear')
    expect(req.prompt).toContain('A3: short prose here')
    const a2 = req.prompt.split('\n').find(l => l.startsWith('A2: ')) ?? ''
    expect(a2.length).toBe('A2: '.length + 600)
  })
  test('code directories are listed', () => {
    expect(req.prompt).toContain('packages/core, packages/api')
  })
  test('the output budget grows with the ledger but is capped', () => {
    expect(req.maxTokens).toBe(800 + 50 * 3)
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: `X${i}`, title: 't', phase: 'p', status: 'planned' as const, source: 'none' as const }))
    expect(buildAssignmentRequest({ sections: SECTIONS, items: many, proseByItem: {}, topDirs: [], codeDirs: [] }).maxTokens).toBe(8000)
  })
})

describe('parseAssignment', () => {
  const reply = (o: unknown) => JSON.stringify(o)
  test('a good reply is accepted as is', () => {
    const r = parseAssignment(
      reply({
        items: [
          { id: 'A1', section: 'api', title: 'Short title' },
          { id: 'A3', section: 'bot', title: 'Another', status: 'partial' },
        ],
        sections: [{ id: 'api', caption: 'The HTTP surface.' }],
        drift: [{ itemId: 'A2', note: 'prose says shipped' }],
      }),
      CTX,
    )
    expect(r).toEqual({
      ok: true,
      result: {
        items: [
          { id: 'A1', section: 'api', title: 'Short title', status: null },
          { id: 'A3', section: 'bot', title: 'Another', status: 'partial' },
        ],
        sections: [{ id: 'api', caption: 'The HTTP surface.', title: null, planned: false }],
        drift: [{ itemId: 'A2', note: 'prose says shipped' }],
      },
    })
  })
  test('unknown item ids are dropped; unknown section ids become unassigned', () => {
    const r = parseAssignment(reply({ items: [{ id: 'ZZ', section: 'api' }, { id: 'A1', section: 'nope' }] }), CTX)
    expect(r.ok && r.result.items).toEqual([{ id: 'A1', section: UNASSIGNED, title: null, status: null }])
  })
  test('a status on a non-judgeable item is ignored: PR evidence wins', () => {
    const r = parseAssignment(reply({ items: [{ id: 'A1', section: 'api', status: 'planned' }, { id: 'A2', section: 'api', status: 'done' }] }), CTX)
    expect(r.ok && r.result.items.map(i => [i.id, i.status])).toEqual([['A1', null], ['A2', 'done']])
  })
  test('invalid statuses are ignored even on judgeable items', () => {
    const r = parseAssignment(reply({ items: [{ id: 'A2', section: 'api', status: 'open' }] }), CTX)
    expect(r.ok && r.result.items[0]?.status).toBeNull()
  })
  test('titles are cut to 8 words and notes to 140 characters', () => {
    const r = parseAssignment(
      reply({
        items: [{ id: 'A1', section: 'api', title: 'one two three four five six seven eight nine ten' }],
        drift: [{ itemId: 'A1', note: 'n'.repeat(300) }],
      }),
      CTX,
    )
    expect(r.ok && r.result.items[0]?.title).toBe('one two three four five six seven eight')
    expect(r.ok && r.result.drift[0]?.note.length).toBe(140)
  })
  test('a caption is one sentence', () => {
    const r = parseAssignment(reply({ sections: [{ id: 'api', caption: 'First sentence. Second sentence.' }] }), CTX)
    expect(r.ok && r.result.sections[0]?.caption).toBe('First sentence.')
  })
  test('new planned sections need a fresh kebab id, a title and planned: true', () => {
    const r = parseAssignment(
      reply({
        sections: [
          { id: 'new-area', title: 'New area here', caption: 'Not started.', planned: true },
          { id: 'Bad Id', title: 'x', caption: 'x', planned: true },
          { id: 'api', title: 'Hijack', caption: 'c', planned: true },
          { id: 'not-planned', title: 'x', caption: 'x' },
          { id: UNASSIGNED, title: 'x', caption: 'x', planned: true },
          { id: 'new-area', title: 'dup', caption: 'x', planned: true },
          { id: 'untitled', caption: 'x', planned: true },
        ],
      }),
      CTX,
    )
    expect(r.ok && r.result.sections.map(s => [s.id, s.planned, s.title])).toEqual([
      ['new-area', true, 'New area here'],
      ['api', false, null],
    ])
  })
  test('a pinned section keeps its own title even if the model sends another', () => {
    const r = parseAssignment(reply({ sections: [{ id: 'api', title: 'Renamed', caption: 'c.' }] }), CTX)
    expect(r.ok && r.result.sections[0]?.title).toBeNull()
  })
  test('duplicate item rows keep the first', () => {
    const r = parseAssignment(reply({ items: [{ id: 'A1', section: 'api' }, { id: 'A1', section: 'bot' }] }), CTX)
    expect(r.ok && r.result.items).toHaveLength(1)
    expect(r.ok && r.result.items[0]?.section).toBe('api')
  })
  test('bad JSON, prose and non-objects return an error and never throw', () => {
    expect(parseAssignment('nope', CTX)).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseAssignment('', CTX)).toEqual({ ok: false, error: 'invalid-json' })
    expect(parseAssignment('[1]', CTX)).toEqual({ ok: false, error: 'bad-shape' })
    expect(parseAssignment('null', CTX)).toEqual({ ok: false, error: 'bad-shape' })
  })
  test('garbage inside valid JSON is skipped, not fatal', () => {
    const r = parseAssignment(reply({ items: [1, null, 'x', { id: 7 }, { id: 'A1', section: 'api' }], sections: 'no', drift: {} }), CTX)
    expect(r.ok && r.result).toEqual({ items: [{ id: 'A1', section: 'api', title: null, status: null }], sections: [], drift: [] })
  })
  test('a ```json fence is tolerated', () => {
    expect(parseAssignment('```json\n{"items":[]}\n```', CTX).ok).toBe(true)
  })
})

describe('applyAssignment', () => {
  const items = [sized('A1', 'L'), sized('A2', 'M'), sized('A3', 'S'), sized('A4', 'S')]
  const prs = [pr(1, 'feat/A1-x')]
  const matches = matchPrs(items, prs)
  const pinned = { sections: SECTIONS as PinnedSection[] }
  const assignment: AssignmentResult = {
    items: [
      { id: 'A1', section: 'api', title: 'Rewritten A1', status: null },
      { id: 'A2', section: 'api', title: null, status: 'done' },
      { id: 'A3', section: 'bot', title: null, status: 'partial' },
    ],
    sections: [
      { id: 'api', caption: 'The API.', title: null, planned: false },
      { id: 'mobile', caption: 'Not started.', title: 'Mobile apps', planned: true },
    ],
    drift: [],
  }
  const out = applyAssignment({ items, matches }, pinned, assignment)

  test('pinned sections first, planned sections next, unassigned last', () => {
    expect(out.map(s => s.id)).toEqual(['api', 'bot', 'mobile', UNASSIGNED])
  })
  test('titles, captions and the planned flag come through', () => {
    expect(out[0]).toMatchObject({ title: 'API', caption: 'The API.', isPlanned: false })
    expect(out[1]).toMatchObject({ title: 'Telegram bot', caption: '', isPlanned: false })
    expect(out[2]).toMatchObject({ title: 'Mobile apps', caption: 'Not started.', isPlanned: true, percent: 0, status: 'planned' })
    expect(out[3]).toMatchObject({ title: '', isPlanned: false })
  })
  test('a judged status counts for items with no PR evidence; PR evidence is untouched', () => {
    const api = out[0]
    expect(api?.items.map(e => [e.item.id, e.status, e.title])).toEqual([['A1', 'done', 'Rewritten A1'], ['A2', 'done', 'A2']])
    expect(api?.percent).toBe(100)
    expect(api?.status).toBe('built')
  })
  test('percent and counts use the same weights and credits as progress.ts', () => {
    const bot = out[1]
    expect(bot?.percent).toBe(50)
    expect(bot?.counts).toEqual({ done: 0, total: 1 })
    expect(bot?.percent).toBe(percentOf(bot?.items ?? []))
    expect(out[3]?.items.map(e => e.item.id)).toEqual(['A4'])
  })
  test('a judged status is ignored when the match came from a PR', () => {
    const forced = applyAssignment({ items, matches }, pinned, {
      ...assignment,
      items: [{ id: 'A1', section: 'api', title: null, status: 'planned' }],
    })
    expect(forced[0]?.items[0]?.status).toBe('done')
  })
  test('pinned sections with no items still appear, at 0%', () => {
    const empty = applyAssignment({ items: [], matches: new Map() }, pinned, { items: [], sections: [], drift: [] })
    expect(empty.map(s => [s.id, s.percent, s.status])).toEqual([['api', 0, 'planned'], ['bot', 0, 'planned']])
  })
  test('an item filed under an unpinned section is unassigned', () => {
    const odd = applyAssignment({ items, matches }, pinned, { items: [{ id: 'A1', section: 'ghost', title: null, status: null }], sections: [], drift: [] })
    expect(odd.find(s => s.id === UNASSIGNED)?.items.map(e => e.item.id)).toEqual(['A1', 'A2', 'A3', 'A4'])
  })
})

describe('runL2', () => {
  const inputs = (hash = 'h1'): L2Inputs => ({
    ledgerTitle: 'Workplan',
    items: AITEMS,
    docHeadings: [],
    topDirs: ['src'],
    codeDirs: ['src'],
    proseByItem: { A2: 'prose', A3: 'prose' },
    hash,
  })
  const assignmentReply = JSON.stringify({ items: [{ id: 'A1', section: 'api' }], sections: [], drift: [] })

  /** A mock model that answers by model name and counts what it was asked. */
  function mock(replies: { sonnet?: string; haiku?: string }, fail: 'none' | 'not-ok' | 'throw' = 'none') {
    const seen: string[] = []
    const complete: Complete = async req => {
      seen.push(req.model)
      if (fail === 'throw') throw new Error('network')
      if (fail === 'not-ok') return { ok: false, reason: 'rate-limit' }
      return { ok: true, text: (req.model === 'sonnet' ? replies.sonnet : replies.haiku) ?? '' }
    }
    return { complete, seen }
  }

  const pinned = { sections: SECTIONS, pinnedAt: 1, ledgerPath: 'WORKPLAN.md' }
  const record: AssignmentRecord = { hash: 'h1', result: { items: [], sections: [], drift: [] }, at: 5 }

  test('nothing pinned and no proposal: exactly one Sonnet call, and a proposal comes back', async () => {
    const m = mock({ sonnet: proposalJson })
    const r = await runL2({ complete: m.complete, store: {}, inputs: inputs(), now: () => 42 })
    expect(r.calls).toEqual(['sonnet'])
    expect(m.seen).toEqual(['sonnet'])
    expect(r.proposal).toEqual({ sections: SECTIONS, proposedAt: 42 })
    expect(r.assignment).toBeUndefined()
    expect(r.error).toBeUndefined()
  })
  test('nothing pinned but a stored proposal: zero calls', async () => {
    const m = mock({ sonnet: proposalJson })
    const stored = { sections: SECTIONS, proposedAt: 1 }
    const r = await runL2({ complete: m.complete, store: { proposal: stored }, inputs: inputs() })
    expect(r.calls).toEqual([])
    expect(r.proposal).toBe(stored)
  })
  test('never more than one Sonnet call, and never Haiku, while nothing is pinned', async () => {
    const m = mock({ sonnet: 'not json' })
    const r = await runL2({ complete: m.complete, store: {}, inputs: inputs() })
    expect(m.seen).toEqual(['sonnet'])
    expect(r.error).toBe('invalid-json')
    expect(r.proposal).toBeUndefined()
  })
  test('pinned with a stored assignment of the same hash: zero calls', async () => {
    const m = mock({ haiku: assignmentReply })
    const r = await runL2({ complete: m.complete, store: { pinned, assignment: record }, inputs: inputs('h1') })
    expect(r.calls).toEqual([])
    expect(r.assignment).toBe(record)
  })
  test('pinned and the hash changed: exactly one Haiku call and a new record', async () => {
    const m = mock({ haiku: assignmentReply })
    const r = await runL2({ complete: m.complete, store: { pinned, assignment: record }, inputs: inputs('h2'), now: () => 99 })
    expect(r.calls).toEqual(['haiku'])
    expect(r.assignment?.hash).toBe('h2')
    expect(r.assignment?.at).toBe(99)
    expect(r.assignment?.result.items).toEqual([{ id: 'A1', section: 'api', title: null, status: null }])
  })
  test('pinned and no stored assignment: one Haiku call', async () => {
    const m = mock({ haiku: assignmentReply })
    const r = await runL2({ complete: m.complete, store: { pinned }, inputs: inputs() })
    expect(r.calls).toEqual(['haiku'])
    expect(r.assignment?.hash).toBe('h1')
  })
  test('a failed model call keeps the previous record and reports model-failed', async () => {
    const m = mock({}, 'not-ok')
    const r = await runL2({ complete: m.complete, store: { pinned, assignment: record }, inputs: inputs('h2') })
    expect(r.calls).toEqual(['haiku'])
    expect(r.assignment).toBe(record)
    expect(r.error).toBe('model-failed')
  })
  test('a throwing model counts as model-failed too', async () => {
    const m = mock({}, 'throw')
    const r = await runL2({ complete: m.complete, store: { pinned, assignment: record }, inputs: inputs('h2') })
    expect(r.assignment).toBe(record)
    expect(r.error).toBe('model-failed')
    const p = await runL2({ complete: m.complete, store: {}, inputs: inputs() })
    expect(p.error).toBe('model-failed')
  })
  test('an invalid reply keeps the previous record and reports invalid-json', async () => {
    const m = mock({ haiku: 'Sure! Here is the JSON' })
    const r = await runL2({ complete: m.complete, store: { pinned, assignment: record }, inputs: inputs('h2') })
    expect(r.assignment).toBe(record)
    expect(r.error).toBe('invalid-json')
  })
  test('the stored hash is not advanced by a failure, so the next run retries', async () => {
    const failing = mock({}, 'not-ok')
    const first = await runL2({ complete: failing.complete, store: { pinned, assignment: record }, inputs: inputs('h2') })
    const ok = mock({ haiku: assignmentReply })
    const second = await runL2({ complete: ok.complete, store: { pinned, assignment: first.assignment }, inputs: inputs('h2') })
    expect(second.calls).toEqual(['haiku'])
    expect(second.assignment?.hash).toBe('h2')
  })
  test('a judgeable status from the model survives the full round trip; a PR-backed one does not', async () => {
    const m = mock({
      haiku: JSON.stringify({ items: [{ id: 'A1', section: 'api', status: 'planned' }, { id: 'A3', section: 'api', status: 'done' }] }),
    })
    const r = await runL2({ complete: m.complete, store: { pinned }, inputs: inputs() })
    expect(r.assignment?.result.items.map(i => [i.id, i.status])).toEqual([['A1', null], ['A3', 'done']])
  })
})

describe('ItemMatch typing smoke', () => {
  test('applyAssignment accepts a hand-built matches map', () => {
    const match: ItemMatch = { status: 'done', prs: [], followups: [], slices: [], reverts: [], source: 'pr' }
    const out = applyAssignment({ items: [item('Z1')], matches: new Map([['Z1', match]]) }, { sections: SECTIONS }, { items: [], sections: [], drift: [] })
    expect(out.find(s => s.id === UNASSIGNED)?.items[0]?.status).toBe('done')
  })
})
