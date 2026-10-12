// The ledger provider: a repository's task ledger (WORKPLAN.md and kin) read against its pull requests.
//
// Layer 1 is deterministic: parse the ledger, match PRs by id, derive status, progress, the next task and
// drift (the pure core under ./ledger/). Layer 2 is "AI proposes, you pin": a model proposes product
// sections, the person pins them, a cheaper model files tasks under them and only reruns when its inputs
// changed. Repository content is read only through git (never the file system, so a symlink cannot redirect
// a read), only for tracked regular files that pass `isSendable`; the repository is never written to
// (`git fetch` only updates remote-tracking refs). Pull or merge requests come from the repository's forge
// (src/forge/: GitHub through gh, GitLab through glab), read only.
import type { Detection, PanelModel, Provider, ProviderContext } from '../../types'
import { join } from '../fsx'
import { forgeFor, problemText } from '../forge'
import type { Forge, ForgeProblem } from '../forge'
import { t } from '../strings/en'
import { runL2 } from './ledger/ai'
import type { AssignmentItem, AssignmentRecord } from './ledger/ai'
import { isSendable, pickLedger, readDeliveryFrontMatter } from './ledger/discover'
import { inputHash } from './ledger/hash'
import {
  currentBranch,
  fetchDefault,
  localTracked,
  remoteTracked,
  repoFacts,
  repoRoot,
  sh,
  showLocal,
  showRemote,
  toPr,
} from './ledger/host'
import {
  RETRY_AFTER_MS,
  buildInputs,
  completeOf,
  docCandidates,
  docHeadings,
  isBackedOff,
  pinKey,
  readRecord,
  storeKey,
  writeRecord,
} from './ledger/l2'
import type { L2Record } from './ledger/l2'
import { matchPrs } from './ledger/match'
import { parseLedger } from './ledger/parse'
import type { Pr } from './ledger/types'
import { modelOf, phaseShape, productShape } from './ledger/view'
import type { Shape } from './ledger/view'
import { reviewCtxOf } from './review/viewer'

const DELIVERY_PATH = 'docs/DELIVERY.md'
const SETTINGS_PATH = '.claude/settings.json'
const FINGERPRINT_MS = 12_000

type Action = 'pin' | 'rebuild' | 'propose'
const ACTIONS: Record<string, Action> = { 'ledger.pin': 'pin', 'ledger.rebuild': 'rebuild', 'ledger.propose': 'propose' }

export const ledger: Provider = {
  id: 'ledger',

  async detect(ctx: ProviderContext): Promise<Detection | null> {
    try {
      const root = await repoRoot(ctx.host, ctx.startDir)
      if (root === null) return null
      const tracked = await localTracked(ctx.host, root)
      const set = new Set(tracked)
      const found = await pickLedger(tracked, path => (isSendable(path, set) ? showLocal(ctx.host, root, path) : Promise.resolve(null)))
      return found ? { provider: 'ledger', root, detail: { ledgerPath: found.path, via: found.via } } : null
    } catch {
      return null
    }
  },

  load: (ctx, detection) => loadLedger(ctx, detection, undefined),

  act: (ctx, detection, actionId) => loadLedger(ctx, detection, ACTIONS[actionId]),

  fingerprint,
}

/** The DELIVERY file's `primary-branch`, read from the committed copy; '' when absent. */
async function primaryBranchOf(ctx: ProviderContext, root: string): Promise<string> {
  const text = await showLocal(ctx.host, root, DELIVERY_PATH)
  return text === null ? '' : (readDeliveryFrontMatter(text)['primary-branch'] ?? '')
}

