// The progress marks: the ring (a donut Svg, or a glyph on the terminal) and
// the stacked status strip of a long collapsed section.
import { t } from '../strings/en'
import type { Item } from '../../types'
import type { Ctx, El } from './kit'

export function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0
}

/** ○ (0) ◔ (1-37) ◑ (38-62) ◕ (63-99) ● (100) */
export function ringGlyph(percent: number): string {
  if (percent >= 100) return '●'
  if (percent >= 63) return '◕'
  if (percent >= 38) return '◑'
  if (percent >= 1) return '◔'
  return '○'
}

/**
 * Fixed mid-tones, not currentColor: the surface draws an Svg as an image,
 * where currentColor need not follow the theme. All read on light and dark.
 */
const RING_TRACK = '#8a8a8a'
const RING_ARC = '#d97757'
const RING_DONE = '#4eba65'
const RING_FAIL = '#ef6f64'
// Nothing reaches 4.5:1 on both #ffffff and #1f1e1c (that needs a luminance both <= 0.183 and >= 0.234).
// #7e7e7e is the balance point: 4.06:1 on white, 4.10:1 on the dark background; the number is large and bold.
const RING_TEXT = '#7e7e7e'

/** A two-circle donut: a faint track and the arc from 12 o'clock, round caps; `isLabelled` draws the % inside. */
export function ringSource(percent: number, size: number, isLabelled: boolean): string {
  const stroke = size >= 30 ? 4 : 3
  const mid = size / 2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const arc = (circumference * percent) / 100
  const track = `<circle cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke="${RING_TRACK}" stroke-opacity="0.35" stroke-width="${stroke}"/>`
  const filled =
    percent > 0
      ? `<circle cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke="${percent >= 100 ? RING_DONE : RING_ARC}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>`
      : ''
  const label = isLabelled
    ? `<text x="${mid}" y="${mid + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${RING_TEXT}" font-family="-apple-system, system-ui, sans-serif">${percent}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${track}${filled}${label}</svg>`
}

/**
 * Where `Svg` exists a donut (the number inside when `isLabelled`); on the
 * terminal the glyph alone: the plan's summary beside it already says the %.
 */
export function ring(ctx: Ctx, percent: number, size: number, isLabelled: boolean): El {
  const { Box, Text, Svg } = ctx.kit
  const value = clampPercent(percent)
  if (Svg) {
    return (
      <Box flexShrink={0}>
        <Svg source={ringSource(value, size, isLabelled)} alt={t('ring.alt', { percent: String(value) })} width={size} height={size} />
      </Box>
    )
  }
  return (
    <Box flexShrink={0}>
      <Text color={value >= 100 ? 'success' : 'claude'}>{ringGlyph(value)}</Text>
    </Box>
  )
}

// ── strip ───────────────────────────────────────────────────────────────────

export type Mix = { done: number; live: number; failed: number; rest: number; total: number }

/** done / open+partial+reopened / failed / the rest, over the items that count (skipped ones do not). */
export function mixOf(items: Item[]): Mix {
  const mix: Mix = { done: 0, live: 0, failed: 0, rest: 0, total: 0 }
  for (const item of items) {
    if (item.status === 'skipped') continue
    mix.total += 1
    if (item.status === 'done' || item.isFinishedLocal === true) mix.done += 1
    else if (item.status === 'open' || item.status === 'partial' || item.status === 'reopened') mix.live += 1
    else if (item.status === 'failed') mix.failed += 1
    else mix.rest += 1
  }
  return mix
}

/** Splits `cells` over the groups in proportion; any non-zero group keeps at least 1; the sum is `cells`. */
export function allot(counts: number[], cells: number): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0)
  if (total === 0) return counts.map(() => 0)
  const out = counts.map(n => (n === 0 ? 0 : Math.max(1, Math.round((n / total) * cells))))
  let diff = cells - out.reduce((sum, n) => sum + n, 0)
  // Settle the rounding on the largest group first, never below 1 for a non-zero one.
  while (diff !== 0) {
    let at = -1
    for (let i = 0; i < out.length; i++) {
      if (diff > 0 ? (counts[i] ?? 0) > 0 : (out[i] ?? 0) > 1) {
        if (at < 0 || (counts[i] ?? 0) > (counts[at] ?? 0)) at = i
      }
    }
    if (at < 0) break
    out[at] = (out[at] ?? 0) + (diff > 0 ? 1 : -1)
    diff += diff > 0 ? -1 : 1
  }
  return out
}

const STRIP_CELLS = 10

/** A stacked bar: done (green), open and partial (accent), failed (red), the rest (track). */
export function strip(ctx: Ctx, mix: Mix, width: number): El | false {
  const { Box, Text, Svg } = ctx.kit
  if (mix.total === 0) return false
  const counts = [mix.done, mix.live, mix.failed, mix.rest]
  if (Svg) {
    const gap = 2
    const present = counts.filter(n => n > 0).length
    const room = width - gap * (present - 1)
    const widths = allot(counts, room)
    const colors = [RING_DONE, RING_ARC, RING_FAIL, RING_TRACK]
    let x = 0
    const bars = widths
      .map((w, i) => {
        if (w === 0) return ''
        const bar = `<rect x="${x}" y="0" width="${w}" height="6" rx="2" fill="${colors[i]}"${i === 3 ? ' fill-opacity="0.45"' : ''}/>`
        x += w + gap
        return bar
      })
      .join('')
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">${bars}</svg>`
    return (
      <Box flexShrink={0}>
        <Svg source={source} alt={t('strip.alt', { done: String(mix.done), total: String(mix.total) })} width={width} height={6} />
      </Box>
    )
  }
  const cells = allot(counts, STRIP_CELLS)
  const looks: { glyph: string; color: string | undefined; isDim: boolean }[] = [
    { glyph: '█', color: 'success', isDim: false },
    { glyph: '▓', color: 'claude', isDim: false },
    { glyph: '▒', color: 'error', isDim: false },
    { glyph: '░', color: undefined, isDim: true },
  ]
  return (
    <Box flexShrink={0}>
      {cells.map((n, i) =>
        n > 0 ? (
          <Text color={looks[i]?.color} dimColor={looks[i]?.isDim}>
            {(looks[i]?.glyph ?? '').repeat(n)}
          </Text>
        ) : (
          false
        ),
      )}
    </Box>
  )
}
