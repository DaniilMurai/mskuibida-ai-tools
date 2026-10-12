// Review round 1: one regression test (or more) for each numbered finding.
import { describe, expect, test } from 'claude-code/testing'
import { ledger } from '../src/providers/ledger'
import { isSendable } from '../src/providers/ledger/discover'
import { localTracked, remoteTracked } from '../src/providers/ledger/host'
import { cleanLine, proseByItem } from '../src/providers/ledger/l2'
import { buildAssignmentRequest, buildProposalRequest, chunkItems } from '../src/providers/ledger/ai'
import type { AssignmentItem } from '../src/providers/ledger/ai'
import { matchPrs } from '../src/providers/ledger/match'
import { parseLedger } from '../src/providers/ledger/parse'
import { defaultExpanded } from '../src/providers/ledger/progress'
import { chipsOf } from '../src/providers/ledger/view'
import { en } from '../src/strings/en'
import * as rem from '../fixtures/ledger/reminders'
import type { Detection, PanelModel } from '../types'
import {
  PROPOSAL,
  REPO,
  assignAll,
  deliveryWorld,
  itemOf,
  remWorld,
  load,
  scripted,
  section,
  withUrls,
  world,
} from './ledger-world'
import type { Replies, World } from './ledger-world'
import { item, pr } from './ledger/helpers'

const SENTINEL = 'SENTINEL-DO-NOT-SEND'
const HOURS = 60 * 60 * 1000
const sonnet = <T extends { model: string }>(s: { asked: T[] }): T[] => s.asked.filter(a => a.model === 'claude-sonnet-5-5')
const haiku = <T extends { model: string }>(s: { asked: T[] }): T[] => s.asked.filter(a => a.model === 'claude-haiku-5-5')
const replies: Replies = { sonnet: PROPOSAL, haiku: assignAll }

/** Loads with the clock moved on by `plus` ms, over a shared store. */
async function loadAt(w: World, r: Replies, stored: Map<string, unknown>, plus = 0) {
  const s = scripted(w, r, stored)
  const ctx = { ...s.ctx, now: s.ctx.now + plus }
  const detection = (await ledger.detect(ctx)) as Detection
  return { s, ctx, detection, model: await ledger.load(ctx, detection) }
}

/** Presses an action over the same store. */
async function press(w: World, r: Replies, stored: Map<string, unknown>, id: string, plus = 0) {
  const s = scripted(w, r, stored)
  const ctx = { ...s.ctx, now: s.ctx.now + plus }
  const detection = (await ledger.detect(ctx)) as Detection
  const model = (await ledger.act?.(ctx, detection, id)) as PanelModel
  return { s, model }
}

/** A delivery-declared ledger of `n` checkbox tasks, with one merged PR each when `withPrs`. */
function bigWorld(n: number, withPrs: boolean, over: Partial<World> = {}): World {
  const text = ['# Big', '## P', ...Array.from({ length: n }, (_, i) => `- [ ] **A${i + 1}** Task ${i + 1}`)].join('\n')
  const delivery = '---\ntask-ledger: PLAN.md\n---\n'
  return world({
    tracked: ['PLAN.md', 'docs/DELIVERY.md'],
    files: { 'PLAN.md': text, 'docs/DELIVERY.md': delivery },
    remote: { 'PLAN.md': text, 'docs/DELIVERY.md': delivery },
    prs: withPrs ? withUrls(Array.from({ length: n }, (_, i) => pr(i + 1, `feat/A${i + 1}-x`))) : [],
    ...over,
  })
}

