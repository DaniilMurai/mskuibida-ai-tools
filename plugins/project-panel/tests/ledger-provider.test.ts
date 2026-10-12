// The ledger provider end to end over a scripted git/gh/model world.
import { describe, expect, test } from 'claude-code/testing'
import { buildModel, runAction } from '../src/model'
import { ledger } from '../src/providers/ledger'
import { aidlc } from '../src/providers/aidlc'
import { parseLedger } from '../src/providers/ledger/parse'
import { chipsOf } from '../src/providers/ledger/view'
import { en } from '../src/strings/en'
import * as checkbox from '../fixtures/ledger/checkbox'
import * as rem from '../fixtures/ledger/reminders'
import * as fsv from '../fixtures/ledger/field-service'
import * as real from '../fixtures/real-sample'
import { item, pr } from './ledger/helpers'
import { matchPrs } from '../src/providers/ledger/match'
import type { Detection, PanelModel } from '../types'
import { ARCH, REM_TRACKED, PROPOSAL, REPO, REPO_URL, assignAll, deliveryWorld, itemOf, remWorld, load, scripted, section, withUrls, world } from './ledger-world'
import type { Replies, World } from './ledger-world'
import { ctxOf } from './world'

const PHASE = 'phase-1-5-task-management-in-telegram'

describe('detect', () => {
  test('a tracked WORKPLAN.md is a hit, with the path and how it was found', async () => {
    const s = scripted(remWorld())
    expect(await ledger.detect(s.ctx)).toEqual({ provider: 'ledger', root: REPO, detail: { ledgerPath: 'WORKPLAN.md', via: 'discovered' } })
  })

  test('docs/DELIVERY.md task-ledger wins', async () => {
    const w = remWorld({
      tracked: [...REM_TRACKED, 'docs/DELIVERY.md', 'notes/LEDGER.md'],
      files: { 'WORKPLAN.md': rem.ledgerText, 'docs/DELIVERY.md': '---\ntask-ledger: notes/LEDGER.md\n---\n', 'notes/LEDGER.md': checkbox.ledgerText },
    })
    expect((await ledger.detect(scripted(w).ctx))?.detail).toEqual({ ledgerPath: 'notes/LEDGER.md', via: 'delivery' })
  })

  test('outside a git repository there is no plan', async () => {
    expect(await ledger.detect(scripted(remWorld({ isRepo: false })).ctx)).toBeNull()
  })

  test('a WORKPLAN.md that git does not track is never read and never detected', async () => {
    const w = remWorld({ tracked: ['README.md', 'src/index.ts'] })
    const s = scripted(w)
    expect(await ledger.detect(s.ctx)).toBeNull()
    expect(s.reads).toEqual([])
  })

  test('a repo with no ledger-shaped file is a miss', async () => {
    const w = world({ tracked: ['README.md'], files: { 'README.md': '# Shop' } })
    expect(await ledger.detect(scripted(w).ctx)).toBeNull()
  })

  test('.env and *.local are never read, even when tracked or named by DELIVERY.md', async () => {
    const w = remWorld({
      tracked: [...REM_TRACKED, '.env', 'PROGRESS.local', 'docs/DELIVERY.md'],
      files: {
        'WORKPLAN.md': rem.ledgerText,
        '.env': 'SECRET=1',
        'PROGRESS.local': rem.ledgerText,
        'docs/DELIVERY.md': '---\ntask-ledger: PROGRESS.local\n---\n',
      },
    })
    const s = scripted(w)
    const detection = await ledger.detect(s.ctx)
    expect(detection?.detail).toEqual({ ledgerPath: 'WORKPLAN.md', via: 'discovered' })
    expect(s.reads.some(p => p.endsWith('.env') || p.endsWith('.local'))).toBe(false)
  })

  test('detect never throws: a host that throws is a miss', async () => {
    const s = scripted(remWorld())
    const broken = { ...s.ctx, host: { ...s.ctx.host, run: async () => { throw new Error('spawn failed') } } }
    expect(await ledger.detect(broken)).toBeNull()
  })

  test('detect is cheap: no network calls', async () => {
    const s = scripted(remWorld())
    await ledger.detect(s.ctx)
    expect(s.host.runs.map(argv => argv.join(' ')).filter(line => line.startsWith('gh ') || line.includes(' fetch '))).toEqual([])
  })
})

