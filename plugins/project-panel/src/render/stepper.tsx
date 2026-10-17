// The phase stepper: a plan of a handful of phases drawn as one row of nodes
// joined by a line, on the surfaces that draw Svg. One-column panes show it
// between the header and the Now card; the wide pane draws phase cards instead
// (./plan). The terminal never gets it: its Plan block says the same in glyphs.
import { t } from '../strings/en'
import type { PanelModel, Section } from '../../types'
import { CARD_FILL, CARD_LINE, clip } from './kit'
import type { Ctx, El } from './kit'
import { RING_ARC, RING_DONE, RING_TEXT, RING_TRACK, clampPercent } from './ring'

const MIN_PHASES = 2
const MAX_PHASES = 7
/**
 * CSS px per cell of the desktop's code font, to size an Svg for a width given in cells. An estimate
 * only: an Svg with no `width` prop shrinks to its slot, so a guess on the wide side costs nothing.
 */
export const PX_PER_CELL = 8.4

const NODE_R = 9
const NODE_Y = 14
const LABEL_Y = 42
const HEIGHT = 50
/** Average advance of the 10.5 px label font, for cutting a title to the room between nodes. */
const LABEL_PX_PER_CHAR = 5.2
const FONT = '-apple-system, system-ui, sans-serif'

/** A section with no items and nothing counted: no ring, a dim title. */
export const isEmptySection = (section: Section): boolean => section.items.length === 0 && !(section.counts && section.counts.total > 0)

/** The sections the phase views draw: every one but a ledger's proposed ones and those that are no phase (Units). */
export const phasesOf = (model: PanelModel): Section[] =>
  model.sections.filter(section => section.isProposed !== true && section.isSupplement !== true)

/** True when the plan is a handful of phases (2 to 7), the shape the stepper and the phase cards are for. */
export function isPhased(model: PanelModel): boolean {
  const count = phasesOf(model).length
  return count >= MIN_PHASES && count <= MAX_PHASES
}

/** The phase's number before its title ("3 Inception"); the title alone when it has none. */
export const numbered = (section: Section): string => (section.ordinal === undefined || section.ordinal === '' ? section.title : `${section.ordinal} ${section.title}`)

type NodeState = 'done' | 'skipped' | 'empty' | 'current' | 'open'

function stateOf(section: Section, isCurrent: boolean): NodeState {
  if (section.status === 'skipped') return 'skipped'
  if (section.status === 'built' || (section.percent ?? 0) >= 100) return 'done'
  // Nothing counted yet: no items, or items that stand for work not defined yet (Construction before its Units).
  if (isEmptySection(section) || section.isUncounted === true) return 'empty'
  return isCurrent ? 'current' : 'open'
}