describe('1. repository content is read through git only', () => {
  test('localTracked drops symlinks (120000) and submodules (160000)', async () => {
    const w = world({ tracked: ['a.md', 'link.md', 'vendor/lib', 'src/x.ts'], modes: { 'link.md': '120000', 'vendor/lib': '160000' } })
    expect(await localTracked(scripted(w).host, REPO)).toEqual(['a.md', 'src/x.ts'])
  })

  test('the origin tree is read in the full form and drops symlinks and submodules too', async () => {
    const w = world({
      remote: { 'a.md': '#', 'link.md': '#', 'vendor/lib': '#', 'src/x.ts': '#' },
      remoteModes: { 'link.md': '120000', 'vendor/lib': '160000' },
    })
    const s = scripted(w)
    expect(await remoteTracked(s.host, REPO, 'main')).toEqual(['a.md', 'src/x.ts'])
    expect(s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} ls-tree -r -z origin/main`)
    expect(s.host.runs.map(a => a.join(' ')).join('\n')).not.toContain('--name-only')
  })

  test('a tracked WORKPLAN.md symlink to PROGRESS.local never reaches fsx, a prompt or the model', async () => {
    const w = world({
      tracked: ['WORKPLAN.md', 'PROGRESS.local', 'docs/DELIVERY.md'],
      modes: { 'WORKPLAN.md': '120000' },
      files: { 'WORKPLAN.md': SENTINEL, 'PROGRESS.local': SENTINEL, 'docs/DELIVERY.md': '---\ntask-ledger: WORKPLAN.md\n---\n' },
      remote: { 'WORKPLAN.md': SENTINEL, 'PROGRESS.local': SENTINEL },
    })
    const s = scripted(w, replies)
    expect(await ledger.detect(s.ctx)).toBeNull()
    expect(s.reads).toEqual([])
    const lines = s.host.runs.map(a => a.join(' '))
    expect(lines.some(l => l.includes('show HEAD:WORKPLAN.md') || l.includes('PROGRESS.local'))).toBe(false)
    // Even handed the symlink as the ledger, load refuses it before asking a model anything.
    const forged: Detection = { provider: 'ledger', root: REPO, detail: { ledgerPath: 'WORKPLAN.md', via: 'delivery' } }
    await expect(ledger.load(s.ctx, forged)).rejects.toThrow()
    expect(s.asked).toEqual([])
  })

  test('a regular ledger is read with git show, never through fsx, and the working copy is not what is sent', async () => {
    const w = remWorld({ files: { 'WORKPLAN.md': rem.ledgerText + '\n#### T88 — Only in the working copy, uncommitted\n' } })
    const { s, model } = await load(w, {})
    expect(s.reads).toEqual([])
    // The committed copy is what the local fallback reads (the origin copy wins when it exists).
    expect(model.provider).toBe('ledger')
    const offline = await load(remWorld({ isShowUp: false, files: { 'WORKPLAN.md': rem.ledgerText } }), {})
    expect(offline.s.reads).toEqual([])
    expect(offline.s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} show HEAD:WORKPLAN.md`)
  })

  test('the DELIVERY.md read goes through git show HEAD, not fsx', async () => {
    const { s } = await load(deliveryWorld(), {})
    expect(s.reads).toEqual([])
    expect(s.host.runs.map(a => a.join(' '))).toContain(`git -C ${REPO} show HEAD:docs/DELIVERY.md`)
  })

  test('a symlinked doc or a submodule on origin is not listed, read, watched or offered to a model', async () => {
    const w = deliveryWorld({
      remoteTree: [...remWorld().tracked, 'packages/sub/x.ts', 'docs/DESIGN.md'],
      remoteModes: { 'docs/ARCHITECTURE.md': '120000', 'packages/sub/x.ts': '160000', 'docs/DESIGN.md': '120000' },
      remote: { 'WORKPLAN.md': rem.ledgerText, 'docs/ARCHITECTURE.md': SENTINEL, 'README.md': '# Shop', 'docs/DESIGN.md': SENTINEL },
    })
    const { s, model } = await load(w, replies)
    const lines = s.host.runs.map(a => a.join(' '))
    expect(lines.some(l => l.includes('ARCHITECTURE.md') && l.includes('show origin'))).toBe(false)
    expect(lines.some(l => l.includes('DESIGN.md') && l.includes('show origin'))).toBe(false)
    expect(model.watch.join(' ')).not.toContain('ARCHITECTURE')
    expect(s.asked.map(a => a.prompt).join('\n')).not.toContain(SENTINEL)
    expect(s.asked.map(a => a.prompt).join('\n')).not.toContain('packages/sub')
  })
})

