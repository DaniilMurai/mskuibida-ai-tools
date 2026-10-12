import { describe, expect, test } from 'claude-code/testing'
import { detectForge } from '../../src/forge'
import { gitlabForge } from '../../src/forge/gitlab'
import { parseRemote } from '../../src/forge/remote'
import type { Forge } from '../../src/forge'
import { approved, notApproved } from '../../fixtures/forge/gitlab-approvals'
import { changes } from '../../fixtures/forge/gitlab-changes'
import { GITLAB_HOST, GITLAB_PATH, GITLAB_WEB, history, mrRow, openRows, page } from '../../fixtures/forge/gitlab-mr-list'
import { mrView } from '../../fixtures/forge/gitlab-mr-view'
import type { PipelineStatus } from '../../fixtures/forge/gitlab-mr-view'
import { project } from '../../fixtures/forge/gitlab-project'
import { isWriting, json, scriptedHost } from './helpers'
import type { Script } from './helpers'

const ROOT = '/work/scanner'
const ENC = encodeURIComponent(GITLAB_PATH)
const API = `glab api --hostname ${GITLAB_HOST} projects/${ENC}`
const LIST = `glab mr list -R ${GITLAB_WEB} --all -F json`
const remote = parseRemote(`git@${GITLAB_HOST}:${GITLAB_PATH}.git`) as NonNullable<ReturnType<typeof parseRemote>>

/** The list pages of a history, as glab answers `-P 100 -p N`; a page past the end is []. */
function pages(rows: ReturnType<typeof page>[number][], upTo = 12): Script {
  const script: Script = {}
  for (let n = 1; n <= upTo; n++) script[`${LIST} -P 100 -p ${n}`] = json(rows.slice((n - 1) * 100, n * 100))
  return script
}

const forgeOf = (script: Script) => {
  const host = scriptedHost(script)
  return { host, forge: gitlabForge(host, ROOT, remote) }
}

const ok = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok).toBe(true)
  return r.value as T
}

describe('gitlab: identity', () => {
  test('refs are !N and file links use /-/blob/', () => {
    const { forge } = forgeOf({})
    expect(forge.kind).toBe('gitlab')
    expect(forge.refPrefix).toBe('!')
    expect(forge.refOf(275)).toBe('!275')
    expect(forge.fileUrl(GITLAB_WEB, 'main', 'docs/STATUS.md', 24)).toBe(`${GITLAB_WEB}/-/blob/main/docs/STATUS.md#L24`)
    expect(forge.fileUrl(GITLAB_WEB, 'main', 'docs/my notes.md', 3)).toBe(`${GITLAB_WEB}/-/blob/main/docs/my%20notes.md#L3`)
    expect(forge.fileUrl('', 'main', 'docs/STATUS.md', 24)).toBe('')
  })
})

describe('gitlab: repoInfo', () => {
  test('web_url and default_branch from the project, the path url-encoded', async () => {
    const { forge, host } = forgeOf({ [API]: json(project) })
    expect(ok(await forge.repoInfo())).toEqual({ webUrl: GITLAB_WEB, defaultBranch: 'main' })
    expect(host.lines).toEqual([API])
    expect(API).toContain('acme%2Fplatform%2Fscanner')
  })

  test('a failure carries the classified problem', async () => {
    const { forge } = forgeOf({ [API]: { exitCode: 1 }, [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 1 } })
    expect(await forge.repoInfo()).toEqual({ ok: false, problem: { kind: 'not-logged-in', cli: 'glab', host: GITLAB_HOST } })
  })
})