async function loadLedger(ctx: ProviderContext, detection: Detection, action: Action | undefined): Promise<PanelModel> {
  const { host } = ctx
  const root = detection.root
  const ledgerPath = String(detection.detail['ledgerPath'] ?? '')
  const via = detection.detail['via'] === 'delivery' ? 'delivery' : 'discovered'

  // Independent reads run together: the index, the repository facts, the change list and the session branch.
  // The forge is found first (one `git remote get-url`): both the facts and the list ask it.
  const trackedP = localTracked(host, root)
  const { forge, problem } = await forgeFor(ctx, root)
  const [tracked, facts, changes, branch] = await Promise.all([
    trackedP,
    repoFacts(
      host,
      root,
      async () => {
        const set = new Set(await trackedP)
        return isSendable(DELIVERY_PATH, set) ? primaryBranchOf(ctx, root) : ''
      },
      undefined,
      forge,
    ),
    forge === null ? Promise.resolve(null) : forge.listChanges({ withReview: true }),
    currentBranch(host, ctx.startDir),
  ])
  // `prs` is null whenever the changes are unknown (no forge, or the forge failed); the caption says why.
  const prs: Pr[] | null = changes?.ok ? changes.value.map(toPr) : null
  const changesNote = noChangesCaption(forge, problem, changes === null ? undefined : changes.ok ? undefined : changes.problem)
  const localSet = new Set(tracked)
  if (ledgerPath === '' || !isSendable(ledgerPath, localSet)) throw new Error(`no readable ledger in ${root}`)
  const review = await reviewCtxOf({
    forge,
    root,
    now: ctx.now,
    options: ctx.options,
    open: (prs ?? []).filter(pr => pr.state === 'OPEN'),
    // The committed copy, read through git like every other file, and only when git tracks it.
    settings: () => (isSendable(SETTINGS_PATH, localSet) ? showLocal(host, root, SETTINGS_PATH) : Promise.resolve(null)),
  })

  // Freshness: the default branch's copy of the ledger, else the committed local one.
  const isFetched = await fetchDefault(host, root, facts.defaultBranch)
  const [remoteText, remoteTree] = await Promise.all([
    showRemote(host, root, facts.defaultBranch, ledgerPath),
    remoteTracked(host, root, facts.defaultBranch),
  ])
  const ledgerText = remoteText ?? (await showLocal(host, root, ledgerPath))
  if (ledgerText === null) throw new Error(`cannot read ${ledgerPath}`)
  const treeSet = new Set(remoteTree ?? tracked)
  const sendable = [...treeSet].filter(p => isSendable(p, treeSet))
  const repoName = root.split('/').filter(Boolean).pop() ?? ''

  // Layer 1.
  const parsed = parseLedger(ledgerText)
  const title = parsed.title || repoName
  const matches = matchPrs(parsed.items, prs ?? [], forge === null ? {} : { citePrefix: forge.refPrefix })
  const aiItems: AssignmentItem[] = parsed.items.flatMap(item => {
    const m = matches.get(item.id)
    return m ? [{ id: item.id, title: item.title, phase: item.phase, status: m.status, source: m.source }] : []
  })

  // Layer 2 needs a readable store, the PR list and something to group; otherwise the phases stand alone.
  const key = storeKey(facts.repoUrl, root)
  const stored = await readRecord(host, key)
  const isL2On = stored !== null && prs !== null && parsed.items.length > 0
  let record: L2Record = stored ?? {}
  let aiMessage = ''
  const docs = docCandidates(sendable, treeSet)

  if (isL2On) {
    const now = ctx.now
    const complete = completeOf(host)
    const mergedPrNumbers = prs.filter(p => p.state === 'MERGED').map(p => p.number)
    // A pin made for another ledger file is no pin for this one.
    if (record.pinned && record.pinned.ledgerPath !== ledgerPath) record = { ...record, pinned: undefined, assignment: undefined }
    let isDirty = false
    let didFail = false

    const inputsFor = async (isProposing: boolean) =>
      buildInputs({
        ledgerTitle: title,
        ledgerText,
        items: aiItems,
        lines: parsed.items,
        mergedPrNumbers,
        tracked: sendable,
        headings: isProposing ? await docHeadings(host, root, facts.defaultBranch, docs) : [],
        pinned: record.pinned?.sections ?? [],
      })

    if (action === 'pin' && record.proposal) {
      record = { ...record, pinned: { sections: record.proposal.sections, pinnedAt: now, ledgerPath } }
      isDirty = true
    }

    // The proposal (Sonnet): on Propose or Rebuild, or by itself only for a ledger the repo declared in DELIVERY.md.
    const wantsProposal = action === 'rebuild' || action === 'propose' || (!record.pinned && !record.proposal && via === 'delivery')
    if (wantsProposal) {
      const inputs = await inputsFor(true)
      const hash = await inputHash(['proposal', ledgerText, inputs.topDirs.join(',')])
      if (action === undefined && isBackedOff(record.failure, 'proposal', hash, now)) {
        // Failed recently on this very input: not again yet.
      } else {
        const result = await runL2({ complete, store: {}, inputs, now: () => now })
        if (result.proposal) {
          record = { ...record, proposal: result.proposal, failure: record.failure?.kind === 'proposal' ? undefined : record.failure }
        } else {
          record = { ...record, failure: { kind: 'proposal', hash, at: now } }
          didFail = true
        }
        isDirty = true
      }
    }

    // The assignment (Haiku), only for pinned sections and only when its inputs changed.
    if (record.pinned) {
      const inputs = await inputsFor(false)
      const current = pinKey(record.pinned.sections)
      const isStale = !record.assignment || record.assignment.hash !== inputs.hash || record.assignment.pinKey !== current
      if (isStale && !(action !== 'pin' && isBackedOff(record.failure, 'assignment', inputs.hash, now))) {
        const result = await runL2({
          complete,
          store: { pinned: record.pinned, proposal: record.proposal, assignment: record.assignment },
          inputs,
          now: () => now,
        })
        if (result.calls.length === 0 && record.assignment) {
          // The stored result is for these very inputs but predates the pin stamp: adopt it, no call needed.
          record = { ...record, assignment: { ...record.assignment, pinKey: current } }
        } else if (result.assignment && !result.error) {
          const fresh: AssignmentRecord = { ...result.assignment, pinKey: current }
          record = { ...record, assignment: fresh, failure: record.failure?.kind === 'assignment' ? undefined : record.failure }
        } else {
          record = { ...record, failure: { kind: 'assignment', hash: inputs.hash, at: now } }
          didFail = true
        }
        isDirty = true
      }
    }
    if (isDirty) await writeRecord(host, key, record)

    const hasUsable = record.pinned !== undefined && record.assignment?.pinKey === pinKey(record.pinned.sections)
    const hasPrevious = hasUsable || (record.proposal !== undefined && !record.pinned)
    if (didFail) aiMessage = hasPrevious ? t('ledger.caption.aiFailed') : t('ledger.caption.aiUnavailable')
    else if (record.pinned && !hasUsable) aiMessage = t('ledger.caption.aiUnavailable')
    else if (record.failure && now - record.failure.at < RETRY_AFTER_MS && hasPrevious) aiMessage = t('ledger.caption.aiFailed')
  }

  const usable = isL2On && record.pinned !== undefined && record.assignment?.pinKey === pinKey(record.pinned.sections)
  const shape: Shape =
    usable && record.pinned && record.assignment
      ? productShape(parsed.items, matches, record.pinned, record.assignment.result)
      : phaseShape(parsed.items, matches)
  const isProposalShown =
    isL2On &&
    record.proposal !== undefined &&
    (!record.pinned || pinKey(record.proposal.sections) !== pinKey(record.pinned.sections))
  const needsPropose = isL2On && !record.pinned && !record.proposal && (via !== 'delivery' || record.failure?.kind === 'proposal')
  const actions = !isL2On
    ? []
    : isProposalShown
      ? [{ id: 'ledger.pin', label: t('ledger.action.pin') }]
      : record.pinned
        ? [{ id: 'ledger.rebuild', label: t('ledger.action.rebuild') }]
        : needsPropose
          ? [{ id: 'ledger.propose', label: t('ledger.action.propose') }]
          : []

  return modelOf({
    root,
    ledgerPath,
    repoUrl: facts.repoUrl,
    defaultBranch: facts.defaultBranch,
    branch,
    now: ctx.now,
    parsed: { ...parsed, title },
    matches,
    shape,
    refOf: forge?.refOf,
    fileUrl: forge?.fileUrl,
    captions: [
      aiMessage,
      remoteText !== null && !isFetched ? t('ledger.caption.stale') : '',
      remoteText === null ? t('ledger.caption.localOnly') : '',
      changesNote,
      isProposalShown ? t('ledger.caption.proposal') : '',
    ],
    proposed: isProposalShown && record.proposal ? record.proposal.sections : [],
    actions: actions.filter(a => a.label !== ''),
    aiDrift: usable && record.assignment ? record.assignment.result.drift : [],
    watch: [join(root, ledgerPath), ...docs.map(p => join(root, p))],
    prs: prs ?? [],
    review,
  })
}

