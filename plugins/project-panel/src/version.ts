// The plugin's own version, for the dim mark at the foot of the pane: read from the manifest the engine loaded the
// mod from, so the pane says which build is drawing it. Pure: the caller hands in the read.

/** The `version` of a plugin.json's text; '' when it is missing, not a string, or the text is no JSON object. */
export function versionOfManifest(text: string | null): string {
  if (text === null) return ''
  try {
    const manifest: unknown = JSON.parse(text)
    if (typeof manifest !== 'object' || manifest === null) return ''
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' ? version.trim() : ''
  } catch {
    return ''
  }
}

/** Where a plugin's manifest stands under its root. */
export const manifestPath = (root: string): string => `${root.replace(/\/+$/, '')}/.claude-plugin/plugin.json`