describe('gitlab: listChanges mapping', () => {
  test('a merged row', async () => {
    const { forge } = forgeOf(pages([history[0]!]))
    const [change] = ok(await forge.listChanges())
    expect(change).toEqual({
      number: 275,
      title: history[0]!.title,
      state: 'merged',
      isDraft: false,
      sourceBranch: history[0]!.source_branch,
      url: `${GITLAB_WEB}/-/merge_requests/275`,
      mergedAt: history[0]!.merged_at,
      labels: history[0]!.labels,
      headSha: history[0]!.sha,
      review: '',
      ci: '',
      failingChecks: [],
      mergeState: '',
    })
  })

  test('closed has no merged_at; opened and locked are open; an unknown state is dropped', async () => {
    const closed = history.find(r => r.state === 'closed')!
    const { forge } = forgeOf(pages([closed, mrRow(300, { state: 'opened', merged_at: null }), mrRow(301, { state: 'locked', merged_at: null }), { ...mrRow(302), state: 'weird' as never }]))
    const rows = ok(await forge.listChanges())
    expect(rows.map(r => [r.number, r.state, r.mergedAt])).toEqual([[closed.iid, 'closed', null], [300, 'open', null], [301, 'open', null]])
  })

  test('draft, labels and a missing web_url or sha', async () => {
    const { forge } = forgeOf(pages([{ ...mrRow(310, { state: 'opened', merged_at: null, draft: true, labels: ['qa:passed', 'reviewed:approved'] }), web_url: undefined as never, sha: undefined as never }]))
    const [row] = ok(await forge.listChanges())
    expect(row).toMatchObject({ isDraft: true, labels: ['qa:passed', 'reviewed:approved'], url: '', headSha: '' })
  })

  test('detailed_merge_status becomes mergeState, for open requests only', async () => {
    const expected: Record<string, string> = {
      mergeable: 'clean',
      need_rebase: 'behind',
      conflict: 'dirty',
      broken_status: 'dirty',
      not_approved: 'blocked',
      blocked_status: 'blocked',
      discussions_not_resolved: 'blocked',
      draft_status: 'blocked',
      ci_must_pass: 'blocked',
      not_open: 'blocked',
      requested_changes: 'blocked',
      checking: 'unknown',
      unchecked: 'unknown',
      ci_still_running: 'unknown',
      preparing: 'unknown',
      something_new: '',
    }
    const rows = Object.keys(expected).map((status, i) => mrRow(400 + i, { state: 'opened', merged_at: null, detailed_merge_status: status }))
    const { forge } = forgeOf(pages([...rows, mrRow(399, { detailed_merge_status: 'mergeable' })]))
    const got = ok(await forge.listChanges())
    expect(got.slice(0, rows.length).map(c => c.mergeState)).toEqual(Object.values(expected))
    expect(got.at(-1)?.mergeState).toBe('')
  })

  test('without withStatus the list stands alone: no view, no approvals', async () => {
    const { forge, host } = forgeOf({ ...pages(openRows) })
    ok(await forge.listChanges())
    expect(host.lines).toEqual([`${LIST} -P 100 -p 1`])
  })
})

describe('gitlab: state filter', () => {
  test('open is glab\'s default (no flag), merged and closed are flags, all is --all', async () => {
    const { forge, host } = forgeOf({
      [`glab mr list -R ${GITLAB_WEB} -F json -P 100 -p 1`]: json(openRows),
      [`glab mr list -R ${GITLAB_WEB} --merged -F json -P 100 -p 1`]: json(history.slice(0, 3)),
      [`glab mr list -R ${GITLAB_WEB} --closed -F json -P 100 -p 1`]: json([]),
      [`${LIST} -P 100 -p 1`]: json([]),
    })
    expect(ok(await forge.listChanges({ state: 'open' }))).toHaveLength(openRows.length)
    expect(ok(await forge.listChanges({ state: 'merged' })).map(r => r.state)).toEqual(['merged', 'merged', 'merged'])
    ok(await forge.listChanges({ state: 'closed' }))
    ok(await forge.listChanges({ state: 'all' }))
    expect(host.lines).toEqual([
      `glab mr list -R ${GITLAB_WEB} -F json -P 100 -p 1`,
      `glab mr list -R ${GITLAB_WEB} --merged -F json -P 100 -p 1`,
      `glab mr list -R ${GITLAB_WEB} --closed -F json -P 100 -p 1`,
      `${LIST} -P 100 -p 1`,
    ])
  })

  test('open with status looks up the open requests only, each under the given timeout', async () => {
    const { forge, host } = forgeOf({
      [`glab mr list -R ${GITLAB_WEB} -F json -P 100 -p 1`]: json([openRows[0]]),
      [`glab mr view 281 -R ${GITLAB_WEB} -F json`]: json(mrView(281, 'failed')),
      [`${API}/merge_requests/281/approvals`]: json(approved),
    })
    const rows = ok(await forge.listChanges({ state: 'open', withStatus: true, limit: 100, timeoutMs: 20_000 }))
    expect(rows[0]).toMatchObject({ number: 281, ci: 'failed', review: 'approved', mergeState: 'clean' })
    expect(host.lines).toHaveLength(3)
    expect(host.inits.every(init => init?.timeoutMs === 20_000)).toBe(true)
  })
})

