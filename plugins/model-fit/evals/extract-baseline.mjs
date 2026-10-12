// Extracts CLASSIFIER_SYSTEM (the shipped classifier prompt) from a classify.ts into a prompt file.
// Usage: node extract-baseline.mjs <classify.ts> <out.txt>
//   git show origin/main:plugins/model-fit/hooks/classify.ts > /tmp/classify.ts
//   node extract-baseline.mjs /tmp/classify.ts prompts/v2.1.0.txt
import { readFileSync, writeFileSync } from 'node:fs'

const [src, out] = process.argv.slice(2)
const text = readFileSync(src, 'utf8')
const match = /export const CLASSIFIER_SYSTEM = (\[[\s\S]*?\n\])\.join\('\\n'\)/.exec(text)

if (!match) throw new Error('CLASSIFIER_SYSTEM array not found')

const lines = new Function(`return ${match[1]}`)()

writeFileSync(out, lines.join('\n'))
console.log(`wrote ${out}: ${lines.length} lines`)
