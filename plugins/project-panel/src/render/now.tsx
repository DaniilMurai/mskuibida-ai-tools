// The Now card: what the session is on, what is next, and the provider's actions.
import { t } from '../strings/en'
import type { ContextLine, Item, PanelModel, Section } from '../../types'
import { safely, toneColor, uniqueIds } from './kit'
import type { Ctx, El } from './kit'
import { itemLook } from './item'

const MODE_BORDER: Record<PanelModel['header']['mode'], string> = {
  stage: 'claude',
  'side-job': 'warning',
  inferred: 'suggestion',
  idle: 'subtle',
}

/** The first current item, with its section and its place among the section's executed items. */
function currentOf(model: PanelModel): { item: Item; section: Section; index: number; total: number } | null {
  for (const section of model.sections) {
    const item = section.items.find(one => one.isCurrent)
    if (item === undefined) continue
    const counted = section.items.filter(one => one.status !== 'skipped')
    return { item, section, index: counted.indexOf(item) + 1, total: counted.length }
  }
  return null
}

/** True when the Now card names a current item (its place duplicates the header's subtitle). */
export function showsCurrentItem(model: PanelModel): boolean {
  return model.header.mode !== 'side-job' && model.header.mode !== 'idle' && currentOf(model) !== null
}

function dimLabel(ctx: Ctx, text: string): El | false {
  const { Text } = ctx.kit
  return (
    text !== '' && (
      <Text bold dimColor wrap="truncate-end">
        {text}
      </Text>
    )
  )
}

function dimCaption(ctx: Ctx, text: string | undefined): El | false {
  const { Text } = ctx.kit
  return (
    text !== undefined &&
    text !== '' && (
      <Text dimColor wrap="wrap">
        {text}
      </Text>
    )
  )
}

/** One line about the side-job session (its branch, its PR, its distance from main): dim, wrapped, a link when it has one. */
function contextLine(ctx: Ctx, line: ContextLine): El | false {
  const { Text, Link } = ctx.kit
  if (line.text === '') return false
  const text = (
    <Text dimColor={line.tone === undefined} color={line.tone === undefined ? undefined : toneColor(line.tone)} wrap="wrap">
      {line.text}
    </Text>
  )
  return line.href !== undefined && line.href !== '' ? (
    <Link href={line.href} label={line.text}>
      {text}
    </Link>
  ) : (
    text
  )
}

/** The Now card; false when it would hold only a label (no item, headline, caption or Next). */
export function nowCard(ctx: Ctx, model: PanelModel): El | false {
  const { Box, Text } = ctx.kit
  const { header } = model
  const mode = header.mode

  let top: (El | false)[]
  if (mode === 'side-job' || mode === 'idle') {
    const key = mode === 'side-job' ? 'now.sideJob' : 'now.idle'
    const headline = t(`${key}.headline`)
    top = [
      dimLabel(ctx, t(`${key}.label`)),
      headline !== '' && (
        <Text bold wrap="wrap">
          {headline}
        </Text>
      ),
      dimCaption(ctx, header.caption),
      ...(mode === 'side-job' ? (header.context ?? []).map(line => contextLine(ctx, line)) : []),
    ]
  } else {
    const current = currentOf(model)
    if (current === null) {
      if (header.caption === '' && (!model.next || model.next.command === '')) return false
      top = [dimLabel(ctx, t('now.nextUp')), dimCaption(ctx, header.caption)]
    } else {
      const look = itemLook(current.item)
      // A current item that lives only in this worktree says where, in the Now card's own words.
      const word = current.item.landing === 'local' ? t('now.landing.local') : look.word
      const base = header.base ?? ''
      // A current item the plan does not count (skipped) has no place to name.
      const where =
        current.index === 0 ? '' : t('now.where', { section: current.section.title, index: String(current.index), total: String(current.total) })
      top = [
        <Box gap={1}>
          {dimLabel(ctx, t('now.label'))}
          {where !== '' && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {where}
              </Text>
            </Box>
          )}
        </Box>,
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text bold color={look.color} dimColor={look.color === undefined}>
              {look.glyph}
            </Text>
          </Box>
          <Box flexShrink={1}>
            <Text bold wrap="wrap">
              {current.item.title}
            </Text>
          </Box>
          {word !== '' && (
            <Box flexShrink={0}>
              <Text color={look.wordColor}>{word}</Text>
            </Box>
          )}
        </Box>,
        dimCaption(ctx, base),
        dimCaption(ctx, current.item.caption !== undefined && current.item.caption !== '' ? current.item.caption : header.caption),
      ]
    }
  }

  const next = nextBlock(ctx, model)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={MODE_BORDER[mode]} paddingX={1}>
      {top}
      {next !== false && (
        <Box flexDirection="column" marginTop={1}>
          {next}
        </Box>
      )}
    </Box>
  )
}

/** "Next /aidlc" over the dim reason, and the Put in prompt button: beside it from M, below it on S. Hidden without a command. */
function nextBlock(ctx: Ctx, model: PanelModel): El | false {
  const { Box, Text, Button } = ctx.kit
  const next = model.next
  if (!next || next.command === '') return false
  const label = t('next.label')
  const fill = t('next.fill')
  const text = (
    <Box flexDirection="column" flexShrink={1}>
      <Box gap={1}>
        {label !== '' && (
          <Box flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
        )}
        <Box flexShrink={1}>
          <Text bold color="claude" wrap="truncate-end">
            {next.command}
          </Text>
        </Box>
      </Box>
      {next.reason !== '' && (
        <Text dimColor wrap="wrap">
          {next.reason}
        </Text>
      )}
    </Box>
  )
  const button =
    fill !== '' ? (
      <Box flexShrink={0}>
        <Button
          key="next:fill"
          hotkey="p"
          variant={model.header.mode === 'side-job' ? 'secondary' : 'primary'}
          onPress={safely(() => ctx.handlers.onFillNext(next.command))}
        >
          {fill}
        </Button>
      </Box>
    ) : (
      false
    )
  if (ctx.bp === 'S') {
    return (
      <Box flexDirection="column">
        {text}
        {button}
      </Box>
    )
  }
  return (
    <Box gap={1} justifyContent="space-between">
      {text}
      {button}
    </Box>
  )
}

export function actionsRow(ctx: Ctx, model: PanelModel): El | false {
  const { Box, Button } = ctx.kit
  const actions = (model.actions ?? []).filter(action => action.label !== '')
  if (actions.length === 0) return false
  const keys = uniqueIds(actions.map(action => action.id))
  return (
    <Box gap={1} flexWrap="wrap">
      {actions.map((action, index) => (
        <Button key={'action:' + keys[index]} onPress={safely(() => ctx.handlers.onAction(action.id))}>
          {action.label}
        </Button>
      ))}
    </Box>
  )
}
