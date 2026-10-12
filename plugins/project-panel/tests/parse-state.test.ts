import { test, expect, describe } from 'claude-code/testing'
import { parseState } from '../src/providers/aidlc/parse-state'
import { upstreamTemplate } from '../fixtures/upstream-template'
import { liveState, archivedState } from '../fixtures/real-sample'

const PANEL_FIELDS = [
  'Lifecycle Phase',
  'Current Stage',
  'Next Stage',
  'Status',
  'Last Completed Stage',
  'Next Action',
  'Last Updated',
]

function stagesOf(text: string, key: string) {
  return parseState(text).phases.find(phase => phase.key === key)?.stages ?? []
}

describe('upstream template', () => {
  test('parses without throwing and finds every field the panel reads', () => {
    const parsed = parseState(upstreamTemplate)
    for (const field of PANEL_FIELDS) expect(parsed.fields).toHaveProperty(field)
    expect(parsed.fields['Lifecycle Phase']).toStartWith('[READY/')
  })

  test('its placeholders produce no phases, no progress and no stages', () => {
    const parsed = parseState(upstreamTemplate)
    expect(parsed.phases).toEqual([])
    expect(parsed.phaseProgress).toEqual({})
    expect(parsed.isArchived).toBe(false)
  })

  test('the Stage Progress legend lists all six markers', () => {
    const legend = upstreamTemplate.split('\n').find(line => line.includes('Checkbox states')) ?? ''
    for (const marker of ['[ ]', '[-]', '[?]', '[R]', '[x]', '[S]']) expect(legend).toContain(marker)
  })

  test('Phase Progress lines do not leak into fields', () => {
    expect(parseState(upstreamTemplate).fields).not.toHaveProperty('[Phase]')
  })
})

describe('real sample', () => {
  const live = parseState(liveState)

  test('phase keys in order, with their Phase Progress status', () => {
    expect(live.phases.map(phase => phase.key)).toEqual(['INITIALIZATION', 'IDEATION', 'INCEPTION', 'CONSTRUCTION', 'OPERATION'])
    expect(live.phaseProgress).toEqual({
      INITIALIZATION: 'verified',
      IDEATION: 'verified',
      INCEPTION: 'active',
      CONSTRUCTION: 'pending',
      OPERATION: 'skipped',
    })
  })

  test('stage counts and executed counts', () => {
    const counts = Object.fromEntries(
      live.phases.map(phase => [
        phase.key,
        {
          rows: phase.stages.length,
          executed: phase.stages.filter(stage => stage.isExecuted).length,
          completed: phase.stages.filter(stage => stage.isExecuted && stage.marker === 'completed').length,
        },
      ]),
    )
    expect(counts).toEqual({
      INITIALIZATION: { rows: 3, executed: 3, completed: 3 },
      IDEATION: { rows: 7, executed: 4, completed: 4 },
      INCEPTION: { rows: 9, executed: 8, completed: 4 },
      CONSTRUCTION: { rows: 7, executed: 7, completed: 0 },
      OPERATION: { rows: 7, executed: 0, completed: 0 },
    })
  })

  test('domain-design is in progress, the rest of Inception is as written', () => {
    const inception = stagesOf(liveState, 'INCEPTION')
    expect(inception.find(stage => stage.slug === 'domain-design')).toEqual({
      slug: 'domain-design',
      marker: 'in-progress',
      isExecuted: true,
      note: '',
    })
    expect(inception[0]).toEqual({ slug: 'reverse-engineering', marker: 'pending', isExecuted: false, note: '' })
  })

  test('Per unit line sits on Construction only', () => {
    expect(live.phases.map(phase => phase.perUnit)).toEqual(['', '', '', '[TBD]', ''])
  })

  test('fields after the blank-line run: Parked and Parked At Stage', () => {
    expect(live.fields['Parked']).toBe('2026-09-04T01:19:27Z')
    expect(live.fields['Parked At Stage']).toBe('domain-design')
    expect(live.fields['Construction Execution']).toBe('serial')
  })

  test('current-status fields', () => {
    expect(live.fields['Lifecycle Phase']).toBe('INCEPTION')
    expect(live.fields['Current Stage']).toBe('domain-design')
    expect(live.fields['Status']).toBe('Running')
    expect(live.fields['Next Action']).toBe('Execute Domain Design')
    expect(live.isArchived).toBe(false)
  })

  test('the archived copy reads as archived and keeps its [S] row', () => {
    const archived = parseState(archivedState)
    expect(archived.isArchived).toBe(true)
    expect(archived.phases.find(phase => phase.key === 'INCEPTION')?.stages[0]).toEqual({
      slug: 'reverse-engineering',
      marker: 'skipped',
      isExecuted: true,
      note: '',
    })
  })
})

