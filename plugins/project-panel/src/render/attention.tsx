// Needs attention: what blocks, and what waits on the viewer. The freshness error, then the gates (a provider
// puts the rows tied to the viewer first: a review asked of them, their approved PR), then the drift flags. A
// row with a command offers it as a button that puts it in the prompt.
import { t } from '../strings/en'
import type { Gate, PanelModel } from '../../types'
import { gateColor, gateGlyph, safely, toneColor, uniqueIds } from './kit'
import type { Ctx, El } from './kit'

type Row = { id: string; glyph: string; color: string | undefined; title: string; where: string; isBold: boolean; href?: string; command?: string }

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
    <Text bold={row.isBold} color={row.color} wrap="wrap">
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
    command === false ? (
      line
    ) : (
      <Box flexDirection="column" flexShrink={1} flexGrow={1} minWidth={0}>
        {line}
        {command}
      </Box>
    )
  return isBoxed ? (
    <Box borderStyle="round" borderColor={row.color ?? 'subtle'} paddingX={1}>
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
  const heading = t('attention.title', { count: String(rows.length) })
  return (
    <Box flexDirection="column">
      {heading !== '' && (
        <Text bold dimColor wrap="truncate-end">
          {heading}
        </Text>
      )}
      {rows.map((row, index) => rowEl(ctx, row, keys[index]!))}
    </Box>
  )
}
