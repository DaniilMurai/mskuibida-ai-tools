import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import type { ModelFitAlias, ModelFitPending, ModelFitRoute } from '../types'
import {
  AVAILABILITY_TTL_MS,
  CLASSIFIER_SYSTEM,
  CLASSIFIER_VOTES,
  UNAVAILABLE_TTL_MS,
  MAX_CARRIED_TURNS,
  MAX_RECHECKS,
  aliasOfTier,
  buildClassifierPrompt,
  capTier,
  decide,
  describeToolUse,
  displayName,
  hashTexts,
  judgeProbe,
  judgeProbeRejection,
  listedIn,
  modelIdFor,
  parseVerdict,
  reachableTier,
  selectResults,
  tierOfModel,
  vote,
} from './classify'
import type { FitTier, ToolResult, Verdict } from './classify'
import * as copy from './copy'

// Tuning. The cost-aware thresholds (what counts as a large context, how big a
// gap earns a switch there, where switching stops altogether) live in classify.ts
// beside the arithmetic they feed.
const MIN_TEXT_CHARS = 12
const MAX_ATTEMPTS = 3
const CLASSIFIER_MAX_TOKENS = 120
const CLASSIFIER_TIMEOUT_MS = 8_000
const RECENT_SESSIONS_CAP = 100
const RECENT_SESSIONS_KEY = 'checkedSessions'
// A prompt that grew the session's recheck text is kept to this many characters.
const MAX_RECHECK_TEXT_CHARS = 8_000
// A prompt the person sent from a terminal, a remote client or the desktop app (which hosts its sessions through the SDK).
// A probe is one token to the model asked about; it is given this long to answer.
const PROBE_TIMEOUT_MS = 8_000
// Room for a reply, so a model that always thinks cannot fail the probe on its thinking budget.
const PROBE_MAX_TOKENS = 16
const AVAILABILITY_KEY = 'availability'
// `highestModel` from the manifest's userConfig, set when the module registers.
let highestModel = 'auto'
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk']
// `/compact`, `/model:set`: a slash command. `/Users/x/foo.ts` is a path, and a task.
const SLASH_COMMAND = /^\/[\w:-]+$/

const checked = atom({ plugin: 'model-fit', key: 'checked' } as const, false)
const attempts = atom({ plugin: 'model-fit', key: 'attempts' } as const, 0)
const inFlightRef = { plugin: 'model-fit', key: 'inFlight' } as const
const inFlight = atom(inFlightRef, false)
const pending = atom({ plugin: 'model-fit', key: 'pending' } as const, null)
const route = atom({ plugin: 'model-fit', key: 'route' } as const, null)
const recheck = atom({ plugin: 'model-fit', key: 'recheck' } as const, null)
const rechecks = atom({ plugin: 'model-fit', key: 'rechecks' } as const, 0)
const runningTurn = atom({ plugin: 'model-fit', key: 'runningTurn' } as const, null)

async function wasCheckedBefore($: EngineInterface): Promise<boolean> {
  try {
    const recent = await $.store.get(RECENT_SESSIONS_KEY)

    return Array.isArray(recent) && recent.includes(await $.session.id())
  } catch {
    return false
  }
}

// Once per session, and once across a resume: the state dies with the session,
// the store's short list of recent ids is what a resumed one is matched against.
async function markChecked($: EngineInterface): Promise<void> {
  await update($, checked, () => true)

  try {
    const recent = await $.store.get(RECENT_SESSIONS_KEY)
    const list: unknown[] = Array.isArray(recent) ? recent : []

    await $.store.set(RECENT_SESSIONS_KEY, [...list, await $.session.id()].slice(-RECENT_SESSIONS_CAP))
  } catch {
    // Without the store a resumed session is simply checked again.
  }
}

