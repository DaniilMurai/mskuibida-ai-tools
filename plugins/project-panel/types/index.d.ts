// The project-panel contract: the provider seam, the provider-neutral
// PanelModel every layer agrees on, and the values the mod keeps in `$.state`.
//
// One direction: a Provider detects its kind of plan (AI-DLC v2 today; a
// WORKPLAN.md ledger, docs, code later) and loads it into a PanelModel; the
// renderer (src/render.tsx) draws any PanelModel the same way, per surface.
// src/detect.ts tries the providers in order, and the first hit wins.
//
// Text in the model is DISPLAY text a provider resolved through
// src/strings/en.ts (or took from the plan itself: a stage slug, a ticket
// title). An empty string means "nothing to show": the renderer hides that
// element and never substitutes text. The renderer's own chrome (refresh,
// "read 12:03", the ring's alt) is resolved there, also through en.ts.
//
// Later milestones only ADD: M2 fills `freshness`, polls `watch` and a
// provider's optional remote `fingerprint` (src/refresh.ts); M3 adds
// two truths per item (`Item.landing`: merged on the default branch, in an open
// PR, or only in this working tree), PR chips, fold groups (`Item.group`),
// reopen chips, `PanelHeader.base` and the PR gate kinds; M4 fills captions and
// side-job titles through a structured-JSON enrichment step. A model call never
// emits UI.

// ── Provider seam ────────────────────────────────────────────────────────────

/** The four file reads a provider needs; never rejects (src/fsx.ts has the helpers). */
export type FsxEntry = { name: string; kind: 'file' | 'dir' | 'other' }
export type Fsx = {
  /** The file's text, or null when it is missing or unreadable. */
  read: (path: string) => Promise<string | null>
  exists: (path: string) => Promise<boolean>
  /** The directory's entries, [] when it is missing. */
  list: (path: string) => Promise<FsxEntry[]>
  /** Last modification in epoch ms, or null when missing. */
  mtime: (path: string) => Promise<number | null>
}

export type ProviderId = 'aidlc' | 'ledger' | 'docs' | 'code'

/**
 * Everything a provider may do besides read files: run a command, ask a model,
 * keep a value. hooks/register.tsx adapts `$.process.run`, `$.model.complete`
 * and `$.store` to it (in that file, as with Fsx), the tests hand a mock.
 * Anything that would spawn a process goes through `run`, never around it.
 */
