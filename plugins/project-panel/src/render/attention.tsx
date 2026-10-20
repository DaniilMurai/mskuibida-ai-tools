// Needs attention: what blocks, and what waits on the viewer. The freshness error, then the gates (a provider
// puts the rows tied to the viewer first: a review asked of them, their approved PR), then the drift flags. A
// row with a command offers it as a button that puts it in the prompt. On a desktop the rows about pull requests (the
// ones that link to a PR) are one card together, where the first of them stands, one line per PR with everything said
// about it; every other row is a card of its own.
import { t } from '../strings/en'
import type { Gate, PanelModel } from '../../types'
import { gateColor, gateGlyph, isRich, safely, tint, toneColor, uniqueIds } from './kit'
import { pill } from './look'
import type { Ctx, El } from './kit'

type Row = { id: string; glyph: string; color: string | undefined; title: string; where: string; isBold: boolean; kind?: string; about?: string; href?: string; command?: string; caption?: string }

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
      kind: gate.kind,
      // Someone else's PR outside the plan is known by its title and author, which a review asked of you says.
      ...(gate.kind === 'review-requested' && !model.sections.some(one => one.id === gate.sectionId) && (gate.caption ?? '') !== '' ? { about: gate.caption } : {}),
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

/** A PR's number and forge from its link: GitHub's `/pull/66`, GitLab's `/merge_requests/66`; null for anything else. */
function prRefOf(href: string): string {
  const github = /\/pull\/(\d+)(?:[/?#]|$)/.exec(href)
  if (github) return t('attention.pr.ref', { number: github[1]! })
  const gitlab = /\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(href)
  return gitlab ? t('attention.pr.ref.gitlab', { number: gitlab[1]! }) : ''
}

/** What a row says about its PR in a word or two (`conflicts`); its own title for a kind with no short word. */
const wordOf = (row: Row): string => t(`attention.pr.word.${row.kind ?? ''}`) || row.title

/** A command as its name alone, for a button on a PR's line: `/pr-review:address-review 66` is `address-review`. */
const commandName = (command: string): string => command.replace(/^\//, '').split(/\s/)[0]!.split(':').pop() ?? command

type PrLine = { href: string; ref: string; rows: { row: Row; key: string }[] }

/** The PR rows by the PR they link to, in the order each PR first comes; the rows in theirs, the worst first. */
function prLinesOf(rows: readonly { row: Row; key: string }[]): PrLine[] {
  const lines: PrLine[] = []
  for (const one of rows) {
    const href = one.row.href ?? ''
    const line = lines.find(each => each.href === href)
    if (line) line.rows.push(one)
    else lines.push({ href, ref: prRefOf(href), rows: [one] })
  }
  for (const line of lines) line.rows.sort((a, b) => (RANK[b.row.color ?? ''] ?? 2) - (RANK[a.row.color ?? ''] ?? 2))
  return lines
}

/**
 * One PR on one line: the glyph of its worst row, the PR as a link, everything the rows say about it in a word or two
 * (`conflicts · changes requested · not merged`), with the title and author of a PR outside the plan, and the first
 * command one of them offers as a small button named by the command.
 */
function prLineEl(ctx: Ctx, line: PrLine): El {
  const { Box, Text, Link, Button } = ctx.kit
  const worst = line.rows[0]!.row
  const about = line.rows.find(one => (one.row.about ?? '') !== '')?.row.about ?? ''
  const words = [...new Set([...line.rows.map(one => wordOf(one.row)), about].filter(word => word !== ''))]
  const label = line.ref || worst.title
  const withCommand = line.rows.find(one => (one.row.command ?? '') !== '')
  const command = withCommand?.row.command ?? ''
  return (
    <Box gap={1} flexShrink={1} flexGrow={1} minWidth={0}>
      <Box width={1} flexShrink={0}>
        <Text bold color={worst.color}>
          {worst.glyph}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Link href={line.href} label={label}>
          <Text bold>{label}</Text>
        </Link>
      </Box>
      <Box flexShrink={1} flexGrow={1} minWidth={0}>
        <Text dimColor wrap="wrap">
          {words.join(t('attention.pr.separator'))}
        </Text>
      </Box>
      {withCommand !== undefined && (
        <Box flexShrink={0}>
          <Button key={'attention:fill:' + withCommand.key} variant="secondary" onPress={safely(() => ctx.handlers.onFillNext(command))}>
            {commandName(command)}
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** The rows about pull requests as one card: a dim heading, then one line per PR. */
function prCard(ctx: Ctx, rows: readonly { row: Row; key: string }[]): El {
  const { Box, Text } = ctx.kit
  const lines = prLinesOf(rows)
  const heading = t('attention.prs', { count: String(lines.length) })
  return card(
    ctx,
    worstOf(rows.map(one => one.row)),
    <Box flexDirection="column" gap={1} flexShrink={1} flexGrow={1} minWidth={0}>
      {heading !== '' && (
        <Text bold dimColor wrap="truncate-end">
          {heading}
        </Text>
      )}
      {lines.map(line => prLineEl(ctx, line))}
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
  // On a desktop, the rows about pull requests are one card, where the first of them stands, a line per PR; the
  // terminal draws no cards and keeps every row in its place.
  const isBoxed = ctx.surface !== 'terminal'
  const prs = keyed.filter(one => one.row.href !== undefined)
  const isFolded = isBoxed && prs.length > 0
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