// Only one check at a time: the first prompt claims the flag, any other passes straight through.
async function claimCheck($: EngineInterface): Promise<boolean> {
  const held = await $.state.get(inFlightRef)

  if (held.value === true) return false

  return (await $.state.set(inFlightRef, true, { ifVersion: held.version })).isSet
}

// The id the engine would resolve the alias to: the person's ANTHROPIC_DEFAULT_*_MODEL
// override first, else the table. Each name is a literal, as `$.env.get` requires.
async function resolveModelId($: EngineInterface, alias: ModelFitAlias): Promise<string> {
  let override: string | undefined

  try {
    switch (alias) {
      case 'haiku':
        override = await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')
        break
      case 'sonnet':
        override = await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')
        break
      case 'opus':
        override = await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')
        break
      case 'fable':
        override = await $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL')
        break
    }
  } catch {
    override = undefined
  }

  return override !== undefined && override.trim() !== '' ? override.trim() : modelIdFor(alias)
}

type Availability = Record<string, { ok: boolean; at: number }>

// One short question to the model itself says whether this plan can use it; judgeProbe reads the
// reply (only a clear answer about the model is definite and worth remembering). The status line
// is up while it waits.
async function probeModel($: EngineInterface, modelId: string): Promise<{ ok: boolean; isDefinite: boolean }> {
  $.ui.status(copy.checking)

  try {
    const answer = await $.model.complete({
      model: modelId,
      prompt: 'ok',
      maxTokens: PROBE_MAX_TOKENS,
      effort: 'low',
      timeoutMs: PROBE_TIMEOUT_MS,
    })

    return judgeProbe(answer)
  } catch (error) {
    return judgeProbeRejection(error instanceof Error ? error.message : String(error))
  } finally {
    $.ui.status(undefined)
  }
}

// Only `auto` asks the model. The answer is kept per model id (the engine exposes no account to key
// it by): a yes for a day, a no for an hour, and nothing at all for an answer that is not about the
// model. A clock that cannot be read means nothing in the cache can be trusted, and nothing is written.
async function isAvailable($: EngineInterface, modelId: string): Promise<boolean> {
  let cache: Availability = {}
  let now: number | undefined

  try {
    const stored = await $.store.get(AVAILABILITY_KEY)

    cache = typeof stored === 'object' && stored !== null ? (stored as Availability) : {}
  } catch {
    cache = {}
  }

  try {
    now = await $.clock.now()
  } catch {
    now = undefined
  }

  const known = cache[modelId]

  if (known !== undefined && now !== undefined && now > 0 && now - known.at < (known.ok ? AVAILABILITY_TTL_MS : UNAVAILABLE_TTL_MS)) {
    return known.ok
  }

  const result = await probeModel($, modelId)

  if (result.isDefinite && now !== undefined && now > 0) {
    try {
      await $.store.set(AVAILABILITY_KEY, { ...cache, [modelId]: { ok: result.ok, at: now } })
    } catch {
      // Without the store the next check simply asks again.
    }
  }

  return result.ok
}

// Whether the person can use a tier: under their `highestModel` cap, on the engine's own
// `availableModels` allowlist (haiku too), and (in `auto` only) answering when asked. Haiku itself
// is never probed: the classifier runs on it.
async function isAllowed($: EngineInterface, tier: FitTier): Promise<boolean> {
  if (tier > capTier(highestModel)) return false

  const alias = aliasOfTier(tier)
  const modelId = await resolveModelId($, alias)

  try {
    if (!listedIn(alias, modelId, (await $.settings.read()).availableModels)) return false
  } catch {
    // Settings that cannot be read are no allowlist.
  }

  return highestModel === 'auto' && tier > 0 ? isAvailable($, modelId) : true
}

async function contextTokens($: EngineInterface): Promise<number> {
  try {
    return (await $.session.usage()).context.tokens ?? 0
  } catch {
    return 0
  }
}

