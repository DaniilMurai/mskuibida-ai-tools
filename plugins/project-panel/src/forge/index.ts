import type { ProviderContext } from '../../types'
import { detectForge } from './detect'
import type { Detected } from './detect'

export { detectForge, resetForgeCache, setForgeClock } from './detect'
export type { Detected, ForgeOverride } from './detect'
export { ForgeError, classify, problemText } from './problem'
export { hostKey, parseRemote, webBase } from './remote'
export type {
  Change,
  ChangeState,
  Forge,
  ForgeKind,
  ForgeProblem,
  ForgeResult,
  ProblemKind,
  Remote,
} from './types'

/** The forge of the repository at `root`, honouring the person's `forge` option (default `auto`). */
export function forgeFor(ctx: ProviderContext, root: string): Promise<Detected> {
  return detectForge(ctx.host, root, ctx.options.forge ?? 'auto')
}
