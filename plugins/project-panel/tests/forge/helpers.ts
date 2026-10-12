// A scripted host for the forge tests: commands are answered by their argv line from a table, every run is
// recorded, and a command nobody scripted fails (exit 1) like an unknown subcommand would.
import type { ProviderHost } from '../../types'

export type Answer = { exitCode?: number; stdout?: string; stderr?: string } | 'reject'
export type Script = Record<string, Answer | ((argv: readonly string[]) => Answer)>

export type Scripted = ProviderHost & {
  /** Every argv run, joined with spaces, in order. */
  lines: string[]
  /** The options each run was given. */
  inits: ({ cwd?: string; timeoutMs?: number } | undefined)[]
}

export function scriptedHost(script: Script): Scripted {
  const lines: string[] = []
  const inits: Scripted['inits'] = []
  return {
    lines,
    inits,
    run: async (argv, init) => {
      const line = argv.join(' ')
      lines.push(line)
      inits.push(init)
      const entry = script[line]
      const answer: Answer = typeof entry === 'function' ? entry(argv) : (entry ?? { exitCode: 1 })
      if (answer === 'reject') throw new Error('spawn failed or timed out')
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    },
    complete: async () => ({ isAnswered: false, text: '' }),
    store: { get: async () => undefined, set: async () => undefined },
  }
}

export const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) })

/** True when `line` could write: a read-only forge session never runs these. */
export function isWriting(line: string): boolean {
  return /\b(create|approve|merge|comment|edit|close|reopen|delete|update|note|rebase|checkout|--method\s+(POST|PUT|PATCH|DELETE)|-X\s+(POST|PUT|PATCH|DELETE))\b/i.test(line)
}
