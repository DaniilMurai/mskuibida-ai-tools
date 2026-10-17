// Construction by Unit of work: the Units, their story points and their receipts in, one row per Unit out.
import { test, expect, describe } from 'claude-code/testing'
import { aidlc } from '../src/providers/aidlc'
import { parseUnitDag, parseUnitEvents, parseUnitIndex, progressOf, unitStageStatuses } from '../src/providers/aidlc/units'
import type { Unit, UnitFacts, UnitProgress } from '../src/providers/aidlc/units'
import { cloudIdsOf, jiraServerOf, parsePointsCsv, storyPointsOf, withRows } from '../src/providers/aidlc/points'
import { isResumedAfter } from '../src/providers/aidlc/park'
import { parseState } from '../src/providers/aidlc/parse-state'
import * as s from '../fixtures/scenarios'
import type { VirtualTree } from '../fixtures/virtual'
import type { PanelModel, ProviderHost } from '../types'
import { ctxOf, mockHost, OPTIONS } from './world'

const INTENT_DIR = `${s.ROOT}/aidlc/spaces/default/intents/${s.INTENT}`
const UNITS_DIR = `${INTENT_DIR}/inception/units-generation`

const DEPENDENCY = `# Unit dependencies

Prose first, with a decoy block:

\`\`\`yaml
other: true
\`\`\`

## Edge block

\`\`\`yaml
units:
  - name: api-core
    kind: service
    depends_on: []
  - name: web-shell
    kind: ui
    depends_on: [api-core]
  - name: "api-billing"   # quoted, with a comment
    kind: service
    depends_on:
      - api-core
  - name: web-billing
    kind: ui
    depends_on: [api-billing, web-shell]
\`\`\`
`

const INDEX = `# Units of work

## Unit index

| Unit ID | Directory | Repo | Kind | Jira | Stories |
|---|---|---|---|---|---|
| U1 | \`u1-api-core\` | api | service | SHOP-11 | US1.1 |
| U2 | \`u2-web-shell\` | web | ui | SHOP-12 | US1.2 |
| U3 | \`u3-api-billing\` | api | service | SHOP-13 | US2.1 |
| U4 | \`u4-web-billing\` | web | ui | created at approval | US2.2 |
`

function audit(...rows: [string, string, string, string][]): string {
  const blocks = rows.map(([at, event, stage, unit]) =>
    ['## Unit', `**Timestamp**: ${at}`, `**Event**: ${event}`, `**Stage**: ${stage}`, `**Unit**: ${unit}`, '**Run floor**: x', ''].join('\n'),
  )
  return ['# AI-DLC Audit Log', '', '## Session Start', '**Timestamp**: 2026-10-01T00:00:00Z', '**Event**: SESSION_STARTED', '', '---', '', blocks.join('\n---\n\n')].join('\n')
}

const PER_UNIT_ROWS = (marks: Record<string, string> = {}) =>
  ['functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation', 'build-and-test', 'ci-pipeline'].map(
    slug => `- [${marks[slug] ?? ' '}] ${slug} — EXECUTE`,
  )

function stateText(marks: Record<string, string> = {}, extra: string[] = []): string {
  const text = s.stateOf({
    lifecycle: 'CONSTRUCTION',
    current: 'code-generation',
    progress: { Inception: 'Verified', Construction: 'Active' },
    phases: {
      INCEPTION: ['- [x] requirements-analysis — EXECUTE', '- [x] units-generation — EXECUTE'],
      CONSTRUCTION: ['Per unit: [TBD]', ...PER_UNIT_ROWS(marks)],
    },
  })
  return text.replace('- **Revision Count**: 3', ['- **Revision Count**: 3', '- **Construction Checkpoints**: enabled', ...extra].join('\n'))
}

