import { test, expect, describe } from 'claude-code/testing'
import { detectWorkspace } from '../src/providers/aidlc/detect'
import { readBranch } from '../src/providers/aidlc/git'
import { modeFor, selectIntent } from '../src/providers/aidlc/select'
import { fsxOf } from '../fixtures/virtual'
import * as real from '../fixtures/real-sample'
import * as s from '../fixtures/scenarios'
import type { Workspace } from '../src/providers/aidlc/types'

const DEFAULT_PATTERN = '^[^/]+/(?<ticket>[^/]+)/(?<stages>.+)$'

async function select(tree: Parameters<typeof fsxOf>[0], root: string, sessionId: string) {
  const fsx = fsxOf(tree)
  const ws = await detectWorkspace(fsx, root)
  if (!ws) throw new Error(`no workspace at ${root}`)
  return selectIntent(fsx, ws, sessionId)
}

describe('detectWorkspace', () => {
  test('finds the real sample and its engine markers', async () => {
    const ws = await detectWorkspace(fsxOf(real.tree), real.ROOT)
    expect(ws).toEqual({
      root: real.ROOT,
      aidlcDir: `${real.ROOT}/aidlc`,
      engineMarkers: ['.claude/tools/aidlc.ts', '.claude/rules/aidlc.md'],
    })
  })

  test('walks up from a deep directory', async () => {
    const ws = await detectWorkspace(fsxOf(s.nested), s.NESTED_START)
    expect(ws?.root).toBe('/work/mono')
    expect(ws?.engineMarkers).toEqual([])
  })

  test('the nearest ancestor wins', async () => {
    const fsx = fsxOf(s.nestedWorkspaces)
    expect((await detectWorkspace(fsx, '/work/outer/packages/inner/src'))?.root).toBe('/work/outer/packages/inner')
    expect((await detectWorkspace(fsx, '/work/outer/other'))?.root).toBe('/work/outer')
  })

  test('a v1-only repo is not a workspace', async () => {
    expect(await detectWorkspace(fsxOf(s.v1Only), '/work/legacy')).toBeNull()
  })

  test('a random aidlc/spaces folder is rejected, an engine marker redeems it', async () => {
    expect(await detectWorkspace(fsxOf(s.randomSpacesDir), '/work/other')).toBeNull()
    expect((await detectWorkspace(fsxOf(s.engineOnly), s.ROOT))?.engineMarkers).toEqual(['.claude/rules/aidlc.md'])
  })

  test('a state file with another heading does not confirm', async () => {
    const tree = { files: { '/w/aidlc/spaces/default/intents/x/aidlc-state.md': '# Something else\n' } }
    expect(await detectWorkspace(fsxOf(tree), '/w')).toBeNull()
  })

  test('nothing above, nothing found; the filesystem root is reached without looping', async () => {
    expect(await detectWorkspace(fsxOf({ files: {} }), '/a/b/c')).toBeNull()
    expect(await detectWorkspace(fsxOf({ files: {} }), '/')).toBeNull()
  })

  test('confirms through the active-intent cursor too', async () => {
    const tree = {
      files: {
        '/w/aidlc/spaces/team/intents/active-intent': 'i1\n',
        '/w/aidlc/spaces/team/intents/i1/aidlc-state.md': '# AI-DLC State Tracking\n',
      },
    }
    expect((await detectWorkspace(fsxOf(tree), '/w/x'))?.root).toBe('/w')
  })
})

describe('readBranch', () => {
  test('a normal checkout', async () => {
    expect(await readBranch(fsxOf(real.tree), `${real.ROOT}/aidlc`)).toBe('dev/SHOP-7/refined-mockups')
  })

  test('from a deep directory', async () => {
    expect(await readBranch(fsxOf(s.nested), s.NESTED_START)).toBe('main')
  })

  test('a linked worktree with a relative gitdir', async () => {
    expect(await readBranch(fsxOf(s.worktree), `${s.WORKTREE_ROOT}/src`)).toBe('dev/SHOP-9/code-generation')
  })

  test('a linked worktree with an absolute gitdir', async () => {
    expect(await readBranch(fsxOf(s.worktreeAbsolute), '/work/wt/abs')).toBe('feat/x')
  })

  test('a directory checkout is told by .git/HEAD, even when reading the directory answers text', async () => {
    const base = fsxOf(real.tree)
    const lenient = { ...base, read: async (path: string) => (path === `${real.ROOT}/.git` ? '' : base.read(path)) }
    expect(await readBranch(lenient, real.ROOT)).toBe('dev/SHOP-7/refined-mockups')
  })

  test('a .git directory without HEAD reads as no branch', async () => {
    expect(await readBranch(fsxOf({ files: { '/w/.git/config': '' } }), '/w')).toBe('')
  })

  test('detached HEAD, broken pointer and no repo all read as empty', async () => {
    expect(await readBranch(fsxOf(s.detachedHead), '/work/det')).toBe('')
    expect(await readBranch(fsxOf(s.brokenWorktree), '/work/broken')).toBe('')
    expect(await readBranch(fsxOf(s.noGit), '/work/plain')).toBe('')
  })
})

