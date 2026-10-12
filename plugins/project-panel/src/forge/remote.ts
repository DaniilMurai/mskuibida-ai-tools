import type { Remote } from './types'

// Parsing an origin URL. Pure. Credentials in a URL are dropped on the floor: nothing here returns, logs or
// stores a user name or token. The user info ends at the LAST `@` of the authority (a password may contain one).
// An ssh-config alias (`Host work` in ~/.ssh/config) is not resolved: set the `forge` option for such a remote.

const SCHEMED = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/i
const HOSTPORT = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/
/** GitHub's ssh-over-443 host: the repository lives on github.com. */
const ALIASES: Record<string, string> = { 'ssh.github.com': 'github.com' }
// scp-like: [user@]host:path, where path does not start with another slash pair (that would be a scheme).
const SCP = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

/** group/sub/repo from a URL path: query and fragment cut, slashes and `.git` trimmed; null unless at least owner/repo. */
function pathOf(raw: string): string | null {
  const noQuery = raw.replace(/[?#].*$/, '')
  const path = noQuery.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const segments = path.split('/')
  if (segments.length < 2) return null
  if (segments.some(s => s === '' || s === '.' || s === '..' || /[\s\\]/.test(s))) return null
  return path
}

function canonicalHost(host: string): string {
  return ALIASES[host] ?? host
}

/** An origin URL as host, port, path and scheme; null for a local path, `file://` or anything unreadable. */
export function parseRemote(url: string): Remote | null {
  const text = url.trim()
  if (text === '') return null

  const schemed = SCHEMED.exec(text)
  if (schemed) {
    const scheme = (schemed[1] as string).toLowerCase()
    const authority = schemed[2] as string
    const hostPort = HOSTPORT.exec(authority.slice(authority.lastIndexOf('@') + 1))
    if (!hostPort) return null
    const host = canonicalHost((hostPort[1] as string).toLowerCase())
    const port = hostPort[2] ? Number(hostPort[2]) : undefined
    if (port !== undefined && !(port > 0 && port < 65536)) return null
    const path = pathOf(schemed[3] ?? '')
    if (!HOST.test(host) || path === null) return null
    if (scheme === 'https' || scheme === 'http') return { host, ...(port !== undefined ? { port } : {}), path, scheme }
    if (scheme === 'git') return { host, path, scheme: 'git' }
    if (scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git') return { host, path, scheme: 'ssh' }
    return null
  }

  // Local paths: absolute, relative, home, Windows drive letters.
  if (/^[/.~]/.test(text) || /^[A-Za-z]:[\\/]/.test(text) || text.includes('\\')) return null
  const scp = SCP.exec(text)
  if (!scp) return null
  const host = canonicalHost((scp[1] as string).toLowerCase())
  const path = pathOf(scp[2] as string)
  if (!HOST.test(host) || host.length < 2 || path === null) return null
  return { host, path, scheme: 'ssh' }
}

/** The repository's web address: `https://host[:port]/path` (the port only for http(s) remotes; http stays http). */
export function webBase(remote: Remote): string {
  const scheme = remote.scheme === 'http' ? 'http' : 'https'
  const port = remote.port === undefined ? '' : `:${remote.port}`
  return `${scheme}://${remote.host}${port}/${remote.path}`
}

/** What `gh` and `glab` know the host by: `host[:port]`. */
export function hostKey(remote: Remote): string {
  return remote.port === undefined ? remote.host : `${remote.host}:${remote.port}`
}
