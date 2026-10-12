// Small synthetic workspaces, one per situation the parse layer must handle.
// Each is a VirtualTree; `ROOT` is where its `aidlc/` lives.
import type { VirtualTree } from './virtual'

export const ROOT = '/work/app'
export const SESSION = 'sess-1'

type Rows = string[]

type StateSpec = {
  lifecycle?: string
  current?: string
  next?: string
  status?: string
  unitStage?: string
  parked?: { at: string; since: string }
  /** `## Phase Progress` values, e.g. { Inception: 'Active' }. */
  progress?: Record<string, string>
  /** `### <KEY> PHASE` sections: key → rows (`- [x] slug — EXECUTE`) or a leading `Per unit:` line. */
  phases?: Record<string, Rows>
}

/** A state file shaped like the engine writes it. */
export function stateOf(spec: StateSpec = {}): string {
  const lines = ['# AI-DLC State Tracking', '', '## Project Information', '- **Project**: A test project', '- **Start Date**: 2026-08-25T03:47:00Z', '']
  lines.push('## Runtime State', '- **Revision Count**: 3')
  if (spec.unitStage) lines.push(`- **Unit Stage**: ${spec.unitStage}`)
  if (spec.parked) lines.push('', '', `- **Parked**: ${spec.parked.since}`, '', `- **Parked At Stage**: ${spec.parked.at}`)
  lines.push('', '## Phase Progress', '<!-- Status values: Pending, Active, Verified, Skipped -->', '')
  for (const [phase, value] of Object.entries(spec.progress ?? {})) lines.push(`- **${phase}**: ${value}`)
  lines.push('', '## Stage Progress', '<!-- Checkbox states -->', '')
  for (const [key, rows] of Object.entries(spec.phases ?? {})) lines.push(`### ${key} PHASE`, ...rows, '')
  lines.push(
    '## Current Status',
    `- **Lifecycle Phase**: ${spec.lifecycle ?? 'INCEPTION'}`,
    `- **Current Stage**: ${spec.current ?? 'domain-design'}`,
    `- **Next Stage**: ${spec.next ?? 'units-generation'}`,
    `- **Status**: ${spec.status ?? 'Running'}`,
    '- **Last Updated**: 2026-09-03T04:47:00Z',
    '',
    '## Session Resume Point',
    '- **Last Completed Stage**: user-stories',
    '- **Next Action**: Execute the current stage',
    '- **Pending Artifacts**: none',
    '',
  )
  return lines.join('\n')
}

const inception: Rows = [
  '- [x] requirements-analysis — EXECUTE',
  '- [x] user-stories — EXECUTE',
  '- [-] domain-design — EXECUTE',
  '- [ ] units-generation — EXECUTE',
]

/** One workspace: a single `default` space with the given intent dirs. */
function workspace(opts: {
  root?: string
  intents: Record<string, string>
  activeIntent?: string
  activeSpace?: string
  extra?: Record<string, string>
}): VirtualTree {
  const root = opts.root ?? ROOT
  const intents = `${root}/aidlc/spaces/default/intents`
  const files: Record<string, string> = { ...opts.extra }
  for (const [dir, text] of Object.entries(opts.intents)) files[`${intents}/${dir}/aidlc-state.md`] = text
  if (opts.activeIntent !== undefined) files[`${intents}/active-intent`] = `${opts.activeIntent}\n`
  if (opts.activeSpace !== undefined) files[`${root}/aidlc/active-space`] = `${opts.activeSpace}\n`
  return { files }
}

export const INTENT = '260801-checkout-flow'
const statePath = `${ROOT}/aidlc/spaces/default/intents/${INTENT}/aidlc-state.md`
const directivePath = `${ROOT}/aidlc/spaces/default/intents/${INTENT}/.aidlc-engine/active-directive.json`
export const paths = { statePath, directivePath }

/** Construction with a `Unit Stage`, a `Per unit` line and a Current Stage on the block's first stage. */
export const construction: VirtualTree = workspace({
  intents: {
    [INTENT]: stateOf({
      lifecycle: 'CONSTRUCTION',
      current: 'functional-design',
      unitStage: 'code-generation',
      progress: { Inception: 'Verified', Construction: 'Active' },
      phases: {
        INCEPTION: ['- [x] requirements-analysis — EXECUTE', '- [x] delivery-planning — EXECUTE'],
        CONSTRUCTION: [
          'Per unit: [billing, auth]',
          '- [x] functional-design — EXECUTE',
          '- [-] code-generation — EXECUTE',
          '- [ ] build-and-test — EXECUTE',
        ],
      },
    }),
  },
  activeIntent: INTENT,
})

