// The refresh engine: keeps the published PanelModel true to the plan and the repo.
//
// Provider-neutral and `$`-free: everything outside (clock, timers, the provider's
// load and fingerprint, stats, commands, the state write, "is the pane on screen")
// is a port that hooks/register.tsx adapts from `$`. So it is unit-testable with
// fake ports and a fake clock.
//
// What it does
//  - Triggers: session start, tool calls that touched the plan, the turn ending, a surface
//    attaching, an mtime poll of the model's `watch` paths plus the git HEAD, a poll of the
//    provider's remote `fingerprint`, and the Refresh button.
//  - Coalesces: a read already scheduled absorbs later requests (it is never pushed out, so a burst
//    cannot starve it); a read already running queues exactly one follow-up.
//  - Publishes only a change: the model is hashed without `readAt` and `freshness`; an identical
//    re-read writes nothing and redraws nothing. `checkedAt()` still moves, for the header stamp.
//  - Never breaks the pane: a failed read or remote check keeps the last model and publishes it
//    with `freshness.error`; the next success clears it.
//  - Runs only while the pane is on screen: stop() cancels every timer, start() resumes with a
//    catch-up read.
import { agoText } from './freshness'
import { t } from './strings/en'
import type { PanelModel } from '../types'

export type Timer = { cancel(): void }

export type RefreshPorts = {
  now(): Promise<number>
  after(ms: number, fn: () => void): Timer
  every(ms: number, fn: () => void): Timer
  /** detect + provider.load; null = no plan; throws on failure. */
  load(): Promise<PanelModel | null>
  /** The detected provider's remote fingerprint; null = it has none; throws on failure. */
  fingerprint(): Promise<string | null>
  /** Last modification of a file or directory, null when missing. Never rejects. */
  mtime(path: string): Promise<number | null>
  run(
    argv: readonly string[],
    init?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string }>
  /** Writes the model to state (null = no plan): readers redraw. */
  publish(model: PanelModel | null): Promise<void>
  /** A redraw without a model change (the manual refresh's "checked …"). */
  invalidate(): Promise<void>
  /** `panel` is not off and the surface lists the pane as open and placed. A person's close removes it from that list. */
  isVisible(): Promise<boolean>
}

export type RefreshConfig = {
  /** The session root: where `git` runs, and what relative tool paths resolve against. */
  startDir: string
  /** `panel: off` is false here: nothing ever runs. */
  isEnabled: boolean
  /** 0 disables the poll. */
  fsPollSeconds: number
  /** 0 disables the poll. */
  prPollSeconds: number
  debounceMs?: number
}

export type ReadOutcome = {
  /** false when the read failed (the last model stays, with an error line). */
  ok: boolean
  /** The model after the read: the new one, or the last good one when it failed. */
  model: PanelModel | null
}

export type RefreshEngine = {
  /** The watched mtimes and git HEAD now: take it BEFORE a read and hand it to `seed`, so a write during the read is not swallowed. */
  snapshot(): Promise<Snapshot>
  /**
   * Adopts a model read elsewhere (session start, a provider action): hash and baselines, and any read in
   * flight drops its result. Returns it with `freshness`, to publish.
   */
  seed(model: PanelModel | null, before?: Snapshot): Promise<PanelModel | null>
  /** The pane drew at `now`: the engine remembers the "checked ..." text on screen. */
  noteRendered(now: number): void
  /** A trigger: debounced. Ignored (beyond re-evaluating visibility) while stopped. */
  request(reason: string): void
  /** An immediate, single-flight read: /panel, the Refresh button. `manual` also redraws. */
  readNow(options?: { manual?: boolean }): Promise<ReadOutcome>
  /** A tool call finished: re-reads when it touched the plan or ran aidlc/git/gh/glab. */
  toolCall(tool: string, input: Record<string, unknown>): void
  /** A surface attached: wake, check the remote, request a read. */
  attach(): Promise<void>
  /** Re-evaluates visibility; resumes when the pane is on screen. Cheap when running. */
  wake(): Promise<void>
  start(): Promise<void>
  /** Cancels every timer and pending debounce. */
  stop(): void
  isRunning(): boolean
  /** Epoch ms of the latest successful check, changed or not; 0 before any. */
  checkedAt(): number
  /**
   * Epoch ms of the latest time the engine read the clock (every poll tick, check and read); 0 before any. The
   * pane's "now" for its stamp: a render that read the clock itself would be redrawn by it, endlessly.
   */
  now(): number
}