describe('selectIntent: bindings', () => {
  test('a valid binding to the live intent', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.live)
    expect(sel).toEqual({
      space: 'default',
      intent: real.LIVE_INTENT,
      source: 'binding',
      slug: 'shop-mvp-restart',
      statePath: `${real.ROOT}/aidlc/spaces/default/intents/${real.LIVE_INTENT}/aidlc-state.md`,
      isBound: true,
      isHidden: false,
      liveIntents: 1,
    })
  })

  test('an empty binding file is no binding: the cursor applies', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.empty)
    expect(sel.source).toBe('active-intent')
    expect(sel.isBound).toBe(false)
    expect(sel.intent).toBe(real.LIVE_INTENT)
  })

  test('a malformed binding file is no binding', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.malformed)
    expect([sel.source, sel.isBound]).toEqual(['active-intent', false])
  })

  test('a binding to no intent reads as unbound', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.nullIntent)
    expect([sel.source, sel.isBound, sel.intent]).toEqual(['active-intent', false, real.LIVE_INTENT])
  })

  // upstream readSessionBinding (core/hooks/aidlc-statusline.ts): an archived bound
  // record returns { space, intent: null, hidden: true } - this session shows NO
  // workflow, and neither the shared cursor nor the space root stands in.
  test('a binding to the archived intent hides the workflow: no cursor fallback', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.archived)
    expect(sel).toEqual({
      space: 'default',
      intent: null,
      source: 'none',
      slug: '',
      statePath: '',
      isBound: false,
      isHidden: true,
      liveIntents: 0,
    })
  })

  // Same function: `intent === null && record.source === "archive"` is hidden too
  // (archiving rebinds the session to no record).
  test('a null-intent binding with source "archive" hides the workflow', async () => {
    const dir = `${real.ROOT}/aidlc/.aidlc-sessions`
    const tree = {
      files: {
        ...real.tree.files,
        [`${dir}/archived-away.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x', source: 'archive' }),
        [`${dir}/plain-null.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x', source: 'unbind' }),
      },
    }
    const hidden = await select(tree, real.ROOT, 'archived-away')
    expect([hidden.isHidden, hidden.intent, hidden.source]).toEqual([true, null, 'none'])
    const plain = await select(tree, real.ROOT, 'plain-null')
    expect([plain.isHidden, plain.intent]).toEqual([false, real.LIVE_INTENT])
  })

  // upstream: a binding whose record has no state file is ignored (null), so the
  // archived check never sees it.
  test('a binding to a missing intent stays no binding, not hidden', async () => {
    const dir = `${real.ROOT}/aidlc/.aidlc-sessions`
    const tree = {
      files: {
        ...real.tree.files,
        [`${dir}/ghost.binding.json`]: JSON.stringify({ space: 'default', intent: 'gone-dir', boundAt: 'x' }),
      },
    }
    const sel = await select(tree, real.ROOT, 'ghost')
    expect([sel.isHidden, sel.isBound, sel.intent]).toEqual([false, false, real.LIVE_INTENT])
  })

  // upstream: `{ space, intent: null }` for a plain null-intent binding; the space is
  // the BINDING's, and activeIntent(projectDir, space) reads that space's cursor.
  test('a null-intent binding takes the intent from the binding space, not the active space', async () => {
    const tree = {
      files: {
        ...s.otherSpace.files,
        [`${s.ROOT}/aidlc/.aidlc-sessions/n.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x' }),
      },
    }
    // active-space is `platform` (intent 260805-ci); the binding says `default`.
    const sel = await select(tree, s.ROOT, 'n')
    expect([sel.space, sel.intent, sel.source, sel.isBound, sel.isHidden]).toEqual([
      'default',
      '260801-checkout-flow',
      'active-intent',
      false,
      false,
    ])
    const unbound = await select(tree, s.ROOT, 'other')
    expect([unbound.space, unbound.intent]).toEqual(['platform', '260805-ci'])
  })

  test('a null-intent binding to a space with two live intents and no cursor selects nothing, and counts them', async () => {
    const tree = {
      files: {
        ...s.twoIntentsNoCursor.files,
        [`${s.ROOT}/aidlc/.aidlc-sessions/n.binding.json`]: JSON.stringify({ space: 'default', intent: null, boundAt: 'x' }),
      },
    }
    const sel = await select(tree, s.ROOT, 'n')
    expect([sel.intent, sel.source, sel.isHidden, sel.liveIntents]).toEqual([null, 'none', false, 2])
  })

  test('no binding file for the session', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.unknown)
    expect([sel.source, sel.isBound]).toEqual(['active-intent', false])
  })

  test('an invalid session id is never read', async () => {
    for (const id of ['', '..', '../x', 'a/b', 'a b']) {
      const sel = await select(real.tree, real.ROOT, id)
      expect(sel.isBound).toBe(false)
    }
  })

  test('a binding that fails upstream validation is ignored', async () => {
    const dir = `${real.ROOT}/aidlc/.aidlc-sessions`
    const bad = (body: object) => JSON.stringify(body)
    const tree = {
      files: {
        ...real.tree.files,
        [`${dir}/no-bound-at.binding.json`]: bad({ space: 'default', intent: real.LIVE_INTENT }),
        [`${dir}/empty-bound-at.binding.json`]: bad({ space: 'default', intent: real.LIVE_INTENT, boundAt: '' }),
        [`${dir}/bad-space.binding.json`]: bad({ space: 'Default', intent: real.LIVE_INTENT, boundAt: 'x' }),
        [`${dir}/slashed.binding.json`]: bad({ space: 'default', intent: '../x', boundAt: 'x' }),
        [`${dir}/ghost.binding.json`]: bad({ space: 'default', intent: 'no-such-dir', boundAt: 'x' }),
        [`${dir}/array.binding.json`]: '[]',
        [`${dir}/scalar.binding.json`]: '3',
      },
    }
    for (const id of ['no-bound-at', 'empty-bound-at', 'bad-space', 'slashed', 'ghost', 'array', 'scalar']) {
      expect((await select(tree, real.ROOT, id)).isBound).toBe(false)
    }
  })

  test('a binding can pin a space other than the active one', async () => {
    const tree = {
      files: {
        ...s.otherSpace.files,
        [`${s.ROOT}/aidlc/.aidlc-sessions/p.binding.json`]: JSON.stringify({ space: 'default', intent: '260801-checkout-flow', boundAt: 'x' }),
      },
    }
    const sel = await select(tree, s.ROOT, 'p')
    expect([sel.space, sel.intent, sel.isBound]).toEqual(['default', '260801-checkout-flow', true])
    const unbound = await select(tree, s.ROOT, 'q')
    expect([unbound.space, unbound.intent]).toEqual(['platform', '260805-ci'])
  })
})

describe('selectIntent: shared cursor and lone intent', () => {
  test('the cursor intent', async () => {
    const sel = await select(s.twoIntentsCursor, s.ROOT, s.SESSION)
    expect([sel.source, sel.intent, sel.slug]).toEqual(['active-intent', '260802-search', 'search'])
  })

  test('no cursor, one live intent: lone-intent (archived ones do not count)', async () => {
    const sel = await select(s.loneIntent, s.ROOT, s.SESSION)
    expect([sel.source, sel.intent, sel.isBound]).toEqual(['lone-intent', '260801-checkout-flow', false])
  })

  test('a cursor on an archived intent falls through to the lone live one', async () => {
    const sel = await select(s.cursorOnArchived, s.ROOT, s.SESSION)
    expect([sel.source, sel.intent]).toEqual(['lone-intent', '260801-checkout-flow'])
  })

  test('a dangling cursor falls through too', async () => {
    const sel = await select(s.cursorDangling, s.ROOT, s.SESSION)
    expect([sel.source, sel.intent]).toEqual(['lone-intent', '260801-checkout-flow'])
  })

  test('two live intents and no cursor: nothing selected', async () => {
    const sel = await select(s.twoIntentsNoCursor, s.ROOT, s.SESSION)
    expect(sel).toEqual({
      space: 'default',
      intent: null,
      source: 'none',
      slug: '',
      statePath: '',
      isBound: false,
      isHidden: false,
      liveIntents: 2,
    })
  })

  test('only archived intents: nothing selected, none live', async () => {
    const sel = await select(s.allArchived, s.ROOT, s.SESSION)
    expect([sel.source, sel.intent, sel.liveIntents]).toEqual(['none', null, 0])
  })
})

describe('selectIntent: spaces and slugs', () => {
  test('an active-space naming a missing space falls back to default', async () => {
    expect((await select(s.missingSpace, s.ROOT, s.SESSION)).space).toBe('default')
  })

  test('an illegal active-space name falls back to default', async () => {
    expect((await select(s.badSpaceName, s.ROOT, s.SESSION)).space).toBe('default')
  })

  test('an existing other space is honoured', async () => {
    const sel = await select(s.otherSpace, s.ROOT, s.SESSION)
    expect([sel.space, sel.intent]).toEqual(['platform', '260805-ci'])
    expect(sel.statePath).toBe(`${s.ROOT}/aidlc/spaces/platform/intents/260805-ci/aidlc-state.md`)
  })

  test('the registry slug comes from the row whose dirName matches', async () => {
    const sel = await select(real.tree, real.ROOT, real.sessions.live)
    expect(sel.slug).toBe('shop-mvp-restart')
  })

  test('a row without dirName matches by slug and uuid', async () => {
    const sel = await select(s.uuidRow, s.ROOT, s.SESSION)
    expect(sel.slug).toBe('shop-flow')
  })

  test('without a registry the slug is the dir name minus its date or hash', async () => {
    expect((await select(s.loneIntent, s.ROOT, s.SESSION)).slug).toBe('checkout-flow')
    const tree = {
      files: {
        '/w/aidlc/spaces/default/intents/auth-flow-0123abcd/aidlc-state.md': '# AI-DLC State Tracking\n',
      },
    }
    expect((await select(tree, '/w', 'x')).slug).toBe('auth-flow')
  })

  test('statePath is built from the workspace aidlc dir', async () => {
    const ws: Workspace = { root: real.ROOT, aidlcDir: `${real.ROOT}/aidlc`, engineMarkers: [] }
    const sel = await selectIntent(fsxOf(real.tree), ws, real.sessions.live)
    expect(sel.statePath.startsWith(ws.aidlcDir)).toBe(true)
  })
})

describe('modeFor', () => {
  const bound = { intent: 'i', isBound: true }
  const unbound = { intent: 'i', isBound: false }

  test('no intent: none, even on a stage branch', () => {
    expect(modeFor({ intent: null, isBound: false }, 'dev/SHOP-7/x', DEFAULT_PATTERN, '--').mode).toBe('none')
  })

  test('bound and on a stage branch: stage, with ticket and stages', () => {
    expect(modeFor(bound, 'dev/SHOP-7/refined-mockups', DEFAULT_PATTERN, '--')).toEqual({
      mode: 'stage',
      stageBranch: { ticket: 'SHOP-7', stages: ['refined-mockups'] },
    })
  })

  test('folded stages split on the separator, empties dropped', () => {
    const { stageBranch } = modeFor(bound, 'dev/SHOP-7/a--b----c--', DEFAULT_PATTERN, '--')
    expect(stageBranch?.stages).toEqual(['a', 'b', 'c'])
  })

  test('bound: a stage session whatever the branch, with no stageBranch off the pattern', () => {
    expect(modeFor(bound, 'main', DEFAULT_PATTERN, '--')).toEqual({ mode: 'stage' })
    expect(modeFor(bound, 'semka/user-stories', DEFAULT_PATTERN, '--')).toEqual({ mode: 'stage' })
  })

  test('unbound on a stage branch: side-job, but stageBranch is still parsed', () => {
    expect(modeFor(unbound, 'dev/SHOP-7/x', DEFAULT_PATTERN, '--')).toEqual({
      mode: 'side-job',
      stageBranch: { ticket: 'SHOP-7', stages: ['x'] },
    })
  })

  test('an unknown branch is never a stage branch, and a bound session is still a stage', () => {
    expect(modeFor(bound, '', DEFAULT_PATTERN, '--')).toEqual({ mode: 'stage' })
    expect(modeFor(bound, '', '.*', '--')).toEqual({ mode: 'stage' })
    expect(modeFor(unbound, '', '.*', '--')).toEqual({ mode: 'side-job' })
  })

  test('an invalid or empty regex does not throw and matches nothing; the binding still decides', () => {
    expect(modeFor(bound, 'dev/SHOP-7/x', '([unclosed', '--')).toEqual({ mode: 'stage' })
    expect(modeFor(bound, 'dev/SHOP-7/x', '(?<ticket>', '--')).toEqual({ mode: 'stage' })
    expect(modeFor(bound, 'dev/SHOP-7/x', '', '--')).toEqual({ mode: 'stage' })
    expect(modeFor(unbound, 'dev/SHOP-7/x', '([unclosed', '--')).toEqual({ mode: 'side-job' })
  })

  test('a pattern without the named groups still decides the mode', () => {
    expect(modeFor(bound, 'dev/SHOP-7/x', '^dev/', '--')).toEqual({ mode: 'stage', stageBranch: { ticket: '', stages: [] } })
  })

  test('an empty separator keeps the stages whole', () => {
    expect(modeFor(bound, 'dev/T/a--b', DEFAULT_PATTERN, '').stageBranch?.stages).toEqual(['a--b'])
  })
})
