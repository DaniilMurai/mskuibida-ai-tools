// Every word the person reads. Names are the display names from classify.ts
// (`Sonnet`, `Opus 5.5`); nothing in register.tsx spells out text of its own.

import { recacheTokens } from './classify'

export const header = 'Model fit'

export const checking = 'Checking model fit…'

export const question = (recommended: string) => `Switch to ${recommended} for this task?`

export const switchLabel = (recommended: string) => `Switch to ${recommended}`

export const stayLabel = (current: string) => `Stay on ${current}`

export const stayDescription = (current: string) => `Run it on ${current} as selected.`

/** Said on the Switch option when the session already holds a lot of context. */
export const recache = (contextTokens: number): string | undefined => {
  const tokens = recacheTokens(contextTokens)

  return tokens === undefined ? undefined : `re-reads ~${Math.round(tokens / 1000)}k tokens`
}

/** The classifier gave no reason: the Switch option still gets a line. */
export const defaultReason = 'A better fit for this task'

/** The Switch option's description: always a string, the reason first, then the re-read note. */
export const switchDescription = (reason: string, contextTokens: number): string =>
  [reason === '' ? defaultReason : reason, recache(contextTokens)].filter(part => part !== undefined).join(' · ')

export const fits = (current: string) => `${current} fits this task`

/** A mismatch the cost rule held back: said instead of "fits", which would not be true. */
export const holding = (current: string) =>
  `Staying on ${current} — a switch now would re-read the whole context`

/** The classifier's best tier is not one this person can use: say what is offered instead. */
export const fallbackReason = (wanted: string, offered: string) =>
  `${wanted} would fit best but isn't available; ${offered} is the closest`

/** Nothing better than the current model is available for this task. */
export const bestAvailable = (current: string) => `${current} is the best available model for this task`

export const switched = (recommended: string) => `This task runs on ${recommended}`

/** No terminal to switch the model from: the prompt is held and the picker is the way. */
export const heldRefilled = (recommended: string) =>
  `Pick ${recommended} in the model picker, then press Enter — your prompt is back in the box`

export const heldResend = (recommended: string) =>
  `Pick ${recommended} in the model picker, then send your prompt again`

/** The text put back in the box so the person can continue the stopped turn. */
export const continueText = 'continue'

/** A Switch chosen mid-turn where the app owns the model: the turn is stopped. */
export const stoppedRefilled = (recommended: string) =>
  `Pick ${recommended} in the model picker, then press Enter to continue`

export const stoppedResend = (recommended: string) =>
  `Pick ${recommended} in the model picker, then send "${continueText}"`

export const pickInPicker = (recommended: string) =>
  `Pick ${recommended} in the model picker to keep it for the session`

/** The line the model reads, so it does not misname itself while the system prompt is stale. */
export const routedContext = (recommended: string, current: string) =>
  `This task runs on ${recommended}: the person switched to it from ${current} when asked. ` +
  `Any mention of ${current} as your model, in the system prompt or elsewhere, is out of date; you are ${recommended}.`
