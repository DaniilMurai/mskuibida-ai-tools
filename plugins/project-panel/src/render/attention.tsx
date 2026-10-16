// Needs attention: what blocks, and what waits on the viewer. The freshness error, then the gates (a provider
// puts the rows tied to the viewer first: a review asked of them, their approved PR), then the drift flags. A
// row with a command offers it as a button that puts it in the prompt.
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

function rowEl(ctx: Ctx, row: Row, key: string): El {
  const { Box, Text, Link } = ctx.kit
  const isBoxed = ctx.surface !== 'terminal'
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
  const body =
    command === false && caption === false ? (
      line
    ) : (
      <Box flexDirection="column" flexShrink={1} flexGrow={1} minWidth={0}>
        {line}
        {caption}
        {command}
      </Box>
    )
  // The desktop fills the card with a tint of its tone under a faint line of it; the title is in the text colour.
  const rich = isRich(ctx)
  return isBoxed ? (
    <Box
      borderStyle="round"
      borderColor={rich ? tint(row.color, '66') : (row.color ?? 'subtle')}
      backgroundColor={rich ? tint(row.color, '17') : undefined}
      paddingX={1}
    >
      {body}
    </Box>
  ) : (
    body
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
      {rows.map((row, index) => rowEl(ctx, row, keys[index]!))}
    </Box>
  )
}
