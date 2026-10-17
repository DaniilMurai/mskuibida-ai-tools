// The Plan block: the overall ring and summary, then every section.
import { t } from '../strings/en'
import type { Gate, PanelModel, Section } from '../../types'
import { CARD_FILL, isRich, safely, uniqueIds } from './kit'
import { emptyRing, pill } from './look'
import type { Ctx, El } from './kit'
import { foldGutters, foldRow, gateCard, itemRow, openCap } from './item'
import { clampPercent, mixOf, ring, strip } from './ring'
import { isEmptySection, numbered } from './stepper'

const BIG_RING = 40
const SMALL_RING = 16
const CARD_RING = 20
/** A phase card's narrowest width in cells: five share a wide pane's plan column, and the row wraps below it. */
const CARD_MIN = 10
/** The card's strip, in px. */
const CARD_STRIP = 72
const LONG_AFTER = { S: 6, M: 10, L: 16 } as const
const OPEN_CAP = { S: 8, M: 12, L: 20 } as const
const STRIP_FROM_ITEMS = 10

/** The Plan fold's state key: `#` keeps it clear of every section id. */
export const PLAN_KEY = '#plan'

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
            <Text bold dimColor={!isRich(ctx)}>
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
          <Text bold={!isRich(ctx)} dimColor={isRich(ctx)} wrap="wrap">
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

/**
 * `asPhases` (the wide pane's plan column, on an Svg surface, for a plan of a handful of phases) draws
 * the section headings as a row of phase cards, with the open phases' items under them.
 */
export function plan(ctx: Ctx, model: PanelModel, expanded: Record<string, boolean>, asPhases = false): El {
  const { Box } = ctx.kit
  // A provider may fold the whole plan (a side job); the person's own choice wins.
  const isFoldable = model.isPlanCollapsed !== undefined
  const isOpen = !isFoldable || (expanded[PLAN_KEY] ?? !model.isPlanCollapsed)
  if (!isOpen) return foldedPlan(ctx, model)
  // A repeated section id gets a distinct key (and fold state); its gates belong to the first.
  const ids = uniqueIds(model.sections.map(section => section.id))
  if (asPhases) return phasePlan(ctx, model, ids, expanded, isFoldable)
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

/** The wide pane's phase view: the heading, orphan gates, a row of phase cards, each open phase's items, then any proposed sections. */
function phasePlan(ctx: Ctx, model: PanelModel, ids: string[], expanded: Record<string, boolean>, isFoldable: boolean): El {
  const { Box, Text } = ctx.kit
  const gatesOf = (index: number): Gate[] => {
    const section = model.sections[index]!
    return ids[index] === section.id ? planGates(model).filter(gate => gate.sectionId === section.id) : []
  }
  // A card is its phase's heading: the same fold key, so a phase open in one column stays open in two.
  const phases = model.sections
    .map((section, index) => ({ section, id: ids[index]!, index, isOpen: isSectionOpen(section, ids[index]!, expanded) }))
    .filter(phase => phase.section.isProposed !== true && phase.section.isSupplement !== true)
  const firstProposed = model.sections.findIndex(section => section.isProposed === true)
  return (
    <Box flexDirection="column">
      {planHeading(ctx, model, isFoldable ? true : undefined)}
      {orphanGates(model).map(gate => gateCard(ctx, gate))}
      <Box flexWrap="wrap" gap={1}>
        {phases.map(phase =>
          phaseCard(ctx, phase.section, phase.id, phase.isOpen, gatesOf(phase.index), () => ctx.handlers.onToggle(phase.id, !phase.isOpen)),
        )}
      </Box>
      {phases
        .filter(phase => phase.isOpen)
        .map(phase => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate-end">
              {numbered(phase.section)}
            </Text>
            {sectionBody(ctx, phase.section, phase.id, gatesOf(phase.index), expanded)}
          </Box>
        ))}
      {/* A section that is no phase (the Units beside a claimed Unit) keeps its list row under the cards. */}
      {model.sections.map(
        (section, index) => section.isSupplement === true && section.isProposed !== true && sectionEl(ctx, section, ids[index]!, gatesOf(index), expanded, 0, false),
      )}
      {model.sections.map((section, index) => section.isProposed === true && sectionEl(ctx, section, ids[index]!, [], expanded, 0, index === firstProposed))}
    </Box>
  )
}