/** The header line for changes that could not be read; '' when they were read, or the person turned the forge off. */
function noChangesCaption(forge: Forge | null, detected: ForgeProblem | undefined, failed: ForgeProblem | undefined): string {
  if (forge === null) return detected?.kind === 'no-remote' ? t('ledger.caption.noRemote') : ''
  return failed === undefined ? '' : t(`ledger.caption.noChanges.${forge.kind}`, { cause: problemText(failed) })
}

/**
 * A cheap digest of what could change the model without a file changing locally: the forge's digest of its
 * pull or merge requests, and the default branch's remote head. No model calls. A failing forge throws a
 * ForgeError (M2's refresh engine turns that into one Attention line and keeps the last model); a failing
 * `git ls-remote` alone leaves its part empty. This is the provider's `fingerprint`, polled by src/refresh.ts.
 */
async function fingerprint(ctx: ProviderContext, detection: Detection): Promise<string> {
  const root = detection.root
  const { forge } = await forgeFor(ctx, root)
  // src/refresh.ts gives the whole call 30 s: the forge digest runs beside the git chain, and the git chain
  // is two commands in a row (repo facts, then ls-remote) of up to 12 s each, so 24 s at worst.
  const [part, sha] = await Promise.all([
    forge === null ? Promise.resolve('') : forge.fingerprint(),
    (async () => {
      const facts = await repoFacts(ctx.host, root, () => primaryBranchOf(ctx, root), FINGERPRINT_MS, forge)
      const head = await sh(ctx.host, ['git', '-C', root, 'ls-remote', 'origin', `refs/heads/${facts.defaultBranch}`], undefined, FINGERPRINT_MS)
      return head.ok ? (head.out.trim().split(/\s+/)[0] ?? '') : ''
    })(),
  ])
  return inputHash([part, sha])
}
