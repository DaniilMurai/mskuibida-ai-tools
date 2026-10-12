// @ts-nocheck
// CI guard: does upstream's state template still have the shape the panel reads?
//
//   node --experimental-strip-types tests/check-upstream.ts [path-to-template.md]
//
// With no argument it fetches the template from upstream's main branch. Exits 1
// with a message per problem. Dependency-free; not a `*.test.ts`, so
// `claude plugin test` does not run it.
import { readFileSync } from 'node:fs'
import { parseState } from '../src/providers/aidlc/parse-state.ts'

const URL = 'https://raw.githubusercontent.com/awslabs/aidlc-workflows/main/core/knowledge/aidlc-shared/state-template.md'

// Fields the panel reads from every state file.
const REQUIRED_FIELDS = [
  'Lifecycle Phase',
  'Current Stage',
  'Next Stage',
  'Status',
  'Last Completed Stage',
  'Next Action',
  'Last Updated',
]
const REQUIRED_MARKERS = ['[ ]', '[-]', '[?]', '[R]', '[x]', '[S]']

const problems = []
const fail = message => problems.push(message)

async function load() {
  const path = process.argv[2]
  if (path) return { text: readFileSync(path, 'utf8'), from: path }
  const response = await fetch(URL)
  if (!response.ok) throw new Error(`GET ${URL} answered ${response.status}`)
  return { text: await response.text(), from: URL }
}

let template
try {
  template = await load()
} catch (error) {
  console.error(`check-upstream: cannot load the template: ${error.message}`)
  process.exit(1)
}
const { text, from } = template
const lines = text.split(/\r?\n/)

for (const field of REQUIRED_FIELDS) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:`, 'm').test(text)) {
    fail(`the template has no "- **${field}**:" line (the panel reads it)`)
  }
}

for (const heading of ['## Phase Progress', '## Stage Progress']) {
  if (!lines.includes(heading)) fail(`the template has no "${heading}" heading`)
}

const legend = lines.find(line => line.includes('Checkbox states')) ?? ''
if (!legend) fail('the Stage Progress legend ("Checkbox states ...") is gone')
for (const marker of REQUIRED_MARKERS) {
  if (legend && !legend.includes(marker)) fail(`the Stage Progress legend no longer lists ${marker}`)
}

if (!lines.some(line => /^### .+ PHASE\s*$/.test(line))) fail('no "### <NAME> PHASE" heading shape left in Stage Progress')
if (!lines.some(line => /^- \[.\] \S+ — /.test(line))) fail('no "- [m] <slug> — ..." stage row shape left in Stage Progress')

try {
  const parsed = parseState(text)
  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed.fields)) fail(`parseState did not find "${field}" in the template`)
  }
} catch (error) {
  fail(`parseState threw on the template: ${error.message}`)
}

if (problems.length > 0) {
  console.error(`check-upstream: ${problems.length} problem(s) in ${from}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-upstream: ok (${from})`)