export const DEBOUNCE_MS = 500
/**
 * A remote check that takes longer than this (a hung gh) counts as failed. Nothing waits on it (attach does
 * `void` it), so it is generous: the ledger's fingerprint is two 12 s commands in a row at worst.
 */
export const REMOTE_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 5000

// ── hashing ──────────────────────────────────────────────────────────────────

/** JSON with sorted keys and no `undefined`: equal values, equal text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`)
  }
  return `{${parts.join(',')}}`
}

/** cyrb53: a 53-bit string hash, as base-36 text. */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The model's identity for "did anything change": everything but `readAt` and `freshness`. */
export function modelHash(model: PanelModel): string {
  const { readAt: _readAt, freshness: _freshness, ...rest } = model
  return hashText(stableStringify(rest))
}

// ── tool-call classification ─────────────────────────────────────────────────

/** An absolute, normalised POSIX path: relative paths resolve against `base`, `.` and `..` fold. */
export function normalizePath(path: string, base: string): string {
  const full = path.startsWith('/') ? path : `${base}/${path}`
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const COMMANDS = ['aidlc', 'git', 'gh', 'glab']
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_C = /^-[a-zA-Z]*c[a-zA-Z]*$/

/** A command that runs another: the flags that take a value, and how many plain words it takes first. */
type Wrapper = { withValue: readonly string[]; positional?: number }
const NO_FLAGS: Wrapper = { withValue: [] }
const WRAPPERS: Record<string, Wrapper> = {
  env: { withValue: ['-u', '-C', '-S', '--unset', '--chdir'] },
  sudo: { withValue: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '--user', '--group'] },
  nice: { withValue: ['-n', '--adjustment'] },
  timeout: { withValue: ['-k', '-s', '--kill-after', '--signal'], positional: 1 },
  xargs: { withValue: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '-J', '--max-args', '--replace', '--delimiter'] },
  stdbuf: NO_FLAGS,
  nohup: NO_FLAGS,
  command: NO_FLAGS,
  builtin: NO_FLAGS,
  exec: NO_FLAGS,
  time: NO_FLAGS,
  npx: { withValue: ['-p', '--package'] },
  bunx: { withValue: ['-p', '--package'] },
  // Shell keywords that stand before a command.
  if: NO_FLAGS,
  then: NO_FLAGS,
  else: NO_FLAGS,
  elif: NO_FLAGS,
  do: NO_FLAGS,
  while: NO_FLAGS,
  until: NO_FLAGS,
  '!': NO_FLAGS,
}
// Package managers: `npm exec x`, `pnpm dlx x`, `npm run x`, `yarn x`, `bun x`: the word after is what runs.
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const RUNNER_VERBS = new Set(['exec', 'dlx', 'run', 'run-script', 'x'])

/** Past flags (and their values) and a bare `--`. */
function skipFlags(words: string[], from: number, withValue: readonly string[]): number {
  let i = from
  while (i < words.length) {
    const word = words[i] ?? ''
    if (word === '--') return i + 1
    if (!word.startsWith('-') || word === '-') return i
    i += withValue.includes(word) ? 2 : 1
  }
  return i
}

/** The command word of a simple command: past env assignments, wrappers and package runners. */
function commandWordOf(words: string[]): { word: string; rest: string[] } | null {
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (ASSIGNMENT.test(word)) {
      i++
      continue
    }
    const base = word.split('/').pop() ?? word
    const wrapper = Object.hasOwn(WRAPPERS, base) ? WRAPPERS[base] : undefined
    if (wrapper !== undefined) {
      i = skipFlags(words, i + 1, wrapper.withValue) + (wrapper.positional ?? 0)
      continue
    }
    if (RUNNERS.has(base)) {
      i = skipFlags(words, i + 1, [])
      if (RUNNER_VERBS.has(words[i] ?? '')) i = skipFlags(words, i + 1, [])
      continue
    }
    return { word: base, rest: words.slice(i + 1) }
  }
  return null
}

/** The index of the `)` closing the `(` at `open`, or the end of the text. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return text.length
}

/**
 * Every command word a shell line runs: the first word of each simple command, after
 * `&&`, `||`, `;`, `|`, `&`, `(`, `$(`, backticks and newlines, past env assignments and wrappers
 * (`FOO=1 env git`, `sudo -u bob git`, `timeout 30 git`, `xargs -n1 git`, `npx aidlc`, `pnpm exec gh`,
 * `npm run git`), inside `bash -c '...'` / `bash -lc ...`, and inside `$(...)` even in double quotes.
 * Quotes and comments are respected, so `echo "a && git b"` and `curl github.com` run neither.
 */
