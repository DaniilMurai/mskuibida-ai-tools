// Who is looking at the pane, as the forge knows them (GitHub: `gh api user`, and `gh api user/teams` for a review
// asked of a team), and whether this repository runs the `pr-review` commands. Both answer rather than reject: an unknown viewer is '' (no rows tied to "you"), an
// unreadable settings file is "not installed".
import type { Forge } from '../../forge/types'
import type { ReviewFacts } from './facts'
import type { ReviewCtx } from './view'

/** A login is kept this long; a failure only a minute, so a gh that comes back is asked again soon. */
const KEEP_MS = 3_600_000
const RETRY_MS = 60_000
const NET_MS = 15_000

const viewers = new Map<string, { login: string; at: number }>()
const teamsOf = new Map<string, { teams: string[] | null; at: number }>()

/** Forgets every viewer and their teams; the tests call it between worlds. */
export function resetViewer(): void {
  viewers.clear()
  teamsOf.clear()
}

/** The signed-in forge user's login for the repository at `root`; '' when the forge cannot say (or has no viewer). */
export async function viewerLogin(forge: Pick<Forge, 'viewer'> | null, root: string, now: number): Promise<string> {
  if (!forge?.viewer) return ''
  const hit = viewers.get(root)
  if (hit && now - hit.at < (hit.login === '' ? RETRY_MS : KEEP_MS)) return hit.login
  const login = (await forge.viewer({ timeoutMs: NET_MS }).catch(() => '')).trim()
  viewers.set(root, { login: /^[A-Za-z0-9_-]{1,64}$/.test(login) ? login : '', at: now })
  return viewers.get(root)?.login ?? ''
}

/**
 * The teams the viewer is in (`org/slug`), for a review asked of a team; [] when the forge cannot say (or has no
 * teams to ask about). Kept an hour, a failure a minute, like the login.
 */
export async function viewerTeams(forge: Pick<Forge, 'viewerTeams'> | null, root: string, now: number): Promise<string[]> {
  if (!forge?.viewerTeams) return []
  const hit = teamsOf.get(root)
  if (hit && now - hit.at < (hit.teams === null ? RETRY_MS : KEEP_MS)) return hit.teams ?? []
  const teams = await forge.viewerTeams({ timeoutMs: NET_MS }).catch(() => null)
  teamsOf.set(root, { teams, at: now })
  return teams ?? []
}

/** What the review context needs to know: the open PRs, the forge, the option and a way to read the settings file. */
export type ReviewInputs = {
  forge: Pick<Forge, 'viewer' | 'viewerTeams'> | null
  root: string
  now: number
  options: { reviewCommands?: string; slackDomain?: string }
  open: readonly { review?: ReviewFacts }[]
  /** The repository's `.claude/settings.json`, null when it cannot be read; asked only for `reviewCommands: auto`. */
  settings: () => Promise<string | null>
}

/**
 * Who is looking, the teams they are in, whether the `pr-review` commands run here, and the Slack domain. Asked
 * only when there is an open PR to speak about; the teams only when one of them asks a team.
 */
export async function reviewCtxOf(inputs: ReviewInputs): Promise<ReviewCtx> {
  const slackDomain = inputs.options.slackDomain ?? ''
  if (inputs.open.length === 0) return { viewer: '', commands: false, slackDomain }
  const option = inputs.options.reviewCommands
  const asksTeam = inputs.open.some(pr => (pr.review?.requestedTeams ?? []).length > 0)
  const [viewer, teams, settings] = await Promise.all([
    viewerLogin(inputs.forge, inputs.root, inputs.now),
    asksTeam ? viewerTeams(inputs.forge, inputs.root, inputs.now) : Promise.resolve([]),
    option === 'on' || option === 'off' ? Promise.resolve(null) : inputs.settings(),
  ])
  return { viewer, ...(teams.length > 0 ? { teams } : {}), commands: usesReviewCommands(option, enablesPrReview(settings)), slackDomain }
}

/**
 * True when a project settings file (`.claude/settings.json`, as text) turns on a `pr-review` plugin
 * (`"enabledPlugins": { "pr-review@<marketplace>": true }`). Anything unreadable is false.
 */
export function enablesPrReview(text: string | null): boolean {
  if (text === null) return false
  try {
    const parsed = JSON.parse(text) as { enabledPlugins?: unknown }
    const plugins = parsed.enabledPlugins
    if (typeof plugins !== 'object' || plugins === null) return false
    return Object.entries(plugins as Record<string, unknown>).some(([id, on]) => (id === 'pr-review' || id.startsWith('pr-review@')) && on === true)
  } catch {
    return false
  }
}

/** The `reviewCommands` option against what the repository says: `on` and `off` win, `auto` asks the settings. */
export function usesReviewCommands(option: string | undefined, isEnabledHere: boolean): boolean {
  if (option === 'on') return true
  if (option === 'off') return false
  return isEnabledHere
}
