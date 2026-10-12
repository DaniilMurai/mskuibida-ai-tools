import { describe, expect, test } from 'claude-code/testing'

import { mountWorld, newWorld, submit, verdict } from './kit'

const TASK = 'Refactor the payment retry loop to use backoff'
const SURFACES = ['terminal', 'desktop'] as const

type Asked = { question: string; options: { label: string; description?: string }[] }

// What the engine does with the dialog: draw it through the plugins, with the questions the model-less call gave it.
describe('the dialog gets descriptions on every surface', () => {
  for (const surface of SURFACES) {
    test(`${surface}: Switch carries the reason, Stay says it runs as selected`, async ($, on) => {
      const world = newWorld({ replies: [verdict('opus', 'cross-service design, path unclear')], answer: 'Stay on Sonnet 5.5', tokens: 2_000 })
      const seen = mountWorld(on, world)

      world.whileAsking = async questions => {
        await $.ui.render({ surface, component: 'AskUserQuestion', requestId: 'ask-1', props: { tool: 'AskUserQuestion', questions: [...questions] } })
      }

      await submit($, TASK)

      const drawn = seen.drawn[0]?.questions[0] as Asked | undefined
      expect(drawn?.question).toBe('Switch to Opus 5.5 for this task?')
      expect(drawn?.options).toEqual([
        { label: 'Switch to Opus 5.5', description: 'cross-service design, path unclear' },
        { label: 'Stay on Sonnet 5.5', description: 'Run it on Sonnet 5.5 as selected.' },
      ])
    })

    test(`${surface}: no reason from the classifier still gives a string description`, async ($, on) => {
      const world = newWorld({ replies: ['{"tier":"opus","enough":true}'], answer: 'Stay on Sonnet 5.5', tokens: 2_000 })
      const seen = mountWorld(on, world)

      world.whileAsking = async questions => {
        await $.ui.render({ surface, component: 'AskUserQuestion', requestId: 'ask-1', props: { tool: 'AskUserQuestion', questions: [...questions] } })
      }

      await submit($, TASK)

      const drawn = seen.drawn[0]?.questions[0] as Asked | undefined
      expect(drawn?.options.map(o => typeof o.description)).toEqual(['string', 'string'])
      expect(drawn?.options[0]?.description).toBe('A better fit for this task')
    })

    test(`${surface}: a large context adds what a switch re-reads`, async ($, on) => {
      const world = newWorld({ model: 'claude-opus-5-5', replies: [verdict('haiku', 'a plain lookup')], answer: 'Stay on Opus 5.5', tokens: 45_300 })
      const seen = mountWorld(on, world)

      world.whileAsking = async questions => {
        await $.ui.render({ surface, component: 'AskUserQuestion', requestId: 'ask-1', props: { tool: 'AskUserQuestion', questions: [...questions] } })
      }

      await submit($, 'Find where the retry count is configured')

      const drawn = seen.drawn[0]?.questions[0] as Asked | undefined
      expect(drawn?.options[0]).toEqual({ label: 'Switch to Haiku 5.5', description: 'a plain lookup · re-reads ~45k tokens' })
    })

    test(`${surface}: another question drawn meanwhile is left as it was`, async ($, on) => {
      const world = newWorld({ replies: [verdict('opus')], answer: 'Stay on Sonnet 5.5' })
      const seen = mountWorld(on, world)
      const other = [{ question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]

      world.whileAsking = async () => {
        await $.ui.render({ surface, component: 'AskUserQuestion', requestId: 'ask-2', props: { tool: 'AskUserQuestion', questions: other } })
      }

      await submit($, TASK)

      expect(seen.drawn[0]?.questions).toEqual(other)
    })
  }
})
