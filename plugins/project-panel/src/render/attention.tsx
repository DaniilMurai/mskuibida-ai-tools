// Needs attention: what blocks, and what waits on the viewer. The freshness error, then the gates (a provider
// puts the rows tied to the viewer first: a review asked of them, their approved PR), then the drift flags. A
// row with a command offers it as a button that puts it in the prompt. On a desktop the rows about pull requests (the
// ones that link to a PR) are one card together, where the first of them stands; every other row is a card of its own.
import { t } from '../strings/en'
import type { Gate, PanelModel } from '../../types'
import { gateColor, gateGlyph, isRich, safely, tint, toneColor, uniqueIds } from './kit'
import { pill } from './look'
import type { Ctx, El } from './kit'

type Row = { id: string; glyph: string; color: string | undefined; title: string; where: string; isBold: boolean; href?: string; command?: string; caption?: string }

/**
 * The gate's section, or "Section, after item" when it holds after an item of it. A row about the viewer is
 * about the item itself ("Section, item"), not what comes after it; one about a PR outside the plan says what
 * the PR is (its caption: title and author).
 */
function whereOf(model: PanelModel, gate: Gate): string {
  const section = model.sections.find(one => one.id === gate.sectionId)
  if (section === undefined) return gate.isAttentionOnly === true ? (gate.caption ?? '') : ''
  const after = section.items.find(one => one.id === gate.afterItemId)
  if (after !== undefined) return t(gate.isAttentionOnly === true ? 'attention.whereOn' : 'attention.whereAfter', { section: section.title, item: after.title })
  return section.title
}

export function rowsOf(model: PanelModel): Row[] {
  const rows: Row[] = []
  const error = model.freshness?.error ?? ''
  if (error !== '') rows.push({ id: 'error', glyph: '!', color: 'error', title: error, where: '', isBold: true })
  for (const gate of model.gates) {
    if (gate.title === '') continue
    rows.push({
      id: 'gate:' + gate.id,
      glyph: gateGlyph(gate),
      color: gateColor(gate),
      title: gate.title,
      where: whereOf(model, gate),
      isBold: true,
      ...(gate.href !== undefined && gate.href !== '' ? { href: gate.href } : {}),
      ...(gate.command !== undefined && gate.command !== '' ? { command: gate.command } : {}),
      ...(gate.caption !== undefined && gate.caption !== '' && gate.isAttentionOnly !== true ? { caption: gate.caption } : {}),
    })
  }
  for (const flag of model.drift) {
    if (flag.label === '') continue
    rows.push({ id: 'drift:' + flag.id, glyph: '≠', color: toneColor(flag.tone), title: flag.label, where: '', isBold: false })
  }
  return rows
}

/** The row's command as a button that puts it in the prompt, under the title. */
function commandEl(ctx: Ctx, row: Row, key: string): El | false {
  const { Box, Button } = ctx.kit
  const command = row.command ?? ''
  if (command === '') return false
  return (
    <Box paddingLeft={2} flexShrink={1}>
      <Button key={'attention:fill:' + key} variant="secondary" onPress={safely(() => ctx.handlers.onFillNext(command))}>
        {command}
      </Button>
    </Box>
  )
}