describe('provider order', () => {
  test('AI-DLC keeps priority when both plans exist', async () => {
    const tree = { files: { ...real.tree.files, [`${real.ROOT}/WORKPLAN.md`]: rem.ledgerText } }
    const w = world({ root: real.ROOT, startDir: real.ROOT, tracked: ['WORKPLAN.md'], files: { 'WORKPLAN.md': rem.ledgerText } })
    const ctx = { ...ctxOf(tree, real.ROOT, real.sessions.live), host: scripted(w).host }
    const model = await buildModel(ctx)
    expect(model?.provider).toBe('aidlc')
    expect(await ledger.detect(ctx)).not.toBeNull()
    expect(await aidlc.detect(ctx)).not.toBeNull()
  })

  test('the ledger builds the model when AI-DLC has no workspace', async () => {
    const s = scripted(remWorld())
    expect((await buildModel(s.ctx))?.provider).toBe('ledger')
  })
})

describe('the model: reminders', () => {
  test('envelope, header, overall', async () => {
    const { model } = await load(remWorld(), { sonnet: PROPOSAL })
    expect(model.version).toBe(2)
    expect(model.provider).toBe('ledger')
    expect(model.root).toBe(REPO)
    expect(model.header.title).toBe('Workplan')
    expect(model.header.subtitle).toMatch(/^WORKPLAN\.md · \d+\/23 done$/)
    expect(model.header.updatedAt).toBe('')
    expect(model.readAt).toBe(1_800_000_000_000)
    expect(model.gates).toEqual([])
    expect(model.freshness).toBeUndefined()
    expect(model.overall.percent).toBeGreaterThan(50)
    expect(model.overall.counts.total).toBe(23)
    expect(model.overall.counts.failed).toBe(1)
  })

  test('the title falls back to the repo name when the ledger has none', async () => {
    const text = ['## Phase', '- [ ] one', '- [ ] two', '- [ ] three', '- [ ] four', '- [ ] five'].join('\n')
    const { model } = await load(world({ tracked: ['TODO.md'], files: { 'TODO.md': text }, remote: { 'TODO.md': text } }), {})
    expect(model.header.title).toBe('shop')
  })

  test('sections are the phases; the active one is open, the rest collapsed', async () => {
    const { model } = await load(remWorld(), { sonnet: PROPOSAL })
    const phases = model.sections.filter(sec => sec.isProposed !== true)
    expect(phases.map(sec => sec.id)).toEqual([PHASE, 'process'])
    expect(phases.map(sec => sec.title)).toEqual(['Phase 1.5 — Task management in Telegram', 'Process'])
    expect(section(model, PHASE).isCollapsed).toBe(false)
    expect(section(model, 'process').isCollapsed).toBe(true)
    expect(section(model, 'process')).toMatchObject({ status: 'built', percent: 100, counts: { done: 2, total: 2 } })
    expect(section(model, PHASE).status).toBe('active')
    expect(section(model, PHASE).counts?.total).toBe(21)
  })

  test('mode: inferred while work is in flight, idle when nothing is, stage on an item branch', async () => {
    expect((await load(remWorld(), {})).model.header.mode).toBe('inferred')
    const quiet = remWorld({ prs: withUrls(rem.prs.filter(p => p.number !== 67 && p.number !== 70)) })
    const idle = (await load(quiet, {})).model
    expect(idle.header.mode).toBe('idle')
    expect(idle.header.badge).toBe(en['header.badge.idle'])
    const staged = (await load(remWorld({ branch: 'feat/T04-act-buttons' }), {})).model
    expect(staged.header.mode).toBe('stage')
    expect(staged.header.badge).toBe('')
    expect(itemOf(staged, 'T04').isCurrent).toBe(true)
    expect(itemOf(staged, 'T03').isCurrent).toBe(false)
  })

  test('items: status, titles, chips with links, and the ledger line as the fallback link', async () => {
    const { model } = await load(remWorld(), {})
    expect(itemOf(model, 'T03')).toMatchObject({
      title: 'Browse',
      status: 'done',
      chips: [{ kind: 'pr', label: '#35', tone: 'success', href: `${REPO_URL}/pull/35` }],
      href: `${REPO_URL}/pull/35`,
    })
    expect(itemOf(model, 'T04')).toMatchObject({ status: 'open', chips: [{ kind: 'pr', label: '#67', tone: 'accent' }] })
    expect(itemOf(model, 'T05')).toMatchObject({ status: 'failed', chips: [{ kind: 'pr', label: '#70', tone: 'error' }] })
    const line = parseLedger(rem.ledgerText).items.find(i => i.id === 'T13c')?.line
    expect(itemOf(model, 'T13c').href).toBe(`${REPO_URL}/blob/main/WORKPLAN.md#L${line}`)
    expect(itemOf(model, 'T13c').chips.map(c => c.label)).toEqual(['#68'])
    expect(itemOf(model, 'T12').chips.map(c => c.label)).toEqual(['#55', 'revert #69'])
    expect(itemOf(model, 'T21').chips.map(c => c.label)).toEqual(['#51', '#49'])
  })

  test('next: the first free planned task, with a command that reads like an instruction', async () => {
    const { model } = await load(remWorld(), {})
    expect(model.next?.command).toBe('start T06 — Slash commands, settings, stats, help')
    expect(model.next?.reason).toBe('depends on T01a, T02, T03, T08, all done')
  })

  test('drift: non-empty labels with the item and the PR', async () => {
    const { model } = await load(remWorld(), {})
    const labels = model.drift.map(d => d.label)
    expect(labels).toContain('T16: the ledger says not done, but #38 merged')
    expect(labels).toContain('T05: QA failed on #70')
    expect(model.drift.every(d => d.label !== '' && d.id !== '')).toBe(true)
    expect(model.drift.find(d => d.id === 'qa-failed:T05')?.tone).toBe('error')
    expect(model.drift.find(d => d.id === 'declared-open-but-merged:T16')?.tone).toBe('warning')
  })

  test('watch lists only the ledger and the plan docs, as absolute paths', async () => {
    const { model } = await load(remWorld(), {})
    expect(model.watch).toEqual([`${REPO}/WORKPLAN.md`, `${REPO}/README.md`, `${REPO}/docs/ARCHITECTURE.md`])
  })

  test('the ledger is read from origin/<default branch> when it is ahead of the local copy', async () => {
    const remoteOnly = rem.ledgerText + '\n#### T77 — Only on the default branch\n'
    const { model, s } = await load(remWorld({ remote: { 'WORKPLAN.md': remoteOnly } }), {})
    expect(itemOf(model, 'T77').title).toBe('Only on the default branch')
    expect(s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} fetch --quiet origin main`)
    expect(model.header.caption).not.toContain(en['ledger.caption.localOnly'])
  })

  test('the default branch comes from gh, then git, then main', async () => {
    const viaGh = await load(remWorld({ defaultBranch: 'trunk', remote: { 'WORKPLAN.md': rem.ledgerText } }), {})
    expect(viaGh.s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} fetch --quiet origin trunk`)
    const noGh = await load(remWorld({ isGhUp: false }), {})
    expect(noGh.s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} fetch --quiet origin main`)
  })

  test('offline: fetch and show fail, the local file is used and the header says so', async () => {
    const { model } = await load(remWorld({ isFetchUp: false, isShowUp: false }), {})
    expect(model.header.caption).toContain(en['ledger.caption.localOnly'])
    expect(itemOf(model, 'T03').status).toBe('done')
  })

  test('a failed fetch alone is tolerated: the stale remote ref is still read', async () => {
    const { model } = await load(remWorld({ isFetchUp: false }), {})
    expect(model.header.caption).not.toContain(en['ledger.caption.localOnly'])
  })

  test('gh failing: no PRs, progress from the ledger alone, and a caption', async () => {
    const { model } = await load(remWorld({ isPrListUp: false }), {})
    expect(model.header.caption).toBe('Pull requests could not be read (gh failed), so progress comes from the ledger alone.')
    expect(itemOf(model, 'T03')).toMatchObject({ status: 'done', chips: [] })
    expect(itemOf(model, 'T05').status).toBe('planned')
    expect(itemOf(model, 'T03').href).toMatch(/#L24$/)
  })

  test('without a repository address there are no ledger-line links', async () => {
    const { model } = await load(remWorld({ isGhUp: false }), {})
    expect(itemOf(model, 'T13c').href).toBeUndefined()
  })
})

describe('the model: field-service', () => {
  const fsvWorld = (over: Partial<World> = {}) =>
    world({
      tracked: ['WORKPLAN.md'],
      files: { 'WORKPLAN.md': fsv.ledgerText },
      remote: { 'WORKPLAN.md': fsv.ledgerText },
      prs: withUrls(fsv.prs),
      ...over,
    })

  test('phases become sections; sub-slice and follow-up chips', async () => {
    const { model } = await load(fsvWorld(), {})
    expect(model.sections.filter(s => !s.isProposed).map(s => s.title)).toEqual([
      'Phase 0 — Foundation',
      'Phase 1 — Auth and tenancy',
      'Phase 2 — API surface',
      'Phase 4 — Platform admin app',
      'Phase 5 — Tenant app',
      'Chores',
    ])
    expect(itemOf(model, 'T03').chips.map(c => c.label)).toEqual(['#154', 'T03b #145', '#161', '#159'])
    expect(itemOf(model, 'T04a').chips.map(c => c.label)).toEqual(['#162', '#166'])
    expect(itemOf(model, 'fix-T04a-backdate-picker')).toMatchObject({ status: 'done', chips: [{ label: '#259' }] })
    expect(model.header.mode).toBe('idle')
    expect(model.overall.counts.total).toBe(32)
  })

  test('size is not drawn as a chip', async () => {
    const { model } = await load(fsvWorld(), {})
    expect(model.sections.flatMap(s => s.items).flatMap(i => i.chips).some(c => c.label === 'L')).toBe(false)
  })
})

describe('the model: checkbox ledgers', () => {
  test('a ledger of checkboxes works with no PRs at all', async () => {
    const w = world({ tracked: ['ROADMAP.md'], files: { 'ROADMAP.md': checkbox.ledgerText }, remote: { 'ROADMAP.md': checkbox.ledgerText }, prs: [] })
    const { model } = await load(w, {})
    expect(model.header.title).toBe('Roadmap')
    expect(model.sections.filter(s => !s.isProposed).map(s => s.id)).toEqual(['phase-1-foundations', 'phase-2-launch'])
    expect(itemOf(model, 'API-3').status).toBe('done')
    expect(itemOf(model, 'API-4').status).toBe('planned')
    expect(itemOf(model, 'phase-1-foundations#1').title).toBe('Project scaffolding')
    expect(model.next?.command).toBe('start API-4 — Pagination')
    expect(model.next?.reason).toBe(en['ledger.next.reasonFree'])
  })
})

describe('chips', () => {
  test('follow-ups are capped at two plus a "+N more" tag', () => {
    const items = [item('T9')]
    const prs = [
      pr(1, 'feat/T9-a'),
      pr(2, 'fix/T9-b'),
      pr(3, 'fix/T9-c'),
      pr(4, 'fix/T9-d'),
      pr(5, 'fix/T9-e'),
    ]
    const chips = chipsOf(matchPrs(items, prs).get('T9') as never)
    expect(chips.map(c => c.label)).toEqual(['#1', '#5', '#4', '+2 more'])
    expect(chips[3]).toMatchObject({ kind: 'tag', tone: 'neutral' })
  })

  test('no more than three best-tier PRs are drawn; the rest count as hidden', () => {
    const prs = [1, 2, 3, 4, 5].map(n => pr(n, `feat/T9-${'abcde'[n - 1]}`))
    const chips = chipsOf(matchPrs([item('T9')], prs).get('T9') as never)
    expect(chips.map(c => c.label)).toEqual(['#5', '#4', '#3', '+2 more'])
  })
})

describe('layer 2: AI proposes, you pin', () => {
  const sonnetCalls = (s: { asked: { model: string }[] }) => s.asked.filter(a => a.model === 'claude-sonnet-5-5').length
  const haikuCalls = (s: { asked: { model: string }[] }) => s.asked.filter(a => a.model === 'claude-haiku-5-5').length
  const replies: Replies = { sonnet: PROPOSAL, haiku: assignAll }

  test('first load: one Sonnet call, proposed sections after the phases, a Pin action', async () => {
    const { model, s } = await load(deliveryWorld(), replies)
    expect(sonnetCalls(s)).toBe(1)
    expect(haikuCalls(s)).toBe(0)
    const proposed = model.sections.filter(sec => sec.isProposed === true)
    expect(proposed.map(sec => [sec.title, sec.caption])).toEqual([
      ['Telegram bot', 'chat surface'],
      ['API', 'HTTP endpoints'],
      ['Tooling', 'build and process'],
    ])
    expect(proposed.every(sec => sec.items.length === 0 && sec.percent === undefined && sec.isCollapsed)).toBe(true)
    expect(model.sections.indexOf(proposed[0] as never)).toBeGreaterThan(model.sections.findIndex(sec => sec.id === 'process'))
    expect(model.actions).toEqual([{ id: 'ledger.pin', label: en['ledger.action.pin'] }])
    expect(model.header.caption).toBe(en['ledger.caption.proposal'])
  })

  test('the proposal prompt carries ledger titles and doc headings, and the model id is a full id', async () => {
    const { s } = await load(deliveryWorld(), replies)
    const asked = s.asked[0]
    expect(asked?.model).toBe('claude-sonnet-5-5')
    expect(asked?.prompt).toContain('T03 | Browse |')
    expect(asked?.prompt).toContain('docs/ARCHITECTURE.md: Architecture / Overview / Data flow')
    expect(asked?.prompt).toContain('packages')
  })

  test('second load: zero calls, the stored proposal is shown', async () => {
    const stored = new Map<string, unknown>()
    await load(deliveryWorld(), replies, stored)
    const { model, s } = await load(deliveryWorld(), replies, stored)
    expect(s.asked).toEqual([])
    expect(model.sections.filter(sec => sec.isProposed === true)).toHaveLength(3)
    expect([...stored.keys()]).toEqual([`ledger:${REPO_URL}`])
  })

  test('pin: one Haiku call, then product sections with the unassigned remainder hidden or titled', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    const s2 = scripted(deliveryWorld(), replies, stored)
    const acted = await ledger.act?.(s2.ctx, first.detection, 'ledger.pin')
    expect(haikuCalls(s2)).toBe(1)
    expect(sonnetCalls(s2)).toBe(0)
    expect(acted?.sections.map(sec => sec.id)).toEqual(['bot', 'api', 'tooling', 'mobile'])
    expect(acted?.sections.some(sec => sec.isProposed === true)).toBe(false)
    const bot = acted?.sections.find(sec => sec.id === 'bot')
    expect(bot?.title).toBe('Telegram bot')
    expect(bot?.caption).toBe('The chat surface.')
    expect(bot?.items).toHaveLength(23)
    expect(bot?.items.find(i => i.id === 'T03')?.title).toBe('T03 short title')
    expect(acted?.sections.find(sec => sec.id === 'mobile')).toMatchObject({ title: 'Mobile apps', status: 'planned', percent: 0, items: [] })
    expect(acted?.sections.find(sec => sec.id === 'api')).toMatchObject({ status: 'planned', percent: 0, counts: { done: 0, total: 0 } })
    expect(acted?.actions).toEqual([{ id: 'ledger.rebuild', label: en['ledger.action.rebuild'] }])
    expect(acted?.header.caption).toBe('')
    expect(acted?.drift.map(d => d.label)).toContain('T01a: prose says shipped')
  })

  test('PR evidence wins over a judged status; evidence-free items take the judged one', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    const s2 = scripted(deliveryWorld(), { sonnet: PROPOSAL, haiku: p => assignAll(p).replace(/"status":"done"/g, '"status":"done"') }, stored)
    const acted = await ledger.act?.(s2.ctx, first.detection, 'ledger.pin')
    const items = acted?.sections.flatMap(sec => sec.items) ?? []
    expect(items.find(i => i.id === 'T05')?.status).toBe('failed')
    expect(items.find(i => i.id === 'T04')?.status).toBe('open')
    expect(items.find(i => i.id === 'T13c')?.status).toBe('done')
  })

  test('reload with the same inputs after pinning: zero calls', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    await ledger.act?.(scripted(deliveryWorld(), replies, stored).ctx, first.detection, 'ledger.pin')
    const again = await load(deliveryWorld(), replies, stored)
    expect(again.s.asked).toEqual([])
    expect(again.model.sections.map(sec => sec.id)).toEqual(['bot', 'api', 'tooling', 'mobile'])
  })

  test('a new merged PR changes the hash: one Haiku call', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    await ledger.act?.(scripted(deliveryWorld(), replies, stored).ctx, first.detection, 'ledger.pin')
    const merged = [...withUrls(rem.prs), { ...pr(99, 'feat/T05-more'), url: `${REPO_URL}/pull/99` }]
    const next = await load(deliveryWorld({ prs: merged }), replies, stored)
    expect(haikuCalls(next.s)).toBe(1)
    expect(sonnetCalls(next.s)).toBe(0)
  })

  test('an open PR changing does not change the hash', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    await ledger.act?.(scripted(deliveryWorld(), replies, stored).ctx, first.detection, 'ledger.pin')
    const open = [...withUrls(rem.prs), { ...pr(98, 'feat/T05-wip', { state: 'OPEN' }), url: 'x' }]
    expect((await load(deliveryWorld({ prs: open }), replies, stored)).s.asked).toEqual([])
  })

  test('rebuild: one Sonnet call, the old pin stays in effect, Pin is offered again', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    await ledger.act?.(scripted(deliveryWorld(), replies, stored).ctx, first.detection, 'ledger.pin')
    const other = JSON.stringify({ sections: [{ id: 'alpha', title: 'Alpha', hint: 'first' }, { id: 'beta', title: 'Beta', hint: 'second' }] })
    const s3 = scripted(deliveryWorld(), { sonnet: other, haiku: assignAll }, stored)
    const rebuilt = await ledger.act?.(s3.ctx, first.detection, 'ledger.rebuild')
    expect(s3.asked.map(a => a.model)).toEqual(['claude-sonnet-5-5'])
    expect(rebuilt?.sections.filter(sec => sec.isProposed !== true).map(sec => sec.id)).toEqual(['bot', 'api', 'tooling', 'mobile'])
    expect(rebuilt?.sections.filter(sec => sec.isProposed === true).map(sec => sec.title)).toEqual(['Alpha', 'Beta'])
    expect(rebuilt?.actions).toEqual([{ id: 'ledger.pin', label: en['ledger.action.pin'] }])
    // Pinning the new proposal moves the view over.
    const s4 = scripted(deliveryWorld(), { sonnet: other, haiku: assignAll }, stored)
    const repinned = await ledger.act?.(s4.ctx, first.detection, 'ledger.pin')
    expect(s4.asked.map(a => a.model)).toEqual(['claude-haiku-5-5'])
    expect(repinned?.sections.map(sec => sec.id).slice(0, 2)).toEqual(['alpha', 'beta'])
  })

  test('invalid JSON from the model: nothing stored, the phase view stays, and a caption says so', async () => {
    const stored = new Map<string, unknown>()
    const { model } = await load(deliveryWorld(), { sonnet: 'Sure! Here are the sections' }, stored)
    expect(model.header.caption).toBe(en['ledger.caption.aiUnavailable'])
    expect(model.sections.map(sec => sec.id)).toEqual([PHASE, 'process'])
    expect(model.actions).toEqual([{ id: 'ledger.propose', label: en['ledger.action.propose'] }])
    expect([...stored.values()]).toMatchObject([{ failure: { kind: 'proposal' } }])
  })

  test('a Haiku failure after pinning keeps the previous assignment and says so', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    await ledger.act?.(scripted(deliveryWorld(), replies, stored).ctx, first.detection, 'ledger.pin')
    const merged = [...withUrls(rem.prs), { ...pr(99, 'feat/T05-more'), url: 'x' }]
    const failed = await load(deliveryWorld({ prs: merged }), { haiku: 'not json' }, stored)
    expect(failed.model.header.caption).toBe(en['ledger.caption.aiFailed'])
    expect(failed.model.sections.map(sec => sec.id)).toEqual(['bot', 'api', 'tooling', 'mobile'])
  })

  test('an unanswered model is a quiet failure too', async () => {
    const { model } = await load(deliveryWorld(), {})
    expect(model.header.caption).toBe(en['ledger.caption.aiUnavailable'])
  })

  test('an unknown action just reloads; pin without a proposal does nothing', async () => {
    const s = scripted(deliveryWorld(), {})
    const detection = (await ledger.detect(s.ctx)) as Detection
    expect((await ledger.act?.(s.ctx, detection, 'ledger.nope'))?.provider).toBe('ledger')
    expect((await ledger.act?.(s.ctx, detection, 'ledger.pin'))?.sections.map(sec => sec.id)).toEqual([PHASE, 'process'])
  })

  test('runAction goes through the provider that owns the plan', async () => {
    const stored = new Map<string, unknown>()
    await load(deliveryWorld(), replies, stored)
    const acted = await runAction(scripted(deliveryWorld(), replies, stored).ctx, 'ledger.pin')
    expect(acted?.sections[0]?.id).toBe('bot')
  })

  test('nothing untracked, .local or .env reaches a model', async () => {
    const SENTINEL = 'SENTINEL-DO-NOT-SEND'
    const w = deliveryWorld({
      tracked: [...REM_TRACKED, 'PROGRESS.local', '.env', 'secrets/.env', 'docs/DESIGN-draft.md'],
      files: {
        'WORKPLAN.md': rem.ledgerText,
        'PROGRESS.local': `# ${SENTINEL}`,
        '.env': SENTINEL,
        'secrets/.env': SENTINEL,
        'docs/DESIGN-draft.md': `# ${SENTINEL}`,
        'docs/ARCHITECTURE-private.md': `# ${SENTINEL}`,
      },
      remote: { 'WORKPLAN.md': rem.ledgerText, 'docs/ARCHITECTURE.md': ARCH, 'README.md': '# Shop' },
      remoteTree: [...REM_TRACKED, 'PROGRESS.local', '.env', 'secrets/.env', 'secrets/keys.ts', 'notes/x.local'],
    })
    const stored = new Map<string, unknown>()
    const first = await load(w, replies, stored)
    await ledger.act?.(scripted(w, replies, stored).ctx, first.detection, 'ledger.pin')
    const everyPrompt = [...first.s.asked].map(a => a.prompt + (a.system ?? '')).join('\n')
    expect(everyPrompt).not.toContain(SENTINEL)
    expect(everyPrompt).not.toContain('PROGRESS.local')
    expect(everyPrompt).not.toContain('.env')
    // A directory only an unsendable file lives in is not offered either; its sendable neighbour is.
    const pinned = scripted(w, replies, stored)
    await ledger.act?.(pinned.ctx, first.detection, 'ledger.rebuild')
    expect(pinned.asked.map(a => a.prompt).join('\n')).not.toContain(SENTINEL)
    const shown = [...first.s.host.runs, ...pinned.host.runs].map(a => a.join(' '))
    expect(shown.some(line => line.includes('.env') && line.includes(' show '))).toBe(false)
    expect(shown.some(line => line.includes('.local') && line.includes(' show '))).toBe(false)
    expect(shown.some(line => line.includes('ARCHITECTURE-private') || line.includes('DESIGN-draft'))).toBe(false)
    expect(first.s.reads).toEqual([])
  })

  test('only sendable doc files are read with git show', async () => {
    const { s } = await load(deliveryWorld(), replies)
    const shown = s.host.runs.map(a => a.join(' ')).filter(line => line.includes(' show origin/'))
    expect(shown).toEqual([
      `git -C ${REPO} show origin/main:WORKPLAN.md`,
      `git -C ${REPO} show origin/main:README.md`,
      `git -C ${REPO} show origin/main:docs/ARCHITECTURE.md`,
    ])
  })

  test('the assignment prompt carries prose only for items without PR evidence', async () => {
    const stored = new Map<string, unknown>()
    const first = await load(deliveryWorld(), replies, stored)
    const s2 = scripted(deliveryWorld(), replies, stored)
    await ledger.act?.(s2.ctx, first.detection, 'ledger.pin')
    const prompt = s2.asked[0]?.prompt ?? ''
    expect(s2.asked[0]?.model).toBe('claude-haiku-5-5')
    expect(prompt).toContain('T13c: ')
    expect(prompt).not.toContain('T03: ')
    expect(prompt).toContain('T03 | Phase 1.5')
  })
})
