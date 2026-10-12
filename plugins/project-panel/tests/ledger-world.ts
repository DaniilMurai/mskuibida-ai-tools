// A scripted git/gh/glab/model world for the ledger provider: the host answers by argv from plain data, the
// file tree is the working copy, and every run, read and model call is recorded for assertions. The origin
// is a github.com URL by default (gh answers); `gitlabWorld` makes it a self-hosted GitLab (glab answers).
import { fsxOf } from '../fixtures/virtual'
import { resetForgeCache } from '../src/forge'
import * as rem from '../fixtures/ledger/reminders'
import { ledger } from '../src/providers/ledger'
import { resetViewer } from '../src/providers/review/viewer'
import type { Pr } from '../src/providers/ledger/types'
import type { Fsx, PanelModel, PanelOptions, ProviderContext, ProviderHost } from '../types'
import { NOW, OPTIONS } from './world'

export const REPO = '/work/shop'
export const REPO_URL = 'https://example.test/acme/shop'
export const GITLAB_HOST = 'gitlab.example.test'
export const GITLAB_PATH = 'acme/platform/scanner'
export const GITLAB_URL = `https://${GITLAB_HOST}/${GITLAB_PATH}`

export type World = {
  root: string
  startDir: string
  /** What `git ls-files -s` lists. */
  tracked: string[]
  /** File modes by path where not a regular file ('120000' symlink, '160000' submodule); default '100644'. */
  modes?: Record<string, string>
  /** Committed content at HEAD (`git show HEAD:<path>`) and working-copy files, by path relative to the root. */
  files: Record<string, string>
  /** `origin/<branch>` contents by relative path; `ls-tree` lists these. */
  remote: Record<string, string>
  /** Overrides what `ls-tree` lists. */
  remoteTree?: string[]
  /** Overrides modes on the remote tree (default '100644'). */
  remoteModes?: Record<string, string>
  branch: string
  defaultBranch: string
  isRepo: boolean
  /** The origin URL `git remote get-url origin` reports; null = the repository has no origin. */
  origin: string | null
  /** `gh auth status` succeeds (also what tells a `failed` call from a `not-logged-in` one). */
  isGhAuthed: boolean
  /** `glab auth status` succeeds. */
  isGlabAuthed: boolean
  isGhUp: boolean
  /** glab answers (project, merge requests); false = its calls exit 1. */
  isGlabUp: boolean
  isFetchUp: boolean
  isShowUp: boolean
  isPrListUp: boolean
  /** `git ls-remote` answers (the fingerprint's default-branch tip). */
  isLsRemoteUp: boolean
  /** The default branch's tip on origin, as `git ls-remote` reports it. */
  remoteSha: string
  prs: (Pr & { url?: string; headRefOid?: string; gh?: Record<string, unknown> })[]
  /** `gh api user`'s login; undefined = it fails. */
  viewer?: string
  /** `gh api user/teams`: the viewer's teams as `org/slug`; undefined = it fails. */
  teams?: string[]
}

export function world(over: Partial<World> = {}): World {
  return {
    root: REPO,
    startDir: REPO,
    tracked: [],
    files: {},
    remote: {},
    branch: 'main',
    defaultBranch: 'main',
    isRepo: true,
    origin: 'git@github.com:acme/shop.git',
    isGhAuthed: true,
    isGlabAuthed: false,
    isGhUp: true,
    isGlabUp: true,
    isFetchUp: true,
    isShowUp: true,
    isPrListUp: true,
    isLsRemoteUp: true,
    remoteSha: '0123abcd',
    prs: [],
    ...over,
  }
}

/** One scripted change as `glab mr list -F json` rows have it (the fields the forge reads). */
function glabRow(p: World['prs'][number]) {
  return {
    iid: p.number,
    title: p.title,
    state: p.state === 'OPEN' ? 'opened' : p.state.toLowerCase(),
    draft: false,
    source_branch: p.headRefName,
    web_url: p.url ?? `${GITLAB_URL}/-/merge_requests/${p.number}`,
    merged_at: p.mergedAt,
    labels: p.labels.map(l => l.name),
    sha: p.headRefOid ?? '',
    updated_at: p.mergedAt ?? '2026-10-01T00:00:00.000Z',
    detailed_merge_status: '',
  }
}

export type Scripted = {
  ctx: ProviderContext
  host: ProviderHost & { runs: (readonly string[])[] }
  /** Absolute paths the provider read through `fsx`. */
  reads: string[]
  /** Model requests, in order. */
  asked: { model: string; system?: string; prompt: string; maxTokens?: number }[]
  stored: Map<string, unknown>
  w: World
}

/** The model's replies by id; `undefined` = unanswered. A function is asked with the request. */
export type Replies = Partial<Record<'sonnet' | 'haiku', string | ((prompt: string) => string) | undefined>>

const SONNET = 'claude-sonnet-5-5'