/** A row's lines, without a card: its glyph, title and where, then its caption and command. */
function rowBody(ctx: Ctx, row: Row, key: string): El {
  const { Box, Text, Link } = ctx.kit
  const glyph = (
    <Box width={1} flexShrink={0}>
      <Text bold color={row.color}>
        {row.glyph}
      </Text>
    </Box>
  )
  const titleText = (
    <Text bold={row.isBold} color={isRich(ctx) ? undefined : row.color} wrap="wrap">
      {row.title}
    </Text>
  )
  // The title wins: it keeps up to 24 columns (its own length when shorter) and the where gives way first.
  const title = (
    <Box flexShrink={1} minWidth={ctx.bp === 'S' ? undefined : Math.min(Array.from(row.title).length, 24)}>
      {row.href !== undefined ? (
        <Link href={row.href} label={row.title}>
          {titleText}
        </Link>
      ) : (
        titleText
      )}
    </Box>
  )
  // The where may be cut to nothing: with no floor of its own it would hold its full length on the desktop
  // and run past the card's border (a long PR caption did).
  const where =
    row.where !== '' ? (
      <Box flexShrink={4} minWidth={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {row.where}
        </Text>
      </Box>
    ) : (
      false
    )
  const command = commandEl(ctx, row, key)
  // The desktop's card also says why, as the plan's gate card did: the gate's caption, dim, under the title.
  const caption =
    isRich(ctx) && row.caption !== undefined ? (
      <Box paddingLeft={2} flexShrink={1}>
        <Text dimColor wrap="wrap">
          {row.caption}
        </Text>
      </Box>
    ) : (
      false
    )
  const line =
    ctx.bp === 'S' ? (
      <Box flexDirection="column" flexShrink={1}>
        <Box gap={1}>
          {glyph}
          {title}
        </Box>
        {where !== false && <Box paddingLeft={2}>{where}</Box>}
      </Box>
    ) : (
      <Box gap={1} flexShrink={1} flexGrow={1} minWidth={0}>
        {glyph}
        {title}
        <Box flexGrow={1} />
        {where}
      </Box>
    )
  return command === false && caption === false ? (
    line
  ) : (
    <Box flexDirection="column" flexShrink={1} flexGrow={1} minWidth={0}>
      {line}
      {caption}
      {command}
    </Box>
  )
}

/** A card in `color`: the desktop fills it with a tint of the tone under a faint line of it; the title is in the text colour. */
function card(ctx: Ctx, color: string | undefined, body: El): El {
  const { Box } = ctx.kit
  const rich = isRich(ctx)
  return (
    <Box
      borderStyle="round"
      borderColor={rich ? tint(color, '66') : (color ?? 'subtle')}
      backgroundColor={rich ? tint(color, '17') : undefined}
      paddingX={1}
    >
      {body}
    </Box>
  )
}

/** The worst tone of several rows, for the card that holds them all: an error over a warning over good news. */
const RANK: Record<string, number> = { error: 3, warning: 2, accent: 1, success: 0 }
const worstOf = (rows: readonly Row[]): string | undefined =>
  rows.reduce<string | undefined>((worst, row) => ((RANK[row.color ?? ''] ?? 2) > (RANK[worst ?? ''] ?? -1) ? row.color : worst), undefined)

/** The rows about pull requests as one card: a dim heading, then each PR row under it, a line apart. */
function prCard(ctx: Ctx, rows: readonly { row: Row; key: string }[]): El {
  const { Box, Text } = ctx.kit
  const heading = t('attention.prs', { count: String(rows.length) })
  return card(
    ctx,
    worstOf(rows.map(one => one.row)),
    <Box flexDirection="column" gap={1} flexShrink={1} flexGrow={1} minWidth={0}>
      {heading !== '' && (
        <Text bold dimColor wrap="truncate-end">
          {heading}
        </Text>
      )}
      {rows.map(one => rowBody(ctx, one.row, one.key))}
    </Box>,
  )
}

export function attention(ctx: Ctx, model: PanelModel): El | false {
  const { Box, Text } = ctx.kit
  const rows = rowsOf(model)
  if (rows.length === 0) return false
  const keys = uniqueIds(rows.map(row => row.id))
  // The desktop: the heading in the text colour with the count as a pill beside it, the cards a little apart.
  const rich = isRich(ctx)
  const heading = rich ? t('attention.heading') : t('attention.title', { count: String(rows.length) })
  const tone = rows.some(row => row.color === 'error') ? 'error' : 'warning'
  const keyed = rows.map((row, index) => ({ row, key: keys[index]! }))
  // On a desktop, two or more rows about pull requests are one card, where the first of them stands; the terminal
  // draws no cards and keeps every row in its place.
  const isBoxed = ctx.surface !== 'terminal'
  const prs = keyed.filter(one => one.row.href !== undefined)
  const isFolded = isBoxed && prs.length >= 2
  const firstPr = prs[0]?.key
  const cards = keyed.flatMap(one => {
    if (isFolded && one.row.href !== undefined) return one.key === firstPr ? [prCard(ctx, prs)] : []
    const body = rowBody(ctx, one.row, one.key)
    return [isBoxed ? card(ctx, one.row.color, body) : body]
  })
  return (
    <Box flexDirection="column" gap={rich ? 1 : 0}>
      {heading !== '' &&
        (rich ? (
          <Box gap={1}>
            <Text bold wrap="truncate-end">
              {heading}
            </Text>
            {pill(ctx, String(rows.length), tone)}
          </Box>
        ) : (
          <Text bold dimColor wrap="truncate-end">
            {heading}
          </Text>
        ))}
      {/* The cards stand apart, so each reads as its own. */}
      <Box flexDirection="column" gap={rich ? 2 : 0}>
        {cards}
      </Box>
    </Box>
  )
}
