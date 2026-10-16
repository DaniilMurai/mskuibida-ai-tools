// The Plan block: the overall ring and summary, then every section.
import { t } from '../strings/en'
import type { Gate, PanelModel, Section } from '../../types'
import { safely, uniqueIds } from './kit'
import type { Ctx, El } from './kit'
import { foldGutters, foldRow, gateCard, itemRow, openCap } from './item'
import { clampPercent, mixOf, ring, strip } from './ring'

const BIG_RING = 40
const SMALL_RING = 16
const LONG_AFTER = { S: 6, M: 10, L: 16 } as const
const OPEN_CAP = { S: 8, M: 12, L: 20 } as const
const STRIP_FROM_ITEMS = 10

/** The Plan fold's state key: `#` keeps it clear of every section id. */
const PLAN_KEY = '#plan'

/** The overall percent and the line that says it: the provider's own label, else "50% done, 11 of 22". */
function overallText(model: PanelModel): { value: number | undefined; summary: string } {
  const { percent, counts } = model.overall
  // One value for the ring and the summary; a percent that is no number draws neither.
  const value = percent !== undefined && Number.isFinite(percent) ? clampPercent(percent) : undefined
  // The provider's own label (e.g. "74% of effort · 189/287 tasks") replaces the renderer's summary.
  const own = model.overall.label ?? ''
  const summary =
    own !== ''
      ? own
      : value === undefined
        ? ''
        : t('plan.summary', { percent: String(value), done: String(counts.done ?? 0), total: String(counts.total) })
  return { value, summary }
}

/** `isOpen` is set only where the provider folds the whole plan: the title is then the toggle (▾ open, ▸ folded). */
export function planHeading(ctx: Ctx, model: PanelModel, isOpen?: boolean): El {
  const { Box, Text, Button } = ctx.kit
  const { value, summary } = overallText(model)
  const title = t('plan.title')
  // The text sits beside the ring in a Box that shrinks; a long label wraps instead of being cut.
  const labels = (
    <Box flexDirection={ctx.kit.Svg ? 'column' : 'row'} gap={ctx.kit.Svg ? 0 : 1} flexShrink={1}>
      {title !== '' && (
        <Box flexShrink={0}>
          {isOpen === undefined ? (
            <Text bold dimColor>
              {title}
            </Text>
          ) : (
            <Button plain key="plan:fold" onPress={safely(() => ctx.handlers.onToggle(PLAN_KEY, !isOpen))}>
              <Text bold dimColor>{`${isOpen ? '▾' : '▸'} ${title}`}</Text>
            </Button>
          )}
        </Box>
      )}
      {summary !== '' && (
        <Box flexShrink={1}>
          <Text bold wrap="wrap">
            {summary}
          </Text>
        </Box>
      )}
    </Box>
  )
  return (
    <Box gap={1} paddingBottom={ctx.kit.Svg ? 1 : 0}>
      {value !== undefined && ring(ctx, value, BIG_RING, true)}
      {labels}
    </Box>
  )
}

/** The gates the plan draws: not the rows that belong under Needs attention only. */
export const planGates = (model: PanelModel): Gate[] => model.gates.filter(gate => gate.isAttentionOnly !== true)

export function orphanGates(model: PanelModel): Gate[] {
  const known = new Set(model.sections.map(section => section.id))
  return planGates(model).filter(gate => !known.has(gate.sectionId))
}

