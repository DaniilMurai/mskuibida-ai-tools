// The file-read port. The types live in the contract (types/index.d.ts);
// hooks/register.tsx adapts `$.fs` to them (there, since the engine follows `$`
// only within one file), the tests hand a provider an in-memory tree. Every
// call answers rather than rejects, so a missing or unreadable file is an
// ordinary value.
export type { Fsx, FsxEntry } from '../types'

/** Joins POSIX path parts, dropping empty ones and doubled slashes. */
export function join(...parts: string[]): string {
  const joined = parts.filter(part => part !== '').join('/')
  return joined.replace(/\/{2,}/g, '/')
}

/** The parent directory, or null at the root. */
export function parent(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return null
  if (cut === 0) return trimmed === '' ? null : '/'
  return trimmed.slice(0, cut)
}