function withDirective(directive: object, directiveMtime: number): VirtualTree {
  const tree = workspace({
    intents: {
      [INTENT]: stateOf({ current: 'user-stories', progress: { Inception: 'Active' }, phases: { INCEPTION: inception } }),
    },
    activeIntent: INTENT,
  })
  tree.files[directivePath] = JSON.stringify(directive)
  tree.mtimes = { [statePath]: 1000, [directivePath]: directiveMtime }
  return tree
}

/** A directive written after the state file: its stage and unit win over Current Stage. */
export const freshDirective = withDirective({ version: 2, stage: 'domain-design', unit: 'billing', delivery: 'issued' }, 2000)
/** Same, but marked superseded: ignored. */
export const supersededDirective = withDirective({ version: 2, stage: 'domain-design', unit: 'billing', delivery: 'superseded' }, 2000)
/** Written at the very same instant as the state file: still counts. */
export const simultaneousDirective = withDirective({ version: 2, stage: 'domain-design', delivery: 'issued' }, 1000)
/** Older than the state file: ignored. */
export const staleDirective = withDirective({ version: 2, stage: 'domain-design', delivery: 'issued' }, 500)
/** Fresh, but its stage is not a slug and its unit is hostile: ignored. */
export const hostileDirective = withDirective({ version: 2, stage: '../../etc', unit: 'x', delivery: 'issued' }, 2000)
/** Fresh with a good stage and a hostile unit: the stage counts, the unit does not. */
export const hostileUnitDirective = withDirective({ version: 2, stage: 'domain-design', unit: '$(rm -rf)', delivery: 'issued' }, 2000)

/** `[?]` and `[R]` stages, plus a parked marker in another phase. */
export const gates: VirtualTree = workspace({
  intents: {
    [INTENT]: stateOf({
      lifecycle: 'INCEPTION',
      current: 'user-stories',
      progress: { Ideation: 'Verified', Inception: 'Active', Construction: 'Pending' },
      phases: {
        IDEATION: ['- [x] intent-capture — EXECUTE', '- [x] feasibility — EXECUTE'],
        INCEPTION: [
          '- [x] requirements-analysis — EXECUTE',
          '- [?] user-stories — EXECUTE',
          '- [R] domain-design — EXECUTE',
          '- [?] contract-design — SKIP: not needed',
        ],
        CONSTRUCTION: ['Per unit: [TBD]', '- [ ] functional-design — EXECUTE'],
      },
    }),
  },
  activeIntent: INTENT,
})

/** Parked at a stage that is in a phase other than the header's. */
export const parkedElsewhere: VirtualTree = workspace({
  intents: {
    [INTENT]: stateOf({
      lifecycle: 'CONSTRUCTION',
      current: 'functional-design',
      parked: { at: 'requirements-analysis', since: '2026-09-02T02:47:00Z' },
      progress: { Inception: 'Verified', Construction: 'Active' },
      phases: {
        INCEPTION: ['- [x] requirements-analysis — EXECUTE'],
        CONSTRUCTION: ['- [-] functional-design — EXECUTE'],
      },
    }),
  },
  activeIntent: INTENT,
})

/** Parked with no stage named. */
export const parkedNoStage: VirtualTree = workspace({
  intents: {
    [INTENT]: stateOf({
      parked: { at: '', since: '2026-09-02T02:47:00Z' },
      progress: { Inception: 'Active' },
      phases: { INCEPTION: inception },
    }),
  },
  activeIntent: INTENT,
})

const done = stateOf({ status: 'Completed', progress: { Inception: 'Verified' }, phases: { INCEPTION: ['- [x] user-stories — EXECUTE'] } })
const archivedText = stateOf({ status: 'Archived', phases: { INCEPTION: inception } })

/** No binding, no active-intent file: the only live intent is chosen (an archived one is passed over). */
export const loneIntent: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done, '260701-old-idea': archivedText },
})

/** The cursor names an archived intent, so the lone live one wins. */
export const cursorOnArchived: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done, '260701-old-idea': archivedText },
  activeIntent: '260701-old-idea',
})

/** The cursor names a directory that is gone. */
export const cursorDangling: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done },
  activeIntent: '999999-ghost',
})

/** Two live intents and no cursor: nothing is selected. */
export const twoIntentsNoCursor: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done, '260802-search': done },
})

/** Two live intents, the cursor picks one. */
export const twoIntentsCursor: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done, '260802-search': done },
  activeIntent: '260802-search',
})

/** Everything archived. */
export const allArchived: VirtualTree = workspace({
  intents: { '260701-old-idea': archivedText },
  activeIntent: '260701-old-idea',
})

/** active-space names a space that does not exist: falls back to default. */
export const missingSpace: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done },
  activeIntent: '260801-checkout-flow',
  activeSpace: 'ghost',
})

/** active-space is not a legal name. */
export const badSpaceName: VirtualTree = workspace({
  intents: { '260801-checkout-flow': done },
  activeIntent: '260801-checkout-flow',
  activeSpace: '../etc',
})

