import { describe, expect, test } from 'claude-code/testing'
import { githubForge } from '../../src/forge/github'
import { parseRemote } from '../../src/forge/remote'
import { inputHash } from '../../src/providers/ledger/hash'
import { isWriting, json, scriptedHost } from './helpers'
import type { Script } from './helpers'

const ROOT = '/work/shop'
const remote = parseRemote('git@github.com:acme/shop.git') as NonNullable<ReturnType<typeof parseRemote>>
const BASE = 'number,title,state,headRefName,headRefOid,isDraft,labels,mergedAt,url'
const STATUS = `${BASE},reviewDecision,mergeStateStatus,statusCheckRollup`
const list = (fields: string, limit = 1000) => `gh pr list --state all --limit ${limit} --json ${fields}`
const FINGERPRINT = 'gh pr list --state all --limit 1000 --json number,state,mergedAt,headRefOid,isDraft,reviewDecision,reviewRequests,latestReviews'

const forgeOf = (script: Script) => {
  const host = scriptedHost(script)
  return { host, forge: githubForge(host, ROOT, remote) }
}
const ok = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok).toBe(true)
  return r.value as T
}

const row = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `FEAT-GEN-${number}: generic subject`,
  state: 'MERGED',
  headRefName: `feat/FEAT-GEN-${number}`,
  headRefOid: `sha${number}`,
  isDraft: false,
  labels: [{ name: 'reviewed:approved', color: 'ededed' }],
  mergedAt: '2026-10-01T09:00:00Z',
  url: `https://github.com/acme/shop/pull/${number}`,
  ...over,
})

describe('github: identity', () => {
  test('refs are #N and file links use /blob/', () => {
    const { forge } = forgeOf({})
    expect(forge.kind).toBe('github')
    expect(forge.refPrefix).toBe('#')
    expect(forge.refOf(33)).toBe('#33')
    expect(forge.fileUrl('https://github.com/acme/shop', 'main', 'docs/STATUS.md', 24)).toBe('https://github.com/acme/shop/blob/main/docs/STATUS.md#L24')
    expect(forge.fileUrl('', 'main', 'docs/STATUS.md', 24)).toBe('')
  })
})

describe('github: repoInfo', () => {
  test('url (without .git or a trailing slash) and the default branch, from the repository root', async () => {
    const { forge, host } = forgeOf({ 'gh repo view --json url,defaultBranchRef': json({ url: 'https://github.com/acme/shop.git/', defaultBranchRef: { name: 'trunk' } }) })
    expect(ok(await forge.repoInfo())).toEqual({ webUrl: 'https://github.com/acme/shop', defaultBranch: 'trunk' })
    expect(host.inits[0]?.cwd).toBe(ROOT)
  })

  test('an empty repository has no default branch name', async () => {
    const { forge } = forgeOf({ 'gh repo view --json url,defaultBranchRef': json({ url: 'https://github.com/acme/shop', defaultBranchRef: null }) })
    expect(ok(await forge.repoInfo()).defaultBranch).toBe('')
  })

  test('a failure carries the problem; the caller falls back to git', async () => {
    const { forge } = forgeOf({ 'gh auth status --hostname github.com': { exitCode: 1 } })
    expect(await forge.repoInfo()).toEqual({ ok: false, problem: { kind: 'not-logged-in', cli: 'gh', host: 'github.com' } })
  })
})

