// A sanitised copy of a real AI-DLC v2 workspace (the essentials), under a fake
// root. The live intent is mid-Inception, parked at domain-design, with its
// engine directive OLDER than the state file; the second intent is archived.
// Sessions: one valid binding, one empty file, one bound to no intent, one
// bound to the archived intent, one malformed.
import type { VirtualTree } from './virtual'

export const ROOT = '/work/shop'
export const LIVE_INTENT = '260806-shop-mvp-restart'
export const ARCHIVED_INTENT = '260802-shop-mvp-2'

export const sessions = {
  live: '11111111-1111-4111-8111-111111111111',
  empty: '22222222-2222-4222-8222-222222222222',
  nullIntent: '33333333-3333-4333-8333-333333333333',
  archived: '44444444-4444-4444-8444-444444444444',
  malformed: '55555555-5555-4555-8555-555555555555',
  unknown: '66666666-6666-4666-8666-666666666666',
}

const intents = `${ROOT}/aidlc/spaces/default/intents`

export const liveState = `# AI-DLC State Tracking

## Project Information
- **Project**: Rebuild the storefront checkout against the settled planning documents.
- **Project Description Source**: project-description.json
- **Project Type**: Greenfield
- **Scope**: mvp
- **Start Date**: 2026-08-30T15:45:39Z
- **State Version**: 8
- **Active Agent**: aidlc-architect-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**: 2026-09-01T17:02:26Z

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.3, 1.4, 1.6, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
- **Stages to Skip**: 1.2 (market-research), 1.5 (team-formation), 1.7 (approval-handoff), 4.1 (deployment-pipeline), 4.2 (environment-provisioning), 4.3 (deployment-execution), 4.4 (observability-setup), 4.5 (incident-response), 4.6 (performance-validation), 4.7 (feedback-optimization), 2.1 (reverse-engineering — greenfield)
- **Depth**: Standard
- **Test Strategy**: Standard
- **Review Override**: 
- **Guard Policy**: relaxed (from scope mvp)
- **Sensors**: on (from scope mvp)
- **Learnings**: on (from scope mvp)
- **Summary Confirmation**: on (from scope mvp)

## Workspace State
- **Project Root**: .
- **Languages**: Unknown
- **Frameworks**: Unknown
- **Build System**: Unknown

## Execution Plan Summary
- **Total Stages**: 22
- **Completed**: 11
- **In Progress**: domain-design

## Runtime State
- **Revision Count**: 24
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial















































- **Parked**: 2026-09-04T01:19:27Z

- **Parked At Stage**: domain-design

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Verified
- **Inception**: Active
- **Construction**: Pending
- **Operation**: Skipped

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [ ] market-research — SKIP
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [ ] team-formation — SKIP
- [x] rough-mockups — EXECUTE
- [ ] approval-handoff — SKIP

### INCEPTION PHASE
- [ ] reverse-engineering — SKIP
- [x] practices-discovery — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [-] domain-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] contract-design — EXECUTE
- [ ] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
Per unit: [TBD]
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — SKIP
- [ ] environment-provisioning — SKIP
- [ ] deployment-execution — SKIP
- [ ] observability-setup — SKIP
- [ ] incident-response — SKIP
- [ ] performance-validation — SKIP
- [ ] feedback-optimization — SKIP

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: domain-design
- **Next Stage**: units-generation
- **Status**: Running
- **Last Updated**: 2026-09-04T01:19:27Z

## Session Resume Point
- **Last Completed Stage**: refined-mockups
- **Next Action**: Execute Domain Design
- **Pending Artifacts**: none
`