export function commandWordsOf(command: string, depth = 0): string[] {
  const found: string[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    const head = commandWordOf(words)
    words = []
    if (head === null) return
    found.push(head.word)
    if (SHELLS.has(head.word) && depth < 4) {
      const at = head.rest.findIndex(flag => SHELL_C.test(flag))
      const script = at >= 0 ? head.rest[at + 1] : undefined
      if (script !== undefined) found.push(...commandWordsOf(script, depth + 1))
    }
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '\\' && i + 1 < command.length) word += command[++i] ?? ''
      else if (c === '"') quote = null
      else if (c === '$' && command[i + 1] === '(' && depth < 4) {
        const close = closingParen(command, i + 1)
        found.push(...commandWordsOf(command.slice(i + 2, close), depth + 1))
        i = close
      } else if (c === '`' && depth < 4) {
        const close = command.indexOf('`', i + 1)
        const end = close < 0 ? command.length : close
        found.push(...commandWordsOf(command.slice(i + 1, end), depth + 1))
        i = end
      } else word += c
    } else if (c === '\\') {
      if (i + 1 < command.length) {
        word += command[++i] ?? ''
        hasWord = true
      }
    } else if (c === "'" || c === '"') {
      quote = c
      hasWord = true
    } else if (c === '#' && !hasWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (c === '$' && command[i + 1] === '(') {
      endCommand()
      i++
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`' || c === '\n') {
      endCommand()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()
  return found
}

/** True when a shell line runs `aidlc`, `git`, `gh` or `glab` as a command. */
export function runsPlanCommand(command: string): boolean {
  return commandWordsOf(command).some(word => COMMANDS.includes(word))
}

/**
 * Whether a finished tool call is worth a re-read: a file tool that wrote a watched path
 * (or anything under a watched directory), or a shell line that ran aidlc, git, gh or glab.
 * `input` is the tool's arguments (`file_path`, `notebook_path`, `command`).
 */
export function isRelevantToolCall(
  tool: string,
  input: Record<string, unknown>,
  watch: readonly string[],
  startDir: string,
): boolean {
  if (tool === 'Bash') return typeof input['command'] === 'string' && runsPlanCommand(input['command'])
  if (!FILE_TOOLS.has(tool)) return false
  const raw = tool === 'NotebookEdit' ? input['notebook_path'] : input['file_path']
  if (typeof raw !== 'string' || raw === '') return false
  const path = normalizePath(raw, startDir)
  return watch.some(entry => {
    if (entry === '') return false
    const target = normalizePath(entry, startDir)
    return path === target || path.startsWith(target === '/' ? '/' : `${target}/`)
  })
}

// ── the engine ───────────────────────────────────────────────────────────────

/** mtimes of the watched paths and the git HEAD signature, as of one moment. */
export type Snapshot = { mtimes: Map<string, number | null>; head: string }

export function createRefreshEngine(ports: RefreshPorts, config: RefreshConfig): RefreshEngine {
  const debounceMs = config.debounceMs ?? DEBOUNCE_MS
  const fsMs = config.fsPollSeconds > 0 ? config.fsPollSeconds * 1000 : 0
  const prMs = config.prPollSeconds > 0 ? config.prPollSeconds * 1000 : 0
  const noop = () => undefined

  // What is published, and what it was read from.
  let last: PanelModel | null = null
  let lastHash: string | null = null
  let publishedError: string | undefined
  let lastCheckedAt = 0
  /** The latest clock reading, for the pane's stamp (see `now()`). */
  let lastNowAt = 0
  let isPlanFailing = false
  let isRemoteFailing = false
  /** The failed remote check's own line (a forge error carries one); '' = the generic one. */
  let remoteErrorText = ''
  /** The last non-empty watch list: a plan that went away is polled for its return. */
  let knownWatch: string[] = []
  /** The "checked ..." text on screen, so a tick redraws only when it would change. */
  let drawnText = ''

  // Baselines taken around every successful read.
  let watchBase = new Map<string, number | null>()
  let headBase = ''
  let fingerprintBase: string | undefined
  /** A fingerprint seen to differ: adopted as the baseline only once a read that started after it succeeds. */
  let pendingFingerprint: { value: string; afterSeq: number } | null = null
  /** false once the provider answered "no fingerprint": no remote timer until a read re-detects one. */
  let hasFingerprint = true

  // Lifecycle. `generation` moves on seed, stop and adopt: work that started before drops its results.
  let generation = 0
  let startedReads = 0
  let isRunning = false
  let isStarting = false
  let isStale = true
  let isTicking = false
  let isCheckingRemote = false
  let remoteToken = 0
  let fsTimer: Timer | null = null
  let remoteTimer: Timer | null = null
  let remoteKick: Timer | null = null
  let debounceTimer: Timer | null = null

  // Single flight.
  let current: Promise<void> | null = null
  let isQueued = false
  let queuedGeneration = 0
  let outcome: ReadOutcome = { ok: true, model: null }

  const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run()
    } catch {
      return fallback
    }
  }

  const watchList = (): string[] => (last !== null && last.watch.length > 0 ? last.watch : knownWatch)

  function currentError(): string | undefined {
    const text = isPlanFailing ? t('refresh.failed') : isRemoteFailing ? remoteErrorText || t('refresh.remoteFailed') : ''
    return text === '' ? undefined : text
  }

  const withFreshness = (model: PanelModel, checkedAt: number, error: string | undefined): PanelModel => ({
    ...model,
    freshness: error === undefined ? { checkedAt } : { checkedAt, error },
  })

  // ── baselines ──

  async function statAll(paths: readonly string[]): Promise<Map<string, number | null>> {
    const entries = await Promise.all(paths.map(async path => [path, await safe(() => ports.mtime(path), null)] as const))
    return new Map(entries)
  }

  /** The git HEAD signature: sha and branch; '' when there is no git (a normal case, never an error). */
  async function headSignature(): Promise<string> {
    const ask = (argv: readonly string[]) =>
      safe(async () => {
        const ran = await ports.run(argv, { cwd: config.startDir, timeoutMs: GIT_TIMEOUT_MS })
        return ran.exitCode === 0 ? ran.stdout.trim() : ''
      }, '')
    const [sha, branch] = await Promise.all([ask(['git', 'rev-parse', 'HEAD']), ask(['git', 'branch', '--show-current'])])
    return sha === '' && branch === '' ? '' : `${sha}|${branch}`
  }

  async function snapshot(): Promise<Snapshot> {
    if (!config.isEnabled) return { mtimes: new Map(), head: '' }
    const [mtimes, head] = await Promise.all([statAll(watchList()), headSignature()])
    return { mtimes, head }
  }

  /** Baselines for `paths`: the snapshot's mtimes where it has them, a stat now for the rest. */
  async function baseline(paths: readonly string[], before: Snapshot): Promise<void> {
    const extra = await statAll(paths.filter(path => !before.mtimes.has(path)))
    watchBase = new Map(paths.map(path => [path, before.mtimes.has(path) ? (before.mtimes.get(path) ?? null) : (extra.get(path) ?? null)]))
    headBase = before.head
  }

  async function hasFsChanged(): Promise<boolean> {
    const now = await snapshot()
    if (now.head !== headBase) return true
    if (now.mtimes.size !== watchBase.size) return true
    for (const [path, mtime] of now.mtimes) if (watchBase.get(path) !== mtime) return true
    return false
  }

  // ── publishing ──

  /** The error line changed without a new model (a failed read, a recovered remote): republish the last one. */
  async function syncError(): Promise<void> {
    const error = currentError()
    if (last === null || error === publishedError) return
    const next = withFreshness(last, last.freshness?.checkedAt ?? lastCheckedAt, error)
    try {
      await ports.publish(next)
      last = next
      publishedError = error
    } catch {
      // Not written: the next change tries again.
    }
  }

  /** Reads the clock (`fallback` when it fails) and remembers the reading for the pane's stamp. */
  async function clockNow(fallback: number): Promise<number> {
    const now = await safe(() => ports.now(), fallback)
    lastNowAt = Math.max(lastNowAt, now)
    return now
  }

  /**
   * A check that found nothing to do still counts: the stamp moves, and the pane redraws only if its text would.
   * While the plan fails to read nothing is checked, but the time still moves: the stamp ages ("checked 30s ago").
   */
  async function markChecked(): Promise<void> {
    const now = await clockNow(lastCheckedAt)
    if (!isPlanFailing) lastCheckedAt = now
    const text = agoText(now, lastCheckedAt)
    if (text === drawnText) return
    drawnText = text
    await safe(() => ports.invalidate(), undefined)
  }

  async function doRead(): Promise<void> {
    const gen = generation
    const seq = ++startedReads
    // Baselines first: a write that lands during the load is then seen by the next poll, not swallowed.
    const before = await snapshot()

    let model: PanelModel | null
    try {
      model = await ports.load()
    } catch {
      if (gen !== generation) return
      isPlanFailing = true
      await syncError()
      outcome = { ok: false, model: last }
      return
    }
    if (gen !== generation) return

    const paths = model !== null && model.watch.length > 0 ? model.watch : knownWatch
    await baseline(paths, before)
    if (gen !== generation) return

    isPlanFailing = false
    // A read just took fresh baselines: a resume right after it has nothing to catch up on.
    isStale = false
    if (model !== null && model.watch.length > 0) knownWatch = model.watch
    const now = await clockNow(model?.readAt ?? lastCheckedAt)
    lastCheckedAt = now
    if (pendingFingerprint !== null && seq > pendingFingerprint.afterSeq) {
      fingerprintBase = pendingFingerprint.value
      pendingFingerprint = null
    }
    if (!hasFingerprint && isRunning) {
      // A fresh read may have found a provider with a remote.
      hasFingerprint = true
      kickRemote()
    }

    const hash = model === null ? '' : modelHash(model)
    const error = model === null ? undefined : currentError()
    if (hash !== lastHash || error !== publishedError) {
      const next = model === null ? null : withFreshness(model, now, error)
      try {
        await ports.publish(next)
        last = next
        lastHash = hash
        publishedError = error
      } catch {
        // Not written: the next read tries again.
      }
    }
    outcome = { ok: true, model: last }
  }

  // ── single flight ──

  async function pump(): Promise<void> {
    try {
      do {
        isQueued = false
        await doRead()
        // A follow-up queued before a stop or a seed belongs to a world that is gone.
      } while (isQueued && queuedGeneration === generation)
    } finally {
      current = null
    }
  }

  /** Runs a read, or queues exactly one follow-up behind the one running. Resolves with the last read's outcome. */
  async function schedule(): Promise<ReadOutcome> {
    if (current !== null) {
      isQueued = true
      queuedGeneration = generation
    } else current = pump()
    await current
    return outcome
  }

  function cancelDebounce(): void {
    debounceTimer?.cancel()
    debounceTimer = null
  }

  // ── polls ──

  async function visible(): Promise<boolean> {
    // A failing visibility check does not stop a running engine.
    return safe(() => ports.isVisible(), true)
  }

  async function fsTick(): Promise<void> {
    if (!isRunning || isTicking) return
    isTicking = true
    const gen = generation
    try {
      if (!(await visible())) {
        engine.stop()
        return
      }
      if (!isRunning || gen !== generation) return
      if (await hasFsChanged()) engine.request('fs')
      else await markChecked()
    } finally {
      isTicking = false
    }
  }

  /** A fingerprint that outlasts REMOTE_TIMEOUT_MS (a hung gh) counts as a failure. */
  function guarded<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = ports.after(REMOTE_TIMEOUT_MS, () => reject(new Error('remote check timed out')))
      work.then(
        value => {
          timer.cancel()
          resolve(value)
        },
        error => {
          timer.cancel()
          reject(error)
        },
      )
    })
  }

  function ensureRemoteTimer(): void {
    if (!isRunning || prMs === 0 || remoteTimer !== null) return
    try {
      remoteTimer = ports.every(prMs, () => void remoteTick().catch(noop))
    } catch {
      remoteTimer = null
    }
  }

  /** Runs the remote check on the next turn of the clock, never inside whatever dispatch woke the engine. */
  function kickRemote(): void {
    remoteKick?.cancel()
    try {
      remoteKick = ports.after(0, () => {
        remoteKick = null
        void checkRemote().catch(noop)
      })
    } catch {
      remoteKick = null
    }
  }

  /** Resolves true when the check itself worked (whatever it found). */
  async function checkRemote(): Promise<boolean> {
    if (isCheckingRemote) return false
    isCheckingRemote = true
    const token = ++remoteToken
    const gen = generation
    try {
      let fingerprint: string | null
      try {
        fingerprint = await guarded(ports.fingerprint())
      } catch (error) {
        if (gen !== generation) return false
        isRemoteFailing = true
        // A provider's error may carry the finished line (the forge layer names the cause); anything else gets the generic one.
        const display = (error as { display?: unknown } | null)?.display
        remoteErrorText = typeof display === 'string' ? display : ''
        hasFingerprint = true
        ensureRemoteTimer()
        await syncError()
        return false
      }
      if (gen !== generation) return false
      isRemoteFailing = false
      remoteErrorText = ''
      if (fingerprint === null) {
        // No remote state: nothing to poll until a read finds a provider that has some.
        hasFingerprint = false
        remoteTimer?.cancel()
        remoteTimer = null
        await syncError()
        return true
      }
      hasFingerprint = true
      ensureRemoteTimer()
      const before = fingerprintBase
      if (before === undefined && last !== null) fingerprintBase = fingerprint
      else if (before !== fingerprint) {
        // Adopted as the baseline only when a read that starts now has succeeded.
        pendingFingerprint = { value: fingerprint, afterSeq: startedReads }
        engine.request('remote')
        return true
      }
      await syncError()
      return true
    } finally {
      if (token === remoteToken) isCheckingRemote = false
    }
  }

  async function remoteTick(): Promise<void> {
    if (!isRunning) return
    if (!(await visible())) {
      engine.stop()
      return
    }
    if (isRunning && (await checkRemote())) await markChecked()
  }

  // ── the engine ──

  const engine: RefreshEngine = {
    snapshot,

    async seed(model, before) {
      if (!config.isEnabled) return model
      generation++
      const now = await clockNow(model?.readAt ?? 0)
      lastCheckedAt = now
      last = model === null ? null : withFreshness(model, now, undefined)
      lastHash = model === null ? '' : modelHash(model)
      publishedError = undefined
      if (model !== null && model.watch.length > 0) knownWatch = model.watch
      await baseline(model !== null && model.watch.length > 0 ? model.watch : knownWatch, before ?? (await snapshot()))
      isStale = false
      return last
    },

    request(_reason) {
      if (!config.isEnabled) return
      if (!isRunning) {
        void engine.wake().catch(noop)
        return
      }
      // A read is already due and will see everything written so far; pushing it out would starve it under a burst.
      if (debounceTimer !== null) return
      debounceTimer = ports.after(debounceMs, () => {
        debounceTimer = null
        if (isRunning) void schedule().catch(noop)
      })
    },

    async readNow(options) {
      if (!config.isEnabled) return { ok: true, model: last }
      cancelDebounce()
      const result = await schedule()
      if (options?.manual === true) await safe(() => ports.invalidate(), undefined)
      return result
    },

    toolCall(tool, input) {
      if (!config.isEnabled) return
      if (isRelevantToolCall(tool, input, watchList(), config.startDir)) engine.request('tool')
    },

    noteRendered(now) {
      drawnText = agoText(now, lastCheckedAt)
    },

    async attach() {
      if (!config.isEnabled) return
      await engine.wake()
      if (!isRunning) return
      // A hung gh must not hold the attach.
      void checkRemote().catch(noop)
      engine.request('attach')
    },

    async wake() {
      if (!config.isEnabled || isRunning) return
      await engine.start()
    },

    async start() {
      if (!config.isEnabled || isRunning || isStarting) return
      isStarting = true
      const gen = generation
      let isShown = false
      try {
        isShown = await safe(() => ports.isVisible(), false)
      } finally {
        isStarting = false
      }
      // A stop (or a seed) that came while the pane was being looked at wins.
      if (gen !== generation || isRunning) return
      if (!isShown) {
        isStale = true
        return
      }
      try {
        if (fsMs > 0) fsTimer = ports.every(fsMs, () => void fsTick().catch(noop))
      } catch {
        fsTimer = null
        return
      }
      isRunning = true
      if (isStale) {
        isStale = false
        engine.request('resume')
      }
      if (prMs > 0 && hasFingerprint) kickRemote()
    },

    stop() {
      isRunning = false
      isStale = true
      isQueued = false
      generation++
      remoteToken++
      isCheckingRemote = false
      fsTimer?.cancel()
      remoteTimer?.cancel()
      remoteKick?.cancel()
      fsTimer = null
      remoteTimer = null
      remoteKick = null
      cancelDebounce()
    },

    isRunning: () => isRunning,
    checkedAt: () => lastCheckedAt,
    now: () => lastNowAt,
  }
  return engine
}
