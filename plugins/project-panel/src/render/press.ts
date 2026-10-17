// What a press on one of the pane's buttons does, from its key and the state now: the same as the button's own
// `onPress` closure, worked out without the drawing. A `ui.press` hook (hooks/register.tsx) runs it and takes the
// press, so a press still lands when the surface shows a drawing whose closures it already let go (a pane hidden and
// shown again repaints its last drawing, and the first press on it found no closure to run).
import type { PanelModel } from '../../types'
import { rowsOf } from './attention'
import { uniqueIds } from './kit'
import { PLAN_KEY } from './plan'

export type PressAction =
  | { kind: 'refresh' }
  /** Fold state: `key` should be `isOpen` after the press. */
  | { kind: 'toggle'; key: string; isOpen: boolean }
  /** Put a command in the prompt. */
  | { kind: 'fill'; command: string }
  /** A provider action. */
  | { kind: 'action'; id: string }

/** The action a press on `element` (a Button's key) means; null for a key the pane does not draw now. */
export function pressAction(model: PanelModel | null, expanded: Record<string, boolean>, element: string): PressAction | null {
  if (element === 'refresh') return { kind: 'refresh' }
  if (model === null) return null

  if (element === 'next:fill') {
    const command = model.next?.command ?? ''
    return command === '' ? null : { kind: 'fill', command }
  }
  const after = (prefix: string): string | null => (element.startsWith(prefix) ? element.slice(prefix.length) : null)

  const row = after('attention:fill:')
  if (row !== null) {
    const rows = rowsOf(model)
    const command = rows[uniqueIds(rows.map(one => one.id)).indexOf(row)]?.command ?? ''
    return command === '' ? null : { kind: 'fill', command }
  }

  const action = after('action:')
  if (action !== null) {
    const actions = (model.actions ?? []).filter(one => one.label !== '')
    const found = actions[uniqueIds(actions.map(one => one.id)).indexOf(action)]
    return found ? { kind: 'action', id: found.id } : null
  }

  if (element === 'plan:fold') {
    const isFoldable = model.isPlanCollapsed !== undefined
    const isOpen = !isFoldable || (expanded[PLAN_KEY] ?? !model.isPlanCollapsed)
    return { kind: 'toggle', key: PLAN_KEY, isOpen: !isOpen }
  }

  const section = after('section:')
  if (section !== null) {
    const ids = uniqueIds(model.sections.map(one => one.id))
    const found = model.sections[ids.indexOf(section)]
    if (!found) return null
    const isOpen = expanded[section] ?? !found.isCollapsed
    return { kind: 'toggle', key: section, isOpen: !isOpen }
  }

  const folds: [string, string, boolean][] = [
    ['more:', '#all', true],
    ['less:', '#all', false],
    ['restless:', '#rest', false],
    ['rest:', '#rest', true],
  ]
  for (const [prefix, suffix, isOpen] of folds) {
    const id = after(prefix)
    if (id !== null) return { kind: 'toggle', key: `${id}${suffix}`, isOpen }
  }
  return null
}