describe('markers', () => {
  const rows = [
    '- [ ] a — EXECUTE',
    '- [-] b — EXECUTE',
    '- [?] c — EXECUTE',
    '- [R] d — EXECUTE',
    '- [x] e — EXECUTE',
    '- [X] f — EXECUTE',
    '- [S] g — EXECUTE',
  ]
  const text = ['## Stage Progress', '', '### INCEPTION PHASE', ...rows, ''].join('\n')

  test('every marker maps to its state', () => {
    expect(stagesOf(text, 'INCEPTION').map(stage => stage.marker)).toEqual([
      'pending',
      'in-progress',
      'awaiting-approval',
      'revising',
      'completed',
      'completed',
      'skipped',
    ])
  })

  test('an unknown marker drops the row', () => {
    const odd = '## Stage Progress\n### INCEPTION PHASE\n- [!] a — EXECUTE\n- [x] b — EXECUTE\n'
    expect(stagesOf(odd, 'INCEPTION').map(stage => stage.slug)).toEqual(['b'])
  })
})

describe('stage rows', () => {
  const wrap = (rows: string[]) => ['## Stage Progress', '### CONSTRUCTION PHASE', ...rows].join('\n')

  test('notes after EXECUTE: and SKIP:', () => {
    const [a, b] = stagesOf(wrap(['- [ ] a — SKIP: not needed here', '- [ ] b — EXECUTE: with care']), 'CONSTRUCTION')
    expect(a).toEqual({ slug: 'a', marker: 'pending', isExecuted: false, note: 'not needed here' })
    expect(b).toEqual({ slug: 'b', marker: 'pending', isExecuted: true, note: 'with care' })
  })

  test('dash variants are accepted', () => {
    const slugs = stagesOf(wrap(['- [ ] a - EXECUTE', '- [ ] b -- SKIP', '- [ ] c – EXECUTE']), 'CONSTRUCTION')
    expect(slugs.map(stage => stage.slug)).toEqual(['a', 'b', 'c'])
  })

  test('placeholder and malformed rows are skipped', () => {
    const rows = [
      '- [ ] stage-slug — [EXECUTE/SKIP: reason]',
      '- [ ] Bad_Slug — EXECUTE',
      '- [ ] x — MAYBE',
      '- [ ] y — SKIPPED',
      '- [ ] z — EXECUTE/SKIP',
      '- [ ] ok — EXECUTE',
      'plain prose',
    ]
    expect(stagesOf(wrap(rows), 'CONSTRUCTION').map(stage => stage.slug)).toEqual(['ok'])
  })

  test('a Per unit line after the first stage is not a perUnit', () => {
    const text = wrap(['Per unit: [a]', '- [ ] one — EXECUTE', 'Per unit: [b]'])
    expect(parseState(text).phases[0]?.perUnit).toBe('[a]')
  })

  test('rows outside Stage Progress and before any phase are ignored', () => {
    const text = '- [x] early — EXECUTE\n## Stage Progress\n- [x] orphan — EXECUTE\n### INCEPTION PHASE\n- [x] in — EXECUTE\n## Other\n- [x] late — EXECUTE\n'
    expect(parseState(text).phases.map(phase => phase.stages.map(stage => stage.slug))).toEqual([['in']])
  })

  test('a non-PHASE ### heading closes the phase', () => {
    const text = wrap(['- [x] a — EXECUTE', '### Notes', '- [x] b — EXECUTE'])
    expect(stagesOf(text, 'CONSTRUCTION').map(stage => stage.slug)).toEqual(['a'])
  })
})

