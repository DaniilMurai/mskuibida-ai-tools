export type ModelFitAlias = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type ModelFitOption = { label: string; description?: string }

/** The question on screen: the render hook reads it to add descriptions. */
export type ModelFitPending = { question: string; options: ModelFitOption[] }

/** A Switch the person chose: the task's turn runs on `targetId`, and nothing outlives that turn. */
export type ModelFitRoute = {
  /** The alias, for `/model <alias>` (which resolves it itself). */
  target: ModelFitAlias
  /** The full model id requests of the routed task are sent with (a turn.step rewrite takes no alias). */
  targetId: string
  /** The session model when the choice was made; if it changes, the person's own choice wins. */
  fromModel: string
  /** The target is a lower tier: its steps are sent without `effort`, so the target's default applies. */
  isDown: boolean
  /** The turn this route belongs to: bound by the first main-loop step after the Switch, null before. */
  turnId: string | null
}

/** A prompt the classifier could not judge from its words alone: asked again as tool results arrive. */
export type ModelFitRecheck = {
  /** The prompt text (prompts sent between turns are appended). */
  text: string
  /** The turn whose steps recheck: bound by its first step, null again once that turn ends. */
  turnId: string | null
  /** The session model when the recheck began: if it changes, the person chose, and the recheck is dropped. */
  model: string
  /** Turns that ended since the last recheck call (the turn it fired in included); past the limit the recheck expires. */
  turnsCarried: number
  /** The step's `messageCount` at the last check: a recheck looks only at rows past it. */
  lastMessageCount: number
  /** A hash of the tool results the classifier last saw: the same evidence is not paid for twice. */
  lastHash: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-fit': {
      /** The real-task check has run for this session. */
      checked: boolean
      /** Classifier calls that failed, returned nothing usable, or could not judge the prompt. */
      attempts: number
      /** A check is under way (classifying or waiting on the dialog): other prompts pass straight through. */
      inFlight: boolean
      pending: ModelFitPending | null
      route: ModelFitRoute | null
      recheck: ModelFitRecheck | null
      /** Recheck classifier calls made this session, across every cycle. */
      rechecks: number
      /** The id of the turn running now (`turn.start`'s), which `$.turn.abort` wants. */
      runningTurn: string | null
    }
  }
}
