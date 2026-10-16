// The desktop surface's element table, as React components: what renderPane's tree becomes on the Claude desktop
// app, approximated from screenshots of the real pane. Cells map to px (CELL_X across, CELL_Y down), theme keys to
// the CSS variables index.html's theme sets, a bordered Box to a rounded card. An approximation for checking a
// design, not the app's renderer: spacing and fonts are close, not exact.
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** Horizontal px per cell (a gap, a padding, a width in columns). */
export const CELL_X = 7
/** Vertical px per cell of spacing (a gap or margin between rows); text lines take their own line height. */
export const CELL_Y = 9
/** The code font's advance the desktop measures `bodyColumns` with. */
export const ADVANCE = 8.4

const THEME_KEYS = new Set([
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged',
  'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide',
  'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
])

/** A theme key follows the theme (a CSS variable); anything else is a raw CSS colour. */
export const paint = (color: unknown): string | undefined =>
  typeof color !== 'string' || color === '' ? undefined : THEME_KEYS.has(color) ? `var(--${color})` : color

const cellsX = (value: unknown): string | number | undefined =>
  typeof value === 'number' ? value * CELL_X : typeof value === 'string' ? value : undefined
const cellsY = (value: unknown): string | number | undefined =>
  typeof value === 'number' ? value * CELL_Y : typeof value === 'string' ? value : undefined
const n = (value: unknown): number => (typeof value === 'number' ? value : 0)

type Props = Record<string, any> & { children?: ReactNode }

export function Box(p: Props) {
  const [isHover, setHover] = useState(false)
  const hover = p.hover && isHover ? p.hover : {}
  const display = (hover.display ?? p.display) === 'none' ? 'none' : 'flex'
  const borderStyle = p.borderStyle
  const borderColor = paint(hover.borderColor ?? p.borderColor ?? 'subtle')
  const px = n(p.paddingX ?? p.padding)
  const py = n(p.paddingY ?? p.padding)
  const style: CSSProperties = {
    display,
    boxSizing: 'border-box',
    flexDirection: p.flexDirection ?? 'row',
    flexGrow: p.flexGrow ?? 0,
    flexShrink: p.flexShrink ?? 1,
    flexWrap: p.flexWrap,
    alignItems: p.alignItems ?? 'stretch',
    alignSelf: p.alignSelf,
    justifyContent: p.justifyContent,
    rowGap: n(p.rowGap ?? p.gap) * CELL_Y,
    columnGap: n(p.columnGap ?? p.gap) * CELL_X,
    width: cellsX(p.width),
    height: cellsY(p.height),
    minWidth: cellsX(p.minWidth) ?? 0,
    minHeight: cellsY(p.minHeight),
    marginTop: n(p.marginTop ?? p.marginY ?? p.margin) * CELL_Y,
    marginBottom: n(p.marginBottom ?? p.marginY ?? p.margin) * CELL_Y,
    marginLeft: n(p.marginLeft ?? p.marginX ?? p.margin) * CELL_X,
    marginRight: n(p.marginRight ?? p.marginX ?? p.margin) * CELL_X,
    paddingTop: n(p.paddingTop ?? py) * CELL_Y,
    paddingBottom: n(p.paddingBottom ?? py) * CELL_Y,
    paddingLeft: n(p.paddingLeft ?? px) * CELL_X,
    paddingRight: n(p.paddingRight ?? px) * CELL_X,
    overflow: p.overflow,
    position: p.position,
    top: cellsY(hover.top ?? p.top),
    left: cellsX(hover.left ?? p.left),
    right: cellsX(hover.right ?? p.right),
    bottom: cellsY(hover.bottom ?? p.bottom),
    background: paint(hover.backgroundColor ?? p.backgroundColor),
  }
  if (borderStyle !== undefined) {
    // The desktop draws a border as a thin rounded line with about a row of room inside it, top and bottom.
    style.border = `1px solid ${borderColor}`
    style.borderRadius = 10
    style.paddingTop = (style.paddingTop as number) + 7
    style.paddingBottom = (style.paddingBottom as number) + 7
    style.paddingLeft = (style.paddingLeft as number) + 2
    style.paddingRight = (style.paddingRight as number) + 2
    if (p.borderDimColor) style.borderColor = 'var(--subtle)'
  }
  const isHoverable = p.hover !== undefined
  return (
    <div
      data-el="Box"
      style={style}
      onMouseEnter={isHoverable ? () => setHover(true) : undefined}
      onMouseLeave={isHoverable ? () => setHover(false) : undefined}
    >
      {p.children}
    </div>
  )
}

function textStyle(p: Props): CSSProperties {
  const color = paint(p.color)
  const style: CSSProperties = {
    color: color ?? (p.dimColor ? 'var(--dim)' : undefined),
    opacity: color !== undefined && p.dimColor ? 0.7 : undefined,
    fontWeight: p.bold ? 600 : undefined,
    fontStyle: p.italic ? 'italic' : undefined,
    textDecoration: [p.underline && 'underline', p.strikethrough && 'line-through'].filter(Boolean).join(' ') || undefined,
    background: paint(p.backgroundColor),
    whiteSpace: 'pre-wrap',
    minWidth: 0,
  }
  if (typeof p.wrap === 'string' && p.wrap.startsWith('truncate')) {
    Object.assign(style, { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' })
  }
  if (p.inverse) Object.assign(style, { background: style.color ?? 'var(--text)', color: 'var(--bg)' })
  return style
}

export function Text(p: Props) {
  return (
    <span data-el="Text" style={textStyle(p)}>
      {p.children}
    </span>
  )
}

export function Button(p: Props) {
  const content = p.children ?? p.label
  const onClick = () => void p.onPress?.()
  if (p.plain) {
    return (
      <button data-el="Button" className="plain" style={{ color: p.dimColor ? 'var(--dim)' : undefined }} onClick={onClick}>
        {content}
      </button>
    )
  }
  return (
    <button data-el="Button" className={p.variant === 'primary' ? 'native primary' : 'native'} onClick={onClick}>
      <span>{content}</span>
      {typeof p.hotkey === 'string' && <kbd>{p.hotkey.toUpperCase()}</kbd>}
    </button>
  )
}

export function Link(p: Props) {
  return (
    <a data-el="Link" href={p.href} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none', minWidth: 0, display: 'contents' }}>
      {p.children ?? p.label}
    </a>
  )
}

export function Svg(p: Props) {
  const src = 'data:image/svg+xml;utf8,' + encodeURIComponent(String(p.source))
  return (
    <img
      data-el="Svg"
      src={src}
      alt={p.alt}
      width={p.width}
      height={p.height}
      style={{ display: 'block', maxWidth: '100%', height: p.height === undefined ? 'auto' : p.height, flexShrink: 0 }}
    />
  )
}

export function Markdown(p: Props) {
  return (
    <div data-el="Markdown" style={{ whiteSpace: 'pre-wrap', color: p.dimColor ? 'var(--dim)' : undefined }}>
      {p.text}
    </div>
  )
}

export function Code(p: Props) {
  return (
    <pre data-el="Code" style={{ margin: 0, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>
      {p.source}
    </pre>
  )
}

export const desktopKit = { Box, Text, Button, Link, Svg, Markdown, Code }