describe('github: listChanges', () => {
  test('maps the rows; asks for the old field set plus head sha and draft', async () => {
    const { forge, host } = forgeOf({
      [list(BASE)]: json([
        row(1),
        row(2, { state: 'OPEN', mergedAt: null, isDraft: true, labels: [] }),
        row(3, { state: 'CLOSED', mergedAt: null, url: undefined }),
        row(4, { state: 'WEIRD' }),
      ]),
    })
    const rows = ok(await forge.listChanges())
    expect(host.lines).toEqual([list(BASE)])
    expect(rows.map(r => [r.number, r.state, r.isDraft, r.mergedAt, r.labels, r.url, r.headSha])).toEqual([
      [1, 'merged', false, '2026-10-01T09:00:00Z', ['reviewed:approved'], 'https://github.com/acme/shop/pull/1', 'sha1'],
      [2, 'open', true, null, [], 'https://github.com/acme/shop/pull/2', 'sha2'],
      [3, 'closed', false, null, ['reviewed:approved'], '', 'sha3'],
    ])
    expect(rows[0]).toMatchObject({ sourceBranch: 'feat/FEAT-GEN-1', review: '', ci: '', failingChecks: [], mergeState: '' })
  })

  test('state narrows the query: open with status, merged without, closed; the rollup is asked for open only', async () => {
    const listIn = (state: string, fields: string, limit: number) => `gh pr list --state ${state} --limit ${limit} --json ${fields}`
    const { forge, host } = forgeOf({
      [listIn('open', STATUS, 100)]: json([row(1, { state: 'OPEN', mergedAt: null })]),
      [listIn('merged', BASE, 200)]: json([row(2)]),
      [listIn('closed', BASE, 1000)]: json([row(3, { state: 'CLOSED', mergedAt: null })]),
    })
    expect(ok(await forge.listChanges({ state: 'open', withStatus: true, limit: 100 })).map(r => r.state)).toEqual(['open'])
    expect(ok(await forge.listChanges({ state: 'merged', limit: 200 })).map(r => r.state)).toEqual(['merged'])
    expect(ok(await forge.listChanges({ state: 'closed' })).map(r => r.state)).toEqual(['closed'])
    expect(host.lines).toHaveLength(3)
    expect(host.lines.filter(line => line.includes('statusCheckRollup'))).toEqual([listIn('open', STATUS, 100)])
  })

  test('timeoutMs bounds the call', async () => {
    const { forge, host } = forgeOf({ [list(BASE)]: json([]) })
    ok(await forge.listChanges({ timeoutMs: 12_000 }))
    expect(host.inits[0]?.timeoutMs).toBe(12_000)
  })

  test('a limit is passed through', async () => {
    const { forge, host } = forgeOf({ [list(BASE, 50)]: json([]) })
    ok(await forge.listChanges({ limit: 50 }))
    expect(host.lines).toEqual([list(BASE, 50)])
  })

  test('withStatus: review, merge state and checks of open changes only', async () => {
    const run = (conclusion: string | null, status = 'COMPLETED', name = 'build') => ({ __typename: 'CheckRun', name, status, conclusion })
    const { forge } = forgeOf({
      [list(STATUS)]: json([
        row(1, { state: 'OPEN', mergedAt: null, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [run('SUCCESS'), run('NEUTRAL', 'COMPLETED', 'lint')] }),
        row(2, { state: 'OPEN', mergedAt: null, reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BEHIND', statusCheckRollup: [run('FAILURE', 'COMPLETED', 'unit'), run('TIMED_OUT', 'COMPLETED', 'e2e'), run('SUCCESS'), { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' }] }),
        row(3, { state: 'OPEN', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', statusCheckRollup: [run('SUCCESS'), run(null, 'IN_PROGRESS', 'e2e')] }),
        row(4, { state: 'OPEN', mergedAt: null, reviewDecision: '', mergeStateStatus: 'DIRTY', statusCheckRollup: [] }),
        row(5, { state: 'OPEN', mergedAt: null, mergeStateStatus: 'UNKNOWN', statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }] }),
        row(6, { state: 'MERGED', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [run('FAILURE')] }),
      ]),
    })
    const by = new Map(ok(await forge.listChanges({ withStatus: true })).map(r => [r.number, r]))
    expect(by.get(1)).toMatchObject({ review: 'approved', mergeState: 'clean', ci: 'success', failingChecks: [] })
    expect(by.get(2)).toMatchObject({ review: 'changes-requested', mergeState: 'behind', ci: 'failed', failingChecks: ['unit', 'e2e', 'ci/legacy'] })
    expect(by.get(3)).toMatchObject({ review: 'required', mergeState: 'blocked', ci: 'running', failingChecks: [] })
    expect(by.get(4)).toMatchObject({ review: '', mergeState: 'dirty', ci: '' })
    expect(by.get(5)).toMatchObject({ review: '', mergeState: 'unknown', ci: 'running' })
    expect(by.get(6)).toMatchObject({ review: '', mergeState: '', ci: '', failingChecks: [] })
  })

  test('a failure carries the problem; unreadable output is a failure', async () => {
    const gone = forgeOf({ 'gh auth status --hostname github.com': { exitCode: 0 } })
    expect(await gone.forge.listChanges()).toEqual({ ok: false, problem: { kind: 'failed', cli: 'gh', host: 'github.com' } })
    const odd = forgeOf({ [list(BASE)]: json({ not: 'a list' }) })
    expect((await odd.forge.listChanges()).ok).toBe(false)
  })
})