// A classification is CLASSIFIER_VOTES cheap Haiku calls at once, the majority deciding. A call
// that fails or does not parse is just a vote that did not count; undefined means none did.
async function classify($: EngineInterface, prompt: string): Promise<Verdict | undefined> {
  $.ui.status(copy.checking)

  const ask = async (): Promise<Verdict | undefined> => {
    try {
      const answer = await $.model.complete({
        model: 'haiku',
        system: CLASSIFIER_SYSTEM,
        prompt,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        effort: 'low',
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
      })

      return answer.isAnswered ? parseVerdict(answer.text) : undefined
    } catch {
      return undefined
    }
  }

  try {
    return vote(await Promise.all(Array.from({ length: CLASSIFIER_VOTES }, ask)))
  } finally {
    $.ui.status(undefined)
  }
}

// The person's answer: true only for the Switch label. A rejection (dismissed, no
// dialog in this host) and free text under "Other" are both Stay.
async function askToSwitch($: EngineInterface, question: ModelFitPending, header: string): Promise<boolean> {
  await update($, pending, () => question)

  try {
    const [switchOption, stayOption] = question.options.map(option => option.label)
    const answer = await $.ui.ask(question.question, { header, options: [switchOption ?? '', stayOption ?? ''] })

    return answer === switchOption
  } catch {
    return false
  } finally {
    await update($, pending, held => (held !== null && held.question === question.question ? null : held)).catch(
      () => undefined,
    )
  }
}

// What the person chose once the verdict was in. `stay`: it fits, a switch is not worth it now,
// or they said Stay. `switch`: they chose it; the caller makes it happen, which differs by host
// and by whether this is the prompt (before the turn) or a step (mid-turn).
type Choice =
  | { kind: 'stay' }
  | { kind: 'switch'; target: ModelFitAlias; targetId: string; targetName: string; currentName: string; isDown: boolean }

// Toasts the fit, holds a mismatch the cost rule does not want, or asks. Shared by the prompt's
// check and the rechecks, so both show the same words and the same window.
async function chooseModel(
  $: EngineInterface,
  currentModel: string,
  currentTier: FitTier,
  verdict: Extract<Verdict, { kind: 'task' }>,
): Promise<Choice> {
  const currentName = displayName(currentModel)
  const tokens = await contextTokens($)
  const decision = decide(currentTier, verdict.tier, tokens)

  if (decision === 'fits') {
    $.ui.toast(copy.fits(currentName))

    return { kind: 'stay' }
  }

  if (decision === 'hold') {
    $.ui.toast(copy.holding(currentName))

    return { kind: 'stay' }
  }

  // The classifier's tier may be one this person cannot use: the nearest usable tier between
  // theirs and that one is what is offered, and nothing usable there means the model fits.
  const tier = await reachableTier(verdict.tier, currentTier, wanted => isAllowed($, wanted))

  if (tier === currentTier) {
    $.ui.toast(copy.bestAvailable(currentName))

    return { kind: 'stay' }
  }

  if (decide(currentTier, tier, tokens) === 'hold') {
    $.ui.toast(copy.holding(currentName))

    return { kind: 'stay' }
  }

  const target = aliasOfTier(tier)
  const targetId = await resolveModelId($, target)
  const targetName = displayName(targetId)
  // The classifier's reason was for the tier it wanted: when what is offered is another, say so.
  const reason =
    tier === verdict.tier ? verdict.reason : copy.fallbackReason(displayName(await resolveModelId($, aliasOfTier(verdict.tier))), targetName)

  const isSwitch = await askToSwitch(
    $,
    {
      question: copy.question(targetName),
      options: [
        { label: copy.switchLabel(targetName), description: copy.switchDescription(reason, tokens) },
        { label: copy.stayLabel(currentName), description: copy.stayDescription(currentName) },
      ],
    },
    copy.header,
  )

  return isSwitch ? { kind: 'switch', target, targetId, targetName, currentName, isDown: tier < currentTier } : { kind: 'stay' }
}