/** Builds a provider context over a world. `replies` scripts the two models; `stored` is shared across contexts of one test. */
export function scripted(w: World, replies: Replies = {}, stored: Map<string, unknown> = new Map(), options: PanelOptions = OPTIONS): Scripted {
  resetForgeCache()
  resetViewer()
  const runs: (readonly string[])[] = []
  const asked: Scripted['asked'] = []
  const reads: string[] = []
  const abs: Record<string, string> = {}
  for (const [path, text] of Object.entries(w.files)) abs[`${w.root}/${path}`] = text
  const base = fsxOf({ files: abs })
  const fsx: Fsx = { ...base, read: async path => (reads.push(path), base.read(path)) }

  const fail = { exitCode: 1, stdout: '', stderr: '' }
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  const host = {
    runs,
    run: async (argv: readonly string[]) => {
      runs.push(argv)
      const line = argv.join(' ')
      if (argv[0] === 'git' && argv[1] === '-C') {
        const rest = argv.slice(3).join(' ')
        if (rest === 'rev-parse --show-toplevel') return w.isRepo ? ok(`${w.root}\n`) : fail
        if (rest === 'rev-parse --abbrev-ref HEAD') return w.isRepo ? ok(`${w.branch}\n`) : fail
        if (rest === 'ls-files -s -z') {
          return ok(w.tracked.map(p => `${w.modes?.[p] ?? '100644'} 0123456789abcdef0123456789abcdef01234567 0\t${p}`).join('\0') + '\0')
        }
        if (rest.startsWith('show HEAD:')) {
          const text = w.files[rest.slice('show HEAD:'.length)]
          return text === undefined ? fail : ok(text)
        }
        if (rest === 'symbolic-ref --short refs/remotes/origin/HEAD') return fail
        if (rest.startsWith('fetch --quiet origin ')) return w.isFetchUp ? ok('') : fail
        if (rest === `ls-tree -r -z origin/${w.defaultBranch}`) {
          if (!w.isShowUp) return fail
          const paths = w.remoteTree ?? Object.keys(w.remote)
          return ok(paths.map(p => `${w.remoteModes?.[p] ?? '100644'} ${w.remoteModes?.[p] === '160000' ? 'commit' : 'blob'} 0123456789abcdef0123456789abcdef01234567\t${p}`).join('\0') + '\0')
        }
        const show = /^show origin\/(.+?):(.+)$/.exec(rest)
        if (show) {
          const text = w.isShowUp && show[1] === w.defaultBranch ? w.remote[show[2] as string] : undefined
          return text === undefined ? fail : ok(text)
        }
        if (rest === `ls-remote origin refs/heads/${w.defaultBranch}`) {
          return w.isLsRemoteUp ? ok(`${w.remoteSha}\trefs/heads/${w.defaultBranch}\n`) : fail
        }
      }
      if (argv[0] === 'git' && argv[1] === '-C' && argv.slice(3).join(' ') === 'remote get-url origin') {
        return w.origin === null ? fail : ok(`${w.origin}\n`)
      }
      if (line.startsWith('gh auth status ')) return w.isGhAuthed ? ok('') : fail
      if (line.startsWith('glab auth status ')) return w.isGlabAuthed ? ok('') : fail
      if (line === 'gh repo view --json url,defaultBranchRef') {
        return w.isGhUp ? ok(JSON.stringify({ url: REPO_URL, defaultBranchRef: { name: w.defaultBranch } })) : fail
      }
      const list = /^gh pr list --state all --limit 1000 --json (\S+)$/.exec(line)
      if (list) {
        if (!w.isGhUp || !w.isPrListUp) return fail
        // gh answers only the fields asked for; `gh` on a fixture PR holds its raw review fields.
        const fields = (list[1] as string).split(',')
        const rows = w.prs.map(({ gh, ...pr }) => Object.fromEntries(Object.entries({ ...pr, ...gh }).filter(([k]) => fields.includes(k))))
        return ok(JSON.stringify(rows))
      }
      if (/^gh api user\/teams\?per_page=100 --hostname \S+$/.test(line)) {
        return w.teams !== undefined
          ? ok(JSON.stringify(w.teams.map(id => ({ slug: id.split('/')[1], organization: { login: id.split('/')[0] } }))))
          : fail
      }
      if (/^gh api user --hostname \S+$/.test(line)) return w.viewer === undefined ? fail : ok(JSON.stringify({ login: w.viewer }))
      if (argv[0] === 'glab') {
        if (!w.isGlabUp) return fail
        if (line === `glab api --hostname ${GITLAB_HOST} projects/${encodeURIComponent(GITLAB_PATH)}`) {
          return ok(JSON.stringify({ web_url: GITLAB_URL, default_branch: w.defaultBranch, path_with_namespace: GITLAB_PATH }))
        }
        if (argv[1] === 'mr' && argv[2] === 'list' && w.isPrListUp) {
          if (line.includes('-o updated_at')) return ok(JSON.stringify(w.prs.map(glabRow)))
          const page = Number(argv[argv.indexOf('-p') + 1])
          return ok(JSON.stringify(w.prs.map(glabRow).slice((page - 1) * 100, page * 100)))
        }
      }
      return fail
    },
    complete: async (req: { model: string; prompt: string; system?: string; maxTokens?: number }) => {
      asked.push(req)
      const reply = replies[req.model === SONNET ? 'sonnet' : 'haiku']
      if (reply === undefined) return { isAnswered: false, text: '' }
      return { isAnswered: true, text: typeof reply === 'function' ? reply(req.prompt) : reply }
    },
    store: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => void stored.set(key, JSON.parse(JSON.stringify(value))),
    },
  }
  const ctx: ProviderContext = { fsx, host, startDir: w.startDir, sessionId: 's', now: NOW, options }
  return { ctx, host, reads, asked, stored, w }
}

