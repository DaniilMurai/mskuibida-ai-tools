// Which provider's plan this repo has: the providers are tried in order and the
// first hit wins (AI-DLC keeps priority over the ledger). A provider that throws
// counts as a miss, so one broken provider never hides another's plan.
import type { Detection, Provider, ProviderContext } from '../types'
import { aidlc } from './providers/aidlc'
import { ledger } from './providers/ledger'

export const PROVIDERS: readonly Provider[] = [aidlc, ledger]

export async function detectPlan(
  ctx: ProviderContext,
  providers: readonly Provider[] = PROVIDERS,
): Promise<{ provider: Provider; detection: Detection } | null> {
  for (const provider of providers) {
    try {
      const detection = await provider.detect(ctx)
      if (detection) return { provider, detection }
    } catch {
      // A miss.
    }
  }
  return null
}
