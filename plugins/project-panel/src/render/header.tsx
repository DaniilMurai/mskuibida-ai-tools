// The header: where am I. Title, badge, freshness stamp and the Refresh button,
// laid out per breakpoint so the title is what gives way and nothing overlaps.
import { checkedText } from '../freshness'
import type { Clock } from '../freshness'
import { t } from '../strings/en'
import type { PanelModel } from '../../types'
import { showsCurrentItem } from './now'
import { clockTime, isRich, safely } from './kit'
import { pill } from './look'
import type { Ctx, El } from './kit'

function badgeColor(mode: PanelModel['header']['mode']): string {
  switch (mode) {
    case 'side-job':
      return 'warning'
    case 'stage':
      return 'claude'
    case 'inferred':
      return 'suggestion'
    default:
      return 'subtle'
  }
}

function stampOf(model: PanelModel | null, clock: Clock | undefined): string {
  if (model === null) return ''
  if (clock !== undefined) return checkedText(model, clock)
  return t('header.readAt', { time: clockTime(model.readAt) })
}

/** Row 1: title | (M/L) badge and stamp | Refresh. Row 2 (S only): badge and stamp. Then the error line. */
export function header(ctx: Ctx, model: PanelModel | null, clock: Clock | undefined): El {
  const { Box, Text, Button } = ctx.kit
  const { bp, handlers } = ctx
  const title = model === null ? t('pane.title') : model.header.title.toUpperCase()
  const badge = model === null ? '' : model.header.badge
  const stamp = stampOf(model, clock)
  const isDimBadge = model?.header.mode === 'idle'
  const error = model?.freshness?.error ?? ''
  // The subtitle (where the plan stands) is dropped when the Now card already names the current item.
  const subtitle = model === null || showsCurrentItem(model) ? '' : model.header.subtitle

  // On M/L the title shrinks first, down to a small floor of its own; the badge and the stamp
  // then give way (truncated); the Refresh button never shrinks. On S they sit on row 2, alone.
  const badgeShrink = bp === 'S' ? 0 : 0.25
  const badgeEl =
    badge !== '' && model !== null ? (
      <Box flexShrink={badgeShrink}>
        <Text bold color={badgeColor(model.header.mode)} dimColor={isDimBadge} wrap="truncate-end">
          {badge}
        </Text>
      </Box>
    ) : (
      false
    )
  const refresh = bp === 'S' ? '↻' : `↻ ${t('header.refresh')}`.trimEnd()
  if (isRich(ctx)) return richHeader(ctx, title, badge, model, stamp, subtitle, error, refresh)

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {title !== '' && (
          <Box flexShrink={1} minWidth={Math.min(Array.from(title).length, 8)}>
            <Text bold wrap="truncate-end">
              {title}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} />
        {bp !== 'S' && badgeEl}
        {bp !== 'S' && stamp !== '' && (
          <Box flexShrink={0.25}>
            <Text dimColor wrap="truncate-end">
              {stamp}
            </Text>
          </Box>
        )}
        <Box flexShrink={0}>
          <Button key="refresh" hotkey="r" onPress={safely(handlers.onRefresh)}>
            {refresh}
          </Button>
        </Box>
      </Box>
      {bp === 'S' && (badge !== '' || stamp !== '') && (
        <Box gap={1}>
          {badgeEl}
          {stamp !== '' && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {stamp}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {subtitle !== '' && (
        <Text dimColor wrap="wrap">
          {subtitle}
        </Text>
      )}
      {error !== '' && (
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text bold color="error">
              !
            </Text>
          </Box>
          <Box flexShrink={1}>
            <Text color="error" wrap="wrap">
              {error}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * The desktop's header: the title with the badge as a pill beside it and Refresh at the end; the stamp, the
 * subtitle and the error line under it, dim. The title is what gives way.
 */
function richHeader(
  ctx: Ctx,
  title: string,
  badge: string,
  model: PanelModel | null,
  stamp: string,
  subtitle: string,
  error: string,
  refresh: string,
): El {
  const { Box, Text, Button } = ctx.kit
  const below = [stamp, subtitle].filter(part => part !== '')
  return (
    <Box flexDirection="column">
      <Box gap={1} alignItems="center">
        {title !== '' && (
          <Box flexShrink={1} minWidth={Math.min(Array.from(title).length, 8)}>
            <Text bold wrap="truncate-end">
              {title}
            </Text>
          </Box>
        )}
        {badge !== '' && model !== null && (
          <Box flexShrink={0}>{pill(ctx, badge, badgeColor(model.header.mode), model.header.mode === 'idle')}</Box>
        )}
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Button key="refresh" hotkey="r" onPress={safely(ctx.handlers.onRefresh)}>
            {refresh}
          </Button>
        </Box>
      </Box>
      {below.map(line => (
        <Text dimColor wrap="wrap">
          {line}
        </Text>
      ))}
      {error !== '' && (
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text bold color="error">
              !
            </Text>
          </Box>
          <Box flexShrink={1}>
            <Text color="error" wrap="wrap">
              {error}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
