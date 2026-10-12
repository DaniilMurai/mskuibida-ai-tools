import { describe, expect, test as base } from 'claude-code/testing'
import { detectForge, resetForgeCache, setForgeClock } from '../../src/forge'
import { isWriting, scriptedHost } from './helpers'
import type { Script } from './helpers'

const ROOT = '/work/scanner'
const ORIGIN = `git -C ${ROOT} remote get-url origin`
const origin = (url: string) => ({ [ORIGIN]: { stdout: `${url}\n` } })
const SELF_HOSTED = 'git@gitlab.example.test:acme/platform/scanner.git'

/** Every test starts with no remembered detections. */
const test = (name: string, fn: () => Promise<void>) =>
  base(name, async () => {
    resetForgeCache()
    await fn()
  })

describe('detectForge', () => {
  test('github.com is GitHub and nothing is probed', async () => {
    const host = scriptedHost(origin('git@github.com:acme/shop.git'))
    const { forge, problem } = await detectForge(host, ROOT, 'auto')
    expect(forge?.kind).toBe('github')
    expect(forge?.refPrefix).toBe('#')
    expect(problem).toBeUndefined()
    expect(host.lines).toEqual([ORIGIN])
  })

  test('a custom host glab is logged in to is GitLab', async () => {
    const host = scriptedHost({ ...origin(SELF_HOSTED), 'glab auth status --hostname gitlab.example.test': { exitCode: 0 } })
    const { forge } = await detectForge(host, ROOT, 'auto')
    expect(forge?.kind).toBe('gitlab')
    expect(forge?.refPrefix).toBe('!')
    expect(forge?.remote).toEqual({ host: 'gitlab.example.test', path: 'acme/platform/scanner', scheme: 'ssh' })
    expect(host.lines).toEqual([ORIGIN, 'glab auth status --hostname gitlab.example.test'])
  })

  test('glab fails, gh is logged in: GitHub Enterprise', async () => {
    const host = scriptedHost({ ...origin('git@git.corp.example.test:acme/shop.git'), 'gh auth status --hostname git.corp.example.test': { exitCode: 0 } })
    const { forge } = await detectForge(host, ROOT, 'auto')
    expect(forge?.kind).toBe('github')
    expect(host.lines).toEqual([ORIGIN, 'glab auth status --hostname git.corp.example.test', 'gh auth status --hostname git.corp.example.test'])
  })

  test('the host key carries the port of an https remote', async () => {
    const host = scriptedHost({ ...origin('https://gitlab.example.test:8443/acme/scanner.git'), 'glab auth status --hostname gitlab.example.test:8443': { exitCode: 0 } })
    expect((await detectForge(host, ROOT, 'auto')).forge?.kind).toBe('gitlab')
  })

  test('neither is logged in: GitLab anyway, and its calls report the real problem', async () => {
    const host = scriptedHost({
      ...origin(SELF_HOSTED),
      // glab is installed but has no login for the host.
      'glab auth status --hostname gitlab.example.test': { exitCode: 1, stderr: 'no token' },
      'gh auth status --hostname gitlab.example.test': { exitCode: 1 },
      'glab api --hostname gitlab.example.test projects/acme%2Fplatform%2Fscanner': { exitCode: 1, stderr: '401' },
    })
    const { forge, problem } = await detectForge(host, ROOT, 'auto')
    expect(forge?.kind).toBe('gitlab')
    expect(problem).toBeUndefined()
    const info = await forge!.repoInfo()
    expect(info).toEqual({ ok: false, problem: { kind: 'not-logged-in', cli: 'glab', host: 'gitlab.example.test' } })
  })

  test('glab not installed: the call says missing', async () => {
    const host = scriptedHost({
      ...origin(SELF_HOSTED),
      'glab auth status --hostname gitlab.example.test': 'reject',
      'gh auth status --hostname gitlab.example.test': 'reject',
      'glab api --hostname gitlab.example.test projects/acme%2Fplatform%2Fscanner': 'reject',
      'glab --version': 'reject',
    })
    const { forge } = await detectForge(host, ROOT, 'auto')
    expect(await forge!.repoInfo()).toEqual({ ok: false, problem: { kind: 'missing', cli: 'glab', host: 'gitlab.example.test' } })
  })

  test('a positive detection is remembered per root and origin: the probe runs once', async () => {
    const host = scriptedHost({ ...origin(SELF_HOSTED), 'glab auth status --hostname gitlab.example.test': { exitCode: 0 } })
    const first = await detectForge(host, ROOT, 'auto')
    const second = await detectForge(host, ROOT, 'auto')
    expect(second.forge?.kind).toBe('gitlab')
    expect(second.isFallback).toBeUndefined()
    expect(host.lines.filter(l => l.startsWith('glab auth'))).toHaveLength(1)
    expect(first.forge).not.toBe(second.forge)
  })

  test('only the KIND is remembered: the forge is rebuilt with the host of each call', async () => {
    const detected = scriptedHost({ ...origin(SELF_HOSTED), 'glab auth status --hostname gitlab.example.test': { exitCode: 0 } })
    await detectForge(detected, ROOT, 'auto')
    const api = 'glab api --hostname gitlab.example.test projects/acme%2Fplatform%2Fscanner'
    const later = scriptedHost({ ...origin(SELF_HOSTED), [api]: { stdout: JSON.stringify({ web_url: 'https://gitlab.example.test/acme/platform/scanner', default_branch: 'trunk' }) } })
    const { forge } = await detectForge(later, ROOT, 'auto')
    expect(await forge!.repoInfo()).toMatchObject({ ok: true, value: { defaultBranch: 'trunk' } })
    expect(later.lines).toContain(api)
    expect(detected.lines.filter(l => l.startsWith('glab api'))).toEqual([])
  })

  test('a fallback is remembered for 60 s: no auth probes on the next loads, then they run again', async () => {
    let at = 1_000_000
    setForgeClock(() => at)
    const host = scriptedHost(origin(SELF_HOSTED))
    const first = await detectForge(host, ROOT, 'auto')
    expect(first.isFallback).toBe(true)
    expect(host.lines.filter(l => l.includes('auth status'))).toHaveLength(2)

    at += 59_000
    expect((await detectForge(host, ROOT, 'auto')).forge?.kind).toBe('gitlab')
    expect(host.lines.filter(l => l.includes('auth status'))).toHaveLength(2)

    at += 2_000
    await detectForge(host, ROOT, 'auto')
    expect(host.lines.filter(l => l.includes('auth status'))).toHaveLength(4)
  })

  test('logging in after the 60 s is picked up; the remembered fallback is dropped', async () => {
    let at = 1_000_000
    setForgeClock(() => at)
    const script: Script = { ...origin(SELF_HOSTED) }
    const host = scriptedHost(script)
    expect((await detectForge(host, ROOT, 'auto')).isFallback).toBe(true)
    script['glab auth status --hostname gitlab.example.test'] = { exitCode: 0 }
    at += 61_000
    const again = await detectForge(host, ROOT, 'auto')
    expect(again.isFallback).toBeUndefined()
    at += 1
    await detectForge(host, ROOT, 'auto')
    expect(host.lines.filter(l => l.startsWith('glab auth'))).toHaveLength(2)
  })

  test('another origin URL or root is detected afresh', async () => {
    const a = scriptedHost({ ...origin(SELF_HOSTED), 'glab auth status --hostname gitlab.example.test': { exitCode: 0 } })
    await detectForge(a, ROOT, 'auto')
    const b = scriptedHost({ ...origin('git@git.corp.example.test:acme/shop.git'), 'gh auth status --hostname git.corp.example.test': { exitCode: 0 } })
    expect((await detectForge(b, ROOT, 'auto')).forge?.kind).toBe('github')
  })
})

