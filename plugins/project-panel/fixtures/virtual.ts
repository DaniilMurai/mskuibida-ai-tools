import type { Fsx, FsxEntry } from '../src/fsx'

/** An in-memory file tree for tests: absolute paths; directories are implied. */
export type VirtualTree = {
  files: Record<string, string>
  /** Last-modified epoch ms by file or directory path; one not listed reads as 1. */
  mtimes?: Record<string, number>
}

/** The `Fsx` port over a virtual tree. */
export function fsxOf(tree: VirtualTree): Fsx {
  // Read per call, not once: a test adds and removes files while a session runs.
  const clean = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)
  const isDir = (path: string): boolean => {
    const paths = Object.keys(tree.files)
    const prefix = clean(path) === '/' ? '/' : `${clean(path)}/`
    return paths.some(file => file.startsWith(prefix))
  }

  return {
    read: async path => tree.files[clean(path)] ?? null,
    exists: async path => clean(path) in tree.files || isDir(path),
    list: async path => {
      const prefix = clean(path) === '/' ? '/' : `${clean(path)}/`
      const entries = new Map<string, FsxEntry>()
      for (const file of Object.keys(tree.files)) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const cut = rest.indexOf('/')
        const name = cut < 0 ? rest : rest.slice(0, cut)
        if (!entries.has(name) || cut >= 0) entries.set(name, { name, kind: cut < 0 ? 'file' : 'dir' })
      }
      return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
    mtime: async path => {
      const key = clean(path)
      if (key in tree.files) return tree.mtimes?.[key] ?? 1
      return isDir(path) ? (tree.mtimes?.[key] ?? 1) : null
    },
  }
}