// What a check asks of the prompt: a context line for the model (Switch, route set), or a drop
// (Switch where this session cannot change its own model). No outcome: the prompt goes on as it is.
type Outcome = { context: string } | { drop: string } | { recheckStarted: true }

// A session with no terminal surface (the desktop app, VS Code, a phone) owns its model in its
// own picker: the engine's `/model` never reaches it, and the host refuses a session's own change.
// So Switch holds the prompt: the text goes back into the box, and the person picks and resends.
async function holdForPicker($: EngineInterface, original: string, targetName: string): Promise<Outcome> {
  let isFilled = false

  try {
    isFilled = (await $.prompt.fill({ text: original, mode: 'replace' })).isFilled
  } catch {
    isFilled = false
  }

  return { drop: isFilled ? copy.heldRefilled(targetName) : copy.heldResend(targetName) }
}

async function messageCount($: EngineInterface): Promise<number> {
  try {
    return (await $.session.messages()).length
  } catch {
    return 0
  }
}

// Everything up to the person's decision.
async function runCheck($: EngineInterface, original: string, canSwitchItself: boolean): Promise<Outcome | undefined> {
  const text = original.trim()

  if (await wasCheckedBefore($)) {
    await update($, checked, () => true)

    return undefined
  }

  const currentModel = await $.session.model()
  const currentTier = tierOfModel(currentModel)

  // A Bedrock or Vertex id would make the rewrite target wrong: only Anthropic ids are checked.
  if (currentTier === undefined || !currentModel.startsWith('claude-')) return undefined

  const verdict = await classify($, buildClassifierPrompt(text))

  if (verdict === undefined) {
    await update($, attempts, count => count + 1)

    return undefined
  }

  // A chat or a quick question is not the task: the check waits for the first real one.
  if (verdict.kind === 'chat') return undefined

  // The words alone do not settle it (`read PROMPT.md, implement`): not checked yet, no window.
  // The steps of the turn look again as tool results arrive, within the session's recheck budget.
  if (!verdict.isEnough) {
    // Counted as an attempt too, so a session of vague prompts cannot spend Haiku calls without end.
    await update($, attempts, tries => tries + 1)

    if ((await read($, rechecks)) >= MAX_RECHECKS) return undefined

    const count = await messageCount($)

    await update($, recheck, () => ({
      text: text.slice(0, MAX_RECHECK_TEXT_CHARS),
      turnId: null,
      model: currentModel,
      turnsCarried: 0,
      lastMessageCount: count,
      lastHash: null,
    }))

    return { recheckStarted: true }
  }

  await markChecked($)

  const choice = await chooseModel($, currentModel, currentTier, verdict)

  if (choice.kind === 'stay') return undefined

  if (!canSwitchItself) return holdForPicker($, original, choice.targetName)

  await update($, route, () => ({
    target: choice.target,
    targetId: choice.targetId,
    fromModel: currentModel,
    isDown: choice.isDown,
    turnId: null,
  }))
  $.ui.toast(copy.switched(choice.targetName))

  return { context: copy.routedContext(choice.targetName, choice.currentName) }
}

async function checkPrompt($: EngineInterface, e: PromptSubmitInput): Promise<Outcome | undefined> {
  const text = e.text.trim()
  const firstToken = text.split(/\s/)[0] ?? ''

  // Typed over a running turn (`turnId`), not the person's, too short, or a slash command.
  if (e.turnId !== undefined || !PERSON_ORIGINS.includes(e.origin.kind)) return undefined
  if (text.length < MIN_TEXT_CHARS || SLASH_COMMAND.test(firstToken)) return undefined
  if (await read($, checked)) return undefined

  // A check is waiting for more context: what the person adds belongs to it, and the steps
  // decide; this prompt does not start a classification of its own.
  if ((await read($, recheck)) !== null) {
    await update($, recheck, held => (held === null ? null : { ...held, text: `${held.text}\n\n${text}`.slice(0, MAX_RECHECK_TEXT_CHARS) }))

    return undefined
  }

  if ((await read($, attempts)) >= MAX_ATTEMPTS) return undefined
  // A plain `claude -p` run has no surface and no one to ask: no Haiku call either.
  const surfaces = await $.session.surfaces()

  if (surfaces.length === 0) return undefined
  if (!(await claimCheck($))) return undefined

  try {
    return await runCheck($, e.text, surfaces.includes('terminal'))
  } finally {
    await update($, inFlight, () => false).catch(() => undefined)
  }
}