/** One phase: its ring, the hidden-gate mark and its count; its title, the press that opens it; its strip. */
function phaseCard(ctx: Ctx, section: Section, id: string, isOpen: boolean, gates: Gate[], press: () => void | Promise<void>): El {
  const { Box, Text, Button } = ctx.kit
  const isSkipped = section.status === 'skipped'
  const isUncounted = section.isUncounted === true
  const isBuilt = section.status === 'built'
  const hasRing = !isSkipped && !isUncounted && section.percent !== undefined && Number.isFinite(section.percent) && !isEmptySection(section)
  // As the list's row says it: skipped dim, work with no size yet in the colour of "local only".
  const count = isSkipped ? t('section.skipped') : isUncounted ? t('section.notIncluded') : countText(section)
  // The open phase draws its gates in its items; a closed one only marks that it holds some.
  const hidden = isOpen ? [] : gates
  const hasError = hidden.some(gate => gate.tone === 'error')
  return (
    <Box
      key={'phase:' + id}
      flexDirection="column"
      flexGrow={1}
      minWidth={CARD_MIN}
      borderStyle="round"
      borderColor={isOpen ? 'claude' : 'subtle'}
      backgroundColor={isOpen ? CARD_FILL : undefined}
      hover={{ borderColor: 'claude' }}
      paddingX={1}
    >
      <Box gap={1}>
        {hasRing && ring(ctx, section.percent ?? 0, CARD_RING, false)}
        <Box flexGrow={1} />
        {hidden.length > 0 && (
          <Text bold color={hasError ? 'error' : 'warning'}>
            {hasError ? '⊘' : '‖'}
          </Text>
        )}
        {count !== '' && (
          <Text dimColor={!isBuilt && !isUncounted} color={isBuilt ? 'success' : isUncounted ? 'warning' : undefined}>
            {count}
          </Text>
        )}
      </Box>
      <Button plain key={'section:' + id} dimColor={isSkipped || isUncounted || isEmptySection(section)} onPress={safely(press)}>
        <Text bold={isOpen} wrap="truncate-end">
          {numbered(section)}
        </Text>
      </Button>
      {!isSkipped && !isUncounted && strip(ctx, mixOf(section.items), CARD_STRIP)}
    </Box>
  )
}

/** Done/total as the section's count column says it ("3/3 ✓" when built); '' when there is nothing to say. */
function countText(section: Section): string {
  if (section.isProposed === true || section.status === 'skipped') return ''
  const isBuilt = section.status === 'built'
  // A provider's own count (story points) stands in for done/total.
  if (section.countLabel !== undefined && section.countLabel !== '') return isBuilt ? `${section.countLabel} ✓` : section.countLabel
  const count = section.counts && section.counts.total > 0 ? t('section.count', { done: String(section.counts.done), total: String(section.counts.total) }) : ''
  if (count === '') return isBuilt ? '✓' : ''
  return isBuilt ? `${count} ✓` : count
}

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

  const isOpen = isSectionOpen(section, id, expanded)
  const heading = sectionHeading(ctx, section, id, isOpen, isOpen ? [] : gates, countWidth)
  if (!isOpen) return <Box flexDirection="column">{heading}</Box>
  return (
    <Box flexDirection="column">
      {heading}
      {sectionBody(ctx, section, id, gates, expanded)}
    </Box>
  )
}

/** The person's fold, else the provider's. */
const isSectionOpen = (section: Section, id: string, expanded: Record<string, boolean>): boolean => expanded[id] ?? !section.isCollapsed

