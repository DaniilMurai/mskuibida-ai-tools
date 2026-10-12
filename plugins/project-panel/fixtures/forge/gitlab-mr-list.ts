// `glab mr list --all -F json -P 100 -p N` as a self-hosted GitLab answers it (glab 1.99.0), sanitised:
// host gitlab.example.test, project acme/platform/scanner, generic people and subjects. What is kept from the
// recording is the shape: 275 merge requests (iid 275 down to 1) in pages of 100, 100 and 75, newest first;
// merged ones carry `merged_at` and `detailed_merge_status: ''`; three are closed with `merged_at: null`;
// labels are plain strings; branches are `<kind>/<ID>-<slug>`; the list rows carry no pipeline.
//
// The recorded project had no open merge request, so the open rows (`openRows`) follow the API's documented
// fields for an open one: `state: 'opened'`, a `detailed_merge_status`, `draft`.

export const GITLAB_HOST = 'gitlab.example.test'
export const GITLAB_PATH = 'acme/platform/scanner'
export const GITLAB_WEB = `https://${GITLAB_HOST}/${GITLAB_PATH}`

export type MrRow = {
  id: number
  iid: number
  project_id: number
  title: string
  state: 'opened' | 'merged' | 'closed' | 'locked'
  target_branch: string
  source_branch: string
  created_at: string
  updated_at: string
  author: { id: number; username: string; name: string; state: string; avatar_url: null; web_url: string }
  assignees: never[]
  reviewers: never[]
  labels: string[]
  draft: boolean
  detailed_merge_status: string
  merged_at: string | null
  closed_at: string | null
  sha: string
  web_url: string
  references: { short: string; relative: string; full: string }
}

/** A 40-character commit id derived from a number: stable, distinct, obviously not real. */
export function shaOf(seed: number): string {
  return seed.toString(16).padStart(8, '0').repeat(5)
}

function stamp(day: number, hour = 9): string {
  const d = new Date(Date.UTC(2026, 7, 1 + day, hour, 15, 0))
  return d.toISOString().replace('.000Z', '.123Z')
}

/** One row with the recorded field set; `over` changes what a test is about. */
export function mrRow(iid: number, over: Partial<MrRow> = {}): MrRow {
  const day = Math.floor(iid / 4)
  return {
    id: 1000 + iid,
    iid,
    project_id: 256,
    title: `Change ${iid}`,
    state: 'merged',
    target_branch: 'main',
    source_branch: `feat/FEAT-GEN-${iid}`,
    created_at: stamp(day, 8),
    updated_at: stamp(day, 10),
    author: { id: 1, username: 'dev-one', name: 'Dev One', state: 'active', avatar_url: null, web_url: `https://${GITLAB_HOST}/dev-one` },
    assignees: [],
    reviewers: [],
    labels: ['reviewed:approved'],
    draft: false,
    detailed_merge_status: '',
    merged_at: stamp(day, 10),
    closed_at: null,
    sha: shaOf(iid),
    web_url: `${GITLAB_WEB}/-/merge_requests/${iid}`,
    references: { short: `!${iid}`, relative: `!${iid}`, full: `${GITLAB_PATH}!${iid}` },
    ...over,
  }
}

const KINDS = ['feat/FEAT-GEN', 'fix/FIX-GEN', 'chore/CHORE-GEN', 'docs/DOCS-GEN', 'feat/T']

/** The row for iid `n` in the recorded history: a spread of branch shapes, three closed, the rest merged. */
function historyRow(n: number): MrRow {
  const closed = n === 245 || n === 229 || n === 48
  const kind = KINDS[n % KINDS.length] as string
  const id = kind.endsWith('/T') ? `T${n}` : `${kind}-${n}`
  const branch = kind.endsWith('/T') ? `${kind.split('/')[0]}/T${n}-generic-slug` : `${kind.split('/')[0]}/${kind.split('/')[1]}-${n}-generic-slug`
  const base = {
    title: `${id}: generic subject ${n}`,
    source_branch: n === 250 ? 'claude/generic-session-52274f' : branch,
    labels: n % 3 === 0 ? ['qa:passed', 'reviewed:approved'] : n % 7 === 0 ? [] : ['reviewed:approved'],
  }
  return closed
    ? mrRow(n, { ...base, state: 'closed', merged_at: null, closed_at: stamp(Math.floor(n / 4), 11) })
    : mrRow(n, base)
}

/** All 275 rows of the history, newest first (iid descending), as the three pages concatenated. */
export const history: MrRow[] = Array.from({ length: 275 }, (_, i) => historyRow(275 - i))

/** Page `n` (1-based) of `-P 100`: 100, 100, then 75 rows, then []. */
export function page(n: number, perPage = 100): MrRow[] {
  return history.slice((n - 1) * perPage, n * perPage)
}

/** Open merge requests: the shapes the list gives for each `detailed_merge_status` a panel reads. */
export const openRows: MrRow[] = [
  mrRow(281, { state: 'opened', merged_at: null, source_branch: 'feat/FEAT-GEN-281', title: 'FEAT-GEN-281: open and mergeable', detailed_merge_status: 'mergeable', labels: ['reviewed:approved'] }),
  mrRow(280, { state: 'opened', merged_at: null, source_branch: 'fix/FIX-GEN-280-slug', title: 'Draft: FIX-GEN-280: a draft', draft: true, detailed_merge_status: 'draft_status', labels: [] }),
  mrRow(279, { state: 'opened', merged_at: null, source_branch: 'feat/FEAT-GEN-279', title: 'FEAT-GEN-279: behind main', detailed_merge_status: 'need_rebase', labels: ['qa:failed'] }),
  mrRow(278, { state: 'opened', merged_at: null, source_branch: 'feat/FEAT-GEN-278', title: 'FEAT-GEN-278: needs an approval', detailed_merge_status: 'not_approved', labels: [] }),
  mrRow(277, { state: 'opened', merged_at: null, source_branch: 'feat/FEAT-GEN-277', title: 'FEAT-GEN-277: conflicts', detailed_merge_status: 'conflict', labels: [] }),
  mrRow(276, { state: 'opened', merged_at: null, source_branch: 'feat/FEAT-GEN-276', title: 'FEAT-GEN-276: changes requested', detailed_merge_status: 'requested_changes', labels: [] }),
]