describe('github: filesChanged', () => {
  test('gh pr view --json files', async () => {
    const { forge, host } = forgeOf({ 'gh pr view 33 --json files': json({ files: [{ path: 'src/a.ts', additions: 1 }, { path: 'docs/b.md' }] }) })
    expect(ok(await forge.filesChanged(33))).toEqual(['src/a.ts', 'docs/b.md'])
    expect(host.lines).toEqual(['gh pr view 33 --json files'])
  })
})

describe('github: fingerprint', () => {
  const rows = [
    { number: 12, state: 'OPEN', mergedAt: null, headRefOid: 'bbb' },
    { number: 3, state: 'MERGED', mergedAt: '2026-10-01T09:00:00Z', headRefOid: 'aaa' },
    { number: 7, state: 'CLOSED', mergedAt: null },
  ]
  // The digest the ledger computed before the forge layer: n:STATE:mergedAt:oid, sorted by number.
  const old = (list: typeof rows) =>
    inputHash([[...list].sort((a, b) => a.number - b.number).map(r => `${r.number}:${r.state}:${r.mergedAt ?? ''}:${(r as { headRefOid?: string }).headRefOid ?? ''}`).join(',')])

  test('equals the digest of the same rows as before, whatever order gh lists them in', async () => {
    const expected = await old(rows)
    expect(await forgeOf({ [FINGERPRINT]: json(rows) }).forge.fingerprint()).toBe(expected)
    expect(await forgeOf({ [FINGERPRINT]: json([...rows].reverse()) }).forge.fingerprint()).toBe(expected)
  })

  test('a merge, a push or a new change moves it', async () => {
    const before = await forgeOf({ [FINGERPRINT]: json(rows) }).forge.fingerprint()
    const merged = await forgeOf({ [FINGERPRINT]: json([{ ...rows[0]!, state: 'MERGED', mergedAt: '2026-10-02T00:00:00Z' }, ...rows.slice(1)]) }).forge.fingerprint()
    const pushed = await forgeOf({ [FINGERPRINT]: json([{ ...rows[0]!, headRefOid: 'ccc' }, ...rows.slice(1)]) }).forge.fingerprint()
    const added = await forgeOf({ [FINGERPRINT]: json([...rows, { number: 20, state: 'OPEN', mergedAt: null, headRefOid: 'ddd' }]) }).forge.fingerprint()
    expect(new Set([before, merged, pushed, added]).size).toBe(4)
  })

  test('throws a ForgeError with the pull-request wording; runs under the shorter timeout', async () => {
    const { forge, host } = forgeOf({ 'gh --version': 'reject', [FINGERPRINT]: 'reject' })
    const error = await forge.fingerprint().catch((e: unknown) => e)
    expect((error as { problem: unknown }).problem).toEqual({ kind: 'missing', cli: 'gh', host: 'github.com' })
    expect((error as { display: string }).display).toBe('Could not check pull requests (gh missing); they may be stale.')
    expect(host.inits[0]?.timeoutMs).toBe(12_000)
  })
})

describe('github: read-only', () => {
  test('nothing it runs writes', async () => {
    const { forge, host } = forgeOf({
      'gh repo view --json url,defaultBranchRef': json({ url: 'https://github.com/acme/shop' }),
      [list(STATUS)]: json([row(1, { state: 'OPEN', mergedAt: null })]),
      'gh pr view 1 --json files': json({ files: [] }),
      [FINGERPRINT]: json([]),
    })
    await forge.repoInfo()
    await forge.listChanges({ withStatus: true })
    await forge.filesChanged(1)
    await forge.fingerprint()
    expect(host.lines).toHaveLength(4)
    expect(host.lines.filter(isWriting)).toEqual([])
  })
})