// The task's turn is over: the routing ends with it. Where the host has `/model`, make the
// switch official for the session; if that fails, or there is no `/model` (the desktop app),
// say how to pick it.
async function endRoute($: EngineInterface, turnId: string): Promise<void> {
  const routed = await read($, route)

  if (routed === null || (routed.turnId !== null && routed.turnId !== turnId)) return

  await update($, route, () => null)

  const hint = () => $.ui.toast(copy.pickInPicker(displayName(routed.targetId)))
  const hasModelCommand = (await $.command.list()).some(command => command.name === 'model')

  if (hasModelCommand) {
    // Queued behind this turn; awaiting it here would wait on the turn this hook is part of.
    void $.command.run({ command: 'model', args: routed.target }).catch(hint)
  } else {
    hint()
  }
}

// A check still waiting for context outlives the turn it was bound to: the next turn's steps
// pick it up. But not for long: after MAX_CARRIED_TURNS turns with no recheck fired it expires,
// leaving the session unchecked so the next prompt is classified afresh.
async function carryRecheck($: EngineInterface, turnId: string): Promise<void> {
  await update($, recheck, held => {
    if (held === null || held.turnId !== turnId) return held

    return held.turnsCarried + 1 > MAX_CARRIED_TURNS ? null : { ...held, turnId: null, turnsCarried: held.turnsCarried + 1 }
  })
}

// The same request, sent to the routed model. Routing down drops `effort`: the lower model's
// own default applies. Up keeps it.
function routedRequest(routed: ModelFitRoute, e: TurnStepInput): TurnStepInput {
  const { effort, ...withoutEffort } = e

  return { ...(routed.isDown ? withoutEffort : { ...withoutEffort, effort }), model: routed.targetId }
}

// A step of the turn the person switched for: bound by the first main-loop step after the Switch.
// A model changed by any other means (the picker, `/model`) ends the routing: their choice wins.
async function routeStep($: EngineInterface, e: TurnStepInput, routed: ModelFitRoute): Promise<TurnStepInput | undefined> {
  const boundTo = routed.turnId ?? e.turnId

  if (routed.turnId === null) {
    await update($, route, held => (held !== null && held.turnId === null ? { ...held, turnId: e.turnId } : held))
  }

  if (e.turnId !== boundTo) return undefined

  if ((await $.session.model()) === routed.fromModel) return routedRequest(routed, e)

  await update($, route, () => null)

  return undefined
}

// The tool results that arrived since the baseline, newest first: the last `added` rows of the
// conversation. Each call appears once (an assistant row and its result row both carry it), and an
// error result is evidence too.
async function toolResultsSince($: EngineInterface, added: number): Promise<ToolResult[]> {
  const found: ToolResult[] = []
  const seen = new Set<string>()
  const messages = await $.session.messages()

  // What each call was aimed at, from the whole conversation: a result can sit in the window
  // while the assistant row that made the call is just before it.
  const labels = new Map<string, string>()

  for (const message of messages) {
    for (const use of message.toolUses) labels.set(use.tool_use_id, describeToolUse(use.tool, use.input))
  }

  const add = (id: string, text: string) => {
    if (seen.has(id)) return

    seen.add(id)
    found.push({ ...(labels.has(id) ? { from: labels.get(id) } : {}), text })
  }

  for (const message of messages.slice(Math.max(0, messages.length - added)).reverse()) {
    for (const result of message.toolResults ?? []) add(result.tool_use_id, result.text)

    for (const use of [...message.toolUses].reverse()) {
      if (use.text !== undefined) add(use.tool_use_id, use.text)
    }
  }

  return selectResults(found)
}