describe('2. isSendable is hardened, case-insensitively, on every segment', () => {
  const tracked = (p: string) => new Set([p])
  test('rejects .git, *.local, *.local.*, .env* and *.env in any segment, in any case', async () => {
    const bad = [
      '.git/config', '.GIT/config', 'a/.Git/x', 'a.local', 'A.LOCAL', 'x/PROGRESS.Local', 'notes.local.md', 'a.LOCAL.txt',
      'foo.local/bar.md', '.env', '.ENV', '.env.production', 'config/.envrc', 'prod.env', 'a/Prod.ENV', 'secrets/.env/x.md',
    ]
    for (const p of bad) expect(isSendable(p, tracked(p))).toBe(false)
  })
  test('keeps ordinary files that merely look similar', async () => {
    for (const p of ['docs/environment.md', 'src/local.ts', 'src/localize/a.ts', 'envoy.yaml', 'docs/WORKPLAN.md', 'a.github/x', '.github/workflows/a.yml']) {
      expect(isSendable(p, tracked(p))).toBe(true)
    }
  })
  test('still tracked-only', async () => {
    expect(isSendable('docs/a.md', new Set())).toBe(false)
  })
})

describe('3a. L2 is skipped when it cannot be done safely', () => {
  test('gh pr list failing: no model call, no store write, phases shown, no actions', async () => {
    const stored = new Map<string, unknown>()
    const { s, model } = await load(deliveryWorld({ isPrListUp: false }), replies, stored)
    expect(s.asked).toEqual([])
    expect(stored.size).toBe(0)
    expect(model.sections.map(x => x.id)).toEqual(['phase-1-5-task-management-in-telegram', 'process'])
    expect(model.actions).toBeUndefined()
  })

  test('a ledger with no items: no call, no write', async () => {
    const w = world({ tracked: ['PLAN.md'], files: { 'PLAN.md': '# Plan\n\nNothing yet.\n' }, remote: { 'PLAN.md': '# Plan\n' }, prs: [] })
    const s = scripted(w, replies)
    const forged: Detection = { provider: 'ledger', root: REPO, detail: { ledgerPath: 'PLAN.md', via: 'delivery' } }
    const model = await ledger.load(s.ctx, forged)
    expect(model.sections).toEqual([])
    expect(s.asked).toEqual([])
    expect(s.stored.size).toBe(0)
  })

  test('store.get throwing: no call and, above all, no write that could drop a pin', async () => {
    const stored = new Map<string, unknown>()
    await load(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    const before = JSON.stringify([...stored.entries()])
    const s = scripted(deliveryWorld({ prs: [...withUrls(rem.prs), { ...pr(99, 'feat/T05-more'), url: 'x' }] }), replies, stored)
    let sets = 0
    const ctx = { ...s.ctx, host: { ...s.host, store: { get: async () => { throw new Error('store down') }, set: async () => { sets += 1 } } } }
    const detection = (await ledger.detect(ctx)) as Detection
    const model = await ledger.load(ctx, detection)
    expect(s.asked).toEqual([])
    expect(sets).toBe(0)
    expect(JSON.stringify([...stored.entries()])).toBe(before)
    expect(model.sections.map(x => x.id)).toEqual(['phase-1-5-task-management-in-telegram', 'process'])
  })
})

describe('3b. a failed call is not repeated for the same input within six hours', () => {
  const bad: Replies = { sonnet: 'not json', haiku: 'not json' }

  test('proposal: not again within 6 h, again after 6 h, at once on changed input, at once on Propose', async () => {
    const stored = new Map<string, unknown>()
    const first = await loadAt(deliveryWorld(), bad, stored)
    expect(sonnet(first.s)).toHaveLength(1)
    expect([...stored.values()][0]).toMatchObject({ failure: { kind: 'proposal' } })

    expect(sonnet((await loadAt(deliveryWorld(), bad, stored, 5 * HOURS)).s)).toHaveLength(0)
    expect(sonnet((await loadAt(deliveryWorld(), bad, stored, 6 * HOURS + 1)).s)).toHaveLength(1)

    const changed = deliveryWorld({ remote: { ...deliveryWorld().remote, 'WORKPLAN.md': rem.ledgerText + '\n#### T91 — A new task\n' } })
    expect(sonnet((await loadAt(changed, bad, stored, 1000)).s)).toHaveLength(1)

    expect(sonnet((await press(deliveryWorld(), bad, stored, 'ledger.propose', 2000)).s)).toHaveLength(1)
  })

  test('a successful retry clears the failure', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), bad, stored)
    await loadAt(deliveryWorld(), { sonnet: PROPOSAL }, stored, 7 * HOURS)
    expect([...stored.values()][0]).not.toHaveProperty('failure')
  })

  test('assignment: not again for the same hash within 6 h; Pin or a changed hash retries at once', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    const merged = deliveryWorld({ prs: [...withUrls(rem.prs), { ...pr(99, 'feat/T05-more'), url: 'x' }] })
    const failing = await loadAt(merged, { haiku: 'not json' }, stored, 1000)
    expect(haiku(failing.s)).toHaveLength(1)
    expect([...stored.values()][0]).toMatchObject({ failure: { kind: 'assignment' } })
    expect(haiku((await loadAt(merged, { haiku: 'not json' }, stored, 2 * HOURS)).s)).toHaveLength(0)
    expect(haiku((await loadAt(merged, { haiku: 'not json' }, stored, 6 * HOURS + 5000)).s)).toHaveLength(1)
    const more = deliveryWorld({ prs: [...withUrls(rem.prs), { ...pr(99, 'feat/T05-more'), url: 'x' }, { ...pr(100, 'feat/T05-again'), url: 'x' }] })
    expect(haiku((await loadAt(more, { haiku: 'not json' }, stored, 2 * HOURS)).s)).toHaveLength(1)
    expect(haiku((await press(merged, replies, stored, 'ledger.pin', 3 * HOURS)).s)).toHaveLength(1)
  })
})

