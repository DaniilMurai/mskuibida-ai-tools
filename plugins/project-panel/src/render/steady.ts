// One press handle per button key, for as long as the pane lives. `<Button>` mints a fresh handle on every call, and the
// host retires a drawing's old handles when the next drawing arrives; a surface still showing the older drawing (a
// redraw it has not taken yet, a pane hidden and shown again) then sends a handle the host no longer holds, and the
// press is lost ("ui_press not handled" in the desktop log; the second press, on the new drawing, works). The host
// keeps a button's handle across drawings when the plugin draws it under the same handle again, so each key keeps the
// first handle it was drawn with. The closure under it is the latest drawing's, as before.

type Press = { plugin: string; handle: number }
type Node = { props?: { key?: unknown }; press?: Press; children?: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const pressOf = (node: Node): Press | null => {
  const { press } = node
  return isObject(press) && press.plugin === '' && typeof press.handle === 'number' ? press : null
}

/**
 * `tree` with every pressable element this plugin drew under the handle its key had before (`held`, which it fills
 * with the keys drawn for the first time). A key drawn twice in one tree keeps its fresh handle the second time, so
 * no two elements share one.
 */
export function steadyPresses<T>(tree: T, held: Map<string, number>): T {
  const drawn = new Set<string>()
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!isObject(value)) return value
    const node = value as Node
    const children = node.children === undefined ? undefined : walk(node.children)
    const withChildren = children === undefined ? node : { ...node, children }
    const press = pressOf(node)
    const key = node.props?.key
    if (press === null || typeof key !== 'string' || drawn.has(key)) return withChildren
    drawn.add(key)
    const handle = held.get(key) ?? press.handle
    held.set(key, handle)
    return handle === press.handle ? withChildren : { ...withChildren, press: { ...press, handle } }
  }
  return walk(tree) as T
}
