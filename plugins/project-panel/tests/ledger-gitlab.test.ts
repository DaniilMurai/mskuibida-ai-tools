// The ledger provider on a self-hosted GitLab (glab), with the forge override and a repository without an origin.
import { describe, expect, test } from 'claude-code/testing'
import { ForgeError } from '../src/forge'
import { ledger } from '../src/providers/ledger'
import * as rem from '../fixtures/ledger/reminders'
import type { Detection } from '../types'
import { GITLAB_HOST, GITLAB_URL, PROPOSAL, deliveryWorld, gitlabWorld, itemOf, remWorld, load, scripted } from './ledger-world'
import type { World } from './ledger-world'
import { OPTIONS } from './world'

const lines = (s: { host: { runs: (readonly string[])[] } }) => s.host.runs.map(argv => argv.join(' '))
const forgeCalls = (s: { host: { runs: (readonly string[])[] } }) => lines(s).filter(l => /^(gh|glab) /.test(l))

async function fingerprintFor(w: World): Promise<string> {
  const s = scripted(w)
  const detection = (await ledger.detect(s.ctx)) as Detection
  return (ledger.fingerprint as NonNullable<typeof ledger.fingerprint>)(s.ctx, detection)
}

describe('ledger on GitLab', () => {
  test('chips are !N and link to the merge request', async () => {
    const { model } = await load(gitlabWorld(), {})
    expect(itemOf(model, 'T03')).toMatchObject({
      status: 'done',
      chips: [{ kind: 'pr', label: '!35', tone: 'success', href: `${GITLAB_URL}/-/merge_requests/35` }],
      href: `${GITLAB_URL}/-/merge_requests/35`,
    })
    expect(itemOf(model, 'T04')).toMatchObject({ status: 'open', chips: [{ label: '!67', tone: 'accent' }] })
    expect(itemOf(model, 'T05')).toMatchObject({ status: 'failed', chips: [{ label: '!70', tone: 'error' }] })
    expect(itemOf(model, 'T12').chips.map(c => c.label)).toEqual(['!55', 'revert !69'])
    expect(itemOf(model, 'T21').chips.map(c => c.label)).toEqual(['!51', '!49'])
  })

  test('no chip, title or caption anywhere spells a GitLab number with #', async () => {
    const { model } = await load(gitlabWorld(), {})
    const labels = [...model.sections.flatMap(s => s.items.flatMap(i => i.chips.map(c => c.label))), ...model.drift.map(d => d.label)]
    expect(labels.length).toBeGreaterThan(10)
    expect(labels.filter(l => l.includes('#'))).toEqual([])
  })

  test('the ledger line links to /-/blob/ on the default branch glab reports', async () => {
    const { model, s } = await load(gitlabWorld({ defaultBranch: 'trunk', remote: { 'WORKPLAN.md': rem.ledgerText } }), {})
    expect(itemOf(model, 'T13c').href).toMatch(new RegExp(`^${GITLAB_URL}/-/blob/trunk/WORKPLAN\\.md#L\\d+$`))
    expect(lines(s)).toContain('git -C /work/shop fetch --quiet origin trunk')
  })

  test('drift names the merge request with !', async () => {
    const { model } = await load(gitlabWorld(), {})
    const labels = model.drift.map(d => d.label)
    expect(labels).toContain('T16: the ledger says not done, but !38 merged')
    expect(labels).toContain('T05: QA failed on !70')
  })

  test('the merge-request list is paged through glab with the web address, from the repository root', async () => {
    const { s } = await load(gitlabWorld(), {})
    expect(lines(s)).toContain(`glab mr list -R ${GITLAB_URL} --all -F json -P 100 -p 1`)
    expect(lines(s)).toContain(`glab api --hostname ${GITLAB_HOST} projects/acme%2Fplatform%2Fscanner`)
    expect(forgeCalls(s).filter(l => l.startsWith('gh '))).toEqual([])
  })

  test('glab not logged in: the header says merge requests could not be read, and why', async () => {
    const { model, s } = await load(gitlabWorld({ isGlabAuthed: false, isGlabUp: false }), {})
    expect(model.header.caption).toBe(`Merge requests could not be read (glab not logged in to ${GITLAB_HOST}), so progress comes from the ledger alone.`)
    expect(itemOf(model, 'T03')).toMatchObject({ status: 'done', chips: [] })
    expect(lines(s)).toContain(`gh auth status --hostname ${GITLAB_HOST}`)
  })

  test('glab logged in but the list failing: glab failed', async () => {
    const { model } = await load(gitlabWorld({ isPrListUp: false }), {})
    expect(model.header.caption).toBe('Merge requests could not be read (glab failed), so progress comes from the ledger alone.')
  })

  test('the fingerprint reads glab only and moves with a merge request', async () => {
    const before = await fingerprintFor(gitlabWorld())
    const s = scripted(gitlabWorld())
    const detection = (await ledger.detect(s.ctx)) as Detection
    s.host.runs.length = 0
    await ledger.fingerprint?.(s.ctx, detection)
    expect(forgeCalls(s).some(l => l.startsWith('gh '))).toBe(false)
    expect(lines(s)).toContain(`glab mr list -R ${GITLAB_URL} --all -F json -P 30 -o updated_at -S desc`)
    const merged = gitlabWorld()
    merged.prs = merged.prs.map(p => (p.number === 67 ? { ...p, state: 'MERGED' as const, mergedAt: '2026-10-01T09:00:00Z' } : p))
    expect(await fingerprintFor(merged)).not.toBe(before)
  })

  test('a failing glab rejects the fingerprint with the merge-request line', async () => {
    const error = await fingerprintFor(gitlabWorld({ isGlabAuthed: false, isGlabUp: false })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).display).toBe(`Could not check merge requests (glab not logged in to ${GITLAB_HOST}); they may be stale.`)
  })
})