// What a step that does not run looks like to the engine: no request was made, no response.
function stoppedStep(e: TurnStepInput): TurnStepResult {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
}

// Mid-turn Switch where the app owns the model: stop this turn, put "continue" in the box (only
// when the person has typed nothing there), and let them pick the model. Resolves true once the
// turn was stopped, whatever the toast and the box do after.
async function stopForPicker($: EngineInterface, e: TurnStepInput, targetName: string): Promise<boolean> {
  // The id `turn.start` handed this plugin is the one `$.turn.abort` wants; the step's is the same turn's.
  const turnId = (await read($, runningTurn)) ?? e.turnId

  try {
    await $.turn.abort({ turnId })
  } catch {
    // The turn could not be stopped: it goes on, and the picker is all there is to point at.
    $.ui.toast(copy.pickInPicker(targetName))

    return false
  }

  let isFilled = false

  // Stopped is stopped: a box or a toast that fails changes nothing about that.
  try {
    // A draft the person is typing is theirs: never written over.
    if ((await $.prompt.read()).text.trim() === '') {
      isFilled = (await $.prompt.fill({ text: copy.continueText, mode: 'replace' })).isFilled
    }
  } catch {
    isFilled = false
  }

  try {
    $.ui.toast(isFilled ? copy.stoppedRefilled(targetName) : copy.stoppedResend(targetName))
  } catch {
    // Nothing to do: the turn is stopped either way.
  }

  return true
}

