// The model for this session: detect a plan, let its provider load it.
import { detectPlan } from './detect'
import type { PanelModel, Provider, ProviderContext } from '../types'

/** null when no provider finds a plan. A provider's `load` may throw; the caller decides what that means. */
export async function buildModel(ctx: ProviderContext, providers?: readonly Provider[]): Promise<PanelModel | null> {
  const found = await detectPlan(ctx, providers)
  return found ? found.provider.load(ctx, found.detection) : null
}

/** Runs a provider action the person pressed, against a fresh detection. */
export async function runAction(
  ctx: ProviderContext,
  actionId: string,
  providers?: readonly Provider[],
): Promise<PanelModel | null> {
  const found = await detectPlan(ctx, providers)
  if (!found?.provider.act) return null
  return found.provider.act(ctx, found.detection, actionId)
}

/**
 * The detected provider's remote fingerprint (src/refresh.ts compares it between polls), or null when no
 * plan is detected or the provider has none. A provider's `fingerprint` may throw; the caller decides what that means.
 */
export async function fingerprintOf(ctx: ProviderContext, providers?: readonly Provider[]): Promise<string | null> {
  const found = await detectPlan(ctx, providers)
  if (!found?.provider.fingerprint) return null
  return found.provider.fingerprint(ctx, found.detection)
}