describe('ledger without a forge', () => {
  test('forge: none reads no requests, runs no gh or glab, and says nothing', async () => {
    const s = scripted(remWorld(), {}, new Map(), { ...OPTIONS, forge: 'none' })
    const detection = (await ledger.detect(s.ctx)) as Detection
    const model = await ledger.load(s.ctx, detection)
    expect(model.header.caption).toBe('')
    expect(itemOf(model, 'T03')).toMatchObject({ status: 'done', chips: [] })
    expect(forgeCalls(s)).toEqual([])
    expect(lines(s).some(l => l.includes('remote get-url'))).toBe(false)
    // The default branch still falls back to git.
    expect(lines(s)).toContain('git -C /work/shop fetch --quiet origin main')
  })

  test('forge: none keeps the model layer off, as an unreadable request list does', async () => {
    const s = scripted(deliveryWorld(), { sonnet: PROPOSAL }, new Map(), { ...OPTIONS, forge: 'none' })
    const detection = (await ledger.detect(s.ctx)) as Detection
    const model = await ledger.load(s.ctx, detection)
    expect(s.asked).toEqual([])
    expect(model.actions).toBeUndefined()
  })

  test('forge: none fingerprints on the git tip alone', async () => {
    const s = scripted(remWorld(), {}, new Map(), { ...OPTIONS, forge: 'none' })
    const detection = (await ledger.detect(s.ctx)) as Detection
    s.host.runs.length = 0
    expect(await ledger.fingerprint?.(s.ctx, detection)).not.toBe('')
    expect(forgeCalls(s)).toEqual([])
  })

  test('forge: gitlab on a github.com origin takes it as GitLab, no probe', async () => {
    const s = scripted(remWorld(), {}, new Map(), { ...OPTIONS, forge: 'gitlab' })
    const detection = (await ledger.detect(s.ctx)) as Detection
    await ledger.load(s.ctx, detection)
    expect(forgeCalls(s).every(l => l.startsWith('glab '))).toBe(true)
    expect(lines(s).some(l => l.includes('auth status'))).toBe(true) // classifying the glab failure, nothing else
  })

  test('no origin remote: the header says so; progress comes from the ledger', async () => {
    const { model, s } = await load(remWorld({ origin: null }), {})
    expect(model.header.caption).toBe('No origin remote, so progress comes from the ledger alone.')
    expect(itemOf(model, 'T03')).toMatchObject({ status: 'done', chips: [] })
    expect(forgeCalls(s)).toEqual([])
  })

  test('no origin remote: the fingerprint is the git tip, not an error', async () => {
    expect(await fingerprintFor(remWorld({ origin: null }))).not.toBe('')
  })
})
