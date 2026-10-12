// `glab api projects/<path>/merge_requests/<iid>/changes` (glab 1.99.0), sanitised: the `changes` array keeps
// the recorded per-file fields, with the diff text cut to ''.
import { mrRow } from './gitlab-mr-list'

function file(path: string, over: Record<string, unknown> = {}) {
  return {
    old_path: path,
    new_path: path,
    a_mode: '100644',
    b_mode: '100644',
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: '',
    ...over,
  }
}

/** A change with an added, an edited, a renamed and a deleted file, and a path listed twice. */
export const changes = {
  ...mrRow(281, { state: 'opened', merged_at: null }),
  changes: [
    file('docs/notes/FEAT-GEN-281.md', { a_mode: '0', new_file: true }),
    file('src/app.ts'),
    file('src/new-name.ts', { old_path: 'src/old-name.ts', renamed_file: true }),
    file('src/gone.ts', { new_path: 'src/gone.ts', deleted_file: true, b_mode: '0' }),
    file('src/app.ts'),
  ],
  overflow: false,
}
