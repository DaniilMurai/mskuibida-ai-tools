// One plan item (a row with its chips, status word and fold gutter) and the
// gate card that can sit between items.
import { t } from '../strings/en'
import type { Chip, Gate, Item, ItemStatus, ReviewState } from '../../types'
import { clip, gateColor, gateGlyph, isRich, tint, toneColor } from './kit'
import { pill, statusIcon } from './look'
import type { Ctx, El } from './kit'

export type Look = { glyph: string; color: string | undefined; isDim: boolean; word: string; wordColor: string | undefined }

/** The status word's colour for a PR's review: the accent while someone reviews, green once approved. */
const REVIEW_COLOR: Record<ReviewState, string | undefined> = {
  draft: undefined,
  awaiting: 'claude',
  changes: 'warning',
  commented: 'warning',
  stale: 'warning',
  approved: 'success',
  'approved-comments': 'success',
  unreviewed: 'warning',
}

/**
 * ✓ done, ◐ open or partial, ○ planned, ✕ failed, – skipped, ↻ revising, ? awaiting, ↺ reopened, ✓ (warning) stale.
 * A landing (two truths) takes the glyph and colour over the status: ✓ merged, ◐ in a PR, ◌ local only.
 * The word is the item's `statusWord` when it has one ('' hides it), else the status's own; a PR's review
 * state colours it.
 */
export function itemLook(item: Pick<Item, 'status' | 'landing' | 'statusWord' | 'review'>): Look {
  const base = statusLook(item.status)
  const landed = landingLook(item.landing)
  const look = landed ? { ...base, ...landed } : base
  const worded = item.statusWord === undefined ? look : { ...look, word: item.statusWord }
  return item.review === undefined ? worded : { ...worded, wordColor: REVIEW_COLOR[item.review] }
}

function landingLook(landing: Item['landing']): Partial<Look> | undefined {
  switch (landing) {
    case 'merged':
      return { glyph: '✓', color: 'success', isDim: false, word: '', wordColor: undefined }
    case 'in-pr':
      return { glyph: '◐', color: 'claude', isDim: false, wordColor: 'claude' }
    case 'local':
      return { glyph: '◌', color: 'warning', isDim: false, wordColor: 'warning' }
    default:
      return undefined
  }
}

function statusLook(status: ItemStatus): Look {
  const word = (one: ItemStatus) => t('item.status.' + one)
  switch (status) {
    case 'done':
      return { glyph: '✓', color: 'success', isDim: false, word: '', wordColor: undefined }
    case 'open':
      return { glyph: '◐', color: 'claude', isDim: false, word: word('open'), wordColor: 'claude' }
    case 'partial':
      return { glyph: '◐', color: 'claude', isDim: false, word: word('partial'), wordColor: 'claude' }
    case 'failed':
      return { glyph: '✕', color: 'error', isDim: false, word: word('failed'), wordColor: 'error' }
    case 'skipped':
      return { glyph: '–', color: undefined, isDim: true, word: word('skipped'), wordColor: undefined }
    case 'revising':
      return { glyph: '↻', color: 'warning', isDim: false, word: word('revising'), wordColor: 'warning' }
    case 'awaiting':
      return { glyph: '?', color: 'warning', isDim: false, word: word('awaiting'), wordColor: 'warning' }
    case 'reopened':
      return { glyph: '↺', color: 'warning', isDim: false, word: word('reopened'), wordColor: 'warning' }
    case 'stale':
      return { glyph: '✓', color: 'warning', isDim: false, word: word('stale'), wordColor: 'warning' }
    default:
      return { glyph: '○', color: undefined, isDim: true, word: '', wordColor: undefined }
  }
}

/** Any fold chip, labelled or not, or a fold group. */
export const hasFold = (item: Item): boolean => item.chips.some(chip => chip.kind === 'fold') || (item.group !== undefined && item.group !== '')

/** What binds an item into a run: its non-empty `group`, else its labelled fold chip. Prefixed so the two never meet. */
function foldKey(item: Item): string | undefined {
  if (item.group !== undefined && item.group !== '') return `group:${item.group}`
  const label = item.chips.find(chip => chip.kind === 'fold' && chip.label !== '')?.label
  return label === undefined ? undefined : `chip:${label}`
}

/** For each item, by index: ┐ first, │ between, ┘ last of a run sharing a group (else a fold chip label); '' otherwise (a lone one gets none). */
export function foldGutters(items: Item[]): string[] {
  const out = items.map(() => '')
  let start = 0
  while (start < items.length) {
    const label = foldKey(items[start]!)
    let end = start
    if (label !== undefined) while (end + 1 < items.length && foldKey(items[end + 1]!) === label) end += 1
    if (label !== undefined && end > start) {
      for (let at = start; at <= end; at++) out[at] = at === start ? '┐' : at === end ? '┘' : '│'
    }
    start = end + 1
  }
  return out
}