/** An open section under its heading (or under its phase card): caption, gates, the fold rows and the items. */
function sectionBody(ctx: Ctx, section: Section, id: string, gates: Gate[], expanded: Record<string, boolean>): El {
  const { Box, Text } = ctx.kit

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

/** ▾/▸ + title on the left; on the right the hidden-gate mark, the strip, the ring and the count (✓ when built), or "skipped". */
function sectionHeading(ctx: Ctx, section: Section, id: string, isOpen: boolean, hiddenGates: Gate[], countWidth: number): El {
  const { Box, Text, Button } = ctx.kit
  const hasError = hiddenGates.some(gate => gate.tone === 'error')
  // The desktop draws the ring before the title (a dashed one where nothing is counted), the count alone on the right.
  const rich = isRich(ctx)
  const chevron = isOpen ? '▾' : '▸'
  const lead = rich && (hasRingOf(section) ? ring(ctx, section.percent ?? 0, SMALL_RING, false) : emptyRing(ctx, SMALL_RING, emptyAlt(section)))
  return (
    <Box gap={1} alignItems="center">
      {rich && (
        <Box flexShrink={0}>
          <Text dimColor>{chevron}</Text>
        </Box>
      )}
      {lead}
      <Box flexShrink={1}>
        <Button plain key={'section:' + id} dimColor={section.status === 'skipped' || isEmptySection(section)} onPress={safely(() => ctx.handlers.onToggle(id, !isOpen))}>
          <Text bold={section.status === 'active'} wrap="truncate-end">
            {rich ? numbered(section) : `${chevron} ${numbered(section)}`}
          </Text>
        </Button>
      </Box>
      {tagOf(ctx, section.titleTag, 'claude')}
      <Box flexGrow={1} />
      <Box flexShrink={0} gap={1}>
        {hiddenGates.length > 0 && (
          <Text bold color={hasError ? 'error' : 'warning'}>
            {hasError ? '⊘' : '‖'}
          </Text>
        )}
        {!isOpen && ctx.bp !== 'S' && section.items.length >= STRIP_FROM_ITEMS && !isFinished(section) && strip(ctx, mixOf(section.items), ctx.bp === 'L' ? 96 : 64)}
        {tagOf(ctx, section.sideCount, undefined)}
        {sectionTail(ctx, section, countWidth, !isRich(ctx))}
      </Box>
    </Box>
  )
}

/** A section's extra label (its title tag, its side count): a pill on the desktop, dim text on the terminal. */
function tagOf(ctx: Ctx, text: string | undefined, color: string | undefined): El | false {
  const { Box, Text } = ctx.kit
  if (text === undefined || text === '') return false
  return (
    <Box flexShrink={1} minWidth={0} overflow="hidden">
      {isRich(ctx) ? (
        pill(ctx, text, color)
      ) : (
        <Text dimColor wrap="truncate-end">
          {text}
        </Text>
      )}
    </Box>
  )
}

/** What a dashed ring says: skipped, not included yet, or nothing (a section with nothing counted). */
const emptyAlt = (section: Section): string =>
  section.status === 'skipped' ? t('section.skipped') : section.isUncounted === true ? t('section.notIncluded') : ''

/** A ring is drawn for a counted section that is not skipped. */
const hasRingOf = (section: Section): boolean =>
  section.status !== 'skipped' && section.isUncounted !== true && section.percent !== undefined && Number.isFinite(section.percent) && !isEmptySection(section)

/** Built or at 100%: the ring and "n/n ✓" already say it, so no strip. */
const isFinished = (section: Section): boolean => section.status === 'built' || (section.percent ?? 0) >= 100

function sectionTail(ctx: Ctx, section: Section, countWidth: number, withRing = true): El | false {
  const { Box, Text } = ctx.kit
  if (section.status === 'skipped') {
    const word = t('section.skipped')
    return word !== '' && <Text dimColor>{word}</Text>
  }
  // Work with no size yet: said in the colour of "local only", not left blank.
  if (section.isUncounted === true) {
    const word = t('section.notIncluded')
    return word !== '' && <Text color="warning">{word}</Text>
  }
  const isBuilt = section.status === 'built'
  const text = countText(section)
  const hasRing = withRing && hasRingOf(section)
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
