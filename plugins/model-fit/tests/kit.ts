import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * What asking a model directly comes back as: an answer, no text, a timeout, an API error (status
 * and kind), or the engine refusing to send it (blocked by the allowlist, or for another reason).
 */
export type ProbeOutcome = 'ok' | 'empty' | 'aborted' | 'blocked' | 'reject' | { status: number | null; error: string }

export type World = {
  model: string
  tokens?: number
  /** What the classifier replies, in order; the last repeats. A string is the reply's text, null is "not answered". */
  replies: (string | null | (string | null)[])[]
  /** What the person answers when asked: a label, or null to dismiss. */
  answer: string | null
  hasModelCommand: boolean
  /** The engine's `availableModels` setting. */
  availableModels?: string[]
  /**
   * What asking a model directly (the availability probe) comes back as, by full model id:
   * an answer, an HTTP status, a timeout, or a refusal by the engine. Unlisted models answer.
   */
  probes?: Record<string, ProbeOutcome>
  /** Reading the clock fails. */
  clockThrows?: boolean
  /** Reading the settings fails. */
  settingsThrow?: boolean
  /** The clock, in ms. */
  now?: number
  /** Surfaces the session draws on; none is a plain `claude -p` run. */
  surfaces: ('terminal' | 'desktop' | 'vscode' | 'mobile')[]
  /** Tool results the conversation holds, oldest first; the plugin reads them back with `$.session.messages()`. */
  toolResults?: (string | { text: string; isError?: true; tool?: string; input?: Record<string, unknown>; orphan?: true })[]
  /** Stopping the turn is refused. */
  abortThrows?: boolean
  /** The turn the engine considers running: `turn.abort` of any other id is refused. */
  runningTurn?: string
  /** What the person has typed in the prompt box. */
  draft?: string
  /** What the prompt box does with a fill: takes it, refuses it, or the call itself fails. */
  fill?: 'filled' | 'refused' | 'throws'
  /** `/model` is listed but fails when run. */
  commandRejects?: boolean
  /** Another plugin drops the prompt beneath ours. */
  dropPrompt?: boolean
  /** What the plugin's store holds when the session starts. */
  store?: Record<string, unknown>
  /** The engine fails to say which model the session runs. */
  modelThrows?: boolean
  /** Environment variables the plugin can read. */
  env?: Record<string, string>
  /** The classifier call itself fails (the engine refuses it) instead of answering. */
  classifierThrows?: boolean
  /** Runs while the dialog is up, before the person answers: where a test draws it. */
  whileAsking?: (questions: readonly unknown[]) => Promise<void>
}

/** Calls per classification. */
export const VOTES = 3
export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'
export const FABLE = 'claude-fable-5-1'
export const HAIKU = 'claude-haiku-5-5'

const RESOLVED: Record<string, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS, fable: FABLE }

export function newWorld(overrides: Partial<World> = {}): World {
  return { model: SONNET, replies: ['{"tier":"sonnet","enough":true,"reason":"ordinary work"}'], answer: null, hasModelCommand: true, surfaces: ['terminal'], ...overrides }
}

export const verdict = (tier: string, reason = 'a reason', enough = true) => JSON.stringify({ tier, enough, reason })

/** The classifier cannot judge the scope from what it was shown. */
export const unsure = (tier = 'sonnet') => verdict(tier, 'points at a file not shown', false)