/**
 * The indexes of the done items a long section folds away: past `cap` items, unless all are
 * shown or the fold row cannot be drawn (`canFold` false: nothing may be hidden then). A done item stays
 * when it is current, carries a fold chip or has a gate after it.
 */
export function foldedDone(items: Item[], hasGateAfter: (index: number) => boolean, cap: number, isAll: boolean, canFold: boolean): Set<number> {
  const out = new Set<number>()
  if (!canFold || isAll || items.length <= cap) return out
  items.forEach((item, index) => {
    if (item.status === 'done' && !item.isCurrent && !hasFold(item) && !hasGateAfter(index)) out.add(index)
  })
  return out
}

/**
 * What a long section draws for its done items: the indexes hidden, the fold row's text ('' = no row),
 * and how many could fold. `label` makes the row's text from that count; when it makes '' the row
 * cannot be drawn, so nothing is hidden.
 */
export function foldRow(
  items: Item[],
  hasGateAfter: (index: number) => boolean,
  cap: number,
  isAll: boolean,
  label: (count: number) => string,
): { hidden: Set<number>; text: string; count: number } {
  const count = foldedDone(items, hasGateAfter, cap, false, true).size
  const text = count > 0 ? label(count) : ''
  return { hidden: foldedDone(items, hasGateAfter, cap, isAll, text !== ''), text, count }
}

/**
 * The open-items cap: of the `visible` indexes (after done-folding) past `cap`, the ones left out (the
 * first `cap` stay, and the current item whatever its place), the row's text ('' = no row) and how many.
 * An empty `label` means the row cannot be drawn, so nothing is left out. `isRest` shows them all.
 */
export function openCap(
  visible: number[],
  isCurrent: (index: number) => boolean,
  cap: number,
  isRest: boolean,
  label: (count: number) => string,
): { capped: Set<number>; text: string; count: number } {
  const dropped = visible.filter((index, at) => at >= cap && !isCurrent(index))
  const text = dropped.length > 0 ? label(dropped.length) : ''
  return { capped: text !== '' && !isRest ? new Set(dropped) : new Set<number>(), text, count: dropped.length }
}

const CHIP_MAX = 20
/** A review word is never cut below this many columns. */
const WORD_FLOOR = 8
/** A chip this short never shrinks; a longer one shrinks before the title, down to a floor of 6 columns. */
const SHORT_CHIP = 8
const LONG_CHIP_FLOOR = 6

/** A chip is cut to a sensible length and shrinks before the title does. */
function chipEl(ctx: Ctx, chip: Chip): El | false {
  const { Box, Text, Link } = ctx.kit
  // The desktop draws a chip as a grey pill (no brackets); the terminal brackets it.
  const label = isRich(ctx) ? `\u00a0${clip(chip.label, CHIP_MAX)}\u00a0` : `[${clip(chip.label, CHIP_MAX)}]`
  const isShort = Array.from(chip.label).length <= SHORT_CHIP
  // A linked chip keeps its tone: the coloured Text sits inside the Link, as a linked title's does.
  const text = (
    <Text dimColor color={toneColor(chip.tone)} backgroundColor={isRich(ctx) ? tint(undefined, '24') : undefined} wrap="truncate-end">
      {label}
    </Text>
  )
  return (
    <Box flexShrink={isShort ? 0 : 4} minWidth={isShort ? undefined : LONG_CHIP_FLOOR} overflow="hidden">
      {chip.href !== undefined && chip.href !== '' ? (
        <Link href={chip.href} label={label}>
          {text}
        </Link>
      ) : (
        text
      )}
    </Box>
  )
}

/** S keeps the first chip and folds the rest into a dim "+N". */
function chipsOf(ctx: Ctx, chips: Chip[]): (El | false)[] {
  const { Box, Text } = ctx.kit
  const shown = chips.filter(chip => chip.label !== '')
  if (ctx.bp !== 'S' || shown.length <= 1) return shown.map(chip => chipEl(ctx, chip))
  return [
    chipEl(ctx, shown[0]!),
    <Box flexShrink={0}>
      <Text dimColor>{`+${shown.length - 1}`}</Text>
    </Box>,
  ]
}