describe('gitlab: paging', () => {
  test('275 rows are three pages: 100, 100, 75; it stops at the short page', async () => {
    const { forge, host } = forgeOf(pages(history))
    const rows = ok(await forge.listChanges())
    expect(rows).toHaveLength(275)
    expect(rows.map(r => r.number)).toEqual(history.map(r => r.iid))
    expect(host.lines).toEqual([1, 2, 3].map(n => `${LIST} -P 100 -p ${n}`))
    expect(page(1)).toHaveLength(100)
    expect(page(3)).toHaveLength(75)
  })

  test('a full last page costs one more request, which comes back empty', async () => {
    const { forge, host } = forgeOf(pages(history.slice(0, 200)))
    expect(ok(await forge.listChanges())).toHaveLength(200)
    expect(host.lines).toHaveLength(3)
  })

  test('a limit caps the pages asked for and the rows returned', async () => {
    const { forge, host } = forgeOf(pages(history))
    expect(ok(await forge.listChanges({ limit: 150 }))).toHaveLength(150)
    expect(host.lines).toEqual([`${LIST} -P 100 -p 1`, `${LIST} -P 100 -p 2`])
    const one = forgeOf(pages(history))
    expect(ok(await one.forge.listChanges({ limit: 30 }))).toHaveLength(30)
    expect(one.host.lines).toHaveLength(1)
  })

  test('the default limit is 1000: ten pages at most', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => mrRow(2000 - i))
    const { forge, host } = forgeOf(pages(rows))
    expect(ok(await forge.listChanges())).toHaveLength(1000)
    expect(host.lines).toHaveLength(10)
  })

  test('a page that fails fails the whole list, with the problem', async () => {
    const script: Script = { ...pages(history), [`${LIST} -P 100 -p 2`]: { exitCode: 1 }, [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 0 } }
    const { forge } = forgeOf(script)
    expect(await forge.listChanges()).toEqual({ ok: false, problem: { kind: 'failed', cli: 'glab', host: GITLAB_HOST } })
  })

  test('a project with no merge requests: empty output, whitespace or null is an empty list, not a failure', async () => {
    for (const stdout of ['', '   \n', 'null', '[]']) {
      const { forge, host } = forgeOf({ [`${LIST} -P 100 -p 1`]: { stdout } })
      expect(ok(await forge.listChanges())).toEqual([])
      expect(host.lines).toEqual([`${LIST} -P 100 -p 1`])
    }
  })

  test('exactly 100 rows ending on an empty page (null) are 100 rows', async () => {
    const { forge } = forgeOf({ [`${LIST} -P 100 -p 1`]: json(history.slice(0, 100)), [`${LIST} -P 100 -p 2`]: { stdout: 'null' } })
    expect(ok(await forge.listChanges())).toHaveLength(100)
  })

  test('the fingerprint of a project with no merge requests is a digest, not an error', async () => {
    const { forge } = forgeOf({ [`${LIST} -P 30 -o updated_at -S desc`]: { stdout: '' } })
    expect(await forge.fingerprint()).not.toBe('')
  })

  test('output that is not a JSON list is a failure, not a crash', async () => {
    const { forge } = forgeOf({ [`${LIST} -P 100 -p 1`]: { stdout: 'not json' } })
    expect((await forge.listChanges()).ok).toBe(false)
    const obj = forgeOf({ [`${LIST} -P 100 -p 1`]: json({ message: '401' }) })
    expect((await obj.forge.listChanges()).ok).toBe(false)
  })
})

