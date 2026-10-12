// The AI-DLC provider's private shapes: what its parse and selection layers
// agree on before anything becomes a provider-neutral PanelModel. Types only.

/** A stage checkbox as upstream's state template spells it. */
export type StageMarker =
  | 'pending' //            [ ]
  | 'in-progress' //        [-]
  | 'awaiting-approval' //  [?]
  | 'revising' //           [R]
  | 'completed' //          [x]
  | 'skipped' //            [S]

/** A `## Phase Progress` value. */
export type PhaseStatus = 'pending' | 'active' | 'verified' | 'skipped'

/** One `- [m] <slug> — EXECUTE|SKIP[: reason]` row. */
export type ParsedStage = {
  slug: string
  marker: StageMarker
  /** false for `— SKIP…`: the stage is out of scope, whatever its box says. */
  isExecuted: boolean
  /** The text after `SKIP:` or `EXECUTE:`, if any. */
  note: string
}

/** One `### <NAME> PHASE` section of `## Stage Progress`. */
export type ParsedPhase = {
  /** Upper-case token from the heading: INITIALIZATION, IDEATION, ... */
  key: string
  /** The `Per unit: …` line under a Construction heading, raw. */
  perUnit: string
  stages: ParsedStage[]
}

/** What `parseState` reads out of one aidlc-state.md. */
export type ParsedState = {
  /** Every `- **Key**: value` field, first occurrence wins, value trimmed. */
  fields: Record<string, string>
  /** `## Phase Progress`, keyed by upper-case phase token. */
  phaseProgress: Record<string, PhaseStatus>
  phases: ParsedPhase[]
  isArchived: boolean
}

/** Where the AI-DLC v2 workspace was found. */
export type Workspace = {
  /** The directory holding `aidlc/`, absolute. */
  root: string
  /** `<root>/aidlc`. */
  aidlcDir: string
  /** Engine marker files present (`.claude/tools/aidlc.ts`, ...). */
  engineMarkers: string[]
}

export type SelectionSource =
  | 'binding' //        aidlc/.aidlc-sessions/<sessionId>.binding.json
  | 'active-intent' //  intents/active-intent, the shared cursor
  | 'lone-intent' //    the only non-archived intent of the space
  | 'none'

/** stage = bound to an intent and on a stage branch; none = nothing to show. */
export type PanelMode = 'stage' | 'side-job' | 'none'

export type Selection = {
  space: string
  /** The intent record's directory name, or null when nothing is selected. */
  intent: string | null
  source: SelectionSource
  /** Display slug: intents.json `slug`, else the dir name minus its prefix/suffix. */
  slug: string
  /** Path of the selected aidlc-state.md, or '' */
  statePath: string
  /** True only for a usable binding to a live intent. */
  isBound: boolean
  /**
   * The session is bound, but to an intent that has been archived (or to
   * nothing, by archiving): it shows no workflow, and neither the shared
   * cursor nor the space root stands in. Upstream's `hidden`.
   */
  isHidden: boolean
  /** Live (non-archived) intents of the selection's space; tells "none" from "none chosen". */
  liveIntents: number
}