/** U1 by ID, U2 by name; U3 is Jira's to answer, U4 has no Jira key. */
const POINTS = 'unit,points,source\nU1,8,human\nweb-shell,3,ai\n'
const POINTS_PATH = `${INTENT_DIR}/unit-points.csv`
const MCP_JSON = JSON.stringify({ mcpServers: { 'jira-acme': { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' }, other: { url: 'https://example.test' } } })

/** An issue answer as the Atlassian MCP gives it with `expand: names`. */
const issue = (points: number | null) =>
  JSON.stringify({ key: 'SHOP-13', fields: { summary: 'x', customfield_10016: points }, names: { summary: 'Summary', customfield_10016: 'Story point estimate' } })

type JiraHost = ProviderHost & { calls: string[][]; writes: Record<string, string> }

/** A host whose MCP answers like the Atlassian server, writing into `t` and reporting `dirty` from git status. */
function jiraHost(t: VirtualTree, answer: (key: string) => string | null, dirty = false): JiraHost {
  const base = mockHost()
  const calls: string[][] = []
  const writes: Record<string, string> = {}
  return {
    ...base,
    calls,
    writes,
    run: async argv => (argv[1] === 'status' ? { exitCode: 0, stdout: dirty ? ` M ${argv.at(-1)}\n` : '', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }),
    mcp: async (server, tool, args) => {
      calls.push([server, tool, String(args['issueIdOrKey'] ?? '')])
      if (tool === 'getAccessibleAtlassianResources') return { isError: false, text: JSON.stringify([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]) }
      const text = answer(String(args['issueIdOrKey']))
      return text === null ? { isError: true, text: 'not found' } : { isError: false, text }
    },
    write: async (path, text) => {
      writes[path] = text
      t.files[path] = text
    },
  }
}

/** A session bound to the intent, on a stage branch: the only kind that writes the points file. */
function asStage(t: VirtualTree): VirtualTree {
  t.files[`${s.ROOT}/aidlc/.aidlc-sessions/${s.SESSION}.binding.json`] = JSON.stringify({ space: 'default', intent: s.INTENT, boundAt: '2026-10-01T00:00:00Z' })
  t.files[`${s.ROOT}/.git/HEAD`] = 'ref: refs/heads/dev/SHOP-7/code-generation\n'
  return t
}

function tree(state: string, files: Record<string, string> = {}): VirtualTree {
  return {
    files: {
      [s.paths.statePath]: state,
      [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n`,
      [`${UNITS_DIR}/unit-of-work-dependency.md`]: DEPENDENCY,
      [`${UNITS_DIR}/unit-of-work.md`]: INDEX,
      ...files,
    },
  }
}

async function load(t: VirtualTree, host: ProviderHost = mockHost()): Promise<PanelModel> {
  const ctx = ctxOf(t, s.ROOT, s.SESSION, OPTIONS, host)
  const detection = await aidlc.detect(ctx)
  if (!detection) throw new Error('expected a detection')
  return aidlc.load(ctx, detection)
}

const construction = (model: PanelModel) => {
  const found = model.sections.find(one => one.id === 'CONSTRUCTION')
  if (!found) throw new Error('no Construction')
  return found
}

/** Where the Unit rows are: the Units section once a Unit is claimed at this checkout, else Construction. */
const unitList = (model: PanelModel) => model.sections.find(one => one.id === 'UNITS') ?? construction(model)

describe('parseUnitDag', () => {
  test('the units block, flow and block lists, quotes and comments', () => {
    expect(parseUnitDag(DEPENDENCY)).toEqual([
      { name: 'api-core', kind: 'service', dependsOn: [] },
      { name: 'web-shell', kind: 'ui', dependsOn: ['api-core'] },
      { name: 'api-billing', kind: 'service', dependsOn: ['api-core'] },
      { name: 'web-billing', kind: 'ui', dependsOn: ['api-billing', 'web-shell'] },
    ])
  })

  test('no units block, or one with a bad name, is null', () => {
    expect(parseUnitDag('# nothing here')).toBeNull()
    expect(parseUnitDag('```yaml\nunits:\n  - name: ../etc\n```\n')).toBeNull()
    expect(parseUnitDag('```yaml\nunits:\n```\n')).toBeNull()
  })
})

describe('parseUnitIndex', () => {
  test('ID and Jira key by directory suffix; a cell that is no issue key is none', () => {
    const index = parseUnitIndex(INDEX, ['api-core', 'web-shell', 'api-billing', 'web-billing', 'absent'])
    expect(index.get('api-core')).toEqual({ id: 'U1', jira: 'SHOP-11' })
    expect(index.get('api-billing')).toEqual({ id: 'U3', jira: 'SHOP-13' })
    expect(index.get('web-billing')).toEqual({ id: 'U4', jira: '' })
    expect(index.has('absent')).toBe(false)
  })

  test('a table without a Unit ID column is not the index', () => {
    expect(parseUnitIndex('| Unit | Repo |\n|---|---|\n| api-core | api |\n', ['api-core']).size).toBe(0)
  })
})

describe('the points file', () => {
  const units: Unit[] = [
    { name: 'api-core', kind: '', dependsOn: [], id: 'U1', jira: '' },
    { name: 'web-shell', kind: '', dependsOn: [], id: 'U2', jira: '' },
  ]

  test('rows by ID (any case) or name; header, comments, junk and unknown Units skipped; the last row wins', () => {
    const got = parsePointsCsv('unit,points,source\n# note\nu1, 8,ai\nweb-shell,2.5,human\nU9,3\nU2,x\napi-core,13,human\n', units)
    expect([...got.points]).toEqual([['api-core', 13], ['web-shell', 2.5]])
    expect(got.repeated).toEqual(['api-core'])
  })

  test('the source is recorded and read by nobody: a row without one counts the same', () => {
    const got = parsePointsCsv('unit,points\nU1,8\nU2,3,ai\n', units)
    expect([...got.points]).toEqual([['api-core', 8], ['web-shell', 3]])
    expect(got.repeated).toEqual([])
  })

  test('new rows are added at the end with their source; a new file starts with the header; an old header gains source', () => {
    expect(withRows('', [{ unit: units[0]!, points: 8, source: 'human' }])).toBe('unit,points,source\nU1,8,human\n')
    expect(withRows('unit,points\nU1,8', [{ unit: { ...units[1]!, id: '' }, points: 3, source: 'human' }])).toBe(
      'unit,points,source\nU1,8\nweb-shell,3,human\n',
    )
    expect(withRows('unit,points,source\nU1,8,ai\n', [{ unit: units[1]!, points: 3, source: 'human' }])).toBe('unit,points,source\nU1,8,ai\nU2,3,human\n')
  })
})

describe('Jira answers', () => {
  test('the Atlassian server is found by its host, not its name', () => {
    expect(jiraServerOf(MCP_JSON)).toBe('jira-acme')
    expect(jiraServerOf(JSON.stringify({ mcpServers: { jira: { url: 'https://evil.test/atlassian.com' } } }))).toBeNull()
    expect(jiraServerOf('not json')).toBeNull()
  })

  test('story points by the names map, by a field named so, or by a name/value entry; none is null', () => {
    expect(storyPointsOf(issue(13))).toBe(13)
    expect(storyPointsOf(issue(null))).toBeNull()
    expect(storyPointsOf(JSON.stringify({ fields: { 'Story Points': 5 } }))).toBe(5)
    expect(storyPointsOf(JSON.stringify({ fields: { customFields: [{ id: 'customfield_1', name: 'Story point estimate', value: '3' }] } }))).toBe(3)
    expect(storyPointsOf('Story points: unknown')).toBeNull()
  })

  test('cloud ids from a list or a { resources } object', () => {
    expect(cloudIdsOf(JSON.stringify([{ id: 'a' }, { id: 'b' }]))).toEqual(['a', 'b'])
    expect(cloudIdsOf(JSON.stringify({ resources: [{ id: 'c' }] }))).toEqual(['c'])
    expect(cloudIdsOf('nope')).toEqual([])
  })
})

describe('parseUnitEvents', () => {
  test('UNIT_* rows only, with stage, unit and time', () => {
    const shard = audit(['2026-10-02T10:00:00Z', 'UNIT_STARTED', 'functional-design', 'api-core'], ['2026-10-02T11:00:00Z', 'UNIT_COMPLETED', 'functional-design', 'api-core'])
    expect(parseUnitEvents(shard)).toEqual([
      { event: 'UNIT_STARTED', stage: 'functional-design', unit: 'api-core', at: '2026-10-02T10:00:00Z' },
      { event: 'UNIT_COMPLETED', stage: 'functional-design', unit: 'api-core', at: '2026-10-02T11:00:00Z' },
    ])
    expect(parseUnitEvents('# AI-DLC Audit Log\n')).toEqual([])
  })
})

describe('progressOf', () => {
  const units: Unit[] = [
    { name: 'a', kind: '', dependsOn: [], id: 'U1', jira: '' },
    { name: 'b', kind: '', dependsOn: [], id: 'U2', jira: '' },
  ]
  const facts = (over: Partial<UnitFacts> = {}): UnitFacts => ({ events: [], builtByFiles: new Set(), startedByFiles: new Map(), ...over })
  const ev = (event: 'UNIT_STARTED' | 'UNIT_PAUSED' | 'UNIT_RESUMED' | 'UNIT_COMPLETED', stage: string, unit: string) => ({ event, stage, unit, at: '' })

  test('with receipts owed, artifacts alone build nothing', () => {
    const got = progressOf(units, parseState(stateText()), facts({ builtByFiles: new Set(['a']) }))
    expect(got.get('a')).toEqual({ phase: 'planned', stage: '' })
  })

  test('without receipts owed, artifacts decide', () => {
    const plain = parseState(stateText().replace('- **Construction Checkpoints**: enabled\n', ''))
    const got = progressOf(units, plain, facts({ builtByFiles: new Set(['a']), startedByFiles: new Map([['a', 'code-generation'], ['b', 'nfr-design']]) }))
    expect(got.get('a')).toEqual({ phase: 'done', stage: '' })
    expect(got.get('b')).toEqual({ phase: 'active', stage: 'nfr-design' })
  })

  test('code-generation completed builds the Unit; a later restart of it unbuilds', () => {
    const done = progressOf(units, parseState(stateText()), facts({ events: [ev('UNIT_COMPLETED', 'code-generation', 'a')] }))
    expect(done.get('a')).toEqual({ phase: 'done', stage: '' })
    const again = progressOf(units, parseState(stateText()), facts({ events: [ev('UNIT_COMPLETED', 'code-generation', 'a'), ev('UNIT_STARTED', 'code-generation', 'a')] }))
    expect(again.get('a')).toEqual({ phase: 'active', stage: 'code-generation' })
  })

  test('between stages, paused, and the Active Unit cache', () => {
    const state = parseState(stateText({}, ['- **Active Unit**: b', '- **Unit State**: paused']))
    const got = progressOf(units, state, facts({ events: [ev('UNIT_COMPLETED', 'functional-design', 'a'), ev('UNIT_STARTED', 'nfr-design', 'b')] }))
    expect(got.get('a')).toEqual({ phase: 'between', stage: 'functional-design' })
    expect(got.get('b')).toEqual({ phase: 'paused', stage: 'nfr-design' })
  })

  test("code-generation's checkbox at [x] builds every Unit", () => {
    const got = progressOf(units, parseState(stateText({ 'code-generation': 'x' })), facts())
    expect([...got.values()].every(one => one.phase === 'done')).toBe(true)
  })
})

describe('Construction drawn as Units', () => {
  const shard = audit(
    ['2026-10-02T09:00:00Z', 'UNIT_STARTED', 'code-generation', 'api-core'],
    ['2026-10-02T10:00:00Z', 'UNIT_COMPLETED', 'code-generation', 'api-core'],
    ['2026-10-02T11:00:00Z', 'UNIT_COMPLETED', 'functional-design', 'web-shell'],
    ['2026-10-02T12:00:00Z', 'UNIT_STARTED', 'nfr-requirements', 'api-billing'],
  )
  const world = (extra: Record<string, string> = {}) =>
    tree(stateText({}, ['- **Active Unit**: api-billing', '- **Unit State**: in-progress']), {
      [`${INTENT_DIR}/audit/host-a.md`]: shard,
      [POINTS_PATH]: POINTS,
      [`${s.ROOT}/.mcp.json`]: MCP_JSON,
      ...extra,
    })

  test('one row per Unit in the block order, with its points, then the once-run stages', async () => {
    const t = world()
    const section = unitList(await load(t, jiraHost(t, () => issue(13))))
    expect(section.items.map(item => [item.id, item.title, item.status, item.statusWord ?? null, item.chips.map(chip => chip.label)])).toEqual([
      ['unit:api-core', 'U1 api-core', 'done', null, ['8 pt']],
      ['unit:web-shell', 'U2 web-shell', 'partial', 'functional-design done', ['3 pt']],
      ['unit:api-billing', 'U3 api-billing', 'open', 'nfr-requirements', ['13 pt']],
      ['unit:web-billing', 'U4 web-billing', 'planned', 'waits on U3, U2', ['5 pt, default']],
      ['build-and-test', 'build-and-test', 'planned', null, []],
      ['ci-pipeline', 'ci-pipeline', 'planned', null, []],
    ])
    expect(section.items.find(item => item.isCurrent)?.id).toBe('unit:api-billing')
    expect(section.caption).toBe('1 of 4 units done, 8 of 29 story points')
    // Counted by story points (the Units' 29 and the run-once stages' 2), with the Units done beside them.
    expect(section.countLabel).toBe('8/31 pt')
    expect(section.sideCount).toBe('1/4 units')
  })

  test('the ring: each Unit weighs its story points, each once-run stage 1 point', async () => {
    const t = world()
    const section = unitList(await load(t, jiraHost(t, () => issue(13))))
    // Points 8 + 3 + 13 + 5 = 29, and 2 for build-and-test and ci-pipeline. Done: U1's 8.
    expect(section.percent).toBe(Math.round((8 / 31) * 100))
    expect(section.counts).toEqual({ done: 1, total: 6 })
  })

  test('the plan: every stage is 1 story point, every Unit its own', async () => {
    const t = world()
    const model = await load(t, jiraHost(t, () => issue(13)))
    // Done: 2 Inception stages (2 pt) + U1 (8 pt). All: 2 + 29 + 2 = 33 pt.
    const percent = Math.round((10 / 33) * 100)
    expect(model.overall.percent).toBe(percent)
    expect(model.overall.label).toBe(`${percent}% done by story points, 10 of 33 pt`)
  })

  test("a side job asks Jira for the Unit the file lacks, but writes nothing", async () => {
    const t = world()
    const host = jiraHost(t, () => issue(13))
    await load(t, host)
    expect(host.calls).toEqual([
      ['jira-acme', 'getAccessibleAtlassianResources', ''],
      ['jira-acme', 'getJiraIssue', 'SHOP-13'],
    ])
    expect(host.writes).toEqual({})
  })

  test('a stage session writes Jira\'s answer to the file; the next load reads it and asks nothing', async () => {
    const t = asStage(world())
    const host = jiraHost(t, () => issue(13))
    await load(t, host)
    expect(host.writes[POINTS_PATH]).toBe('unit,points,source\nU1,8,human\nweb-shell,3,ai\nU3,13,human\n')
    const again = jiraHost(t, () => issue(13))
    const section = unitList(await load(t, again))
    expect(again.calls).toEqual([])
    expect(section.items.find(item => item.id === 'unit:api-billing')?.chips[0]?.label).toBe('13 pt')
  })

  test('no points on the issue: 5, nothing written, and Jira is not asked again within the hour', async () => {
    const t = asStage(world())
    const host = jiraHost(t, () => issue(null))
    const section = unitList(await load(t, host))
    expect(section.items.find(item => item.id === 'unit:api-billing')?.chips[0]?.label).toBe('5 pt, default')
    expect(host.writes).toEqual({})
    const ctx = ctxOf(t, s.ROOT, s.SESSION, OPTIONS, host)
    const detection = await aidlc.detect(ctx)
    await aidlc.load(ctx, detection!)
    expect(host.calls.filter(call => call[1] === 'getJiraIssue')).toHaveLength(1)
  })

  test('no Atlassian server in .mcp.json: every Unit without a row is 5, and nothing is asked', async () => {
    const t = world({ [`${s.ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: {} }) })
    const host = jiraHost(t, () => issue(13))
    const section = unitList(await load(t, host))
    expect(host.calls).toEqual([])
    expect(section.items.find(item => item.id === 'unit:api-billing')?.chips[0]?.label).toBe('5 pt, default')
  })

  test('Jira failing is the default, not an error', async () => {
    const t = world()
    const host: ProviderHost = { ...jiraHost(t, () => null), mcp: async () => { throw new Error('not connected') } }
    const model = await load(t, host)
    expect(unitList(model).items.find(item => item.id === 'unit:api-billing')?.chips[0]?.label).toBe('5 pt, default')
  })

  test('an uncommitted points file asks to be committed, under Needs attention', async () => {
    const t = world()
    const gate = (await load(t, jiraHost(t, () => issue(13), true))).gates.find(one => one.id === 'points-uncommitted')
    expect(gate?.title).toBe('unit-points.csv not committed')
    expect(gate?.isAttentionOnly).toBe(true)
    expect((await load(t, jiraHost(t, () => issue(13), false))).gates.some(one => one.id === 'points-uncommitted')).toBe(false)
  })

  test('a Unit listed more than once: the last row counts, and Needs attention names it', async () => {
    const t = world({ [POINTS_PATH]: `${POINTS}U1,13,human\n` })
    const model = await load(t, jiraHost(t, () => issue(13)))
    expect(unitList(model).items.find(item => item.id === 'unit:api-core')?.chips[0]?.label).toBe('13 pt')
    const gate = model.gates.find(one => one.id === 'points-repeated')
    expect(gate?.title).toBe('unit-points.csv lists a unit more than once')
    expect(gate?.caption).toBe('U1: the last row counts. Remove the rows that are out of date.')
    expect(gate?.isAttentionOnly).toBe(true)
  })

  test('an open gate on a per-unit stage hangs after the stage of the Unit this checkout claimed', async () => {
    const t = tree(stateText({ 'nfr-requirements': '?' }, ['- **Active Unit**: api-billing', '- **Unit State**: in-progress']), { [`${INTENT_DIR}/audit/host-a.md`]: shard })
    const model = await load(t)
    const gate = model.gates.find(one => one.id === 'awaiting:nfr-requirements')
    expect(gate?.sectionId).toBe('CONSTRUCTION')
    expect(gate?.afterItemId).toBe('nfr-requirements')
    expect(construction(model).items.find(item => item.id === 'nfr-requirements')?.status).toBe('awaiting')
  })

  test('with no Unit claimed, an open gate on a per-unit stage hangs after the Unit being worked', async () => {
    const t = tree(stateText({ 'nfr-requirements': '?' }), { [`${INTENT_DIR}/audit/host-a.md`]: shard })
    const gate = (await load(t)).gates.find(one => one.id === 'awaiting:nfr-requirements')
    expect(gate?.sectionId).toBe('CONSTRUCTION')
    expect(gate?.afterItemId).toBe('unit:api-billing')
  })

  test('before Units Generation has cut any, Construction keeps its stage rows and stage count', async () => {
    const t: VirtualTree = { files: { [s.paths.statePath]: stateText(), [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n` } }
    const model = await load(t)
    expect(construction(model).items.map(item => item.id)).toContain('code-generation')
    expect(model.overall.label).toBeUndefined()
  })

  test('until Units Generation has finished and made Units, Construction is not counted at all', async () => {
    const pending = stateText().replace('- [x] units-generation — EXECUTE', '- [ ] units-generation — EXECUTE')
    const t: VirtualTree = { files: { [s.paths.statePath]: pending, [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n` } }
    const model = await load(t)
    const section = construction(model)
    expect(section.isUncounted).toBe(true)
    expect(section.counts).toBeUndefined()
    expect(section.percent).toBeUndefined()
    // The rows are still listed, so the person sees what is coming; the plan counts only the other phases.
    expect(section.items.map(item => item.id)).toContain('code-generation')
    const others = model.sections.filter(one => one.id !== 'CONSTRUCTION').flatMap(one => one.items).filter(item => item.status !== 'skipped')
    expect(model.overall.counts.total).toBe(others.length)
  })

  test('once Units exist, Construction counts again, by its Units', async () => {
    const model = await load(tree(stateText()))
    expect(construction(model).isUncounted).toBeUndefined()
    expect(construction(model).counts?.total).toBe(6)
  })

  test('a skipped Units Generation leaves Construction counted by its stages', async () => {
    const skipped = stateText().replace('- [x] units-generation — EXECUTE', '- [S] units-generation — SKIP: one unit')
    const t: VirtualTree = { files: { [s.paths.statePath]: skipped, [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n` } }
    const section = construction(await load(t))
    expect(section.isUncounted).toBeUndefined()
    expect(section.counts?.total).toBe(7)
  })

  test('phases and stages are numbered by lifecycle (Initialization is 0), stages from 1: 3, and 3.6', async () => {
    const model = await load(tree(stateText()))
    expect(construction(model).ordinal).toBe('3')
    // This fixture lists only two phases; each keeps its place in the lifecycle.
    expect(model.sections.map(one => one.ordinal)).toEqual(['2', '3'])
    // The Units have no stage number; build-and-test is the sixth row of Construction.
    expect(construction(model).items.find(item => item.id === 'unit:api-core')?.ordinal).toBeUndefined()
    expect(construction(model).items.find(item => item.id === 'build-and-test')?.ordinal).toBe('3.6')
  })

  test('code-generation out of scope keeps the stage rows', async () => {
    const skipped = stateText().replace('- [ ] code-generation — EXECUTE', '- [S] code-generation — SKIP: no code')
    const section = construction(await load(tree(skipped)))
    expect(section.items.some(item => item.id.startsWith('unit:'))).toBe(false)
  })
})

describe('a Unit claimed at this checkout', () => {
  const shard = audit(
    ['2026-10-02T09:00:00Z', 'UNIT_COMPLETED', 'code-generation', 'api-core'],
    ['2026-10-02T10:00:00Z', 'UNIT_STARTED', 'functional-design', 'api-billing'],
    ['2026-10-02T11:00:00Z', 'UNIT_COMPLETED', 'functional-design', 'api-billing'],
    ['2026-10-02T12:00:00Z', 'UNIT_STARTED', 'nfr-requirements', 'api-billing'],
  )
  const world = (extra: string[] = ['- **Active Unit**: api-billing', '- **Unit State**: in-progress']) =>
    tree(stateText({}, extra), { [`${INTENT_DIR}/audit/host-a.md`]: shard, [POINTS_PATH]: POINTS, [`${s.ROOT}/.mcp.json`]: MCP_JSON })

  test("Construction is the claimed Unit's own walk through the per-unit stages", async () => {
    const t = world()
    const model = await load(t, jiraHost(t, () => issue(13)))
    const section = construction(model)
    expect(section.items.map(item => [item.id, item.ordinal, item.status, item.isCurrent])).toEqual([
      ['functional-design', '3.1', 'done', false],
      ['nfr-requirements', '3.2', 'open', true],
      ['nfr-design', '3.3', 'planned', false],
      ['infrastructure-design', '3.4', 'planned', false],
      ['code-generation', '3.5', 'planned', false],
    ])
    expect(section.titleTag).toBe('U3 api-billing')
    expect(section.caption).toBe('U3 api-billing, 13 pt: claimed at this checkout')
    expect(section.counts).toEqual({ done: 1, total: 5 })
    expect(section.percent).toBe(20)
    expect(section.ordinal).toBe('3')
    expect(section.isDetail).toBe(true)
    // Its stages are counted one each (1/5), with no points: the Unit's points are counted under Units.
    expect(section.countLabel).toBeUndefined()
    expect(section.items.map(item => item.points)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  test('every Unit, with the stages that run once, moves to a folded Units section that is no phase', async () => {
    const t = world()
    const model = await load(t, jiraHost(t, () => issue(13)))
    expect(model.sections.map(one => one.id).slice(-2)).toEqual(['CONSTRUCTION', 'UNITS'])
    const units = unitList(model)
    expect(units.title).toBe('Units')
    expect(units.ordinal).toBeUndefined()
    expect(units.isSupplement).toBe(true)
    expect(units.isCollapsed).toBe(true)
    expect(units.items.map(item => item.id)).toEqual(['unit:api-core', 'unit:web-shell', 'unit:api-billing', 'unit:web-billing', 'build-and-test', 'ci-pipeline'])
    expect(units.countLabel).toBe('8/31 pt')
    expect(units.sideCount).toBe('1/4 units')
  })

  test("the plan's percent is the same whether a Unit is claimed or not: it counts the Units, never the claimed one's stages", async () => {
    const claimed = world()
    const unclaimed = world([])
    const a = await load(claimed, jiraHost(claimed, () => issue(13)))
    const b = await load(unclaimed, jiraHost(unclaimed, () => issue(13)))
    expect(a.overall.percent).toBe(b.overall.percent)
    expect(a.overall.label).toBe(b.overall.label)
  })

  test('the Now card is on the claimed Unit\'s stage', async () => {
    const t = world()
    const model = await load(t, jiraHost(t, () => issue(13)))
    const first = model.sections.flatMap(one => one.items).find(item => item.isCurrent)
    expect(first?.id).toBe('nfr-requirements')
  })

  test('a fresh claim, with no receipt yet: the workflow\'s Current Stage is the claimed Unit\'s, and the Now card is on it', async () => {
    const fresh = tree(stateText({}, ['- **Active Unit**: web-billing', '- **Unit State**: in-progress']).replace('- **Current Stage**: code-generation', '- **Current Stage**: functional-design'), {
      [`${INTENT_DIR}/audit/host-a.md`]: shard,
      [POINTS_PATH]: POINTS,
      [`${s.ROOT}/.mcp.json`]: MCP_JSON,
    })
    const model = await load(fresh, jiraHost(fresh, () => issue(13)))
    const section = construction(model)
    expect(section.titleTag).toBe('U4 web-billing')
    expect(section.items.map(item => [item.id, item.status, item.isCurrent])).toEqual([
      ['functional-design', 'open', true],
      ['nfr-requirements', 'planned', false],
      ['nfr-design', 'planned', false],
      ['infrastructure-design', 'planned', false],
      ['code-generation', 'planned', false],
    ])
    expect(section.counts).toEqual({ done: 0, total: 5 })
    expect(model.sections.flatMap(one => one.items).find(item => item.isCurrent)?.id).toBe('functional-design')
  })

  test('a paused Unit says so on its stage', async () => {
    const t = world(['- **Active Unit**: api-billing', '- **Unit State**: paused'])
    const item = construction(await load(t, jiraHost(t, () => issue(13)))).items.find(one => one.id === 'nfr-requirements')
    expect(item?.status).toBe('open')
    expect(item?.statusWord).toBe('paused')
  })

  test('no Active Unit: Construction keeps the Units, counted by story points, and there is no Units section', async () => {
    const t = world([])
    const model = await load(t, jiraHost(t, () => issue(13)))
    expect(model.sections.some(one => one.id === 'UNITS')).toBe(false)
    const section = construction(model)
    expect(section.items[0]?.id).toBe('unit:api-core')
    expect(section.countLabel).toBe('8/31 pt')
    expect(section.sideCount).toBe('1/4 units')
    expect(section.titleTag).toBeUndefined()
  })

  test('an Active Unit that is none of the Units claims nothing', async () => {
    const t = world(['- **Active Unit**: not-a-unit'])
    const model = await load(t, jiraHost(t, () => issue(13)))
    expect(model.sections.some(one => one.id === 'UNITS')).toBe(false)
  })
})

describe('unitStageStatuses', () => {
  const at = (phase: UnitProgress['phase'], stage: string) => [...unitStageStatuses({ phase, stage }).values()]
  test('before the stage done, the stage itself active or paused, after it planned', () => {
    expect(at('active', 'nfr-design')).toEqual(['done', 'done', 'active', 'planned', 'planned'])
    expect(at('paused', 'nfr-design')).toEqual(['done', 'done', 'paused', 'planned', 'planned'])
    expect(at('between', 'nfr-design')).toEqual(['done', 'done', 'done', 'planned', 'planned'])
  })
  test('built is all done; not started, or a stage it does not name, all planned', () => {
    expect(at('done', '')).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(at('planned', '')).toEqual(['planned', 'planned', 'planned', 'planned', 'planned'])
    expect(at('active', 'unknown-stage')).toEqual(['planned', 'planned', 'planned', 'planned', 'planned'])
  })
})

describe('a park the engine left behind, and a running stage', () => {
  const parkedLines = ['- **Parked**: 2026-10-02T11:30:00Z', '- **Parked At Stage**: nfr-requirements', '- **Parked By**: person']
  const claimed = ['- **Active Unit**: api-billing', '- **Unit State**: in-progress']
  // A stage session (bound): a side job names no Next whatever the state says.
  const world = (rows: [string, string, string, string][], extra: string[] = []) =>
    asStage(tree(stateText({}, [...parkedLines, ...claimed, ...extra]), { [`${INTENT_DIR}/audit/host-a.md`]: audit(...rows), [POINTS_PATH]: POINTS }))

  test('parked, and nothing started since: the gate stands and Next resumes', async () => {
    const model = await load(world([['2026-10-02T10:00:00Z', 'UNIT_STARTED', 'nfr-requirements', 'api-billing']]))
    expect(model.gates.some(gate => gate.kind === 'parked')).toBe(true)
    expect(model.next?.command).toBe('/aidlc')
  })

  test('a Unit stage started after the park: the park is over, and a running stage names no Next', async () => {
    const model = await load(world([['2026-10-02T12:00:00Z', 'UNIT_STARTED', 'nfr-requirements', 'api-billing']]))
    expect(model.gates.some(gate => gate.kind === 'parked')).toBe(false)
    expect(model.sections.flatMap(one => one.items).find(item => item.isCurrent)?.id).toBe('nfr-requirements')
    expect(model.next).toBeUndefined()
  })

  test('isResumedAfter: unparked, a stage or a Unit started later ends it; an earlier one, or another event, does not', () => {
    const shard = (event: string, at: string) => ['## X', `**Timestamp**: ${at}`, `**Event**: ${event}`, ''].join('\n')
    const since = '2026-10-02T11:30:00Z'
    expect(isResumedAfter(shard('WORKFLOW_UNPARKED', '2026-10-02T11:31:00Z'), since)).toBe(true)
    expect(isResumedAfter(shard('STAGE_STARTED', '2026-10-02T12:00:00Z'), since)).toBe(true)
    expect(isResumedAfter(shard('UNIT_STARTED', '2026-10-02T11:00:00Z'), since)).toBe(false)
    expect(isResumedAfter(shard('ARTIFACT_CREATED', '2026-10-02T12:00:00Z'), since)).toBe(false)
    expect(isResumedAfter(shard('STAGE_STARTED', '2026-10-02T12:00:00Z'), 'not a time')).toBe(false)
  })
})
