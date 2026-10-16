// Shared by the render tests: the rich surfaces (desktop, vscode, mobile - the ones that draw Svg) draw pills and chips
// with a non-breaking space of padding each side, where the terminal draws bare words and [bracketed] chips.
export const NBSP = ' '

/** Text padded the way a pill or a chip is on the rich surfaces. */
export const padded = (word: string): string => `${NBSP}${word}${NBSP}`

/** A pill's or chip's text without its padding; any other text comes back as it is. */
export const bare = (text: string): string => (text.startsWith(NBSP) && text.endsWith(NBSP) && text.length >= 2 ? text.slice(1, -1) : text)

/** True for the surfaces that draw Svg (the element tables that have it). */
export const isRichSurface = (surface: string): boolean => surface !== 'terminal'

export type SvgFound = { props: Record<string, unknown> }
/** The rings of one size among the Svgs found: 40 the plan's, 16 a section's, 20 a phase card's. */
export const ringsOf = <T extends SvgFound>(svgs: T[], size: number): T[] =>
  svgs.filter(svg => svg.props.width === size && String(svg.props.alt ?? '').endsWith('% done'))