describe('gitlab: listChanges with status', () => {
  const view = (iid: number, status: PipelineStatus | null) => json(mrView(iid, status))
  const viewKey = (iid: number) => `glab mr view ${iid} -R ${GITLAB_WEB} -F json`
  const approvalsKey = (iid: number) => `${API}/merge_requests/${iid}/approvals`

  test('the pipeline status and the approval of each open request', async () => {
    const { forge, host } = forgeOf({
      ...pages([...openRows, ...history.slice(0, 5)]),
      [viewKey(281)]: view(281, 'success'),
      [approvalsKey(281)]: json(approved),
      [viewKey(280)]: view(280, 'running'),
      [approvalsKey(280)]: json(notApproved),
      [viewKey(279)]: view(279, 'failed'),
      [approvalsKey(279)]: json(notApproved),
      [viewKey(278)]: view(278, null),
      [approvalsKey(278)]: json(notApproved),
      [viewKey(277)]: view(277, 'manual'),
      [approvalsKey(277)]: json(approved),
      [viewKey(276)]: view(276, 'canceled'),
    })
    const rows = ok(await forge.listChanges({ withStatus: true }))
    const by = (n: number) => rows.find(r => r.number === n)!
    expect(by(281)).toMatchObject({ ci: 'success', review: 'approved', mergeState: 'clean' })
    expect(by(280)).toMatchObject({ ci: 'running', review: 'required', isDraft: true })
    expect(by(279)).toMatchObject({ ci: 'failed', review: 'required', mergeState: 'behind' })
    expect(by(278)).toMatchObject({ ci: '', review: 'required' })
    expect(by(277)).toMatchObject({ ci: 'pending', review: 'approved' })
    // requested_changes: no approvals call, review says so.
    expect(by(276)).toMatchObject({ ci: 'canceled', review: 'changes-requested' })
    expect(host.lines).not.toContain(approvalsKey(276))
    // Merged ones are never looked up.
    expect(by(275)).toMatchObject({ ci: '', review: '' })
    expect(host.lines.filter(l => l.startsWith('glab mr view'))).toHaveLength(6)
    expect(host.lines.filter(isWriting)).toEqual([])
  })

  test('every pipeline status maps', async () => {
    const statuses: [PipelineStatus, string][] = [
      ['success', 'success'], ['failed', 'failed'], ['running', 'running'], ['pending', 'pending'], ['created', 'pending'],
      ['waiting_for_resource', 'pending'], ['preparing', 'pending'], ['scheduled', 'pending'], ['manual', 'pending'],
      ['canceled', 'canceled'], ['skipped', 'skipped'],
    ]
    for (const [status, ci] of statuses) {
      const { forge } = forgeOf({ ...pages([mrRow(500, { state: 'opened', merged_at: null })]), [viewKey(500)]: view(500, status), [approvalsKey(500)]: json(notApproved) })
      expect(ok(await forge.listChanges({ withStatus: true }))[0]?.ci).toBe(ci)
    }
  })

  test('a failing approvals or view call leaves that field empty, not an error', async () => {
    const { forge } = forgeOf({ ...pages([mrRow(501, { state: 'opened', merged_at: null })]), [viewKey(501)]: { exitCode: 1 }, [approvalsKey(501)]: { exitCode: 1 } })
    expect(ok(await forge.listChanges({ withStatus: true }))[0]).toMatchObject({ number: 501, ci: '', review: '' })
  })

  test('a failed approvals or view call runs no classify probes', async () => {
    const { forge, host } = forgeOf({ ...pages([mrRow(502, { state: 'opened', merged_at: null })]), [viewKey(502)]: { exitCode: 1 }, [approvalsKey(502)]: { exitCode: 1 } })
    expect(ok(await forge.listChanges({ withStatus: true }))[0]).toMatchObject({ ci: '', review: '' })
    expect(host.lines.filter(line => line.includes('auth status') || line.includes('--version'))).toEqual([])
  })

  test('a light status skips the approvals: the pipeline only, requested changes still read from the list', async () => {
    const rows = [mrRow(503, { state: 'opened', merged_at: null }), mrRow(504, { state: 'opened', merged_at: null, detailed_merge_status: 'requested_changes' })]
    const { forge, host } = forgeOf({ ...pages(rows), [viewKey(503)]: view(503, 'failed'), [viewKey(504)]: view(504, 'running') })
    const got = ok(await forge.listChanges({ withStatus: true, isLight: true }))
    expect(got.map(c => [c.number, c.ci, c.review])).toEqual([[503, 'failed', ''], [504, 'running', 'changes-requested']])
    expect(host.lines.some(line => line.endsWith('/approvals'))).toBe(false)
  })

  test('at most 5 glab calls per merge request run at once', async () => {
    const open = Array.from({ length: 12 }, (_, i) => mrRow(800 - i, { state: 'opened', merged_at: null }))
    const inner = scriptedHost(pages(open))
    let live = 0
    let peak = 0
    let calls = 0
    const run: typeof inner.run = async (argv, init) => {
      if (argv[1] === 'mr' && argv[2] === 'list') return inner.run(argv, init)
      live++
      calls++
      peak = Math.max(peak, live)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      live--
      const stdout = argv[2] === 'view' ? JSON.stringify(mrView(Number(argv[3]), 'success')) : JSON.stringify(approved)
      return { exitCode: 0, stdout, stderr: '' }
    }
    const rows = ok(await gitlabForge({ ...inner, run }, ROOT, remote).listChanges({ withStatus: true }))
    expect(calls).toBe(24)
    expect(peak).toBe(5)
    expect(rows.every(r => r.ci === 'success' && r.review === 'approved')).toBe(true)
  })

  test('at most 20 open requests are looked up', async () => {
    const open = Array.from({ length: 30 }, (_, i) => mrRow(700 - i, { state: 'opened', merged_at: null }))
    const script: Script = { ...pages(open) }
    for (const row of open) {
      script[viewKey(row.iid)] = view(row.iid, 'success')
      script[approvalsKey(row.iid)] = json(approved)
    }
    const { forge, host } = forgeOf(script)
    const rows = ok(await forge.listChanges({ withStatus: true }))
    expect(rows).toHaveLength(30)
    expect(rows.filter(r => r.ci === 'success')).toHaveLength(20)
    expect(host.lines.filter(l => l.startsWith('glab mr view'))).toHaveLength(20)
  })

  test('the lookups run together', async () => {
    const open = [mrRow(601, { state: 'opened', merged_at: null }), mrRow(600, { state: 'opened', merged_at: null })]
    const inner = scriptedHost(pages(open))
    let live = 0
    let peak = 0
    const run: typeof inner.run = async (argv, init) => {
      if (argv[2] !== 'view') return inner.run(argv, init)
      live++
      peak = Math.max(peak, live)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      live--
      return { exitCode: 0, stdout: JSON.stringify(mrView(Number(argv[3]), 'success')), stderr: '' }
    }
    await gitlabForge({ ...inner, run }, ROOT, remote).listChanges({ withStatus: true })
    expect(peak).toBe(2)
  })
})

