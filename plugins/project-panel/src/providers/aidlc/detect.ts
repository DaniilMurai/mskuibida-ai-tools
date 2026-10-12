import { join, parent } from '../../fsx'
import type { Fsx } from '../../fsx'
import type { Workspace } from './types'

const ENGINE_MARKERS = ['.claude/tools/aidlc.ts', '.claude/rules/aidlc.md']
const STATE_HEADING = '# AI-DLC State Tracking'
// Far deeper than any real checkout; stops a pathological startDir.
const MAX_DEPTH = 64

/**
 * Finds the nearest ancestor of `startDir` holding an AI-DLC v2 workspace:
 * `<dir>/aidlc/spaces/`. The v1 `aidlc-docs/` layout is not looked at.
 * A bare `aidlc/spaces/` counts only when an intent state file or an engine
 * marker backs it up, so an unrelated folder of that name is not mistaken.
 */
export async function detectWorkspace(fsx: Fsx, startDir: string): Promise<Workspace | null> {
  let dir: string | null = startDir
  for (let depth = 0; dir !== null && depth < MAX_DEPTH; depth++) {
    const found = await inspect(fsx, dir)
    if (found) return found
    dir = parent(dir)
  }
  return null
}

async function inspect(fsx: Fsx, root: string): Promise<Workspace | null> {
  const aidlcDir = join(root, 'aidlc')
  const spacesDir = join(aidlcDir, 'spaces')
  if (!(await fsx.exists(spacesDir))) return null

  const engineMarkers: string[] = []
  for (const marker of ENGINE_MARKERS) {
    if (await fsx.exists(join(root, marker))) engineMarkers.push(marker)
  }
  if (engineMarkers.length > 0 || (await hasStateFile(fsx, spacesDir))) {
    return { root, aidlcDir, engineMarkers }
  }
  return null
}

/** True when some space's `active-intent` or any intent dir holds an AI-DLC state file. */
async function hasStateFile(fsx: Fsx, spacesDir: string): Promise<boolean> {
  for (const space of await fsx.list(spacesDir)) {
    if (space.kind === 'file') continue
    const intentsDir = join(spacesDir, space.name, 'intents')

    const active = (await fsx.read(join(intentsDir, 'active-intent')))?.trim()
    if (active && (await isStateFile(fsx, join(intentsDir, active, 'aidlc-state.md')))) return true

    for (const intent of await fsx.list(intentsDir)) {
      if (intent.kind === 'file') continue
      if (await isStateFile(fsx, join(intentsDir, intent.name, 'aidlc-state.md'))) return true
    }
  }
  return false
}

async function isStateFile(fsx: Fsx, path: string): Promise<boolean> {
  const text = await fsx.read(path)
  return text !== null && text.replace(/^﻿/, '').trimStart().startsWith(STATE_HEADING)
}
