// A scripted git/gh/glab world for the AI-DLC provider's two truths (M3): the host answers by argv from plain
// data, the working tree is the file tree, and every run is recorded. The origin is a github.com URL by default
// (gh answers); `gitlabAworld` makes it a self-hosted GitLab (glab answers from fixtures/forge/*). Sanitised: owner
// `dev`, ticket `SHOP-7`, repository `acme/shop` (GitLab: `acme/platform/scanner` on gitlab.example.test), upstream's
// generic stage names.
import { stateOf } from '../fixtures/scenarios'
import { fsxOf } from '../fixtures/virtual'
import { approved, notApproved } from '../fixtures/forge/gitlab-approvals'
import { changes } from '../fixtures/forge/gitlab-changes'
import { GITLAB_HOST, GITLAB_PATH, GITLAB_WEB, mrRow } from '../fixtures/forge/gitlab-mr-list'
import type { MrRow } from '../fixtures/forge/gitlab-mr-list'
import { mrView } from '../fixtures/forge/gitlab-mr-view'
import type { PipelineStatus } from '../fixtures/forge/gitlab-mr-view'
import { project } from '../fixtures/forge/gitlab-project'
import { resetForgeCache } from '../src/forge'
import { aidlc } from '../src/providers/aidlc'
import { resetCache } from '../src/providers/aidlc/prs'
import type { Detection, PanelModel, PanelOptions, ProviderContext, ProviderHost } from '../types'
import { NOW, OPTIONS } from './world'

export const REPO = '/work/shop'
export const REPO_URL = 'https://example.test/acme/shop'
/** What `git remote get-url origin` says by default: GitHub, so `gh` is the forge. */
export const GITHUB_ORIGIN = 'git@github.com:acme/shop.git'
export const GITLAB_ORIGIN = `git@${GITLAB_HOST}:${GITLAB_PATH}.git`
export { GITLAB_HOST, GITLAB_PATH, GITLAB_WEB }
export const INTENT = '261006-shop-mvp'
export const PREFIX = `aidlc/spaces/default/intents/${INTENT}/`
export const STATE = `${REPO}/${PREFIX}aidlc-state.md`
export const SESSION = 'sess-1'

export const INCEPTION = ['requirements-analysis', 'user-stories', 'refined-mockups', 'domain-design', 'units-generation', 'contract-design']
export const CONSTRUCTION = ['functional-design', 'code-generation']

type Spec = Parameters<typeof stateOf>[0] & object

/**
 * A state file where `marks` sets the boxes by stage slug (' ' pending, '-' in progress, '?' awaiting, 'R' revising,
 * 'x' completed) and every other row is pending. `skip` rows are out of scope.
 */
export function state(marks: Record<string, string>, spec: Spec = {}, skip: string[] = []): string {
  const row = (slug: string) => (skip.includes(slug) ? `- [S] ${slug} — SKIP: not needed` : `- [${marks[slug] ?? ' '}] ${slug} — EXECUTE`)
  const progress = { Inception: 'Active', Construction: 'Pending', ...spec.progress }
  return stateOf({
    current: 'domain-design',
    ...spec,
    progress,
    phases: { INCEPTION: INCEPTION.map(row), CONSTRUCTION: ['Per unit: [api]', ...CONSTRUCTION.map(row)] },
  })
}

/** A raw `gh pr list` row. */
export function pr(number: number, branch: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `feat(SHOP-7): ${branch.split('/').pop()}`,
    state: 'OPEN',
    headRefName: branch,
    headRefOid: `sha-${number}`,
    isDraft: false,
    reviewDecision: '',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [],
    mergedAt: null,
    url: `${REPO_URL}/pull/${number}`,
    ...over,
  }
}

/** A raw `glab mr list` row for a stage branch: open, mergeable, one generic subject (see `AWorld.mrs`). */
export function mr(iid: number, branch: string, over: Partial<MrRow> = {}): MrRow {
  return mrRow(iid, {
    title: `feat(SHOP-7): ${branch.split('/').pop()}`,
    state: 'opened',
    merged_at: null,
    source_branch: branch,
    detailed_merge_status: 'mergeable',
    labels: [],
    ...over,
  })
}