/** A repository whose origin is a self-hosted GitLab that glab is logged in to; `remWorld`'s ledger and merge requests. */
export function gitlabWorld(over: Partial<World> = {}): World {
  return remWorld({
    origin: `git@${GITLAB_HOST}:${GITLAB_PATH}.git`,
    isGlabAuthed: true,
    isGhAuthed: false,
    prs: rem.prs.map(p => ({ ...p, url: `${GITLAB_URL}/-/merge_requests/${p.number}` })),
    ...over,
  })
}

/** `gh pr list` rows carry a url; give every fixture PR one. */
export function withUrls(prs: Pr[]): (Pr & { url: string })[] {
  return prs.map(p => ({ ...p, url: `${REPO_URL}/pull/${p.number}` }))
}

export const PROPOSAL = JSON.stringify({
  sections: [
    { id: 'bot', title: 'Telegram bot', hint: 'chat surface' },
    { id: 'api', title: 'API', hint: 'HTTP endpoints' },
    { id: 'tooling', title: 'Tooling', hint: 'build and process' },
  ],
})

/**
 * A Haiku reply that files every item id found in the prompt under the first section, judges the
 * evidence-free ones done, and adds one planned section.
 */
export function assignAll(prompt: string): string {
  const ids = [...prompt.matchAll(/^([A-Za-z0-9][\w#-]*) \| [^|\n]*\| [^|\n]*\| \w+\/\w+$/gm)].map(m => m[1] as string)
  const judge = [...prompt.matchAll(/^([A-Za-z0-9][\w#-]*): /gm)].map(m => m[1] as string)
  return JSON.stringify({
    items: ids.map(id => ({ id, section: 'bot', title: `${id} short title`, ...(judge.includes(id) ? { status: 'done' } : {}) })),
    sections: [
      { id: 'bot', caption: 'The chat surface.' },
      { id: 'mobile', title: 'Mobile apps', caption: 'Not started.', planned: true },
    ],
    drift: ids.length > 0 ? [{ itemId: ids[0], note: 'prose says shipped' }] : [],
  })
}

// ── shared scenarios ─────────────────────────────────────────────────────────

export const REM_TRACKED = ['README.md', 'WORKPLAN.md', 'src/index.ts', 'packages/core/a.ts', 'packages/api/b.ts', 'docs/ARCHITECTURE.md']
export const ARCH = ['# Architecture', '## Overview', '```', '# not a heading', '```', '### Data flow', '#### too deep'].join('\n')

/** A repository with the reminders fixture as its ledger, up to date on origin/main. */
export function remWorld(over: Partial<World> = {}): World {
  return world({
    tracked: REM_TRACKED,
    files: { 'WORKPLAN.md': rem.ledgerText },
    remote: { 'WORKPLAN.md': rem.ledgerText, 'docs/ARCHITECTURE.md': ARCH, 'README.md': '# Shop' },
    remoteTree: [...REM_TRACKED, 'secrets/.env', 'notes.local'],
    prs: withUrls(rem.prs),
    ...over,
  })
}

/** The same repository, but with docs/DELIVERY.md naming the ledger: the repo declared its plan, so L2 may propose by itself. */
export function deliveryWorld(over: Partial<World> = {}): World {
  const delivery = '---\ntask-ledger: WORKPLAN.md\n---\n'
  const base = remWorld(over)
  return {
    ...base,
    tracked: [...base.tracked, 'docs/DELIVERY.md'],
    files: { ...base.files, 'docs/DELIVERY.md': delivery },
    remote: { ...base.remote, 'docs/DELIVERY.md': delivery },
  }
}

export async function load(w: World, replies: Replies = {}, stored?: Map<string, unknown>) {
  const s = scripted(w, replies, stored)
  const detection = await ledger.detect(s.ctx)
  if (!detection) throw new Error('expected a detection')
  return { s, detection, model: await ledger.load(s.ctx, detection) }
}

export const section = (model: PanelModel, id: string) => {
  const found = model.sections.find(one => one.id === id)
  if (!found) throw new Error(`no section ${id}`)
  return found
}
export const itemOf = (model: PanelModel, id: string) => {
  const found = model.sections.flatMap(s => s.items).find(one => one.id === id)
  if (!found) throw new Error(`no item ${id}`)
  return found
}
