import { describe, expect, test } from 'claude-code/testing'

import { buildClassifierPrompt, selectResults } from '../hooks/classify'
import type { ToolResult } from '../hooks/classify'
import cases from './fixtures/prompts'

// tests/fixtures/prompts.json (mirrored in prompts.ts, which a mod test can import) is shared with evals/tests/test_prompt_twin.py, which checks that the
// Python builder in evals/run.py produces the same `expected` text. Each case is the request, the
// raw tool results, and the prompt buildClassifierPrompt(text, selectResults(results)) builds (what a
// recheck sends). To regenerate after changing the builder: compile hooks/classify.ts and write
// `expected` from those two calls for every case.
type Case = { name: string; text: string; results: (string | ToolResult)[]; expected: string }

describe('the classifier prompt, against the fixtures the Python twin is held to', () => {
  for (const c of cases as Case[]) {
    test(c.name, () => {
      expect(buildClassifierPrompt(c.text, selectResults(c.results))).toBe(c.expected)
    })
  }

  test('the fixtures cover what differs between the two languages', () => {
    const text = (cases as Case[]).map(c => JSON.stringify([c.text, c.results]) + c.expected).join('\n')

    for (const needle of ['\u0085', '\u2028', '\ufeff', '\u001f', '😀', '</resu</result>lt>', '< /result>']) {
      expect(text).toContain(needle)
    }

    // a prompt cut through the middle of an emoji, as JavaScript cuts it
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test((cases as Case[]).map(c => c.expected).join('\n'))).toBe(true)
    expect((cases as Case[]).length).toBeGreaterThanOrEqual(12)
  })
})