describe('Phase Progress', () => {
  test('values are case-folded, unknown ones ignored', () => {
    const text = '## Phase Progress\n- **Inception**: ACTIVE\n- **Construction**: Pending\n- **Operation**: Nonsense\n- **[Phase]**: [Pending/Active/Verified/Skipped]\n'
    expect(parseState(text).phaseProgress).toEqual({ INCEPTION: 'active', CONSTRUCTION: 'pending' })
  })

  test('a trailing remark does not hide the value', () => {
    expect(parseState('## Phase Progress\n- **Inception**: Active (finalizing)\n').phaseProgress).toEqual({ INCEPTION: 'active' })
  })
})

describe('fields', () => {
  test('first occurrence wins, values are trimmed', () => {
    const text = '- **Status**:   Running  \n- **Status**: Completed\n'
    expect(parseState(text).fields['Status']).toBe('Running')
  })

  test('prose that merely mentions a label is not a field', () => {
    const text = '> The Lifecycle Phase: OPERATION was added\nLifecycle Phase: X\n- **Lifecycle Phase**: IDEATION\n'
    expect(parseState(text).fields['Lifecycle Phase']).toBe('IDEATION')
  })

  test('an empty value is an empty string, not the next line', () => {
    expect(parseState('- **Worktree Path**:\n- **Bolt Refs**: x\n').fields).toEqual({ 'Worktree Path': '', 'Bolt Refs': 'x' })
  })
})

describe('archive flag', () => {
  test('only an exact Status line counts', () => {
    expect(parseState('- **Status**: Archived\n').isArchived).toBe(true)
    expect(parseState('- **Status**:   Archived   \n').isArchived).toBe(true)
    expect(parseState('- **Archived From**: Running\n').isArchived).toBe(false)
    expect(parseState('- **Status**: Archived soon\n').isArchived).toBe(false)
    expect(parseState('- **Status**: Running\n').isArchived).toBe(false)
  })
})

describe('line separators inside a line', () => {
  // `.` stops at U+2028, U+2029 and a stray \r, which used to drop the whole line.
  for (const [name, sep] of [['U+2028', '\u2028'], ['U+2029', '\u2029'], ['a stray CR', '\r']] as const) {
    test(`a field value keeps ${name}`, () => {
      const parsed = parseState(`- **Next Action**: a${sep}b\n- **Status**: Running\n`)
      expect(parsed.fields['Next Action']).toBe(`a${sep}b`)
      expect(parsed.fields['Status']).toBe('Running')
    })

    test(`a stage row with ${name} in its note is kept`, () => {
      const text = ['## Stage Progress', '### INCEPTION PHASE', `- [ ] a — SKIP: not${sep}needed`, '- [x] b — EXECUTE'].join('\n')
      expect(stagesOf(text, 'INCEPTION')).toEqual([
        { slug: 'a', marker: 'pending', isExecuted: false, note: `not${sep}needed` },
        { slug: 'b', marker: 'completed', isExecuted: true, note: '' },
      ])
    })

    test(`a Phase Progress value and a Per unit line survive ${name}`, () => {
      const text = `## Phase Progress\n- **Inception**: Active${sep}(now)\n## Stage Progress\n### CONSTRUCTION PHASE\nPer unit: [a,${sep}b]\n- [ ] x — EXECUTE\n`
      const parsed = parseState(text)
      expect(parsed.phaseProgress).toEqual({ INCEPTION: 'active' })
      expect(parsed.phases[0]?.perUnit).toBe(`[a,${sep}b]`)
    })
  }
})

describe('odd input', () => {
  test('CRLF gives the same result as LF', () => {
    const lf = parseState(liveState)
    const crlf = parseState(liveState.replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(lf)
  })

  test('CRLF archive flag', () => {
    expect(parseState('- **Status**: Archived\r\n').isArchived).toBe(true)
  })

  test('empty and junk input never throw', () => {
    const empty = { fields: {}, phaseProgress: {}, phases: [], isArchived: false }
    expect(parseState('')).toEqual(empty)
    expect(parseState('\n\n\n')).toEqual(empty)
    const junk = Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('')
    parseState(junk)
    parseState('- **' + '*'.repeat(5000))
    parseState('## Stage Progress\n### ' + 'X'.repeat(5000) + ' PHASE\n- [' + ' '.repeat(5000))
    parseState('\u0000￿\uD800 - [x]')
    parseState(undefined as unknown as string)
  })
})