export function itemRow(ctx: Ctx, item: Item, fold: string): El {
  const { Box, Text, Link } = ctx.kit
  const look = itemLook(item)
  const isQuiet = item.status === 'done' || item.status === 'skipped'
  // S drops the status word, except "local only", a PR's review state, and "reopened" / "stale": nothing else on a
  // narrow row says the work is not pushed, what its review waits on, or that a ✓ no longer holds. A long review
  // word ("approved with comments") may be cut, down to 8 columns; every other word keeps its length.
  const keepsWord = item.landing === 'local' || item.review !== undefined || item.status === 'reopened' || item.status === 'stale'
  const hasWord = (ctx.bp !== 'S' || keepsWord) && look.word !== ''
  const isWordCut = item.review !== undefined && Array.from(look.word).length > WORD_FLOOR
  const rich = isRich(ctx)
  return (
    <Box flexDirection="column">
      {/* The desktop marks the current row with a tint instead of the › and draws the status as an icon. */}
      <Box paddingLeft={rich ? 1 : 2} paddingRight={rich ? 1 : 0} marginLeft={rich ? 1 : 0} gap={1} backgroundColor={rich && item.isCurrent ? tint('claude', '1a') : undefined}>
        {!rich && (
          <Box width={1} flexShrink={0}>
            {item.isCurrent && (
              <Text bold color="claude">
                ›
              </Text>
            )}
          </Box>
        )}
        {rich ? (
          statusIcon(ctx, item, look.glyph, look.word)
        ) : (
          <Box flexShrink={0}>
            <Text color={look.color} dimColor={look.isDim}>
              {look.glyph}
            </Text>
          </Box>
        )}
        {item.ordinal !== undefined && item.ordinal !== '' && (
          <Box flexShrink={0}>
            <Text dimColor>{item.ordinal}</Text>
          </Box>
        )}
        <Box flexShrink={1} minWidth={Math.min(Array.from(item.title).length, 12)} overflow="hidden">
          {item.href !== undefined && item.href !== '' ? (
            <Link href={item.href} label={item.title}>
              <Text wrap="truncate-end">{item.title}</Text>
            </Link>
          ) : (
            <Text wrap="truncate-end" bold={item.isCurrent} dimColor={isQuiet}>
              {item.title}
            </Text>
          )}
        </Box>
        {chipsOf(ctx, item.chips)}
        <Box flexGrow={1} />
        {hasWord && (
          <Box flexShrink={isWordCut ? 2 : 0} minWidth={isWordCut ? WORD_FLOOR : undefined} overflow={isWordCut ? 'hidden' : undefined}>
            {rich ? (
              pill(ctx, look.word, look.wordColor, look.isDim || item.review === 'draft')
            ) : (
              <Text color={look.wordColor} dimColor={look.isDim || item.review === 'draft'} wrap={isWordCut ? 'truncate-end' : undefined}>
                {look.word}
              </Text>
            )}
          </Box>
        )}
        <Box width={1} flexShrink={0}>
          {fold !== '' && <Text color="claude">{fold}</Text>}
        </Box>
      </Box>
      {item.caption !== undefined && item.caption !== '' && (
        <Box paddingLeft={6}>
          <Text dimColor wrap="wrap">
            {item.caption}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** A bordered card in the gate's tone: glyph and bold title, the dim caption below. */
export function gateCard(ctx: Ctx, gate: Gate): El | false {
  const { Box, Text, Link } = ctx.kit
  if (gate.title === '') return false
  const color = gateColor(gate)
  // The desktop draws it as one quiet line in its tone under the item: the card with its caption is under Needs attention.
  if (isRich(ctx)) {
    return (
      <Box gap={1} marginLeft={5}>
        <Box flexShrink={0}>
          <Text bold color={color}>
            {gateGlyph(gate)}
          </Text>
        </Box>
        <Box flexShrink={1}>
          {gate.href !== undefined && gate.href !== '' ? (
            <Link href={gate.href} label={gate.title}>
              <Text color={color} wrap="wrap">
                {gate.title}
              </Text>
            </Link>
          ) : (
            <Text color={color} wrap="wrap">
              {gate.title}
            </Text>
          )}
        </Box>
      </Box>
    )
  }
  const title = (
    <Text bold color={color} wrap="truncate-end">
      {gate.title}
    </Text>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} marginLeft={4} paddingX={1}>
      <Box gap={1}>
        <Box flexShrink={0}>
          <Text bold color={color}>
            {gateGlyph(gate)}
          </Text>
        </Box>
        <Box flexShrink={1}>
          {gate.href !== undefined && gate.href !== '' ? (
            <Link href={gate.href} label={gate.title}>
              {title}
            </Link>
          ) : (
            title
          )}
        </Box>
      </Box>
      {gate.caption !== undefined && gate.caption !== '' && (
        <Text dimColor wrap="wrap">
          {gate.caption}
        </Text>
      )}
    </Box>
  )
}