/** A second space is active; its intent is the one shown. */
export const otherSpace: VirtualTree = (() => {
  const tree = workspace({ intents: { '260801-checkout-flow': done }, activeIntent: '260801-checkout-flow', activeSpace: 'platform' })
  const intents = `${ROOT}/aidlc/spaces/platform/intents`
  tree.files[`${intents}/260805-ci/aidlc-state.md`] = done
  tree.files[`${intents}/active-intent`] = '260805-ci\n'
  return tree
})()

/** An intent with a registry row matched by slug+uuid (no dirName). */
export const uuidRow: VirtualTree = (() => {
  const tree = workspace({ intents: { 'shop-flow-8123456789abcdef': done }, activeIntent: 'shop-flow-8123456789abcdef' })
  tree.files[`${ROOT}/aidlc/spaces/default/intents/intents.json`] = JSON.stringify([
    { uuid: '01a00000-0000-7000-8123-456789abcdef', slug: 'shop-flow' },
  ])
  return tree
})()

/** Only the v1 layout. */
export const v1Only: VirtualTree = {
  files: {
    '/work/legacy/aidlc-docs/inception/plans/execution-plan.md': '# plan\n',
    '/work/legacy/aidlc-docs/aidlc-state.md': '# AI-DLC State Tracking\n',
  },
}

/** `aidlc/spaces/` exists but nothing in it is an AI-DLC state file, and no engine is installed. */
export const randomSpacesDir: VirtualTree = {
  files: { '/work/other/aidlc/spaces/notes.txt': 'not ours\n', '/work/other/aidlc/spaces/x/intents/readme.md': 'hello\n' },
}

/** A workspace with an engine installed but no intent yet. */
export const engineOnly: VirtualTree = {
  files: { [`${ROOT}/aidlc/spaces/default/.keep`]: '', [`${ROOT}/.claude/rules/aidlc.md`]: '# rules\n' },
}

/** Workspace at /work/mono, the session starts deep below it. */
export const NESTED_START = '/work/mono/apps/web/src/components'
export const nested: VirtualTree = workspace({
  root: '/work/mono',
  intents: { '260801-checkout-flow': done },
  activeIntent: '260801-checkout-flow',
  extra: { '/work/mono/.git/HEAD': 'ref: refs/heads/main\n', '/work/mono/apps/web/src/components/Button.tsx': '' },
})

/** An outer workspace and an inner one: the nearest ancestor wins. */
export const nestedWorkspaces: VirtualTree = (() => {
  const outer = workspace({ root: '/work/outer', intents: { '260801-outer': done }, activeIntent: '260801-outer' })
  const inner = workspace({ root: '/work/outer/packages/inner', intents: { '260802-inner': done }, activeIntent: '260802-inner' })
  return { files: { ...outer.files, ...inner.files } }
})()

/** A linked git worktree: `.git` is a file whose gitdir is relative. */
export const WORKTREE_ROOT = '/work/wt/feature'
export const worktree: VirtualTree = {
  files: {
    [`${WORKTREE_ROOT}/.git`]: 'gitdir: ../../main/.git/worktrees/feature\n',
    '/work/main/.git/HEAD': 'ref: refs/heads/main\n',
    '/work/main/.git/worktrees/feature/HEAD': 'ref: refs/heads/dev/SHOP-9/code-generation\n',
    [`${WORKTREE_ROOT}/src/index.ts`]: '',
  },
}

/** A linked worktree that also holds the AI-DLC workspace (the usual stage-session layout). */
export const worktreeWithWorkspace: VirtualTree = {
  files: {
    ...worktree.files,
    [`${WORKTREE_ROOT}/aidlc/spaces/default/intents/260801-checkout-flow/aidlc-state.md`]: done,
    [`${WORKTREE_ROOT}/aidlc/spaces/default/intents/active-intent`]: '260801-checkout-flow\n',
    [`${WORKTREE_ROOT}/aidlc/.aidlc-sessions/wt.binding.json`]: JSON.stringify({
      space: 'default',
      intent: '260801-checkout-flow',
      boundAt: '2026-09-03T04:47:00Z',
    }),
  },
}

/** A linked worktree with an absolute gitdir. */
export const worktreeAbsolute: VirtualTree = {
  files: {
    '/work/wt/abs/.git': 'gitdir: /work/main/.git/worktrees/abs\n',
    '/work/main/.git/worktrees/abs/HEAD': 'ref: refs/heads/feat/x\n',
  },
}

export const detachedHead: VirtualTree = { files: { '/work/det/.git/HEAD': '0123456789abcdef0123456789abcdef01234567\n' } }
export const brokenWorktree: VirtualTree = { files: { '/work/broken/.git': 'not a pointer\n' } }
export const noGit: VirtualTree = { files: { '/work/plain/file.txt': '' } }
