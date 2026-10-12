// The AI-DLC provider's remote fingerprint (M3): what it digests, when it fetches, how it fails, and that the
// re-load a changed digest triggers reuses the list the fingerprint just fetched.
import { describe, expect, test } from 'claude-code/testing'
import { ForgeError } from '../src/forge'
import { fingerprintOf } from '../src/model'
import { aidlc } from '../src/providers/aidlc'
import type { Detection } from '../types'
import { NOW } from './world'
import { ascripted, aworld, branchOf, pr } from './aidlc-world'
import type { AWorld } from './aidlc-world'

/** One fetch of the list is an open query and a merged query side by side; count the open ones. */
const prLines = (lines: string[]) => lines.filter(line => line.startsWith('gh pr list --state open'))
const fetches = (lines: string[]) => lines.filter(line => line.includes(' fetch '))

/** The fingerprint of a world, through the provider's own detection. */
async function fingerprintFor(w: AWorld): Promise<string> {
  const s = ascripted(w)
  const detection = (await aidlc.detect(s.ctx)) as Detection
  expect(detection).not.toBeNull()
  return (aidlc.fingerprint as NonNullable<typeof aidlc.fingerprint>)(s.ctx, detection)
}

const base = () => aworld({ prs: [pr(33, branchOf('refined-mockups')), pr(31, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-10-03T10:00:00Z' })] })
const with33 = (over: Record<string, unknown>) =>
  aworld({ prs: [pr(33, branchOf('refined-mockups'), over), pr(31, branchOf('user-stories'), { state: 'MERGED', mergedAt: '2026-10-03T10:00:00Z' })] })

describe('aidlc.fingerprint', () => {
  test('is on the provider', () => {
    expect(typeof aidlc.fingerprint).toBe('function')
  })

  test('the same world gives the same string, twice and from separate contexts', async () => {
    const first = await fingerprintFor(base())
    expect(first).not.toBe('')
    expect(await fingerprintFor(base())).toBe(first)
    const s = ascripted(base())
    const detection = (await aidlc.detect(s.ctx)) as Detection
    expect(await aidlc.fingerprint?.(s.ctx, detection)).toBe(first)
    expect(await aidlc.fingerprint?.(s.ctx, detection)).toBe(first)
  })

  test('the order gh lists the PRs in does not matter', async () => {
    const forward = await fingerprintFor(base())
    const reversed = await fingerprintFor(aworld({ prs: [...(base().prs ?? [])].reverse() }))
    expect(reversed).toBe(forward)
  })

  test('flips on a new PR', async () => {
    const extra = aworld({ prs: [...(base().prs ?? []), pr(34, branchOf('domain-design'))] })
    expect(await fingerprintFor(extra)).not.toBe(await fingerprintFor(base()))
  })

  test('flips on a merge', async () => {
    const after = with33({ state: 'MERGED', mergedAt: '2026-10-07T09:00:00Z' })
    expect(await fingerprintFor(after)).not.toBe(await fingerprintFor(base()))
  })

  test('flips on a PR closing, a new head commit, a draft turning ready, a review and a merge state', async () => {
    const before = await fingerprintFor(base())
    for (const over of [{ state: 'CLOSED' }, { headRefOid: 'sha-new' }, { isDraft: true }, { reviewDecision: 'CHANGES_REQUESTED' }, { mergeStateStatus: 'BEHIND' }]) {
      expect(await fingerprintFor(with33(over))).not.toBe(before)
    }
  })

  test('flips on CI going red, and back when it is green again', async () => {
    const before = await fingerprintFor(base())
    const red = await fingerprintFor(with33({ statusCheckRollup: [{ conclusion: 'FAILURE', name: 'build' }] }))
    expect(red).not.toBe(before)
    expect(await fingerprintFor(with33({ statusCheckRollup: [{ conclusion: 'FAILURE', name: 'lint' }] }))).not.toBe(red)
    expect(await fingerprintFor(with33({ statusCheckRollup: [{ conclusion: 'SUCCESS', name: 'build' }] }))).toBe(before)
  })

  test('flips on a new tip of the default branch on origin', async () => {
    const a = await fingerprintFor({ ...base(), remoteSha: 'bbbb2222' })
    const b = await fingerprintFor({ ...base(), remoteSha: 'cccc3333' })
    expect(a).not.toBe(b)
  })

  test('a failing `gh pr list` rejects', async () => {
    const error = await fingerprintFor(aworld({ prs: null })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).display).toBe('Could not check pull requests (gh failed); they may be stale.')
  })

  test('a failing `git ls-remote` alone resolves, with its part empty and no fetch', async () => {
    const w = { ...base(), isLsRemoteUp: false, remoteSha: 'zzzz9999' }
    const s = ascripted(w)
    const detection = (await aidlc.detect(s.ctx)) as Detection
    const down = (await aidlc.fingerprint?.(s.ctx, detection)) as string
    expect(down).not.toBe('')
    expect(down).not.toBe(await fingerprintFor(base()))
    expect(fetches(s.lines())).toEqual([])
  })

  test('it fetches the default branch only when the tip on origin is not the local origin/main', async () => {
    const quiet = ascripted({ ...base(), remoteSha: 'aaaa1111', localSha: 'aaaa1111' })
    const detection = (await aidlc.detect(quiet.ctx)) as Detection
    await aidlc.fingerprint?.(quiet.ctx, detection)
    expect(fetches(quiet.lines())).toEqual([])

    const moved = ascripted({ ...base(), remoteSha: 'bbbb2222', localSha: 'aaaa1111' })
    await aidlc.fingerprint?.(moved.ctx, detection)
    expect(fetches(moved.lines()).map(line => line.split(' ').slice(3).join(' '))).toEqual(['fetch --quiet origin main'])

    const missing = ascripted({ ...base(), remoteSha: 'bbbb2222', hasRef: false, refAfterFetch: false })
    await aidlc.fingerprint?.(missing.ctx, detection)
    expect(fetches(missing.lines())).toHaveLength(1)
  })

  test('it asks for the PR list and the tip, and never a model', async () => {
    const s = ascripted(base())
    const detection = (await aidlc.detect(s.ctx)) as Detection
    await aidlc.fingerprint?.(s.ctx, detection)
    const lines = s.lines()
    expect(prLines(lines)).toHaveLength(1)
    expect(lines.some(line => line.includes('ls-remote origin refs/heads/main'))).toBe(true)
  })

  test('outside a git work tree, or with no origin, it is the empty string and asks nothing remote', async () => {
    for (const w of [aworld({ isRepo: false }), aworld({ hasOrigin: false })]) {
      const s = ascripted(w)
      const detection = (await aidlc.detect(s.ctx)) as Detection
      expect(await aidlc.fingerprint?.(s.ctx, detection)).toBe('')
      expect(s.lines().some(line => line.startsWith('gh '))).toBe(false)
    }
  })

  test('the load a changed fingerprint triggers reuses the list the fingerprint fetched', async () => {
    const s = ascripted(base())
    const detection = (await aidlc.detect(s.ctx)) as Detection
    await aidlc.fingerprint?.(s.ctx, detection)
    await aidlc.load({ ...s.ctx, now: NOW + 5_000 }, detection)
    expect(prLines(s.lines())).toHaveLength(1)
  })

  test('fingerprintOf returns it for an AI-DLC repo, and rejects when gh fails', async () => {
    const s = ascripted(base())
    expect(await fingerprintOf(s.ctx, [aidlc])).toBe(await fingerprintFor(base()))
    await expect(fingerprintOf(ascripted(aworld({ prs: null })).ctx, [aidlc])).rejects.toThrow()
  })
})