export const branchOf = (...stages: string[]) => `dev/SHOP-7/${stages.join('--')}`

export type AWorld = {
  /** The working tree's state file. */
  local: string
  /** The default branch's copy; null = the intent is not on it yet. */
  main: string | null
  isRepo: boolean
  /** `origin/<base>` exists locally. */
  hasRef: boolean
  /** It appears after a `git fetch`. */
  refAfterFetch: boolean
  branch: string
  base: string
  /** `gh pr list` rows; null = gh fails. */
  prs: Record<string, unknown>[] | null
  /** The origin URL `git remote get-url origin` reports (see `hasOrigin`). */
  origin: string
  /** `gh auth status` and `glab auth status` succeed (also what tells a `failed` call from a `not-logged-in` one). */
  isGhAuthed: boolean
  isGlabAuthed: boolean
  /** glab answers (project, merge requests); false = its calls exit 1. */
  isGlabUp: boolean
  /** `glab mr list` rows (GitLab worlds); the head pipeline and the approval of an open one are looked up by iid. */
  mrs: MrRow[]
  pipelines: Record<number, PipelineStatus | null>
  approvals: Record<number, boolean>
  /** The first this-many `glab mr list` calls fail, as a network that flaps does (default 0). */
  mrFlaps?: number
  /** The first this-many `gh pr list` calls fail, as a network that flaps does (default 0). */
  listFlaps?: number
  isGhUp: boolean
  /** `gh pr view <n> --json files`, by number. */
  files: Record<number, string[]>
  /** `rev-list --count HEAD..origin/<base>`. */
  behind: number
  /** `rev-list --left-right --count origin/<base>...HEAD`: what a side job's context line says; undefined = git fails. */
  distance?: { ahead: number; behind: number }
  /** The tip of the default branch on origin (`ls-remote`) and what `origin/<base>` is locally. */
  remoteSha: string
  localSha: string
  isLsRemoteUp: boolean
  hasOrigin: boolean
  /** The session has its AI-DLC binding to the intent (default true): what makes it a stage session. */
  isBound?: boolean
  /** Extra files of the working tree, by absolute path. */
  extra: Record<string, string>
  /** Stages marked started in `local` that have written nothing yet (no artifact file). */
  quiet: string[]
  /** `refs/remotes/origin/<branch>` exists for these branches. */
  pushed: string[]
  /** `gh api user`'s login; undefined = it fails. */
  viewer?: string
  /** `gh api user/teams`: the viewer's teams as `org/slug`; undefined = it fails. */
  teams?: string[]
}

export function aworld(over: Partial<AWorld> = {}): AWorld {
  return {
    local: state({}),
    main: state({}),
    isRepo: true,
    hasRef: true,
    refAfterFetch: true,
    branch: 'main',
    base: 'main',
    prs: [],
    origin: GITHUB_ORIGIN,
    isGhAuthed: true,
    isGlabAuthed: false,
    isGlabUp: true,
    mrs: [],
    pipelines: {},
    approvals: {},
    isGhUp: true,
    files: {},
    behind: 0,
    remoteSha: 'aaaa1111',
    localSha: 'aaaa1111',
    isLsRemoteUp: true,
    hasOrigin: true,
    extra: {},
    quiet: [],
    pushed: [],
    ...over,
  }
}

/** A started stage has written something; a `quiet` one has not. */
function artifacts(w: AWorld): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [phase, slugs] of [['inception', INCEPTION], ['construction', CONSTRUCTION]] as const) {
    for (const slug of slugs) {
      const started = new RegExp(`^- \\[[^ S]\\] ${slug} `, 'm').test(w.local)
      if (started && !w.quiet.includes(slug)) out[`${REPO}/${PREFIX}${phase}/${slug}/notes.md`] = '# notes\n'
    }
  }
  return out
}

/** A repository whose origin is a self-hosted GitLab that glab is logged in to (and gh is not). */
export function gitlabAworld(over: Partial<AWorld> = {}): AWorld {
  return aworld({ origin: GITLAB_ORIGIN, isGhAuthed: false, isGlabAuthed: true, ...over })
}

export type AScripted = {
  ctx: ProviderContext
  host: ProviderHost & { runs: (readonly string[])[] }
  /** The commands run, joined with spaces. */
  lines(): string[]
  w: AWorld
}