/** Everything beneath the plugin: the engine's answers, recorded. */
export function mountWorld(on: On, world: World) {
  let running = 0
  let lastStatus: string | undefined
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))
  const seen = {
    /** Classifications made (each is three calls). */
    completes: 0,
    classifierCalls: 0,
    peakParallel: 0,
    classifierPrompts: [] as string[],
    asked: [] as { question: string; header?: string; options: string[] }[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    commands: [] as { command: string; args: string }[],
    submitted: [] as { text: string; context?: readonly string[] }[],
    store,
    steps: [] as { model: string; agentId?: string; effort?: unknown }[],
    probes: [] as string[],
    /** The request of each probe, and the status line showing while it ran. */
    probeRequests: [] as { model: string; maxTokens?: number; effort?: string; status: string | undefined }[],
    aborts: [] as string[],
    order: [] as string[],
    fills: [] as { text: string; mode: string }[],
    stateWrites: [] as [string, unknown][],
    drawn: [] as { questions: unknown[] }[],
  }

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: world.env?.[e.name] }))
  on('prompt.fill', (_, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })

    if (world.fill === 'throws') throw new Error('no prompt box')

    return world.fill === 'refused' ? { isFilled: false, refusal: 'no_composer' as const } : { isFilled: true }
  })
  on('turn.abort', (_, e) => {
    seen.aborts.push(e.turnId)

    if (world.abortThrows === true) throw new Error('not the running turn')
    if (world.runningTurn !== undefined && e.turnId !== world.runningTurn) throw new Error(`turn ${e.turnId} is not the running turn ${world.runningTurn}`)

    return { value: undefined }
  })
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'the prompt', toolUses: [] },
      ...(world.toolResults ?? []).flatMap((entry, i) => {
        const result = typeof entry === 'string' ? { text: entry } : entry
        const error = result.isError === true ? { isError: true as const } : {}
        const call = { tool: result.tool ?? 'Read', input: result.input ?? {} }

        // An orphan is a result whose assistant row, with the call, is not in the conversation.
        const callRow = { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: `use-${i}`, ...call, text: result.text, ...error }] }

        return [
          ...(result.orphan === true ? [] : [callRow]),
          { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: `use-${i}`, text: result.text, isError: result.isError === true }] },
        ]
      }),
    ],
  }))
  on('prompt.read', () => ({ value: { text: world.draft ?? '', cursor: (world.draft ?? '').length } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('state.set', (_, e, next) => {
    seen.stateWrites.push([e.key, e.value])

    return next(e)
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => {
    if (world.modelThrows === true) throw new Error('no model to report')

    return { value: world.model }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, ...(world.tokens === undefined ? {} : { tokens: world.tokens }) },
      rateLimits: [],
    },
  }))
  on('settings.read', () => {
    if (world.settingsThrow === true) throw new Error('settings unreadable')

    return { value: world.availableModels === undefined ? {} : { availableModels: world.availableModels } }
  })
  on('clock.now', () => {
    if (world.clockThrows === true) throw new Error('no clock')

    return { value: world.now ?? 0 }
  })
  on('model.complete', async (_, e) => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

    // Anything but the classifier (which asks for `haiku`) is an availability probe.
    if (e.model !== 'haiku') {
      seen.probes.push(e.model)
      seen.probeRequests.push({
        model: e.model,
        ...(e.maxTokens === undefined ? {} : { maxTokens: e.maxTokens }),
        ...(e.effort === undefined ? {} : { effort: e.effort }),
        status: lastStatus,
      })
      const outcome = world.probes?.[e.model] ?? 'ok'

      if (outcome === 'blocked') return { deny: 'model is not allowed by the availableModels setting' }
      if (outcome === 'reject') return { deny: 'maxTokens is out of range' }
      if (outcome === 'aborted') return { value: { isAnswered: false as const, reason: 'aborted' as const, usage } }
      if (outcome === 'empty') return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
      if (typeof outcome === 'object') {
        return {
          value: {
            isAnswered: false as const,
            reason: 'api-error' as const,
            status: outcome.status,
            // The kit's error kinds are plain strings; the engine's type names the real ones.
            error: outcome.error as 'unknown',
            usage,
          },
        }
      }

      return { value: { isAnswered: true as const, text: 'ok', usage } }
    }

    // A classification is three calls at once: call n belongs to classification floor(n / 3), and
    // the reply entry for it is one reply for all three, or a list of three.
    const call = seen.classifierCalls
    const group = Math.floor(call / VOTES)

    seen.classifierCalls += 1
    seen.completes = group + 1
    if (call % VOTES === 0) seen.classifierPrompts.push(e.prompt)

    running += 1
    seen.peakParallel = Math.max(seen.peakParallel, running)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    running -= 1

    if (world.classifierThrows === true) throw new Error('the engine refused the request')

    const entry = world.replies[Math.min(group, world.replies.length - 1)] ?? null
    const reply = Array.isArray(entry) ? (entry[call % VOTES] ?? null) : entry

    return {
      value: reply === null ? { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage } : { isAnswered: true as const, text: reply, usage },
    }
  })
  on('ui.status', (_, e) => {
    lastStatus = e.text
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('command.list', () => ({
    value: world.hasModelCommand
      ? [{ name: 'model', description: 'Set the model', source: 'builtin' as const }]
      : [{ name: 'help', description: 'Help', source: 'builtin' as const }],
  }))
  on('command.run', (_, e) => {
    seen.commands.push({ command: e.command, args: e.args })

    if (world.commandRejects === true) throw new Error('/model failed')

    // `/model <alias>` really switches the session, as the engine does.
    if (e.command === 'model') world.model = RESOLVED[e.args] ?? e.args

    return {}
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
    const q = e.questions[0]
    seen.order.push('ask')
    seen.asked.push({ question: q?.question ?? '', header: q?.header, options: (q?.options ?? []).map(o => o.label) })

    await world.whileAsking?.(e.questions)

    if (world.answer === null) return { deny: 'dismissed' }

    return { result: { questions: e.questions, answers: { [q?.question ?? '']: world.answer } } }
  })
  on('prompt.submit', (_, e) => {
    seen.submitted.push({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) })

    if (world.dropPrompt === true) return { drop: 'blocked by another plugin' }

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })

  on('turn.step', async function* (_, e) {
    seen.order.push('step')
    seen.steps.push({
      model: e.model,
      ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
      ...('effort' in e ? { effort: e.effort } : {}),
    })

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AskUserQuestion' }, (_, e) => {
    seen.drawn.push({ questions: e.props.questions })

    return { type: 'Box' as const }
  })

  return seen
}