export const archivedState = `# AI-DLC State Tracking

## Project Information
- **Project**: Build the storefront checkout against the planning documents.
- **Project Description Source**: project-description.json
- **Project Type**: Greenfield
- **Scope**: mvp
- **Start Date**: 2026-08-26T11:08:24Z
- **State Version**: 8
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.3, 1.4, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
- **Stages to Skip**: 1.2 (market-research), 1.5 (team-formation), 4.1 (deployment-pipeline), 4.2 (environment-provisioning), 4.3 (deployment-execution), 4.4 (observability-setup), 4.5 (incident-response), 4.6 (performance-validation), 4.7 (feedback-optimization)
- **Depth**: Standard
- **Test Strategy**: Standard
- **Review Override**: 
- **Guard Policy**: relaxed (from scope mvp)
- **Sensors**: on (from scope mvp)
- **Learnings**: on (from scope mvp)
- **Summary Confirmation**: on (from scope mvp)

## Workspace State
- **Project Root**: .
- **Languages**: Unknown
- **Frameworks**: Unknown
- **Build System**: Unknown

## Execution Plan Summary
- **Total Stages**: 24
- **Completed**: 8
- **In Progress**: practices-discovery

## Runtime State
- **Revision Count**: 2
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial





- **Parked**: 2026-08-27T09:07:04Z

- **Parked At Stage**: practices-discovery

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Verified
- **Inception**: Active
- **Construction**: Pending
- **Operation**: Skipped

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [ ] market-research — SKIP
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [ ] team-formation — SKIP
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [S] reverse-engineering — EXECUTE
- [-] practices-discovery — EXECUTE
- [ ] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
- [ ] refined-mockups — EXECUTE
- [ ] domain-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] contract-design — EXECUTE
- [ ] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
Per unit: [TBD]
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — SKIP
- [ ] environment-provisioning — SKIP
- [ ] deployment-execution — SKIP
- [ ] observability-setup — SKIP
- [ ] incident-response — SKIP
- [ ] performance-validation — SKIP
- [ ] feedback-optimization — SKIP

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: practices-discovery
- **Next Stage**: requirements-analysis
- **Status**: Archived
- **Last Updated**: 2026-08-30T15:45:31Z

## Session Resume Point
- **Last Completed Stage**: approval-handoff
- **Next Action**: Execute Practices Discovery
- **Pending Artifacts**: none
`

export const tree: VirtualTree = {
  files: {
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/dev/SHOP-7/refined-mockups\n',
    [`${ROOT}/.claude/tools/aidlc.ts`]: '// engine\n',
    [`${ROOT}/.claude/rules/aidlc.md`]: '# AI-DLC rules\n',
    [`${ROOT}/aidlc/active-space`]: 'default\n',
    [`${intents}/active-intent`]: `${LIVE_INTENT}\n`,
    [`${intents}/intents.json`]: JSON.stringify(
      [
        {
          uuid: '01a00000-0000-7000-8000-000000000001',
          slug: 'shop-mvp',
          dirName: ARCHIVED_INTENT,
          scope: 'mvp',
          status: 'archived',
        },
        {
          uuid: '01a00000-0000-7000-8000-000000000002',
          slug: 'shop-mvp-restart',
          dirName: LIVE_INTENT,
          scope: 'mvp',
          repos: ['api', 'web'],
          status: 'in-flight',
        },
      ],
      null,
      2,
    ),
    [`${intents}/${LIVE_INTENT}/aidlc-state.md`]: liveState,
    [`${intents}/${LIVE_INTENT}/.aidlc-engine/active-directive.json`]: JSON.stringify({
      version: 2,
      stage: 'refined-mockups',
      unit: null,
      delivery: 'issued',
    }),
    [`${intents}/${ARCHIVED_INTENT}/aidlc-state.md`]: archivedState,
    [`${ROOT}/aidlc/.aidlc-sessions/${sessions.live}.binding.json`]: JSON.stringify({
      space: 'default',
      intent: LIVE_INTENT,
      boundAt: '2026-09-02T06:41:03Z',
    }),
    [`${ROOT}/aidlc/.aidlc-sessions/${sessions.empty}.binding.json`]: '',
    [`${ROOT}/aidlc/.aidlc-sessions/${sessions.nullIntent}.binding.json`]: JSON.stringify({
      space: 'default',
      intent: null,
      boundAt: '2026-08-26T11:02:40Z',
    }),
    [`${ROOT}/aidlc/.aidlc-sessions/${sessions.archived}.binding.json`]: JSON.stringify({
      space: 'default',
      intent: ARCHIVED_INTENT,
      boundAt: '2026-08-26T11:12:56Z',
    }),
    [`${ROOT}/aidlc/.aidlc-sessions/${sessions.malformed}.binding.json`]: '{"space": "default", "intent":',
  },
  // Epoch ms; the directive is older than the state file, as on the real machine.
  mtimes: {
    [`${intents}/${LIVE_INTENT}/aidlc-state.md`]: 1788484767000,
    [`${intents}/${LIVE_INTENT}/.aidlc-engine/active-directive.json`]: 1788453258000,
    [`${intents}/${ARCHIVED_INTENT}/aidlc-state.md`]: 1788120300000,
  },
}