describe('3c. Haiku inputs are bounded', () => {
  const item = (id: string, source: AssignmentItem['source']): AssignmentItem => ({ id, title: id, phase: 'P', status: 'planned', source })

  test('chunkItems: at most 120 tasks and 40 judgeable tasks per batch, in order', () => {
    const backed = Array.from({ length: 250 }, (_, i) => item(`B${i}`, 'pr'))
    expect(chunkItems(backed).map(c => c.length)).toEqual([120, 120, 10])
    const free = Array.from({ length: 100 }, (_, i) => item(`F${i}`, 'none'))
    expect(chunkItems(free).map(c => c.length)).toEqual([40, 40, 20])
    const mixed = [...backed.slice(0, 100), ...free.slice(0, 45)]
    const chunks = chunkItems(mixed)
    expect(chunks.every(c => c.length <= 120 && c.filter(i => i.source === 'none').length <= 40)).toBe(true)
    expect(chunks.flat().map(i => i.id)).toEqual(mixed.map(i => i.id))
    expect(chunkItems([])).toEqual([])
  })

  test('maxTokens per batch is min(8000, 800 + 50 n)', () => {
    const req = (n: number) =>
      buildAssignmentRequest({ sections: [], items: Array.from({ length: n }, (_, i) => item(`X${i}`, 'pr')), proseByItem: {}, topDirs: [], codeDirs: [] })
    expect(req(10).maxTokens).toBe(1300)
    expect(req(120).maxTokens).toBe(6800)
    expect(req(400).maxTokens).toBe(8000)
  })

  test('250 PR-backed tasks: three Haiku calls of 120, 120 and 10 tasks', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(bigWorld(250, true), replies, stored)
    const { s } = await press(bigWorld(250, true), replies, stored, 'ledger.pin')
    const sizes = haiku(s).map(a => a.prompt.split('\n').filter(l => /^A\d+ \| P \| Task \d+ \| done\/pr$/.test(l)).length)
    expect(sizes).toEqual([120, 120, 10])
    expect(haiku(s).map(a => a.maxTokens)).toEqual([6800, 6800, 1300])
  })

  test('250 evidence-free tasks: at most 40 judged per call', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(bigWorld(250, false), replies, stored)
    const { s } = await press(bigWorld(250, false), replies, stored, 'ledger.pin')
    expect(haiku(s)).toHaveLength(7)
    for (const call of haiku(s)) {
      expect(call.prompt.split('\n').filter(l => /^A\d+: /.test(l)).length).toBeLessThanOrEqual(40)
    }
  })

  test('a failed batch fails the whole assignment: nothing is stored, the old result stays', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(bigWorld(250, true), replies, stored)
    await press(bigWorld(250, true), replies, stored, 'ledger.pin')
    const oldHash = ((([...stored.values()][0]) as { assignment: { hash: string } }).assignment.hash)
    let n = 0
    const flaky: Replies = { haiku: p => (++n === 2 ? 'not json' : assignAll(p)) }
    const grown = bigWorld(250, true, { prs: [...withUrls(Array.from({ length: 250 }, (_, i) => pr(i + 1, `feat/A${i + 1}-x`))), { ...pr(999, 'feat/A1-more'), url: 'x' }] })
    const { s, model } = await loadAt(grown, flaky, stored, 1000)
    expect(haiku(s)).toHaveLength(2)
    expect((([...stored.values()][0]) as { assignment: { hash: string } }).assignment.hash).toBe(oldHash)
    expect(model.header.caption).toBe(en['ledger.caption.aiFailed'])
    expect(model.sections.map(x => x.id)).toEqual(['bot', 'api', 'tooling', 'mobile'])
  })

  test('the proposal prompt lists at most 40 top-level directories', async () => {
    const dirs = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}/x.ts`)
    const base = deliveryWorld()
    const w = deliveryWorld({ remoteTree: [...base.tracked, ...dirs] })
    const { s } = await load(w, replies)
    const line = (s.asked[0]?.prompt ?? '').split('\n').find(l => l.startsWith('Top-level directories:')) ?? ''
    expect(line.split(': ')[1]?.split(', ')).toHaveLength(40)
  })
})

describe('3d. Rebuild makes at most one Sonnet call per press', () => {
  test('even when the reply is invalid', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    expect(sonnet((await press(deliveryWorld(), { sonnet: 'nope', haiku: assignAll }, stored, 'ledger.rebuild')).s)).toHaveLength(1)
    expect(sonnet((await press(deliveryWorld(), { sonnet: PROPOSAL, haiku: assignAll }, stored, 'ledger.rebuild')).s)).toHaveLength(1)
  })

  test('with nothing pinned and no proposal, Rebuild is still one call', async () => {
    const stored = new Map<string, unknown>()
    const { s } = await press(deliveryWorld(), { sonnet: 'nope' }, stored, 'ledger.rebuild')
    expect(sonnet(s)).toHaveLength(1)
  })
})

describe('3e. a stored assignment is applied only to the pin it was made for', () => {
  const OTHER = JSON.stringify({ sections: [{ id: 'alpha', title: 'Alpha', hint: 'first' }, { id: 'beta', title: 'Beta', hint: 'second' }] })

  test('re-pinning other sections: phases and a caption until Haiku succeeds, then the new sections', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    await press(deliveryWorld(), { sonnet: OTHER }, stored, 'ledger.rebuild')
    const failing = await press(deliveryWorld(), { sonnet: OTHER, haiku: 'not json' }, stored, 'ledger.pin')
    expect(failing.model.sections.map(x => x.id)).toEqual(['phase-1-5-task-management-in-telegram', 'process'])
    expect(failing.model.header.caption).toBe(en['ledger.caption.aiUnavailable'])
    const ok = await press(deliveryWorld(), { sonnet: OTHER, haiku: assignAll }, stored, 'ledger.pin', 1000)
    expect(ok.model.sections.map(x => x.id).slice(0, 2)).toEqual(['alpha', 'beta'])
  })

  test('the hash covers titles and hints: same ids, new hint, one new Haiku call', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    const reworded = JSON.stringify({
      sections: JSON.parse(PROPOSAL).sections.map((x: { hint: string }) => ({ ...x, hint: x.hint + ' (reworded)' })),
    })
    await press(deliveryWorld(), { sonnet: reworded }, stored, 'ledger.rebuild')
    const repin = await press(deliveryWorld(), { sonnet: reworded, haiku: assignAll }, stored, 'ledger.pin')
    expect(haiku(repin.s)).toHaveLength(1)
  })

  test('a pin made for a different ledger path counts as no pin', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    await press(deliveryWorld(), replies, stored, 'ledger.pin')
    const record = [...stored.values()][0] as { pinned: { ledgerPath: string } }
    record.pinned.ledgerPath = 'OLD-PLAN.md'
    stored.set([...stored.keys()][0] as string, record)
    const { s, model } = await loadAt(deliveryWorld(), replies, stored, 1000)
    expect(s.asked).toEqual([])
    expect(model.sections.filter(x => x.isProposed !== true).map(x => x.id)).toEqual(['phase-1-5-task-management-in-telegram', 'process'])
    expect(model.actions?.map(a => a.id)).not.toContain('ledger.rebuild')
  })
})

describe('4. matcher edge cases', () => {
  const ids = (m: Map<string, { prs: { number: number }[] }>, id: string) => (m.get(id)?.prs ?? []).map(p => p.number)

  test('a, trailing parenthesis counts only when it is all ids', () => {
    const m = matchPrs(
      [item('T04'), item('T05')],
      [pr(1, 'claude/a', { title: 'refactor (builds on T04)' }), pr(2, 'claude/b', { title: 'refactor (not T04)' }), pr(3, 'claude/c', { title: 'refactor (T04, T05)' }), pr(4, 'claude/d', { title: 'refactor (T04)' })],
    )
    expect(ids(m, 'T04')).toEqual([4, 3])
    expect(ids(m, 'T05')).toEqual([3])
  })

  test('b, containment uses the id boundary rule: T1 and T10 in one PR both count', () => {
    const m = matchPrs([item('T1'), item('T10')], [pr(1, 'feat/x', { title: 'feat(T1,T10): both' })])
    expect(ids(m, 'T1')).toEqual([1])
    expect(ids(m, 'T10')).toEqual([1])
  })

  test('b, a real containment (an id inside a longer slug id) still goes to the longest', () => {
    const m = matchPrs([item('T04a'), item('fix-T04a-picker')], [pr(1, 'fix/fix-T04a-picker')])
    expect(ids(m, 'fix-T04a-picker')).toEqual([1])
    expect(m.get('T04a')?.status).toBe('planned')
  })

  test('c, revert detection is narrow', () => {
    const m = matchPrs([item('T04')], [pr(1, 'feat/T04-safe', { title: 'Revert-safe migrations for T04' }), pr(2, 'revert-T04-x', { title: 'undo' }), pr(3, 'x/y', { title: 'Revert "feat(T04): act"' }), pr(4, 'x/z', { title: 'revert: T04' })])
    expect(m.get('T04')?.prs.map(p => p.number)).toEqual([1])
    expect(m.get('T04')?.reverts.map(p => p.number)).toEqual([4, 3, 2])
  })

  test('d, an id followed by -<digit> is not a match unless the item is that longer id', () => {
    const m = matchPrs([item('T04'), item('T04-2')], [pr(1, 'feat/T04-2-x'), pr(2, 'feat/T04-x')])
    expect(ids(m, 'T04')).toEqual([2])
    expect(ids(m, 'T04-2')).toEqual([1])
  })

  test('e, follow-up chips are neutral whatever the PR state', () => {
    const m = matchPrs([item('T9')], [pr(1, 'feat/T9-a'), pr(2, 'fix/T9-b'), pr(3, 'fix/T9-c', { state: 'OPEN' })])
    const chips = chipsOf(m.get('T9') as never)
    expect(chips.map(c => [c.label, c.tone])).toEqual([['#1', 'success'], ['#3', 'neutral'], ['#2', 'neutral']])
  })
})

describe('5. the default-open section', () => {
  test('is the least-done active section; empty and proposed sections are not chosen', async () => {
    expect(
      defaultExpanded([
        { id: 'empty', percent: 0, status: 'planned', items: [] },
        { id: 'prop', percent: 0, status: 'planned', items: [{}], isProposed: true },
        { id: 'real', percent: 40, status: 'partial', items: [{}] },
        { id: 'busy', percent: 90, status: 'active', items: [{}] },
      ]),
    ).toBe('busy')
    expect(
      defaultExpanded([
        { id: 'empty', percent: 0, status: 'planned', items: [] },
        { id: 'real', percent: 40, status: 'partial', items: [{}] },
        { id: 'less', percent: 10, status: 'planned', items: [{}] },
      ]),
    ).toBe('less')
  })
  test('an empty or proposed section opens only when no section holds a task at all', async () => {
    expect(defaultExpanded([{ id: 'a', percent: 100, status: 'built', items: [{}] }, { id: 'empty', percent: 0, status: 'planned', items: [] }])).toBeNull()
    expect(defaultExpanded([{ id: 'empty', percent: 0, status: 'planned', items: [] }, { id: 'prop', percent: 0, status: 'planned', isProposed: true }])).toBe('empty')
    expect(defaultExpanded([{ id: 'a', percent: 100, status: 'built', items: [{}] }])).toBeNull()
  })
  test('product view: a planned-only section with no tasks is not the one that opens', async () => {
    const stored = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, stored)
    const { model } = await press(deliveryWorld(), replies, stored, 'ledger.pin')
    const open = model.sections.filter(x => !x.isCollapsed)
    expect(open.map(x => x.id)).toEqual(['bot'])
  })
})

describe('6. load order, staleness and consent', () => {
  test('gh repo view, gh pr list and the branch lookup are in flight together', async () => {
    const s = scripted(remWorld(), {})
    const events: string[] = []
    const inner = s.host.run
    const run = async (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => {
      const tag = argv.slice(0, 3).join(' ')
      events.push(`start ${tag}`)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      const out = await inner(argv, init)
      events.push(`end ${tag}`)
      return out
    }
    const ctx = { ...s.ctx, host: { ...s.host, run } }
    const detection = (await ledger.detect(ctx)) as Detection
    events.length = 0
    await ledger.load(ctx, detection)
    const at = (e: string) => events.indexOf(e)
    expect(at('start gh pr list')).toBeGreaterThan(-1)
    expect(at('start gh pr list')).toBeLessThan(at('end gh repo view'))
    expect(at('start git -C ' + REPO)).toBeGreaterThan(-1)
  })

  test('a failed fetch with a good show origin/... says the ledger may be behind', async () => {
    const stale = (await load(remWorld({ isFetchUp: false }), {})).model
    expect(stale.header.caption).toBe(en['ledger.caption.stale'])
    const fresh = (await load(remWorld(), {})).model
    expect(fresh.header.caption).not.toBe(en['ledger.caption.stale'])
  })

  test('a discovered ledger makes no model call by itself; Propose makes exactly one', async () => {
    const stored = new Map<string, unknown>()
    const first = await loadAt(remWorld(), replies, stored)
    expect(first.s.asked).toEqual([])
    expect(first.model.actions).toEqual([{ id: 'ledger.propose', label: en['ledger.action.propose'] }])
    expect(first.model.header.caption).toBe('')
    const pressed = await press(remWorld(), replies, stored, 'ledger.propose')
    expect(pressed.s.asked.map(a => a.model)).toEqual(['claude-sonnet-5-5'])
    expect(pressed.model.actions).toEqual([{ id: 'ledger.pin', label: en['ledger.action.pin'] }])
    expect(pressed.model.sections.filter(x => x.isProposed === true)).toHaveLength(3)
  })

  test('a ledger declared in DELIVERY.md is proposed on load', async () => {
    const first = await loadAt(deliveryWorld(), replies, new Map())
    expect(sonnet(first.s)).toHaveLength(1)
  })
})

describe('7. prompt hygiene', () => {
  test('the ledger title falls back to the repo name', async () => {
    const text = ['## P', ...Array.from({ length: 5 }, (_, i) => `- [ ] **A${i + 1}** Task ${i + 1}`)].join('\n')
    const delivery = '---\ntask-ledger: PLAN.md\n---\n'
    const w = world({ tracked: ['PLAN.md', 'docs/DELIVERY.md'], files: { 'PLAN.md': text, 'docs/DELIVERY.md': delivery }, remote: { 'PLAN.md': text }, prs: [] })
    const { s } = await load(w, replies)
    expect(s.asked[0]?.prompt).toContain('Ledger: shop')
  })

  test('no empty fields: an item without a phase or title prints only what it has', () => {
    const req = buildProposalRequest({ ledgerTitle: '', items: [{ id: 'A1', title: 'Task', phase: '' }, { id: 'A2', title: '', phase: '' }], docHeadings: [{ path: 'docs/X.md', headings: [] }, { path: 'docs/Y.md', headings: ['Intro'] }], topDirs: [] })
    expect(req.prompt).toContain('\nA1 | Task\n')
    expect(req.prompt).toContain('\nA2\n')
    expect(req.prompt).not.toMatch(/\| *\n|\| *\|/)
    expect(req.prompt).not.toContain('Ledger:')
    expect(req.prompt).not.toContain('docs/X.md')
    expect(req.prompt).toContain('docs/Y.md: Intro')
    const asg = buildAssignmentRequest({ sections: [], items: [{ id: 'A1', title: '', phase: '', status: 'planned', source: 'none' }], proseByItem: {}, topDirs: [], codeDirs: [] })
    expect(asg.prompt).toContain('\nA1 | planned/none\n')
  })

  test('judge excerpts lose table pipes, bold, heading marks and the duplicate id', () => {
    expect(cleanLine('| **T13c** | Plugin validation — eval vs baseline | T11 | M |', 'T13c')).toBe('Plugin validation — eval vs baseline; T11; M')
    expect(cleanLine('#### T21 — A schedule-anchored pre-reminder', 'T21')).toBe('A schedule-anchored pre-reminder')
    expect(cleanLine('- [ ] **API-4** Pagination', 'API-4')).toBe('Pagination')
    const prose = proseByItem(rem.ledgerText, parseLedger(rem.ledgerText).items, new Set(['T13c', 'T04']))
    expect(prose['T13c']).not.toMatch(/\||\*\*/)
    expect(prose['T13c']).not.toContain('T13c')
    expect(prose['T04']).toContain('Act')
    expect(prose['T04']).not.toMatch(/\||\*\*|####/)
  })
})

describe('8. chips and captions', () => {
  test('one chip per PR number: a PR that is both the best-tier PR and a slice is drawn once', () => {
    const m = matchPrs([item('T9')], [pr(1, 'feat/T9-a', { title: '[T9b] first slice, delivered under T9' })])
    const chips = chipsOf(m.get('T9') as never)
    expect(chips.map(c => c.label)).toEqual(['#1'])
  })

  test('slice chips are capped at two, with a "+N more" tag', () => {
    const prs = ['a', 'b', 'c', 'd'].map((x, i) => pr(i + 1, `feat/T6${x}-x`))
    const chips = chipsOf(matchPrs([item('T6')], prs).get('T6') as never)
    expect(chips.map(c => c.label)).toEqual(['T6d #4', 'T6c #3', '+2 more'])
  })

  test('chips come best first: best-tier PRs, slices, follow-ups, the +N tag last', () => {
    const prs = [pr(10, 'feat/T6-a'), pr(11, 'feat/T6b-x'), pr(12, 'fix/T6-a'), pr(13, 'fix/T6-b'), pr(14, 'fix/T6-c')]
    const chips = chipsOf(matchPrs([item('T6')], prs).get('T6') as never)
    expect(chips.map(c => c.label)).toEqual(['#10', 'T6b #11', '#14', '#13', '+1 more'])
    expect(chips.map(c => c.kind)).toEqual(['pr', 'tag', 'pr', 'pr', 'tag'])
  })

  test('collapsed sections still carry their full items', async () => {
    const { model } = await load(remWorld(), {})
    const process = section(model, 'process')
    expect(process.isCollapsed).toBe(true)
    expect(process.items.map(i => i.id)).toEqual(['T-DL01', 'T-CL01'])
  })

  test('at most one caption: the most important wins', async () => {
    const offline = remWorld({ isShowUp: false, isPrListUp: false })
    const a = (await load(offline, {})).model
    expect(a.header.caption).toBe(en['ledger.caption.localOnly'])
    const stale = (await load(remWorld({ isFetchUp: false, isPrListUp: false }), {})).model
    expect(stale.header.caption).toBe(en['ledger.caption.stale'])
    const noPrs = (await load(remWorld({ isPrListUp: false }), {})).model
    expect(noPrs.header.caption).toBe('Pull requests could not be read (gh failed), so progress comes from the ledger alone.')
    const proposed = (await load(deliveryWorld(), replies)).model
    expect(proposed.header.caption).toBe(en['ledger.caption.proposal'])
    const both = (await load(deliveryWorld({ isFetchUp: false }), replies)).model
    expect(both.header.caption).toBe(en['ledger.caption.stale'])
  })

  test('aiFailed only with a previous result; otherwise aiUnavailable, once per failure window', async () => {
    const stored = new Map<string, unknown>()
    const first = await loadAt(deliveryWorld(), { sonnet: 'nope' }, stored)
    expect(first.model.header.caption).toBe(en['ledger.caption.aiUnavailable'])
    const again = await loadAt(deliveryWorld(), { sonnet: 'nope' }, stored, HOURS)
    expect(again.s.asked).toEqual([])
    expect(again.model.header.caption).toBe('')

    const withProposal = new Map<string, unknown>()
    await loadAt(deliveryWorld(), replies, withProposal)
    const rebuilt = await press(deliveryWorld(), { sonnet: 'nope' }, withProposal, 'ledger.rebuild', 1000)
    expect(rebuilt.model.header.caption).toBe(en['ledger.caption.aiFailed'])
  })
})
