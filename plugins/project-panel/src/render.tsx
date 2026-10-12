// The panel's tree: any PanelModel, drawn the same way. Deterministic and
// I/O-free: model + folds + clock in, elements out. Box, Text, Button and Link
// are in every surface's table; Svg (rings, the status strip) is in all but the
// terminal's, which draws glyphs and block cells instead.
//
// Top to bottom: header (where am I), the Now card with Next (what am I on,
// what is next), the actions, Needs attention (what blocks), Plan (overall
// progress and sections). From 80 columns, with sections, the Now card, actions
// and attention sit in a left column and the plan in a right one.
//
// Copy comes from `t()` or from the model (display text a provider resolved).
// A string that is '' hides its element; nothing is substituted. Glyphs are
// not copy. The pieces live in ./render/.
import type { RenderSurface } from 'claude-code'
import type { Clock } from './freshness'
import { t } from './strings/en'
import type { PanelModel } from '../types'
import { attention, rowsOf } from './render/attention'
import { header } from './render/header'
import { breakpoint } from './render/kit'
import type { Ctx, El, Handlers, Kit } from './render/kit'
import { actionsRow, nowCard } from './render/now'
import { orphanGates, plan } from './render/plan'

export type { Handlers, Kit } from './render/kit'

const LEFT_SHARE = 0.4
const COLUMN_GAP = 2

/**
 * `surface` decides the ring, not the table's keys: the terminal's table answers
 * an `Svg` constructor at run time though its type has none, and draws nothing from it.
 * `clock` (the engine's `now`, its last check) turns the stamp into "checked 12s ago";
 * without it the stamp is the model's "read 12:03".
 */
export function renderPane(
  table: Kit,
  surface: RenderSurface,
  columns: number,
  model: PanelModel | null,
  expanded: Record<string, boolean>,
  handlers: Handlers,
  clock?: Clock,
): El {
  const kit: Kit = surface === 'terminal' ? { ...table, Svg: undefined } : table
  const width = Number.isFinite(columns) ? columns : 60
  const ctx: Ctx = { kit, surface, bp: breakpoint(width), columns: width, handlers }
  const { Box, Text } = kit

  if (model === null) {
    const empty = t('pane.empty')
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        {header(ctx, null, clock)}
        {empty !== '' && (
          <Text dimColor wrap="wrap">
            {empty}
          </Text>
        )}
      </Box>
    )
  }

  const hasPlan = model.sections.length > 0 || orphanGates(model).length > 0
  const isTwoColumn = ctx.bp === 'L' && hasPlan
  // The left column is 40% of the pane, less the gap: it lays out for its own width, not the pane's.
  const leftWidth = Math.floor(width * LEFT_SHARE) - COLUMN_GAP
  const leftCtx: Ctx = isTwoColumn ? { ...ctx, bp: breakpoint(leftWidth), columns: leftWidth } : ctx
  const left = [nowCard(leftCtx, model), actionsRow(leftCtx, model), rowsOf(model).length > 0 && attention(leftCtx, model)]
  const right = hasPlan && plan(ctx, model, expanded)

  return (
    <Box flexDirection="column" gap={1}>
      {header(ctx, model, clock)}
      {isTwoColumn ? (
        <Box gap={COLUMN_GAP}>
          <Box flexDirection="column" gap={1} width="40%">
            {left}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {right}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {left}
          {right}
        </Box>
      )}
    </Box>
  )
}