describe('gitlab: filesChanged', () => {
  const DIFFS = (n: number, page = 1) => `${API}/merge_requests/${n}/diffs?per_page=100${page > 1 ? `&page=${page}` : ''}`
  const file = (path: string, over: Record<string, unknown> = {}) => ({ old_path: path, new_path: path, deleted_file: false, diff: '', ...over })

  test('new paths, plus the old path of a deleted file, each once (from /diffs)', async () => {
    const { forge, host } = forgeOf({ [DIFFS(281)]: json(changes.changes) })
    expect(ok(await forge.filesChanged(281))).toEqual(['docs/notes/FEAT-GEN-281.md', 'src/app.ts', 'src/new-name.ts', 'src/gone.ts'])
    expect(host.lines).toEqual([DIFFS(281)])
  })

  test('/diffs is paged: a full page asks the next, a short one ends it', async () => {
    const first = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`))
    const { forge, host } = forgeOf({ [DIFFS(5)]: json(first), [DIFFS(5, 2)]: json([file('src/last.ts')]) })
    const paths = ok(await forge.filesChanged(5))
    expect(paths).toHaveLength(101)
    expect(paths.at(-1)).toBe('src/last.ts')
    expect(host.lines).toEqual([DIFFS(5), DIFFS(5, 2)])
  })

  test('a merge request with no files: empty, blank and null bodies are []', async () => {
    for (const stdout of ['', '  \n', 'null', '[]']) {
      const { forge } = forgeOf({ [DIFFS(6)]: { stdout } })
      expect(ok(await forge.filesChanged(6))).toEqual([])
    }
  })

  test('an older GitLab without /diffs falls back to /changes', async () => {
    const { forge, host } = forgeOf({
      [DIFFS(281)]: { exitCode: 1, stderr: '404 Not Found' },
      [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 0 },
      [`${API}/merge_requests/281/changes`]: json(changes),
    })
    expect(ok(await forge.filesChanged(281))).toEqual(['docs/notes/FEAT-GEN-281.md', 'src/app.ts', 'src/new-name.ts', 'src/gone.ts'])
    expect(host.lines.at(-1)).toBe(`${API}/merge_requests/281/changes`)
  })

  test('not logged in is not a reason to try /changes', async () => {
    const { forge, host } = forgeOf({ [DIFFS(1)]: { exitCode: 1 }, [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 1, stderr: 'no token' } })
    expect(await forge.filesChanged(1)).toEqual({ ok: false, problem: { kind: 'not-logged-in', cli: 'glab', host: GITLAB_HOST } })
    expect(host.lines.some(line => line.endsWith('/changes'))).toBe(false)
  })

  test('a failure of both is a result, not a throw', async () => {
    const { forge } = forgeOf({ [DIFFS(1)]: { exitCode: 1 }, [`${API}/merge_requests/1/changes`]: { exitCode: 1 }, [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 0 } })
    expect((await forge.filesChanged(1)).ok).toBe(false)
  })
})

describe('gitlab: fingerprint', () => {
  const key = `${LIST} -P 30 -o updated_at -S desc`

  test('stable for the same rows', async () => {
    const a = await forgeOf({ [key]: json(history.slice(0, 30)) }).forge.fingerprint()
    const b = await forgeOf({ [key]: json(history.slice(0, 30)) }).forge.fingerprint()
    expect(a).not.toBe('')
    expect(a).toBe(b)
  })

  test('a new request, a state change or a push moves it', async () => {
    const base = history.slice(0, 30)
    const before = await forgeOf({ [key]: json(base) }).forge.fingerprint()
    const created = await forgeOf({ [key]: json([mrRow(300, { state: 'opened', merged_at: null }), ...base]) }).forge.fingerprint()
    const merged = await forgeOf({ [key]: json([{ ...base[0]!, state: 'closed' }, ...base.slice(1)]) }).forge.fingerprint()
    const pushed = await forgeOf({ [key]: json([{ ...base[0]!, sha: 'f'.repeat(40), updated_at: '2026-10-09T00:00:00.000Z' }, ...base.slice(1)]) }).forge.fingerprint()
    expect(new Set([before, created, merged, pushed]).size).toBe(4)
  })

  test('throws a ForgeError whose display names the cause', async () => {
    const { forge } = forgeOf({ [key]: { exitCode: 1 }, [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 1 } })
    const error = await forge.fingerprint().catch((e: unknown) => e)
    expect((error as { problem: unknown }).problem).toEqual({ kind: 'not-logged-in', cli: 'glab', host: GITLAB_HOST })
    expect((error as { display: string }).display).toBe(`Could not check merge requests (glab not logged in to ${GITLAB_HOST}); they may be stale.`)
  })

  test('runs one cheap command with its own, shorter timeout', async () => {
    const { forge, host } = forgeOf({ [key]: json([]) })
    await forge.fingerprint()
    expect(host.lines).toEqual([key])
    expect(host.inits[0]?.timeoutMs).toBe(12_000)
  })
})

describe('gitlab: read-only, end to end through detection', () => {
  test('a whole session of reads runs nothing that writes', async () => {
    const script: Script = {
      [`git -C ${ROOT} remote get-url origin`]: { stdout: `git@${GITLAB_HOST}:${GITLAB_PATH}.git\n` },
      [`glab auth status --hostname ${GITLAB_HOST}`]: { exitCode: 0 },
      [API]: json(project),
      ...pages(history),
      [`${API}/merge_requests/275/diffs?per_page=100`]: json(changes.changes),
      [`${LIST} -P 30 -o updated_at -S desc`]: json(history.slice(0, 30)),
    }
    const host = scriptedHost(script)
    const detected = await detectForge(host, ROOT, 'auto')
    const forge = detected.forge as Forge
    await forge.repoInfo()
    await forge.listChanges()
    await forge.filesChanged(275)
    await forge.fingerprint()
    expect(host.lines.length).toBeGreaterThan(6)
    expect(host.lines.filter(isWriting)).toEqual([])
    for (const line of host.lines) expect(line).toMatch(/^(git -C \S+ remote get-url origin|glab (auth status|api|mr list|mr view) )/)
  })
})
