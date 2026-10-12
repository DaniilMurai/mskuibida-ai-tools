import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const SHORT = 'Go ahead with the #40 plan above?'
// The ask that started this plugin: a whole plan crammed into the question.
const WALL =
  'All 12 cards stayed in Fix in this PR; no board follow-up. Plan for #40: reopen Domain Design (2.6) on this branch ' +
  '(backward jump as its own call, unpark, orchestrate next --resume). Then a new questions file ' +
  'domain-design-review-questions.md (Q11+) in your form for the three choices: R2 the preview-unavailable wording, ' +
  'R5 the merged review-lesson rule, R10 whether "review pages for big artifacts" becomes a team.md rule. Go ahead?'

function ask(...questions: string[]) {
  return {
    tool: 'AskUserQuestion' as const,
    questions: questions.map(question => ({
      question,
      header: 'Plan',
      multiSelect: false,
      options: [
        { label: 'Go ahead', description: 'Run the plan as written.' },
        { label: 'Hold', description: 'Stop here.' },
      ],
    })),
  }
}

// Stands for the dialog: answers every call that gets past the plugin.
function answering(on: On, opened: string[][]) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    opened.push(e.questions.map(q => q.question))

    return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Go ahead' } } }
  })
}

describe('the model asks', () => {
  test('a one-line question opens the dialog', async ($, on) => {
    const opened: string[][] = []
    answering(on, opened)

    const result = await $.tool.call(ask(SHORT))

    expect(result.deny).toBeUndefined()
    expect(opened).toEqual([[SHORT]])
  })

  test('a wall of text is sent back with the length, the limit and how to ask instead', async ($, on) => {
    const opened: string[][] = []
    answering(on, opened)

    const result = await $.tool.call(ask(WALL))

    expect(opened).toEqual([])
    expect(result.deny).toContain(`question 1 is ${WALL.length} characters`)
    expect(result.deny).toContain('the limit is 250')
    expect(result.deny).toContain('markdown message first')
  })

  test('only the long question of several is named', async ($, on) => {
    answering(on, [])

    const result = await $.tool.call(ask(SHORT, WALL))

    expect(result.deny).toContain('question 2 is')
    expect(result.deny).not.toContain('question 1 is')
  })

  test('the limit comes from the plugin option', { options: { maxQuestionChars: 20 } }, async ($, on) => {
    const opened: string[][] = []
    answering(on, opened)

    const result = await $.tool.call(ask(SHORT))

    expect(result.deny).toContain('the limit is 20')
    expect(opened).toEqual([])
  })
})
