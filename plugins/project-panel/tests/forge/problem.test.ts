import { describe, expect, test } from 'claude-code/testing'
import { ForgeError, classify, problemText } from '../../src/forge'
import { createRefreshEngine } from '../../src/refresh'
import type { RefreshPorts, Timer } from '../../src/refresh'
import { en } from '../../src/strings/en'
import type { PanelModel } from '../../types'
import { scriptedHost } from './helpers'

declare const setTimeout: (fn: () => void, ms: number) => unknown

const HOST = 'gitlab.example.test'
const rejected = { isRejected: true } as const
const exited = (stderr = '', exitCode = 1) => ({ isRejected: false, exitCode, stderr }) as const

describe('problemText', () => {
  test('each cause reads as a short phrase', () => {
    expect(problemText({ kind: 'not-logged-in', cli: 'glab', host: HOST })).toBe('glab not logged in to gitlab.example.test')
    expect(problemText({ kind: 'missing', cli: 'gh', host: 'github.com' })).toBe('gh missing')
    expect(problemText({ kind: 'unreachable', cli: 'glab', host: HOST })).toBe('could not reach gitlab.example.test')
    expect(problemText({ kind: 'failed', cli: 'glab', host: HOST })).toBe('glab failed')
    expect(problemText({ kind: 'no-remote', cli: '', host: '' })).toBe('no origin remote')
  })
})