/** The phase the session is on: the one holding the current item, else the first active one; -1 for none. */
export function currentPhase(sections: Section[]): number {
  const holding = sections.findIndex(section => section.items.some(item => item.isCurrent))
  return holding >= 0 ? holding : sections.findIndex(section => section.status === 'active')
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function nodeSource(state: NodeState, x: number, percent: number, label: string): string {
  const circle = (attrs: string) => `<circle cx="${x}" cy="${NODE_Y}" r="${NODE_R}" fill="none" ${attrs}/>`
  const number = (fill: string, weight: number) =>
    label === ''
      ? ''
      : `<text x="${x}" y="${NODE_Y + 3.5}" text-anchor="middle" font-size="10" font-weight="${weight}" fill="${fill}" font-family="${FONT}">${escapeXml(label)}</text>`
  const arc = (stroke: number) => {
    if (percent <= 0) return ''
    const circumference = 2 * Math.PI * NODE_R
    return circle(
      `stroke="${RING_ARC}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${((circumference * percent) / 100).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${x} ${NODE_Y})"`,
    )
  }
  switch (state) {
    case 'done':
      return (
        `<circle cx="${x}" cy="${NODE_Y}" r="${NODE_R}" fill="${RING_DONE}"/>` +
        `<path d="M${x - 4} ${NODE_Y + 0.2}l2.8 2.8 5.2-5.6" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
      )
    case 'skipped':
      return (
        circle(`stroke="${RING_TRACK}" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="3 3"`) +
        `<line x1="${x - 4}" y1="${NODE_Y}" x2="${x + 4}" y2="${NODE_Y}" stroke="${RING_TEXT}" stroke-width="2" stroke-linecap="round"/>`
      )
    case 'empty':
      return circle(`stroke="${RING_TRACK}" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="3 3"`) + number(RING_TEXT, 600)
    case 'current':
      return circle(`stroke="${RING_TRACK}" stroke-opacity="0.35" stroke-width="3"`) + arc(3) + number(RING_ARC, 700)
    default:
      return circle(`stroke="${RING_TRACK}" stroke-opacity="0.55" stroke-width="2"`) + arc(2) + number(RING_TEXT, 600)
  }
}

/**
 * The stepper's markup, `width` px wide: one node per phase, evenly spaced, each over its cut title.
 * Done is a green check, the current phase an accent ring with its percent as the arc, skipped and
 * uncounted (empty, or not included yet) phases dashed. The line after a done phase is green, the rest the track tone.
 */
export function stepperSource(sections: Section[], current: number, width: number): string {
  const count = sections.length
  const spacing = width / count
  const xs = sections.map((_, index) => Number((spacing * (index + 0.5)).toFixed(1)))
  const states = sections.map((section, index) => stateOf(section, index === current))
  const chars = Math.max(3, Math.floor((spacing - 4) / LABEL_PX_PER_CHAR))
  const lines = xs
    .slice(0, -1)
    .map((x, index) => {
      const next = xs[index + 1]!
      const isDone = states[index] === 'done'
      const isDashed = states[index + 1] === 'skipped' || states[index + 1] === 'empty'
      const stroke = isDone ? `stroke="${RING_DONE}"` : `stroke="${RING_TRACK}" stroke-opacity="0.45"`
      return `<line x1="${x + NODE_R + 3}" y1="${NODE_Y}" x2="${next - NODE_R - 3}" y2="${NODE_Y}" ${stroke} stroke-width="2"${isDashed ? ' stroke-dasharray="3 4"' : ''}/>`
    })
    .join('')
  const nodes = sections
    .map((section, index) => nodeSource(states[index]!, xs[index]!, clampPercent(section.percent ?? 0), section.ordinal ?? String(index + 1)))
    .join('')
  const labels = sections
    .map((section, index) => {
      const isCurrent = states[index] === 'current'
      const title = escapeXml(clip(section.title, chars))
      return `<text x="${xs[index]}" y="${LABEL_Y}" text-anchor="middle" font-size="10.5" font-weight="${isCurrent ? 700 : 400}" fill="${isCurrent ? RING_ARC : RING_TEXT}" font-family="${FONT}">${title}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">${lines}${nodes}${labels}</svg>`
}

/** What the stepper says to a reader that cannot see it: every phase and where it stands. */
export function stepperAlt(sections: Section[], current: number): string {
  const parts = sections.map((section, index) => {
    const title = section.title
    switch (stateOf(section, index === current)) {
      case 'done':
        return t('stepper.alt.done', { title })
      case 'skipped':
        return t('stepper.alt.skipped', { title })
      case 'empty':
        return t('stepper.alt.empty', { title })
      case 'current':
        return t('stepper.alt.current', { title, percent: String(clampPercent(section.percent ?? 0)) })
      default:
        return t('stepper.alt.open', { title, percent: String(clampPercent(section.percent ?? 0)) })
    }
  })
  return t('stepper.alt', { phases: parts.filter(part => part !== '').join(', ') })
}

/** The stepper, sized for the pane's width; false off the Svg surfaces or for a plan that is not a handful of phases. */
export function stepper(ctx: Ctx, model: PanelModel): El | false {
  const { Box, Svg } = ctx.kit
  if (Svg === undefined || !isPhased(model)) return false
  const sections = phasesOf(model)
  const current = currentPhase(sections)
  // The card's border and padding take about four columns.
  const width = Math.max(200, Math.round((ctx.columns - 4) * PX_PER_CELL))
  // On a card of its own, as the Now card is.
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={CARD_LINE} backgroundColor={CARD_FILL} paddingX={1}>
      <Svg source={stepperSource(sections, current, width)} alt={stepperAlt(sections, current)} />
    </Box>
  )
}