export type ProviderHost = {
  /** Runs `argv` (no shell); resolves on any exit code, rejects when it cannot start or times out. */
  run(
    argv: readonly string[],
    init?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** One model completion; `isAnswered: false` carries `text: ''`. */
  complete(req: {
    model: string
    prompt: string
    system?: string
    maxTokens?: number
  }): Promise<{ isAnswered: boolean; text: string }>
  /**
   * Calls `tool` on one of the session's connected MCP servers (`$.mcp.call`): the text blocks joined, and whether
   * the server reported an error. Rejects when the server is not connected or the call cannot be made. Absent = no
   * MCP (tests, a host without it).
   */
  mcp?(server: string, tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>
  /** Writes a whole file, creating its directories (`$.fs.write`). Absent = the host writes nothing. */
  write?(path: string, text: string): Promise<void>
  /** The plugin's persistent store (JSON values; survives the session). */
  store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
}

/** What every provider is handed: file reads, the host, the session, the options. */
export type ProviderContext = {
  fsx: Fsx
  host: ProviderHost
  /** The session's project root, absolute. */
  startDir: string
  sessionId: string
  /** Epoch ms. */
  now: number
  options: PanelOptions
}

export type PanelOptions = {
  stageBranchPattern: string
  foldSeparator: string
  /**
   * Which forge the repository's origin lives on (src/forge/): `auto` finds out (github.com is GitHub, a host
   * `glab` is logged in to is GitLab, one `gh` is logged in to is GitHub Enterprise), `none` reads no pull or
   * merge requests. Absent = `auto`.
   */
  forge?: 'auto' | 'github' | 'gitlab' | 'none'
  /**
   * Whether attention rows and Next name the `pr-review` commands (`/pr-review:review-pr N`, ...): `auto` when
   * the repository's `.claude/settings.json` enables a `pr-review` plugin, `on`, `off`. Absent = `auto`.
   */
  reviewCommands?: 'auto' | 'on' | 'off'
  /** The Slack workspace's domain (`acme` for acme.slack.com): makes the PR's Slack thread a link. '' = presence only. */
  slackDomain?: string
}

/** A provider's hit: where its plan lives, plus whatever it found on the way. */
export type Detection = {
  provider: ProviderId
  /** The directory the plan belongs to, absolute. */
  root: string
  /** Provider-private findings, handed back to its `load` untouched. */
  detail: Record<string, unknown>
}

export interface Provider {
  id: ProviderId
  /** null = not this provider's kind of repo. Never throws. */
  detect(ctx: ProviderContext): Promise<Detection | null>
  load(ctx: ProviderContext, detection: Detection): Promise<PanelModel>
  /**
   * Runs one of the model's `actions` (a button the person pressed) and
   * returns the model afterwards; the panel stores it and redraws.
   */
  act?(ctx: ProviderContext, detection: Detection, actionId: string): Promise<PanelModel>
  /**
   * A cheap fingerprint of the plan's REMOTE state (open PRs, the default
   * branch's tip on origin): anything `watch` mtimes cannot see. The refresh
   * engine (src/refresh.ts) calls it every `prPollSeconds` and when a surface
   * attaches; a fingerprint that differs from the last one triggers `load`.
   * Absent = the provider has no remote state. The ledger and the AI-DLC
   * provider (M3) both have: the PR list and the default branch's tip.
   *
   * Runs through `ctx.host.run` only. May throw (gh missing, offline): the
   * panel keeps its last model and shows one Attention line, never an error.
   * Keep it cheap: no model calls, one or two commands.
   */
  fingerprint?(ctx: ProviderContext, detection: Detection): Promise<string>
}

// ── The provider-neutral model ───────────────────────────────────────────────

/**
 * stage    — the session works on one item of the plan (an AI-DLC stage session).
 * side-job — the repo has a plan, this session isn't one of its items.
 * inferred — the plan was read off conventions, not declared (later providers).
 * idle     — a plan exists but nothing is in flight (no active intent).
 */
export type HeaderMode = 'stage' | 'side-job' | 'inferred' | 'idle'

export type SectionStatus = 'built' | 'partial' | 'planned' | 'active' | 'skipped'

export type ItemStatus =
  | 'done'
  | 'partial'
  | 'open' //      in progress
  | 'planned' //   not started
  | 'failed'
  | 'skipped'
  | 'revising'
  | 'awaiting' //  waiting on a person (approval, answers)
  | 'reopened' //  was done, being redone (AI-DLC: a merged stage carried again); not done
  | 'stale' //     was done, but built on a reopened item before it; not done

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

/**
 * Where an item's progress lives, for a provider that reads the plan twice (the
 * working tree and the default branch on origin), M3:
 *   merged — done on the default branch (✓);
 *   in-pr  — done or in progress on a branch with an open PR, or pushed when
 *            PRs could not be read; not merged (◐);
 *   local  — only in this working tree (not pushed), or pushed with no PR (◌).
 * Absent = the item's status is the default branch's own (or the provider reads
 * one truth only): drawn by `status` as before.
 */
export type Landing = 'merged' | 'in-pr' | 'local'

/**
 * Where an open PR's review stands (src/providers/review/facts.ts): a draft, awaiting a reviewer, changes
 * requested, only commented, approved but changed since (stale), approved (with or without comments), or nobody
 * asked yet. Not display text: it colours the
 * status word and keeps it on a narrow row.
 */
export type ReviewState = 'draft' | 'awaiting' | 'changes' | 'commented' | 'stale' | 'approved' | 'approved-comments' | 'unreviewed'

/** A short tag on an item: a PR number, a unit, a fold or reopen marker. */
export type Chip = {
  kind: 'pr' | 'unit' | 'fold' | 'reopen' | 'tag'
  label: string
  tone: Tone
  /** When set, the renderer draws the chip as a link to it. */
  href?: string
}

export type Item = {
  id: string
  /** One line. */
  title: string
  status: ItemStatus
  /** The item the session (or the plan's cursor) is on. */
  isCurrent: boolean
  chips: Chip[]
  /** ≤ 2 sentences. */
  caption?: string
  /** When set, the renderer draws the title as a link to it. */
  href?: string
  /** Where the item's progress lives (M3); drives the glyph: ✓ merged, ◐ in-pr, ◌ local. */
  landing?: Landing
  /**
   * Finished (checked off) in this working tree but not landed anywhere (landing `local`): the status is still
   * open and the row is drawn ◌ "local only", yet counts, rings and the plan's percent take it as done.
   */
  isFinishedLocal?: boolean
  /**
   * Where the item sits in the plan's numbering ("3.2": the third phase's second stage); '' or absent = unnumbered.
   * Not display text: the renderer draws it dim beside the title.
   */
  ordinal?: string
  /**
   * Display text that replaces the status word on the row ("in PR #33",
   * "local only"); '' hides the word. Absent = the status's own word.
   */
  statusWord?: string
  /** The review state of the item's open PR; the status word then says it ("changes requested"). */
  review?: ReviewState
  /**
   * Consecutive items sharing a `group` draw one bracket in the fold gutter
   * (one PR spanning several stages). Not display text; a lone item draws none.
   */
  group?: string
}

export type Section = {
  id: string
  title: string
  caption?: string
  /** 0–100; the renderer draws a ring wherever it is set. */
  percent?: number
  /** Counted items, for the "4/8" beside the ring. */
  counts?: { done: number; total: number }
  status: SectionStatus
  /** Default fold; the person's own choice (state `expanded`) wins. */
  isCollapsed: boolean
  /** The phase's number in the plan ("3"); absent = unnumbered. Not display text: drawn dim beside the title. */
  ordinal?: string
  /**
   * The section's items stand for work that is not defined yet (Construction before its Units exist): they carry no
   * count or ring and are left out of the plan's totals.
   */
  isUncounted?: boolean
  /** Suggested by the provider, not declared in the plan: the row is dimmed and tagged. */
  isProposed?: boolean
  items: Item[]
}

/**
 * A gate between items: drawn right after `afterItemId` in its section (the
 * item it holds, or the last one before what it blocks); without
 * `afterItemId`, at the top of the section.
 */
export type Gate = {
  id: string
  /**
   * parked, awaiting-approval, questions-unanswered, guard-refusal,
   * pr-not-merged, ci-failing, changes-requested, behind-main, conflicts, and the rows tied to the viewer:
   * review-requested, approved-comments, approved, review-not-requested, ...
   */
  kind: string
  /** success and accent are for rows that are good news with a step left (an approved PR to merge). */
  tone: 'warning' | 'error' | 'success' | 'accent'
  title: string
  /** One line. */
  caption?: string
  sectionId: string
  afterItemId?: string
  /** When set, the renderer draws the title as a link to it (the PR a gate waits on). */
  href?: string
  /** A command that deals with it (`/pr-review:review-pr 33`); the row offers to put it in the prompt. */
  command?: string
  /**
   * Drawn under Needs attention only, never in the plan's list: a row about the viewer (a review asked of
   * them), which may concern a PR outside the plan.
   */
  isAttentionOnly?: boolean
}

/** A short flag that the plan and the repo disagree (M3: done on branch, not merged). */
export type Drift = {
  id: string
  label: string
  tone: Tone
}

export type PanelHeader = {
  title: string
  mode: HeaderMode
  /** One line under the title: "Inception · unit api · domain-design". */
  subtitle: string
  /** The badge for side-job / idle ("Side job"); '' in stage mode. */
  badge: string
  /** ≤ 2 sentences. */
  caption: string
  /** The plan's own "last updated", as written there ('' when absent). */
  updatedAt: string
  /**
   * One line: where the default branch stands when this session is ahead of it
   * ("main: refined-mockups in PR #33"). Drawn under the Now card's item;
   * absent or '' hides it.
   */
  base?: string
  /**
   * What the provider knows about this session when it is a side job (mode `side-job`): drawn in the Now card
   * under the caption, one dim line each. Absent or empty = nothing to show.
   */
  context?: ContextLine[]
}

/** One line about the session itself (its branch, its pull request, how far it is from the default branch). */
export type ContextLine = {
  id: string
  text: string
  /** When set, the renderer draws the line as a link to it (the session's PR). */
  href?: string
  /** Colours the line; absent = dim. */
  tone?: Tone
}

/** What to do next: a command the person can put in the prompt, and why. */
export type Next = {
  /** Drawn bold; "put in prompt" fills it. '' hides the block. */
  command: string
  /** One line, dim. */
  reason: string
}

/** A button under the header card; a press calls `Provider.act`. */
export type Action = {
  id: string
  label: string
}

export type PanelModel = {
  version: 2
  provider: ProviderId
  /** The directory the plan belongs to. */
  root: string
  header: PanelHeader
  overall: {
    percent?: number
    /**
     * Display text for the plan heading's summary (e.g. "74% of effort · 189/287 tasks"); when set
     * (non-empty) it replaces the renderer's own "{percent}% done, {done} of {total}".
     */
    label?: string
    counts: Partial<Record<ItemStatus, number>> & { total: number }
  }
  /** Under the header card. */
  next?: Next
  actions?: Action[]
  /**
   * Default fold of the whole Plan block (its heading becomes a toggle); the person's own choice (state
   * `expanded`, key `#plan`) wins. Absent = the plan is always drawn open, with no toggle.
   */
  isPlanCollapsed?: boolean
  sections: Section[]
  gates: Gate[]
  drift: Drift[]
  /**
   * Absolute paths whose change means "re-load": files or directories. The
   * refresh engine polls their mtimes every `fsPollSeconds`, and a Write/Edit
   * tool call on a watched file, or on any path under a watched directory,
   * re-reads at once.
   */
  watch: string[]
  /** Epoch ms the model was read at. */
  readAt: number
  /** Filled by the refresh engine (src/refresh.ts), never by a provider. */
  freshness?: Freshness
}

/**
 * Set by the refresh engine when it publishes a model. The panel redraws only
 * when the model's hash (everything but `readAt` and `freshness`) changes, or
 * `error` does, so `checkedAt` is the check that produced what is drawn.
 */
export type Freshness = {
  /** Epoch ms of the check that produced this model. */
  checkedAt: number
  /**
   * Display text (src/strings/en.ts) when the latest re-read or remote check
   * failed: the model is the last good one, drawn with this as an Attention
   * line. Absent = the latest check succeeded.
   */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'project-panel': {
      /** The last model built for this session; null when no provider detected a plan. */
      model: PanelModel | null
      /** The person's own fold choices, by section id; absent = the section's default. */
      expanded: Record<string, boolean>
      /** The person closed the pane this session: `panel: auto` does not reopen it; /panel does. */
      isClosed: boolean
    }
  }
}
