// The AI-DLC provider's load: workspace in, provider-neutral PanelModel out.
import { test, expect, describe } from 'claude-code/testing'
import { aidlc } from '../src/providers/aidlc'
import { formatWhen } from '../src/providers/aidlc/load'
import * as real from '../fixtures/real-sample'
import * as s from '../fixtures/scenarios'
import type { VirtualTree } from '../fixtures/virtual'
import type { PanelModel, PanelOptions } from '../types'
import { NOW, OPTIONS, ctxOf, mockHost } from './world'

async function load(tree: VirtualTree, startDir: string, sessionId: string, options: PanelOptions = OPTIONS): Promise<PanelModel> {
  const ctx = ctxOf(tree, startDir, sessionId, options)
  const detection = await aidlc.detect(ctx)
  if (!detection) throw new Error('expected a detection')
  return aidlc.load(ctx, detection)
}

const section = (model: PanelModel, id: string) => {
  const found = model.sections.find(one => one.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}

/** A state file shaped like the engine writes it, with a parked marker. */
function parkedTree(at: string, since: string, phases: Parameters<typeof s.stateOf>[0] = {}): VirtualTree {
  const state = s.stateOf({ parked: { at, since }, ...phases })
  return { files: { [s.paths.statePath]: state, [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n` } }
}

describe('detect', () => {
  test('a hit carries the root and the workspace', async () => {
    const detection = await aidlc.detect(ctxOf(real.tree, `${real.ROOT}/aidlc`, real.sessions.live))
    expect(detection?.provider).toBe('aidlc')
    expect(detection?.root).toBe(real.ROOT)
    expect(detection?.detail).toEqual({
      workspace: { root: real.ROOT, aidlcDir: `${real.ROOT}/aidlc`, engineMarkers: ['.claude/tools/aidlc.ts', '.claude/rules/aidlc.md'] },
    })
  })

  test('a miss is null', async () => {
    expect(await aidlc.detect(ctxOf(s.v1Only, '/work/legacy', 'x'))).toBeNull()
  })

  test('never throws, even over a tree that does', async () => {
    const ctx = ctxOf(real.tree, real.ROOT, 'x')
    const broken = { ...ctx, fsx: { ...ctx.fsx, exists: async () => { throw new Error('boom') } } }
    expect(await aidlc.detect(broken)).toBeNull()
  })

  test('load re-detects when handed a bare detection', async () => {
    const ctx = ctxOf(real.tree, real.ROOT, real.sessions.live)
    const model = await aidlc.load(ctx, { provider: 'aidlc', root: real.ROOT, detail: {} })
    expect(model.header.title).toBe('shop-mvp-restart')
  })
})

describe('real sample, bound session on its stage branch', () => {
  test('envelope and header', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.version).toBe(2)
    expect(model.provider).toBe('aidlc')
    expect(model.root).toBe(real.ROOT)
    expect(model.readAt).toBe(NOW)
    expect(model.header).toEqual({
      title: 'shop-mvp-restart',
      mode: 'stage',
      subtitle: 'Inception · domain-design',
      badge: '',
      caption: '',
      updatedAt: '2026-09-04T01:19:27Z',
    })
    expect(model.drift).toEqual([])
  })

  test('next is /aidlc with the Next Action as the reason', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.next).toEqual({ command: '/aidlc', reason: 'Execute Domain Design' })
  })

  test('no Next Action, no next', async () => {
    const tree: VirtualTree = { files: { ...s.construction.files } }
    tree.files[s.paths.statePath] = (tree.files[s.paths.statePath] ?? '').replace('- **Next Action**: Execute the current stage', '- **Next Action**:')
    expect((await load(tree, s.ROOT, s.SESSION)).next).toBeUndefined()
  })

  test('sections: status, percent and done/total over executed stages only', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.sections.map(one => [one.id, one.title, one.status, one.counts, one.percent])).toEqual([
      ['INITIALIZATION', 'Initialization', 'built', { done: 3, total: 3 }, 100],
      ['IDEATION', 'Ideation', 'built', { done: 4, total: 4 }, 100],
      ['INCEPTION', 'Inception', 'active', { done: 4, total: 8 }, 50],
      // units-generation is not done: Construction has no size yet, so it carries no count or ring.
      ['CONSTRUCTION', 'Construction', 'planned', undefined, undefined],
      ['OPERATION', 'Operation', 'skipped', { done: 0, total: 0 }, undefined],
    ])
    expect(section(model, 'CONSTRUCTION').caption).toBeUndefined() // Per unit: [TBD]
  })

  test('items: id and title are the slug; skipped rows stay, unexecuted', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    const inception = section(model, 'INCEPTION')
    expect(inception.items.map(one => [one.id, one.title, one.status])).toEqual([
      ['reverse-engineering', 'reverse-engineering', 'skipped'],
      ['practices-discovery', 'practices-discovery', 'done'],
      ['requirements-analysis', 'requirements-analysis', 'done'],
      ['user-stories', 'user-stories', 'done'],
      ['refined-mockups', 'refined-mockups', 'done'],
      ['domain-design', 'domain-design', 'open'],
      ['units-generation', 'units-generation', 'planned'],
      ['contract-design', 'contract-design', 'planned'],
      ['delivery-planning', 'delivery-planning', 'planned'],
    ])
    expect(section(model, 'IDEATION').items.find(one => one.id === 'market-research')?.status).toBe('skipped')
    expect(section(model, 'OPERATION').items.every(one => one.status === 'skipped')).toBe(true)
    expect(model.sections.flatMap(one => one.items).every(one => one.chips.length === 0)).toBe(true)
  })

  test('the stale directive is ignored: only domain-design is current', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    const current = model.sections.flatMap(one => one.items.filter(item => item.isCurrent).map(item => item.id))
    expect(current).toEqual(['domain-design'])
  })

  test('fold defaults: the active section opens, the rest fold', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.sections.map(one => [one.id, one.isCollapsed])).toEqual([
      ['INITIALIZATION', true],
      ['IDEATION', true],
      ['INCEPTION', false],
      ['CONSTRUCTION', true],
      ['OPERATION', true],
    ])
  })

  test('overall counts executed items by status, percent over them', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    // Construction's seven stages are not counted until Units Generation has made Units: 15 stages, 11 done.
    expect(model.overall).toEqual({ percent: 73, counts: { done: 11, open: 1, planned: 3, total: 15 } })
  })

  test('the Parked fields make one parked gate right after domain-design, date formatted', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.gates).toEqual([
      {
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: 'Parked at domain-design',
        caption: 'The workflow was parked 2026-09-04 01:19. Resume it with /aidlc.',
        sectionId: 'INCEPTION',
        afterItemId: 'domain-design',
      },
    ])
  })

  test('watch lists the state, the directive, the binding, the cursor, the space file, the intent directory, its stage points and aidlc', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    const intent = `${real.ROOT}/aidlc/spaces/default/intents/${real.LIVE_INTENT}`
    expect(model.watch).toEqual([
      `${intent}/aidlc-state.md`,
      `${intent}/.aidlc-engine/active-directive.json`,
      `${real.ROOT}/aidlc/.aidlc-sessions/${real.sessions.live}.binding.json`,
      `${real.ROOT}/aidlc/spaces/default/intents/active-intent`,
      `${real.ROOT}/aidlc/active-space`,
      intent,
      `${intent}/stage-story-points.txt`,
      `${real.ROOT}/aidlc/.aidlc-unit-scope.json`,
      `${real.ROOT}/aidlc`,
    ])
  })

  test('the model is plain data: it survives a JSON round trip', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(JSON.parse(JSON.stringify(model))).toEqual(model)
  })

  test('with no git, load is 0.6.0\'s: the host is asked where the repository is, and nothing else', async () => {
    const host = mockHost()
    await aidlc.load(ctxOf(real.tree, real.ROOT, real.sessions.live, OPTIONS, host), {
      provider: 'aidlc',
      root: real.ROOT,
      detail: {},
    })
    expect(host.runs).toEqual([['git', '-C', real.ROOT, 'rev-parse', '--show-toplevel']])
  })

  test('with no git, no item carries a landing, a statusWord or a group, and the header has no base', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.live)
    expect(model.header).not.toHaveProperty('base')
    for (const item of model.sections.flatMap(one => one.items)) {
      expect(item).not.toHaveProperty('landing')
      expect(item).not.toHaveProperty('statusWord')
      expect(item).not.toHaveProperty('group')
    }
    expect(model.gates.map(gate => gate.kind)).toEqual(['parked'])
  })
})

describe('modes over the real sample', () => {
  test('an unbound session is a side job on the cursor intent', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.empty)
    expect(model.header.mode).toBe('side-job')
    expect(model.header.badge).toBe('Side job')
    expect(model.header.title).toBe('shop-mvp-restart')
    expect(model.header.caption).toBe(
      'This session is not bound to a stage of shop-mvp-restart. Progress below is the intent the workspace points at.',
    )
    expect(model.sections.length).toBe(5)
  })

  test('bound: a stage session whatever the branch pattern says', async () => {
    for (const stageBranchPattern of ['^never/', '', '(']) {
      const model = await load(real.tree, real.ROOT, real.sessions.live, { ...OPTIONS, stageBranchPattern })
      expect(model.header.mode).toBe('stage')
    }
  })

  test('bound and on main: still a stage session', async () => {
    const onMain: VirtualTree = { files: { ...real.tree.files, [`${real.ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n' } }
    expect((await load(onMain, real.ROOT, real.sessions.live)).header.mode).toBe('stage')
  })
})

describe('idle', () => {
  // upstream readSessionBinding: bound to an archived intent -> hidden, no workflow.
  test('a session bound to the archived intent is idle with the archived caption and no sections', async () => {
    const model = await load(real.tree, real.ROOT, real.sessions.archived)
    expect(model.header).toEqual({
      title: 'AI-DLC',
      mode: 'idle',
      subtitle: '',
      badge: 'Idle',
      caption: 'This session was bound to an intent that has since been archived, so it shows no workflow.',
      updatedAt: '',
    })
    expect(model.sections).toEqual([])
    expect(model.gates).toEqual([])
    expect(model.next).toBeUndefined()
    expect(model.overall).toEqual({ counts: { total: 0 } })
    // The binding file is still watched: archiving or rebinding changes it.
    expect(model.watch).toContain(`${real.ROOT}/aidlc/.aidlc-sessions/${real.sessions.archived}.binding.json`)
  })

  test('intent:null with source "archive" is idle too', async () => {
    const tree = {
      files: {
        ...real.tree.files,
        [`${real.ROOT}/aidlc/.aidlc-sessions/gone.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x', source: 'archive' }),
      },
    }
    const model = await load(tree, real.ROOT, 'gone')
    expect([model.header.mode, model.header.caption, model.sections]).toEqual([
      'idle',
      'This session was bound to an intent that has since been archived, so it shows no workflow.',
      [],
    ])
  })

  test('intent:null (not archive) is a side job on the binding space', async () => {
    const tree = {
      files: {
        ...s.otherSpace.files,
        [`${s.ROOT}/aidlc/.aidlc-sessions/n.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x' }),
      },
    }
    const model = await load(tree, s.ROOT, 'n')
    expect(model.header.mode).toBe('side-job')
    expect(model.header.title).toBe('checkout-flow') // the default space's intent, not platform's `ci`
  })

  test('two live intents and no cursor: idle, with the "none selected" caption', async () => {
    const model = await load(s.twoIntentsNoCursor, s.ROOT, s.SESSION)
    expect(model.header.mode).toBe('idle')
    expect(model.header.caption).toBe('This workspace has more than one live intent and none is selected. Pick one with /aidlc.')
    expect(model.sections).toEqual([])
    expect(model.gates).toEqual([])
  })

  test('only archived intents: idle, nothing in flight', async () => {
    const model = await load(s.allArchived, s.ROOT, s.SESSION)
    expect([model.header.mode, model.header.caption]).toEqual(['idle', 'This workspace has no intent in flight. Start one with /aidlc.'])
  })

  test('an engine-only workspace has no intent either', async () => {
    const model = await load(s.engineOnly, s.ROOT, s.SESSION)
    expect([model.header.mode, model.header.caption]).toEqual(['idle', 'This workspace has no intent in flight. Start one with /aidlc.'])
  })
})

describe('shown step', () => {
  test('Unit Stage wins over Current Stage', async () => {
    const model = await load(s.construction, s.ROOT, s.SESSION)
    expect(model.header.subtitle).toBe('Construction · code-generation')
    expect(section(model, 'CONSTRUCTION').items.map(one => one.isCurrent)).toEqual([false, true, false])
    expect(section(model, 'CONSTRUCTION').caption).toBe('per unit: [billing, auth]')
  })

  test('a fresher directive overrides Current Stage and carries the unit', async () => {
    const model = await load(s.freshDirective, s.ROOT, s.SESSION)
    expect(model.header.subtitle).toBe('Inception · unit billing · domain-design')
    expect(section(model, 'INCEPTION').items.filter(one => one.isCurrent).map(one => one.id)).toEqual(['domain-design'])
  })

  test('Unit Stage still beats a fresher directive', async () => {
    const tree: VirtualTree = { files: { ...s.freshDirective.files }, mtimes: s.freshDirective.mtimes ?? {} }
    tree.files[s.paths.statePath] = (tree.files[s.paths.statePath] ?? '').replace('- **Revision Count**: 3', '- **Revision Count**: 3\n- **Unit Stage**: user-stories')
    expect((await load(tree, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · user-stories')
  })

  test('a directive written in the same instant as the state still counts', async () => {
    expect((await load(s.simultaneousDirective, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · domain-design')
  })

  test('superseded, stale and hostile directives are ignored', async () => {
    for (const tree of [s.supersededDirective, s.staleDirective, s.hostileDirective]) {
      expect((await load(tree, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · user-stories')
    }
  })

  test('a hostile unit name is dropped but the stage is kept', async () => {
    expect((await load(s.hostileUnitDirective, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · domain-design')
  })

  test('a malformed directive file falls back to Current Stage', async () => {
    const tree: VirtualTree = { files: { ...s.freshDirective.files }, mtimes: s.freshDirective.mtimes ?? {} }
    tree.files[s.paths.directivePath] = '{not json'
    expect((await load(tree, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · user-stories')
    tree.files[s.paths.directivePath] = 'null'
    expect((await load(tree, s.ROOT, s.SESSION)).header.subtitle).toBe('Inception · user-stories')
  })

  test('a status other than Running is appended to the subtitle', async () => {
    const model = await load(s.nested, s.NESTED_START, s.SESSION)
    expect(model.header.subtitle).toBe('Inception · domain-design · Completed')
  })
})

describe('gates', () => {
  test('[?] stages become awaiting-approval gates after their own item; [R] does not', async () => {
    const model = await load(s.gates, s.ROOT, s.SESSION)
    expect(model.gates).toEqual([
      {
        id: 'awaiting:user-stories',
        kind: 'awaiting-approval',
        tone: 'warning',
        title: 'user-stories awaits your approval',
        caption: 'The gate is open: approve or request changes to move on.',
        sectionId: 'INCEPTION',
        afterItemId: 'user-stories',
      },
    ])
    expect(section(model, 'INCEPTION').items.map(one => one.status)).toEqual(['done', 'awaiting', 'revising', 'skipped'])
  })

  test('markers on a SKIP row are not gates, and do not count toward totals', async () => {
    const inception = section(await load(s.gates, s.ROOT, s.SESSION), 'INCEPTION')
    expect(inception.counts).toEqual({ done: 1, total: 3 })
    expect(inception.percent).toBe(33)
  })

  test('parked in another section puts the gate there and keeps that section open', async () => {
    const model = await load(s.parkedElsewhere, s.ROOT, s.SESSION)
    expect(model.gates.map(gate => [gate.sectionId, gate.afterItemId, gate.title])).toEqual([
      ['INCEPTION', 'requirements-analysis', 'Parked at requirements-analysis'],
    ])
    expect(model.gates[0]?.caption).toBe('The workflow was parked 2026-09-02 02:47.')
    expect(section(model, 'INCEPTION').status).toBe('built')
    expect(section(model, 'INCEPTION').isCollapsed).toBe(false)
    expect(section(model, 'CONSTRUCTION').isCollapsed).toBe(false)
  })

  test('parked with no stage sits at the top of the section holding the current stage', async () => {
    const model = await load(s.parkedNoStage, s.ROOT, s.SESSION)
    expect(model.gates).toEqual([
      {
        id: 'parked',
        kind: 'parked',
        tone: 'warning',
        title: 'Parked',
        caption: 'The workflow was parked 2026-09-02 02:47.',
        sectionId: 'INCEPTION',
      },
    ])
  })

  test('parked at an unknown stage is never dropped: current section, else active, else first', async () => {
    const phases = {
      progress: { Ideation: 'Verified', Inception: 'Active' },
      phases: { IDEATION: ['- [x] intent-capture — EXECUTE'], INCEPTION: ['- [x] requirements-analysis — EXECUTE', '- [ ] user-stories — EXECUTE'] },
    }
    // The current stage lives in IDEATION, which is not the active section.
    const holdsCurrent = await load(parkedTree('ghost', '2026-09-02T02:47:00Z', { ...phases, current: 'intent-capture' }), s.ROOT, s.SESSION)
    expect(holdsCurrent.gates.map(gate => [gate.title, gate.sectionId, gate.afterItemId])).toEqual([['Parked', 'IDEATION', undefined]])
    // No current stage anywhere: the active section.
    const active = await load(parkedTree('ghost', '2026-09-02T02:47:00Z', { ...phases, current: 'nowhere' }), s.ROOT, s.SESSION)
    expect(active.gates.map(gate => gate.sectionId)).toEqual(['INCEPTION'])
    // Nothing active either: the first section.
    const first = await load(
      parkedTree('ghost', '2026-09-02T02:47:00Z', { current: 'nowhere', progress: { Ideation: 'Verified', Inception: 'Verified' }, phases: phases.phases }),
      s.ROOT,
      s.SESSION,
    )
    expect(first.gates.map(gate => gate.sectionId)).toEqual(['IDEATION'])
  })

  test('a parked gate with no sections at all is still in the model', async () => {
    const model = await load(parkedTree('x', '2026-09-02T02:47:00Z'), s.ROOT, s.SESSION)
    expect(model.sections).toEqual([])
    expect(model.gates.map(gate => [gate.title, gate.sectionId])).toEqual([['Parked', '']])
  })

  test('a section holding a gate is open even when it is not active', async () => {
    const model = await load(s.parkedElsewhere, s.ROOT, s.SESSION)
    expect(section(model, 'INCEPTION').status).toBe('built')
    expect(section(model, 'INCEPTION').isCollapsed).toBe(false)
  })

  test('no Parked field, no gate', async () => {
    expect((await load(s.construction, s.ROOT, s.SESSION)).gates).toEqual([])
  })

  test('formatWhen: UTC, to the minute; whatever does not parse stays as written', () => {
    expect(formatWhen('2026-09-04T01:19:27Z')).toBe('2026-09-04 01:19')
    expect(formatWhen('2026-09-02T04:47:00+02:00')).toBe('2026-09-02 02:47')
    expect(formatWhen('2026-09-02')).toBe('2026-09-02')
    expect(formatWhen('yesterday')).toBe('yesterday')
    expect(formatWhen('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z')
    expect(formatWhen('')).toBe('')
  })
})

describe('fold and status defaults', () => {
  test('a built section with no current stage folds; the section holding the current stage opens even when not active', async () => {
    const model = await load(s.gates, s.ROOT, s.SESSION)
    expect(model.sections.map(one => [one.id, one.status, one.isCollapsed])).toEqual([
      ['IDEATION', 'built', true],
      ['INCEPTION', 'active', false],
      ['CONSTRUCTION', 'planned', true],
    ])
    const tree: VirtualTree = { files: { ...s.construction.files } }
    tree.files[s.paths.statePath] = (tree.files[s.paths.statePath] ?? '').replace('**Construction**: Active', '**Construction**: Pending')
    const pending = section(await load(tree, s.ROOT, s.SESSION), 'CONSTRUCTION')
    expect(pending.isCollapsed).toBe(false)
    // Some done, some not, and not active: partial.
    expect(pending.status).toBe('partial')
    expect(pending.counts).toEqual({ done: 1, total: 3 })
  })

  test('a phase missing from Phase Progress is planned', async () => {
    const tree: VirtualTree = { files: { ...s.construction.files } }
    tree.files[s.paths.statePath] = (tree.files[s.paths.statePath] ?? '').replace(/- \*\*Inception\*\*: Verified\n/, '')
    expect(section(await load(tree, s.ROOT, s.SESSION), 'INCEPTION').status).toBe('planned')
  })

  test('an active section with some done stays active, not partial', async () => {
    const model = await load(s.construction, s.ROOT, s.SESSION)
    expect(section(model, 'CONSTRUCTION').status).toBe('active')
  })
})

describe('layout cases', () => {
  test('a session deep below the workspace root', async () => {
    const model = await load(s.nested, s.NESTED_START, s.SESSION)
    expect(model.root).toBe('/work/mono')
    expect(model.header.mode).toBe('side-job') // on `main`, not a stage branch
  })

  test('a git worktree reports its own branch and, bound, is on a stage branch', async () => {
    const model = await load(s.worktreeWithWorkspace, `${s.WORKTREE_ROOT}/src`, 'wt')
    expect(model.header.mode).toBe('stage')
    expect(model.header.badge).toBe('')
  })

  test('a state file with no stage rows yields a model with no sections', async () => {
    const tree: VirtualTree = { files: { ...s.construction.files } }
    tree.files[s.paths.statePath] = '# AI-DLC State Tracking\n'
    const model = await load(tree, s.ROOT, s.SESSION)
    expect(model.header.mode).toBe('side-job')
    expect(model.sections).toEqual([])
    expect(model.header.title).toBe('checkout-flow')
    expect(model.header.subtitle).toBe('')
    expect(model.overall).toEqual({ counts: { total: 0 } })
  })

  test('a phase the sheet has no label for is title-cased from its key', async () => {
    const tree: VirtualTree = { files: { ...s.construction.files } }
    tree.files[s.paths.statePath] = (tree.files[s.paths.statePath] ?? '').replace('### CONSTRUCTION PHASE', '### DISCOVERY PHASE')
    expect(model_titles(await load(tree, s.ROOT, s.SESSION))).toContain('Discovery')
  })
})

const model_titles = (model: PanelModel) => model.sections.map(one => one.title)