describe('detectForge: the override', () => {
  test('none: no forge, no problem, nothing run', async () => {
    const host = scriptedHost(origin(SELF_HOSTED))
    expect(await detectForge(host, ROOT, 'none')).toEqual({ forge: null })
    expect(host.lines).toEqual([])
  })

  test('github: the origin host as GitHub, no auth probe', async () => {
    const host = scriptedHost(origin(SELF_HOSTED))
    const { forge } = await detectForge(host, ROOT, 'github')
    expect(forge?.kind).toBe('github')
    expect(host.lines).toEqual([ORIGIN])
  })

  test('gitlab: even github.com is taken as GitLab', async () => {
    const host = scriptedHost(origin('git@github.com:acme/shop.git'))
    const { forge } = await detectForge(host, ROOT, 'gitlab')
    expect(forge?.kind).toBe('gitlab')
    expect(host.lines).toEqual([ORIGIN])
  })
})

describe('detectForge: no origin', () => {
  test('a repository without an origin: the no-remote problem', async () => {
    const host = scriptedHost({})
    expect(await detectForge(host, ROOT, 'auto')).toEqual({ forge: null, problem: { kind: 'no-remote', cli: '', host: '' } })
  })

  test('a local path as origin is no remote either', async () => {
    const host = scriptedHost(origin('/srv/git/shop.git'))
    expect((await detectForge(host, ROOT, 'auto')).problem?.kind).toBe('no-remote')
  })

  test('git itself failing to start is no remote', async () => {
    const host = scriptedHost({ [ORIGIN]: 'reject' })
    expect((await detectForge(host, ROOT, 'auto')).problem?.kind).toBe('no-remote')
  })

  test('override none wins over a missing origin; github/gitlab do not', async () => {
    expect((await detectForge(scriptedHost({}), ROOT, 'none')).problem).toBeUndefined()
    expect((await detectForge(scriptedHost({}), ROOT, 'github')).problem?.kind).toBe('no-remote')
  })
})

describe('detectForge: read-only', () => {
  test('every command it runs is a read', async () => {
    const host = scriptedHost({ ...origin(SELF_HOSTED), 'gh auth status --hostname gitlab.example.test': { exitCode: 0 } })
    await detectForge(host, ROOT, 'auto')
    expect(host.lines.length).toBeGreaterThan(1)
    expect(host.lines.filter(isWriting)).toEqual([])
    for (const line of host.lines) expect(line).toMatch(/^(git -C \S+ remote get-url origin|(gh|glab) auth status --hostname \S+)$/)
  })
})
