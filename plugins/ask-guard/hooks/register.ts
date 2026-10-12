import type { Register } from 'claude-code'

// The dialog draws a question as plain text: no markdown, no line structure. Past about one line it
// is a wall, so the model is sent back to write the context as a message (which renders) first.
const DEFAULT_MAX_QUESTION_CHARS = 250

export function maxQuestionChars(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_QUESTION_CHARS
}

// Which questions run long, by their place in the call (1-based) and length.
export function overLong(questions: readonly { question: string }[], max: number): { place: number; length: number }[] {
  return questions
    .map((q, i) => ({ place: i + 1, length: q.question.trim().length }))
    .filter(q => q.length > max)
}

// What the model reads in place of the answer; it never reaches the person as the dialog would.
export function denial(long: readonly { place: number; length: number }[], max: number): string {
  const which = long.map(q => `question ${q.place} is ${q.length} characters`).join(', ')

  return (
    `ask-guard: ${which}; the limit is ${max}. The dialog draws a question as plain text, so a long one is unreadable. ` +
    'Write the context (the plan, findings, lists) as a normal markdown message first, put per-option detail in ' +
    "each option's description or preview, then call AskUserQuestion again with a one-line question, " +
    'e.g. "Go ahead with the plan above?".'
  )
}

export const register: Register = (on, options) => {
  const max = maxQuestionChars(options.maxQuestionChars)

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    // Only the model's own asks: another plugin's dialog (model-fit's Switch or Stay) is its business.
    if (next.origin.plugin !== 'engine') return next(e)

    const long = overLong(e.questions, max)

    return long.length === 0 ? next(e) : { deny: denial(long, max) }
  }).catch(($, e, next) => next(e)) // A broken guard must never cost the person their question.
}