// One step of the main loop while a recheck is waiting. Resolves to the request to send instead
// (a Switch routed this very step), 'stopped' when the turn was stopped and the step must not run,
// or undefined to let the step go on as it is.
async function recheckStep($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput | 'stopped' | undefined> {
  const held = await read($, recheck)

  if (held === null) return undefined

  if (await read($, checked)) {
    await update($, recheck, () => null)

    return undefined
  }

  const currentModel = await $.session.model()

  // The person (or anything else) changed the model: their choice stands, and the next prompt is judged afresh.
  if (currentModel !== held.model) {
    await update($, recheck, () => null)

    return undefined
  }

  if (held.turnId !== null && held.turnId !== e.turnId) {
    // Another turn's first step while this one was never closed (its completion was missed):
    // the recheck moves to the new turn, counting the old one as carried.
    if (e.index === 0) {
      await update($, recheck, now => {
        if (now === null) return null

        return now.turnsCarried + 1 > MAX_CARRIED_TURNS
          ? null
          : { ...now, turnId: e.turnId, turnsCarried: now.turnsCarried + 1, lastMessageCount: e.messageCount }
      })
    }

    return undefined
  }

  // The first step names the turn; at its start nothing new has arrived, so it only sets the baseline.
  if (held.turnId === null) {
    const start = e.index === 0 ? e.messageCount : held.lastMessageCount

    await update($, recheck, now => (now !== null && now.turnId === null ? { ...now, turnId: e.turnId, lastMessageCount: start } : now))

    if (e.index === 0) return undefined
  }

  const baseline = held.lastMessageCount

  // The conversation shrank (a compaction): the old baseline means nothing, start again from here.
  if (e.messageCount < baseline) {
    await update($, recheck, now => (now === null ? null : { ...now, lastMessageCount: e.messageCount }))

    return undefined
  }

  if (e.index === 0 || e.messageCount <= baseline) return undefined

  if ((await read($, rechecks)) >= MAX_RECHECKS) {
    await update($, recheck, () => null)

    return undefined
  }

  const currentTier = tierOfModel(currentModel)

  if (currentTier === undefined || !currentModel.startsWith('claude-')) {
    await update($, recheck, () => null)

    return undefined
  }

  // Only what arrived since the last look counts as new evidence. None, or the same as last time,
  // is no reason to pay for a call and no strike against the budget.
  const evidence = await toolResultsSince($, e.messageCount - baseline)
  const hash = hashTexts(evidence)

  if (evidence.length === 0 || hash === held.lastHash) {
    await update($, recheck, now => (now === null ? null : { ...now, lastMessageCount: e.messageCount }))

    return undefined
  }

  const verdict = await classify($, buildClassifierPrompt(held.text, evidence))
  const used = await update($, rechecks, count => count + 1)

  if (verdict === undefined || verdict.kind === 'chat' || !verdict.isEnough) {
    // Out of rechecks: give up silently, the session runs as selected.
    await update($, recheck, now =>
      now === null || used >= MAX_RECHECKS ? null : { ...now, turnsCarried: 0, lastMessageCount: e.messageCount, lastHash: hash },
    )

    return undefined
  }

  await update($, recheck, () => null)
  await markChecked($)

  const choice = await chooseModel($, currentModel, currentTier, verdict)

  if (choice.kind === 'stay') return undefined

  const surfaces = await $.session.surfaces()

  if (!surfaces.includes('terminal')) {
    return (await stopForPicker($, e, choice.targetName)) ? 'stopped' : undefined
  }

  const routed: ModelFitRoute = {
    target: choice.target,
    targetId: choice.targetId,
    fromModel: currentModel,
    isDown: choice.isDown,
    turnId: e.turnId,
  }

  await update($, route, () => routed)
  $.ui.toast(copy.switched(choice.targetName))

  return routedRequest(routed, e)
}

export const register: Register = (on, options) => {
  highestModel = typeof options.highestModel === 'string' ? options.highestModel : 'auto'

  on('prompt.submit', async ($, e, next) => {
    const outcome = await checkPrompt($, e)

    if (outcome === undefined) return next(e)

    // The one deliberate drop: answered before any `next`, so the prompt never entered.
    if ('drop' in outcome) return { drop: outcome.drop }

    if ('recheckStarted' in outcome) {
      const passed = await next(e)

      // Another hook dropped the prompt: no turn will come for the recheck to look at.
      if (passed.drop !== undefined) await update($, recheck, () => null)

      return passed
    }

    const result = await next({ ...e, context: [...(e.context ?? []), outcome.context] })

    // Another hook dropped the prompt: no task will run, so nothing is left to route.
    if (result.drop !== undefined) await update($, route, () => null)

    return result
  }).catch(($, e, next) => next(e))

  // The dialog's two options get their descriptions here; a render hook never writes state.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = await read($, pending)
    const [first, ...rest] = e.props.questions as { question?: unknown }[]

    if (asked === null || first?.question !== asked.question) return next(e)

    return next({ ...e, props: { ...e.props, questions: [{ ...first, options: asked.options }, ...rest] } })
  })

  // Main-loop steps only (a subagent's never count). While a Switch routes the turn, its steps go
  // to the other model; otherwise a prompt the classifier could not judge is looked at again as
  // tool results arrive. Either way a failure here must leave the step as it was.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const routed = await read($, route)
      let request: TurnStepInput | 'stopped' | undefined

      try {
        request = routed !== null ? await routeStep($, e, routed) : await recheckStep($, e)
      } catch {
        request = undefined
      }

      if (request === 'stopped') return stoppedStep(e)
      if (request !== undefined) return yield* next(request)
    }

    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // The running turn's id, which stopping a turn must name.
  on('turn.start', async ($, e, next) => {
    await update($, runningTurn, () => e.turnId)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await endRoute($, e.turnId)
      await carryRecheck($, e.turnId)
      await update($, runningTurn, held => (held === e.turnId ? null : held))
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
