// The desktop look's small parts (see isRich in ./kit): a word drawn as a pill, and an item's status as a 14 px
// icon instead of its glyph. Fixed mid-tones in the icons, as in the rings: an Svg is drawn as an image.
import { t } from '../strings/en'
import type { Item } from '../../types'
import { tint } from './kit'
import type { Ctx, El } from './kit'
import { RING_ARC, RING_DONE, RING_FAIL, RING_TEXT, RING_TRACK } from './ring'

const AMBER = '#e3a83a'
const ICON = 14

/** A word drawn as a pill: the tone's tint behind the tone's colour, a space of room each side. Dim: a grey pill. */
export function pill(ctx: Ctx, word: string, color: string | undefined, isDim = false): El {
  const { Text } = ctx.kit
  return (
    <Text color={color} dimColor={isDim || color === undefined} backgroundColor={tint(isDim ? undefined : color, isDim ? '1a' : '24')}>
      {` ${word} `}
    </Text>
  )
}

type Kind = 'done' | 'stale' | 'live' | 'local' | 'current' | 'planned' | 'skipped' | 'failed' | 'mark'

/** What the item's glyph means, as an icon. */
function kindOf(item: Item, glyph: string): Kind {
  if (glyph === '✓') return item.status === 'stale' ? 'stale' : 'done'
  if (glyph === '◐') return 'live'
  if (glyph === '◌') return 'local'
  if (glyph === '✕') return 'failed'
  if (glyph === '–') return 'skipped'
  if (glyph === '○') return item.isCurrent ? 'current' : 'planned'
  return 'mark'
}

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 14 14">${body}</svg>`

/** The icon's markup; `glyph` is drawn inside an amber ring for the statuses that have no icon of their own (↻ ? ↺). */
export function iconSource(kind: Kind, glyph = ''): string {
  const ring = (stroke: string, extra = '', width = 1.5) => `<circle cx="7" cy="7" r="5.75" fill="none" stroke="${stroke}" stroke-width="${width}"${extra}/>`
  switch (kind) {
    case 'done':
      return svg(`<circle cx="7" cy="7" r="6.5" fill="${RING_DONE}"/><path d="M4.2 7.2l2 2 3.8-4.2" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
    case 'stale':
      return svg(ring(AMBER) + `<path d="M4.4 7.2l1.8 1.8 3.4-3.8" fill="none" stroke="${AMBER}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`)
    case 'live':
      return svg(ring(RING_ARC) + `<path d="M7 1.25a5.75 5.75 0 0 1 0 11.5z" fill="${RING_ARC}"/>`)
    case 'local':
      return svg(ring(AMBER, ' stroke-dasharray="2.2 2"') + `<circle cx="7" cy="7" r="2" fill="${AMBER}"/>`)
    case 'current':
      return svg(ring(RING_ARC, '', 1.6) + `<circle cx="7" cy="7" r="2.2" fill="${RING_ARC}"/>`)
    case 'planned':
      return svg(ring(RING_TRACK, ' stroke-opacity="0.7"'))
    case 'skipped':
      return svg(ring(RING_TRACK, ' stroke-opacity="0.5" stroke-dasharray="2 2"') + `<line x1="4.5" y1="7" x2="9.5" y2="7" stroke="${RING_TEXT}" stroke-width="1.5" stroke-linecap="round"/>`)
    case 'failed':
      return svg(`<circle cx="7" cy="7" r="6.5" fill="${RING_FAIL}"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>`)
    default:
      return svg(
        ring(AMBER) +
          `<text x="7" y="10" text-anchor="middle" font-size="8" font-weight="700" fill="${AMBER}" font-family="-apple-system, system-ui, sans-serif">${glyph.replace(/[<>&"']/g, '')}</text>`,
      )
  }
}

/** The item's status as a 14 px icon; its alt is the status word, else the glyph's meaning. */
export function statusIcon(ctx: Ctx, item: Item, glyph: string, word: string): El | false {
  const { Box, Svg } = ctx.kit
  if (Svg === undefined) return false
  const kind = kindOf(item, glyph)
  const alt = word !== '' ? word : t(`icon.alt.${kind}`)
  return (
    <Box flexShrink={0} alignItems="center">
      <Svg source={iconSource(kind, glyph)} alt={alt} width={ICON} height={ICON} />
    </Box>
  )
}

/** A dashed ring the size of a section's: the place of a ring for a phase with nothing counted, or skipped. */
export function emptyRing(ctx: Ctx, size: number, alt: string): El | false {
  const { Box, Svg } = ctx.kit
  if (Svg === undefined) return false
  const r = size / 2 - 1.5
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${RING_TRACK}" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="2.5 2.5"/></svg>`
  return (
    <Box flexShrink={0}>
      <Svg source={source} alt={alt} width={size} height={size} />
    </Box>
  )
}
