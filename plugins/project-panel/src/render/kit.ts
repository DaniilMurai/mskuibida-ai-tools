// Shared by the pane's drawing modules: the element kit, the press handlers,
// the breakpoint and the small pure helpers every block uses.
import type { Elements, RenderSurface } from 'claude-code'
import type { Gate, Tone } from '../../types'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> & {
  /** Absent on the terminal. */
  Svg?: Elements['desktop']['Svg']
}
export type El = ReturnType<Kit['Box']>

export type Handlers = {
  onRefresh: () => void | Promise<void>
  /** `isOpen` is what the section should be after the press. */
  onToggle: (sectionId: string, isOpen: boolean) => void | Promise<void>
  /** A provider action button. */
  onAction: (actionId: string) => void | Promise<void>
  /** "put in prompt" on the Next block. */
  onFillNext: (command: string) => void | Promise<void>
}

/** narrow S < 48, medium M 48-79, wide L >= 80 (the Pane's `bodyColumns`). */
export type Bp = 'S' | 'M' | 'L'

/** A width that is no finite number reads as medium. */
export function breakpoint(columns: number): Bp {
  if (!Number.isFinite(columns)) return 'M'
  return columns < 48 ? 'S' : columns < 80 ? 'M' : 'L'
}

/**
 * Ids made unique for use as keys: the first of an id keeps it, a repeat gets `~<index>`.
 * Unique ids come back as they are.
 */
export function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  return ids.map((id, index) => {
    const out = seen.has(id) ? `${id}~${index}` : id
    seen.add(id)
    return out
  })
}

/** `text` cut to `max` characters with a trailing … (a model string, not copy). */
export function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

/** What every block needs to draw itself. */
export type Ctx = {
  kit: Kit
  surface: RenderSurface
  bp: Bp
  columns: number
  handlers: Handlers
}

/** A press handler that never leaves a rejection unhandled. */
export function safely(run: () => void | Promise<void>): () => void {
  return () => {
    void (async () => {
      try {
        await run()
      } catch {
        // A failed press changes nothing on screen.
      }
    })()
  }
}

export function toneColor(tone: Tone): string | undefined {
  switch (tone) {
    case 'accent':
      return 'claude'
    case 'success':
      return 'success'
    case 'warning':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return undefined
  }
}

export function gateColor(gate: Pick<Gate, 'tone'>): string {
  switch (gate.tone) {
    case 'error':
      return 'error'
    case 'success':
      return 'success'
    case 'accent':
      return 'claude'
    default:
      return 'warning'
  }
}

/** ‖ parked, ? waiting on a person (you, for a review), ✓ approved, otherwise ⊘ when blocking and ‖ when only a warning. */
export function gateGlyph(gate: Pick<Gate, 'kind' | 'tone'>): string {
  if (gate.kind === 'parked') return '‖'
  if (gate.kind === 'awaiting-approval' || gate.kind === 'questions-unanswered' || gate.kind === 'review-requested') return '?'
  if (gate.kind === 'approved' || gate.kind === 'approved-comments') return '✓'
  return gate.tone === 'error' ? '⊘' : '‖'
}

export function clockTime(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