/** A provider context over a world. Bound to the intent; HEAD is on `w.branch`. */
export function ascripted(w: AWorld, options: PanelOptions = OPTIONS): AScripted {
  resetCache()
  resetForgeCache()
  const runs: (readonly string[])[] = []
  let flapped = 0
  let mrFlapped = 0
  const files: Record<string, string> = {
    [`${REPO}/.git/HEAD`]: `ref: refs/heads/${w.branch}\n`,
    [`${REPO}/.claude/tools/aidlc.ts`]: '// engine\n',
    [STATE]: w.local,
    ...(w.isBound === false
      ? {}
      : { [`${REPO}/aidlc/.aidlc-sessions/${SESSION}.binding.json`]: JSON.stringify({ space: 'default', intent: INTENT, boundAt: '2026-10-06T08:00:00Z' }) }),
    ...artifacts(w),
    ...w.extra,
  }
  const fail = { exitCode: 1, stdout: '', stderr: '' }
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  let fetched = false

  // glab, as a self-hosted GitLab answers it; the rows are fixtures/forge's shapes.
  const enc = encodeURIComponent(GITLAB_PATH)
  const glab = (argv: readonly string[]) => {
    const line = argv.join(' ')
    if (!w.isGlabUp) return fail
    if (line === `glab api --hostname ${GITLAB_HOST} projects/${enc}`) return ok(JSON.stringify({ ...project, default_branch: w.base }))
    if (argv[1] === 'mr' && argv[2] === 'list') {
      if (mrFlapped < (w.mrFlaps ?? 0)) {
        mrFlapped += 1
        return fail
      }
      const flag = argv[5]
      const rows = w.mrs.filter(row => (flag === '--all' ? true : flag === '--merged' ? row.state === 'merged' : flag === '--closed' ? row.state === 'closed' : row.state === 'opened'))
      const page = Number(argv[argv.indexOf('-p') + 1] ?? 1)
      return ok(JSON.stringify(rows.slice((page - 1) * 100, page * 100)))
    }
    const view = /^glab mr view (\d+) -R \S+ -F json$/.exec(line)
    if (view) {
      const row = w.mrs.find(m => m.iid === Number(view[1]))
      return row ? ok(JSON.stringify({ ...mrView(row.iid, w.pipelines[row.iid] ?? null), ...row })) : fail
    }
    const approvals = /^glab api --hostname \S+ projects\/\S+\/merge_requests\/(\d+)\/approvals$/.exec(line)
    if (approvals) return ok(JSON.stringify(w.approvals[Number(approvals[1])] ? approved : notApproved))
    const diffs = /^glab api --hostname \S+ projects\/\S+\/merge_requests\/(\d+)\/diffs\?per_page=100(?:&page=(\d+))?$/.exec(line)
    if (diffs) {
      const paths = w.files[Number(diffs[1])]
      if (!paths) return fail
      return ok(JSON.stringify(Number(diffs[2] ?? 1) > 1 ? [] : paths.map(path => ({ ...changes.changes[0], old_path: path, new_path: path }))))
    }
    const diff = /^glab api --hostname \S+ projects\/\S+\/merge_requests\/(\d+)\/changes$/.exec(line)
    if (diff) {
      const paths = w.files[Number(diff[1])]
      return paths ? ok(JSON.stringify({ changes: paths.map(path => ({ ...changes.changes[0], old_path: path, new_path: path })) })) : fail
    }
    return fail
  }

  const host = {
    runs,
    run: async (argv: readonly string[]) => {
      runs.push(argv)
      const line = argv.join(' ')
      if (argv[0] === 'git' && argv[1] === '-C') {
        const rest = argv.slice(3).join(' ')
        if (rest === 'rev-parse --show-toplevel') return w.isRepo ? ok(`${REPO}\n`) : fail
        if (rest === 'rev-parse --show-prefix') return w.isRepo ? ok(`${PREFIX}\n`) : fail
        if (rest === `rev-parse --verify --quiet origin/${w.base}`) return w.hasRef || (fetched && w.refAfterFetch) ? ok(`${w.localSha}\n`) : fail
        if (rest === `fetch --quiet origin ${w.base}`) {
          fetched = true
          return ok('')
        }
        if (rest === 'remote get-url origin') return w.hasOrigin ? ok(`${w.origin}\n`) : fail
        if (rest === `show origin/${w.base}:${PREFIX}aidlc-state.md`) return w.main === null ? fail : ok(w.main)
        if (rest === `rev-list --left-right --count origin/${w.base}...HEAD`) return w.distance ? ok(`${w.distance.behind}\t${w.distance.ahead}\n`) : fail
        if (rest === `rev-list --count HEAD..origin/${w.base}`) return ok(`${w.behind}\n`)
        if (rest === `ls-remote origin refs/heads/${w.base}`) return w.isLsRemoteUp ? ok(`${w.remoteSha}\trefs/heads/${w.base}\n`) : fail
        if (rest === 'symbolic-ref --short refs/remotes/origin/HEAD') return fail
        const pushed = /^rev-parse --verify --quiet refs\/remotes\/origin\/(.+)$/.exec(rest)
        if (pushed) return w.pushed.includes(pushed[1] as string) ? ok('cccc3333\n') : fail
      }
      if (line.startsWith('gh auth status ')) return w.isGhAuthed ? ok('') : fail
      if (line.startsWith('glab auth status ')) return w.isGlabAuthed ? ok('') : fail
      if (argv[0] === 'glab') return glab(argv)
      if (line === 'gh repo view --json url,defaultBranchRef') {
        return w.isGhUp ? ok(JSON.stringify({ url: REPO_URL, defaultBranchRef: { name: w.base } })) : fail
      }
      const list = /^gh pr list --state (open|merged) --limit (\d+) --json (\S+)$/.exec(line)
      if (list) {
        if (!w.isGhUp || w.prs === null) return fail
        if (flapped < (w.listFlaps ?? 0)) {
          flapped += 1
          return fail
        }
        const isOpen = list[1] === 'open'
        // gh answers only the fields asked for: the merged query leaves the review and check fields out. The open
        // query also hands back whatever is not merged, so a test can feed it a malformed row.
        const fields = (list[3] as string).split(',')
        const rows = w.prs.filter(row => (isOpen ? row?.state !== 'MERGED' && row?.state !== 'CLOSED' : row?.state === 'MERGED'))
        return ok(JSON.stringify(rows.map(row => (row === null || typeof row !== 'object' ? row : Object.fromEntries(Object.entries(row).filter(([k]) => fields.includes(k)))))))
      }
      if (/^gh api user\/teams\?per_page=100 --hostname \S+$/.test(line)) {
        return w.isGhUp && w.teams !== undefined
          ? ok(JSON.stringify(w.teams.map(id => ({ slug: id.split('/')[1], organization: { login: id.split('/')[0] } }))))
          : fail
      }
      if (/^gh api user --hostname \S+$/.test(line)) return w.isGhUp && w.viewer !== undefined ? ok(JSON.stringify({ login: w.viewer })) : fail
      const view = /^gh pr view (\d+) --json files$/.exec(line)
      if (view) {
        const paths = w.files[Number(view[1])]
        return w.isGhUp && paths ? ok(JSON.stringify({ files: paths.map(path => ({ path })) })) : fail
      }
      return fail
    },
    complete: async () => ({ isAnswered: false, text: '' }),
    store: { get: async () => undefined, set: async () => {} },
  }
  const ctx: ProviderContext = { fsx: fsxOf({ files }), host, startDir: REPO, sessionId: SESSION, now: NOW, options }
  return { ctx, host, lines: () => runs.map(argv => argv.join(' ')), w }
}

export async function aload(w: AWorld, options?: PanelOptions): Promise<{ s: AScripted; model: PanelModel; detection: Detection }> {
  const s = ascripted(w, options)
  const detection = await aidlc.detect(s.ctx)
  if (!detection) throw new Error('expected a detection')
  return { s, detection, model: await aidlc.load(s.ctx, detection) }
}

export const sectionOf = (model: PanelModel, id: string) => {
  const found = model.sections.find(one => one.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}
export const itemOf = (model: PanelModel, id: string) => {
  const found = model.sections.flatMap(s => s.items).find(one => one.id === id)
  if (!found) throw new Error(`no item ${id}`)
  return found
}
