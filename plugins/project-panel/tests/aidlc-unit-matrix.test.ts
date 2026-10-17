// Which per-unit stages a Unit owes by its kind (src/providers/aidlc/unit-matrix.ts): the engine's own rule over the
// stage files' `produces` and `produces_kinds`.
import { describe, expect, test } from 'claude-code/testing'

import { parseStageProduces, stageApplies, withKinds } from '../src/providers/aidlc/unit-matrix'
import type { UnitMatrix } from '../src/providers/aidlc/unit-matrix'
import type { Unit, UnitCell } from '../src/providers/aidlc/units'

const FUNCTIONAL = `---
slug: functional-design
produces:
  - entities
  - rules
  - functional-spec
  - traceability
optional_produces:
  - frontend-components
produces_kinds:
  entities: [service, spec, library]
  rules: [service, spec, library]
  functional-spec: [service, spec, ui, library]
  traceability: [service, spec, ui, library]
  frontend-components: [ui]
consumes:
  - artifact: unit-of-work
    required: true
---

# Functional Design

produces:
  - not-front-matter
`

const unit = (name: string, kind: string): Unit => ({ name, kind, dependsOn: [], id: '', jira: '' })

describe('parseStageProduces', () => {
  test('the front matter only: produces and the kinds map, optional produces left out', () => {
    const parsed = parseStageProduces(FUNCTIONAL)
    expect(parsed?.produces).toEqual(['entities', 'rules', 'functional-spec', 'traceability'])
    expect([...(parsed?.producesKinds ?? new Map())]).toEqual([
      ['entities', ['service', 'spec', 'library']],
      ['rules', ['service', 'spec', 'library']],
      ['functional-spec', ['service', 'spec', 'ui', 'library']],
      ['traceability', ['service', 'spec', 'ui', 'library']],
      ['frontend-components', ['ui']],
    ])
  })

  test('a flow list, no kinds map, no front matter', () => {
    expect(parseStageProduces('---\nproduces: [a, "b"]\n---\n')).toEqual({ produces: ['a', 'b'], producesKinds: null })
    expect(parseStageProduces('---\nslug: x\n---\n')).toBeNull()
    expect(parseStageProduces('# no front matter\nproduces:\n  - a\n')).toBeNull()
  })
})

describe('stageApplies', () => {
  const matrix: UnitMatrix = new Map([
    ['functional-design', parseStageProduces(FUNCTIONAL)!],
    // An artifact the map does not name is for every kind.
    ['nfr-design', { produces: ['performance-design', 'traceability'], producesKinds: new Map([['performance-design', ['service']]]) }],
    ['code-generation', { produces: ['code-summary'], producesKinds: null }],
    ['infrastructure-design', { produces: [], producesKinds: null }],
  ])

  test('a stage none of whose artifacts are for the kind does not apply', () => {
    expect(stageApplies(matrix, 'functional-design', 'packaging')).toBe(false)
    expect(stageApplies(matrix, 'functional-design', 'ui')).toBe(true)
    expect(stageApplies(matrix, 'nfr-design', 'packaging')).toBe(true)
    expect(stageApplies(matrix, 'code-generation', 'packaging')).toBe(true)
  })

  test('an untagged Unit owes every stage that produces something; a stage the matrix lacks applies', () => {
    expect(stageApplies(matrix, 'functional-design', '')).toBe(true)
    expect(stageApplies(matrix, 'infrastructure-design', '')).toBe(false)
    expect(stageApplies(matrix, 'nfr-requirements', 'packaging')).toBe(true)
  })

  test('withKinds: only an [x] the kind does not owe turns skipped; no matrix, the table as it is', () => {
    const table = new Map([
      ['u6', new Map<string, UnitCell>([['functional-design', 'x'], ['code-generation', ' ']])],
      ['u1', new Map<string, UnitCell>([['functional-design', 'x']])],
    ])
    const units = [unit('u6', 'packaging'), unit('u1', 'service')]
    const read = withKinds(table, units, matrix)
    expect([...(read.get('u6') ?? new Map())]).toEqual([['functional-design', 'S'], ['code-generation', ' ']])
    expect(read.get('u1')?.get('functional-design')).toBe('x')
    expect(withKinds(table, units, new Map())).toBe(table)
  })
})