export const composer = { kind: 'composer' } as const

type Origin = { kind: 'composer' } | { kind: 'sdk' } | { kind: 'bridge' } | { kind: 'task-notification' } | { kind: 'scheduled-trigger' }

export async function submit($: Engine, text: string, origin: Origin = composer, turnId?: string) {
  return $.prompt.submit({ text, wait: false, origin, ...(turnId === undefined ? {} : { turnId }) })
}

type Where = { agentId?: string; turnId?: string; index?: number; messageCount?: number }

/** One model request of a turn (turn-1 unless said), main loop unless an agent id is given. */
export async function step($: Engine, model: string, where: Where & { effort?: 'low' | 'high' } = {}): Promise<void> {
  const stream = $.turn.step({
    turnId: where.turnId ?? 'turn-1',
    index: where.index ?? 0,
    model,
    messageCount: where.messageCount ?? 1,
    ...(where.effort === undefined ? {} : { effort: where.effort }),
    ...(where.agentId === undefined ? {} : { agentId: where.agentId }),
  })

  for await (const chunk of stream) void chunk
}

export async function endTurn($: Engine, where: Where = {}): Promise<void> {
  await $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: where.turnId ?? 'turn-1',
    reason: 'answer',
    ...(where.agentId === undefined ? {} : { agentId: where.agentId }),
  })
}

/** The engine starts a turn: the plugin learns its id. */
export async function startTurn($: Engine, turnId = 'turn-1'): Promise<void> {
  await $.turn.start({ text: 'the prompt', turnId })
}

/** Lets work a hook left running unawaited (a queued `/model`) finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