describe('classify', () => {
  test('a call that never ran and a CLI that will not even print its version: missing', async () => {
    const host = scriptedHost({ 'glab --version': 'reject' })
    expect(await classify(host, 'glab', HOST, rejected)).toEqual({ kind: 'missing', cli: 'glab', host: HOST })
    expect(host.lines).toEqual(['glab --version'])
    expect(host.inits[0]?.timeoutMs).toBe(5000)
  })

  test('a call that never ran but the CLI answers its version: it timed out, so unreachable', async () => {
    const host = scriptedHost({ 'gh --version': { stdout: 'gh version 2.0.0' } })
    expect(await classify(host, 'gh', 'github.com', rejected)).toEqual({ kind: 'unreachable', cli: 'gh', host: 'github.com' })
  })

  test('a non-zero exit and a failing auth status: not logged in', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 1, stderr: 'no token found' } })
    expect(await classify(host, 'glab', HOST, exited('401'))).toEqual({ kind: 'not-logged-in', cli: 'glab', host: HOST })
  })

  test('auth status failing because the network is down is unreachable, not logged out', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 1, stderr: 'dial tcp: lookup gitlab.example.test: no such host' } })
    expect((await classify(host, 'glab', HOST, exited())).kind).toBe('unreachable')
  })

  test('logged in, and stderr that looks like a network error: unreachable', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 0 } })
    for (const stderr of ['Could not resolve host: gitlab.example.test', 'i/o timeout', 'connection refused', 'network is unreachable', 'unexpected EOF', 'dial tcp 10.0.0.1:443']) {
      expect((await classify(host, 'glab', HOST, exited(stderr))).kind).toBe('unreachable')
    }
  })

  test('logged in and some other stderr: failed', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 0 } })
    expect(await classify(host, 'glab', HOST, exited('404 Project Not Found'))).toEqual({ kind: 'failed', cli: 'glab', host: HOST })
  })

  test('an address in stderr is not a network error: a 404 on acme/network-tools, or a path with timeout, connection, EOF', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 0 } })
    for (const stderr of [
      `GET https://${HOST}/api/v4/projects/acme%2Fnetwork-tools: 404 {message: 404 Project Not Found}`,
      `GET https://${HOST}/api/v4/projects/acme%2Fconnection-pool/merge_requests/1/diffs: 404 Not Found`,
      `404 Not Found: projects/acme/timeout-service`,
      `404 Not Found (projects/acme/EOF)`,
      `Get "https://${HOST}/acme/timeout/EOF": 404 Not Found`,
      `could not find acme/connection refused-docs`,
    ]) {
      expect(await classify(host, 'glab', HOST, exited(stderr))).toEqual({ kind: 'failed', cli: 'glab', host: HOST })
    }
  })

  test('real error shapes still read as unreachable, even with the URL beside them', async () => {
    const host = scriptedHost({ [`glab auth status --hostname ${HOST}`]: { exitCode: 0 } })
    for (const stderr of [
      `Get "https://${HOST}/api/v4/projects/acme%2Fshop": dial tcp: lookup ${HOST}: no such host`,
      `Get "https://${HOST}/api/v4/projects": net/http: TLS handshake timeout`,
      `Get "https://${HOST}/api/v4/projects": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
      `read tcp 10.0.0.2:51234->10.0.0.1:443: connection reset by peer`,
      `Get "https://${HOST}/api/v4/projects": dial tcp 10.0.0.1:443: i/o timeout`,
      `Get "https://${HOST}/api/v4/projects": EOF`,
      `error\nunexpected EOF\n`,
    ]) {
      expect((await classify(host, 'glab', HOST, exited(stderr))).kind).toBe('unreachable')
    }
  })

  test('only reads: version and auth status', async () => {
    const host = scriptedHost({})
    await classify(host, 'gh', 'github.com', rejected)
    await classify(host, 'gh', 'github.com', exited())
    expect(host.lines).toEqual(['gh --version', 'gh auth status --hostname github.com'])
  })
})

describe('ForgeError', () => {
  test('carries the problem and the finished line for each forge kind', () => {
    const problem = { kind: 'not-logged-in', cli: 'glab', host: HOST } as const
    const gitlab = new ForgeError(problem, 'gitlab')
    expect(gitlab.problem).toEqual(problem)
    expect(gitlab.display).toBe('Could not check merge requests (glab not logged in to gitlab.example.test); they may be stale.')
    expect(gitlab.message).toBe('glab not logged in to gitlab.example.test')
    const github = new ForgeError({ kind: 'missing', cli: 'gh', host: 'github.com' }, 'github')
    expect(github.display).toBe('Could not check pull requests (gh missing); they may be stale.')
    expect(github).toBeInstanceOf(Error)
  })

  test('the copy never spells a change number with # or !', () => {
    for (const [key, text] of Object.entries(en)) {
      if (key.startsWith('forge.') || key.startsWith('refresh.remoteFailed') || key.startsWith('ledger.caption.noChanges')) expect(text).not.toMatch(/[#!]/)
    }
  })
})

// ── the refresh engine shows the display text ────────────────────────────────

const timers: Timer = { cancel() {} }

function engineWith(fingerprint: () => Promise<string | null>) {
  const published: (PanelModel | null)[] = []
  const model: PanelModel = {
    version: 2,
    provider: 'ledger',
    root: '/work/scanner',
    header: { title: 'T', mode: 'inferred', subtitle: '', badge: '', caption: '', updatedAt: '' },
    overall: { counts: { total: 0 } },
    sections: [],
    gates: [],
    drift: [],
    watch: [],
    readAt: 0,
  }
  const ports: RefreshPorts = {
    now: async () => 1000,
    after: () => timers,
    every: () => timers,
    load: async () => model,
    fingerprint,
    mtime: async () => null,
    run: async () => ({ exitCode: 1, stdout: '' }),
    publish: async m => void published.push(m),
    invalidate: async () => undefined,
    isVisible: async () => true,
  }
  const engine = createRefreshEngine(ports, { startDir: '/work/scanner', isEnabled: true, fsPollSeconds: 0, prPollSeconds: 0 })
  return { engine, published }
}

describe('the refresh line', () => {
  test('a ForgeError shows its display text', async () => {
    const error = new ForgeError({ kind: 'not-logged-in', cli: 'glab', host: HOST }, 'gitlab')
    const { engine, published } = engineWith(async () => {
      throw error
    })
    await engine.seed(null)
    await engine.readNow()
    await engine.attach()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await engine.readNow({ manual: true })
    expect(published.at(-1)?.freshness?.error).toBe('Could not check merge requests (glab not logged in to gitlab.example.test); they may be stale.')
  })

  test('any other error gets the generic line', async () => {
    const { engine, published } = engineWith(async () => {
      throw new Error('boom')
    })
    await engine.readNow()
    await engine.attach()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await engine.readNow({ manual: true })
    expect(published.at(-1)?.freshness?.error).toBe('Could not check the remote; changes may be stale.')
  })
})
