// Input hashing for the AI layer: the model is called again only when what it reads has changed.

/** SHA-256 hex of the parts joined with NUL, via the web-standard `crypto.subtle`. */
export async function inputHash(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join('\u0000'))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The canonical parts that decide whether the assignment must be recomputed: the ledger text, the merged
 * PR numbers and the top-level directories, each order-independent. `pinnedIds` (optional) folds the
 * pinned section ids in so re-pinning also invalidates the stored assignment.
 */
export function assignmentInputs(
  ledgerText: string,
  mergedPrNumbers: number[],
  topDirs: string[],
  pinnedIds: string[] = [],
): string[] {
  const prs = [...mergedPrNumbers].sort((a, b) => a - b).join(',')
  const dirs = [...topDirs].sort().join(',')
  const parts = [ledgerText, prs, dirs]
  if (pinnedIds.length) parts.push([...pinnedIds].sort().join(','))
  return parts
}
