// How long ago the panel last looked, as display text. Pure: the caller hands in
// `now`, so the renderer stays deterministic and the redesign can call it freely.
import { t } from './strings/en'
import type { PanelModel } from '../types'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** "just now" under 5 s, then "12s ago", "3m ago", "2h ago"; '' for a bad or absent time. */
export function agoText(now: number, then: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(then)) return ''
  const elapsed = Math.max(0, now - then)
  if (elapsed < 5 * SECOND) return t('ago.now')
  if (elapsed < MINUTE) return t('ago.seconds', { n: String(Math.floor(elapsed / SECOND)) })
  if (elapsed < HOUR) return t('ago.minutes', { n: String(Math.floor(elapsed / MINUTE)) })
  return t('ago.hours', { n: String(Math.floor(elapsed / HOUR)) })
}

/** The clock the header stamp reads: the engine's `now`, and the engine's last check. */
export type Clock = { now: number; checkedAt?: number }

/** "checked 12s ago": the freshest of the engine's last check, the model's own check and its read. '' hides the stamp. */
export function checkedText(model: PanelModel, clock: Clock): string {
  const at = Math.max(clock.checkedAt ?? 0, model.freshness?.checkedAt ?? 0, model.readAt)
  const ago = agoText(clock.now, at)
  return ago === '' ? '' : t('header.checked', { ago })
}
