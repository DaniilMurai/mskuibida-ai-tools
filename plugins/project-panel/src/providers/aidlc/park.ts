// Whether a park still holds. The engine writes `Parked:` into the state file when the workflow parks and should clear it
// when work resumes, but a resume can leave it behind (seen on a real intent: parked at 03:20, the Unit's stage started
// at 04:07, the `Parked:` line still there). The audit shards say what happened after: a park is over once any of them
// has a work event later than it. Pure: the caller reads the shards.

/** Events that mean the workflow is moving again. */
const RESUME_EVENTS: readonly string[] = ['WORKFLOW_UNPARKED', 'STAGE_STARTED', 'UNIT_STARTED', 'UNIT_RESUMED']

/** True when `shard` (one audit file's text) has a resume event timestamped after `since` (the state's `Parked:` value). */
export function isResumedAfter(shard: string, since: string): boolean {
  const parkedAt = Date.parse(since)
  if (Number.isNaN(parkedAt)) return false
  if (!RESUME_EVENTS.some(event => shard.includes(event))) return false
  for (const block of shard.split(/^---\s*$/m)) {
    const field = (key: string) => new RegExp(`^\\*\\*${key}\\*\\*:[^\\S\\n]*([^\\n]*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
    if (!RESUME_EVENTS.includes(field('Event'))) continue
    const at = Date.parse(field('Timestamp'))
    if (!Number.isNaN(at) && at > parkedAt) return true
  }
  return false
}
