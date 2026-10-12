import { join, parent } from '../../fsx'
import type { Fsx } from '../../fsx'

const MAX_DEPTH = 64

/**
 * The branch checked out at `startDir`, read from `.git/HEAD` without running
 * git. Handles a normal checkout (`.git` dir) and a linked worktree (`.git`
 * file pointing at its gitdir). '' for a detached HEAD, no repo, or anything
 * unreadable.
 */
export async function readBranch(fsx: Fsx, startDir: string): Promise<string> {
  let dir: string | null = startDir
  for (let depth = 0; dir !== null && depth < MAX_DEPTH; depth++) {
    const dotGit = join(dir, '.git')
    if (await fsx.exists(dotGit)) {
      // A directory checkout has `.git/HEAD`; anything else at `.git` is a
      // linked worktree's pointer file. No guess from how `read` fails on a dir.
      const gitDir = (await fsx.exists(join(dotGit, 'HEAD')))
        ? dotGit
        : gitDirOf(await fsx.read(dotGit), dir)
      if (gitDir === null) return ''
      return branchOf(await fsx.read(join(gitDir, 'HEAD')))
    }
    dir = parent(dir)
  }
  return ''
}

/** `gitdir: <path>` of a worktree's `.git` file; relative paths hang off `base`. */
function gitDirOf(pointer: string | null, base: string): string | null {
  if (pointer === null) return null
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1]
  if (!target) return null
  return target.startsWith('/') ? normalise(target) : normalise(join(base, target))
}

/** Collapses `.` and `..` segments of an absolute POSIX path. */
function normalise(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function branchOf(head: string | null): string {
  return head === null ? '' : (/^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)?.[1] ?? '')
}
