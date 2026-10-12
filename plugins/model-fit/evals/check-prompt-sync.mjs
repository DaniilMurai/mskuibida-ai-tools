// Fails (exit 1) when CLASSIFIER_SYSTEM in hooks/classify.ts is not byte-identical to
// prompts/candidate.txt, the prompt the evals measure. Plain node, no dependencies.
// Usage: node evals/check-prompt-sync.mjs   (from anywhere)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'hooks', 'classify.ts'), 'utf8')
const candidate = readFileSync(join(here, 'prompts', 'candidate.txt'), 'utf8')
const match = /export const CLASSIFIER_SYSTEM = `([^`]*)`/.exec(source)

if (match === null) {
  console.error('check-prompt-sync: CLASSIFIER_SYSTEM must be a template literal in hooks/classify.ts')
  process.exit(1)
}

// The literal is read as written: a backslash or ${ would change it, and the prompt has neither.
if (/\\|\$\{/.test(match[1])) {
  console.error('check-prompt-sync: CLASSIFIER_SYSTEM must not contain a backslash or ${')
  process.exit(1)
}

if (match[1] !== candidate) {
  const a = match[1].split('\n')
  const b = candidate.split('\n')
  const line = a.findIndex((text, i) => text !== b[i])

  console.error('check-prompt-sync: hooks/classify.ts CLASSIFIER_SYSTEM differs from evals/prompts/candidate.txt')
  console.error(`first difference at line ${(line === -1 ? Math.min(a.length, b.length) : line) + 1}`)
  process.exit(1)
}

console.log(`check-prompt-sync: ok (${candidate.length} bytes)`)