/** The folded plan: one row with the toggle, the summary, and the ring; a ‖ when a gate hides in it. */
function foldedPlan(ctx: Ctx, model: PanelModel): El {
  const { Box, Text, Button } = ctx.kit
  const { value, summary } = overallText(model)
  const title = t('plan.title')
  const hint = t('plan.foldedHint')
  const hasGate = planGates(model).length > 0
  return (
    <Box gap={1}>
      <Box flexShrink={0}>
        <Button plain key="plan:fold" onPress={safely(() => ctx.handlers.onToggle(PLAN_KEY, true))}>
          <Text bold dimColor>{`▸ ${title}`}</Text>
        </Button>
      </Box>
      {summary !== '' && (
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={1}>
        {hasGate && (
          <Text bold color="warning">
            ‖
          </Text>
        )}
        {hint !== '' && ctx.bp !== 'S' && <Text dimColor>{hint}</Text>}
        {value !== undefined && ring(ctx, value, SMALL_RING, false)}
      </Box>
    </Box>
  )
}

export function plan(ctx: Ctx, model: PanelModel, expanded: Record<string, boolean>): El {
  const { Box } = ctx.kit
  // A provider may fold the whole plan (a side job); the person's own choice wins.
  const isFoldable = model.isPlanCollapsed !== undefined
  const isOpen = !isFoldable || (expanded[PLAN_KEY] ?? !model.isPlanCollapsed)
  if (!isOpen) return foldedPlan(ctx, model)
  // A repeated section id gets a distinct key (and fold state); its gates belong to the first.
  const ids = uniqueIds(model.sections.map(section => section.id))
  // One width for every count, from the widest ("18/18 ✓"), so the rings and counts line up.
  const countWidth = Math.max(0, ...model.sections.map(section => Array.from(countText(section)).length))
  const firstProposed = model.sections.findIndex(section => section.isProposed === true)
  return (
    <Box flexDirection="column">
      {model.sections.length > 0 && planHeading(ctx, model, isFoldable ? true : undefined)}
      {orphanGates(model).map(gate => gateCard(ctx, gate))}
      {model.sections.map((section, index) =>
        sectionEl(
          ctx,
          section,
          ids[index]!,
          ids[index] === section.id ? planGates(model).filter(gate => gate.sectionId === section.id) : [],
          expanded,
          countWidth,
          index === firstProposed,
        ),
      )}
    </Box>
  )
}

/** Done/total as the section's count column says it ("3/3 ✓" when built); '' when there is nothing to say. */
function countText(section: Section): string {
  if (section.isProposed === true || section.status === 'skipped') return ''
  const isBuilt = section.status === 'built'
  const count = section.counts && section.counts.total > 0 ? t('section.count', { done: String(section.counts.done), total: String(section.counts.total) }) : ''
  if (count === '') return isBuilt ? '✓' : ''
  return isBuilt ? `${count} ✓` : count
}

/** A section with no items and nothing counted: no ring, a dim title. */
const isEmptySection = (section: Section): boolean => section.items.length === 0 && !(section.counts && section.counts.total > 0)

function sectionEl(
  ctx: Ctx,
  section: Section,
  id: string,
  gates: Gate[],
  expanded: Record<string, boolean>,
  countWidth: number,
  isFirstProposed: boolean,
): El {
  const { Box, Text } = ctx.kit
  if (section.isProposed === true) {
    // The first proposed card follows a dim "Proposed" divider; the cards carry no tag of their own.
    const divider = isFirstProposed ? t('section.proposedHeading') : ''
    return (
      <Box flexDirection="column">
        {divider !== '' && (
          <Box marginTop={1}>
            <Text dimColor>{divider}</Text>
          </Box>
        )}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text bold dimColor wrap="truncate-end">
            {section.title}
          </Text>
          {section.caption !== undefined && section.caption !== '' && (
            <Text dimColor wrap="wrap">
              {section.caption}
            </Text>
          )}
        </Box>
      </Box>
    )
  }

  const isOpen = expanded[id] ?? !section.isCollapsed
  const heading = sectionHeading(ctx, section, id, isOpen, isOpen ? [] : gates, countWidth)
  if (!isOpen) return <Box flexDirection="column">{heading}</Box>

  // Gates belong to the first item with their id, so a repeated id never doubles a gate.
  const owner = new Map<string, number>()
  section.items.forEach((item, index) => {
    if (!owner.has(item.id)) owner.set(item.id, index)
  })
  const atTop = gates.filter(gate => gate.afterItemId === undefined || !owner.has(gate.afterItemId))
  const afterIndex = (index: number) => gates.filter(gate => gate.afterItemId !== undefined && owner.get(gate.afterItemId) === index)

  // Done-folding: a long section hides the done items nobody needs to see, but only behind a row that can bring them back.
  const cap = LONG_AFTER[ctx.bp]
  const isAll = expanded[`${id}#all`] === true
  const folding = foldRow(section.items, index => afterIndex(index).length > 0, cap, isAll, count => t('section.doneFold', { count: String(count) }))
  const { hidden } = folding
  const moreText = folding.text
  const less = moreText !== '' && isAll ? t('section.doneHide') : ''

  // The open-items cap, after done-folding: the first few and the current one, behind a row that shows the rest.
  const isRest = expanded[`${id}#rest`] === true
  const visible = section.items.map((_, index) => index).filter(index => !hidden.has(index))
  const capped = openCap(visible, index => section.items[index]!.isCurrent, OPEN_CAP[ctx.bp], isRest, count =>
    t('section.moreItems', { count: String(count) }),
  )
  const drawn = visible.filter(index => !capped.capped.has(index))
  // Fold gutters over what is drawn.
  const gutters = foldGutters(drawn.map(index => section.items[index]!))
  const folds = new Map(drawn.map((index, at) => [index, gutters[at] ?? ''] as const))
  const fewer = isRest && capped.text !== '' ? t('section.fewerItems') : ''

  return (
    <Box flexDirection="column">
      {heading}
      {section.caption !== undefined && section.caption !== '' && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {section.caption}
          </Text>
        </Box>
      )}
      {atTop.map(gate => gateCard(ctx, gate))}
      {hidden.size > 0 && foldButton(ctx, `more:${id}`, `✓ ${moreText}`, () => ctx.handlers.onToggle(`${id}#all`, true))}
      {less !== '' && foldButton(ctx, `less:${id}`, less, () => ctx.handlers.onToggle(`${id}#all`, false))}
      {drawn.map(index => (
        <Box flexDirection="column">
          {itemRow(ctx, section.items[index]!, folds.get(index) ?? '')}
          {afterIndex(index).map(gate => gateCard(ctx, gate))}
        </Box>
      ))}
      {capped.capped.size > 0 && foldButton(ctx, `rest:${id}`, capped.text, () => ctx.handlers.onToggle(`${id}#rest`, true))}
      {fewer !== '' && foldButton(ctx, `restless:${id}`, fewer, () => ctx.handlers.onToggle(`${id}#rest`, false))}
    </Box>
  )
}

function foldButton(ctx: Ctx, key: string, label: string, press: () => void | Promise<void>): El {
  const { Box, Button } = ctx.kit
  return (
    <Box paddingLeft={2}>
      <Button plain key={key} onPress={safely(press)}>
        {label}
      </Button>
    </Box>
  )
}

/** The phase's number before its title ("3 Inception"); the title alone when it has none. */
const numbered = (section: Section): string => (section.ordinal === undefined || section.ordinal === '' ? section.title : `${section.ordinal} ${section.title}`)

/** ▾/▸ + title on the left; on the right the hidden-gate mark, the strip, the ring and the count (✓ when built), or "skipped". */
function sectionHeading(ctx: Ctx, section: Section, id: string, isOpen: boolean, hiddenGates: Gate[], countWidth: number): El {
  const { Box, Text, Button } = ctx.kit
  const hasError = hiddenGates.some(gate => gate.tone === 'error')
  return (
    <Box gap={1}>
      <Box flexShrink={1}>
        <Button plain key={'section:' + id} dimColor={section.status === 'skipped' || isEmptySection(section)} onPress={safely(() => ctx.handlers.onToggle(id, !isOpen))}>
          <Text bold={section.status === 'active'} wrap="truncate-end">{`${isOpen ? '▾' : '▸'} ${numbered(section)}`}</Text>
        </Button>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={1}>
        {hiddenGates.length > 0 && (
          <Text bold color={hasError ? 'error' : 'warning'}>
            {hasError ? '⊘' : '‖'}
          </Text>
        )}
        {!isOpen && ctx.bp !== 'S' && section.items.length >= STRIP_FROM_ITEMS && !isFinished(section) && strip(ctx, mixOf(section.items), ctx.bp === 'L' ? 96 : 64)}
        {sectionTail(ctx, section, countWidth)}
      </Box>
    </Box>
  )
}

/** Built or at 100%: the ring and "n/n ✓" already say it, so no strip. */
const isFinished = (section: Section): boolean => section.status === 'built' || (section.percent ?? 0) >= 100

function sectionTail(ctx: Ctx, section: Section, countWidth: number): El | false {
  const { Box, Text } = ctx.kit
  if (section.status === 'skipped') {
    const word = t('section.skipped')
    return word !== '' && <Text dimColor>{word}</Text>
  }
  const isBuilt = section.status === 'built'
  const text = countText(section)
  const hasRing = section.percent !== undefined && Number.isFinite(section.percent) && !isEmptySection(section)
  if (!hasRing && text === '') return false
  return (
    <Box gap={1}>
      {hasRing && ring(ctx, section.percent ?? 0, SMALL_RING, false)}
      <Box minWidth={countWidth} justifyContent="flex-end">
        {text !== '' && (
          <Text dimColor={!isBuilt} color={isBuilt ? 'success' : undefined}>
            {text}
          </Text>
        )}
      </Box>
    </Box>
  )
}
