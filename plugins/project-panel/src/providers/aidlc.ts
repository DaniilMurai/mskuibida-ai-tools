// The AI-DLC v2 provider (awslabs/aidlc-workflows): an `aidlc/spaces/` workspace
// read into sections (phases), items (stages) and gates (parked, awaiting
// approval, and, since M3, the PRs between a stage and the default branch).
// The pieces live under ./aidlc/.
import type { Detection, Provider, ProviderContext } from '../../types'
import { isSafeRef, repoRoot, sh } from './ledger/host'
import { detectWorkspace } from './aidlc/detect'
import { loadAidlc } from './aidlc/load'
import { defaultBranch, remoteFingerprint } from './aidlc/prs'

export const aidlc: Provider = {
  id: 'aidlc',

  async detect(ctx: ProviderContext): Promise<Detection | null> {
    try {
      const workspace = await detectWorkspace(ctx.fsx, ctx.startDir)
      return workspace ? { provider: 'aidlc', root: workspace.root, detail: { workspace } } : null
    } catch {
      return null
    }
  },

  load: loadAidlc,

  /**
   * The change list (pull or merge requests, through the forge layer) and the default branch's tip on origin,
   * digested (./aidlc/prs.ts; it also fetches the branch when its tip moved). '' where there is nothing remote to
   * watch: not in a git work tree, or no `origin`. A failing forge throws a ForgeError, which the refresh engine
   * turns into one Attention line. Never a model call.
   */
  async fingerprint(ctx: ProviderContext): Promise<string> {
    const root = await repoRoot(ctx.host, ctx.startDir)
    if (root === null) return ''
    if (!(await sh(ctx.host, ['git', '-C', root, 'remote', 'get-url', 'origin'], undefined)).ok) return ''
    const base = await defaultBranch(ctx.host, root, ctx.now, ctx.options.forge ?? 'auto')
    return isSafeRef(base) ? remoteFingerprint(ctx.host, root, base, ctx.now, ctx.options.forge ?? 'auto') : ''
  },
}
