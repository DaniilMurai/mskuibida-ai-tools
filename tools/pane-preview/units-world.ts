// A Construction-by-Unit workspace for the preview, read by the real AI-DLC provider: six Units with story points
// (13, 5, 13, 3, 8, 3: 45 in all), U1 built, U3 at nfr-requirements. `claimed` names U3 as this checkout's Active Unit.
import { aidlc } from '../../plugins/project-panel/src/providers/aidlc'
import * as s from '../../plugins/project-panel/fixtures/scenarios'
import { ctxOf, mockHost, OPTIONS } from '../../plugins/project-panel/tests/world'
import type { PanelModel } from '../../plugins/project-panel/types'

const INTENT_DIR = `${s.ROOT}/aidlc/spaces/default/intents/${s.INTENT}`
const UNITS_DIR = `${INTENT_DIR}/inception/units-generation`
const UNITS = [
  ['U1', 'u1-api-core', 13, []],
  ['U2', 'u2-assistant-access', 5, ['u1-api-core']],
  ['U3', 'u3-day-page', 13, ['u1-api-core']],
  ['U4', 'u4-day-navigation', 3, ['u3-day-page']],
  ['U5', 'u5-live-updates', 8, ['u3-day-page']],
  ['U6', 'u6-installation', 3, []],
] as const

const dependency = ['# Unit dependencies', '', '```yaml', 'units:', ...UNITS.flatMap(([, name, , deps]) => [`  - name: ${name}`, '    kind: service', `    depends_on: [${deps.join(', ')}]`]), '```', ''].join('\n')
const index = ['# Units of work', '', '| Unit ID | Directory | Repo | Kind | Jira | Stories |', '|---|---|---|---|---|---|', ...UNITS.map(([id, name]) => `| ${id} | \`${name}\` | app | service | none | US |`), ''].join('\n')
const points = ['unit,points,source', ...UNITS.map(([id, , pt]) => `${id},${pt},human`), ''].join('\n')

function audit(rows: [string, string, string][]): string {
  const blocks = rows.map(([event, stage, unit], at) =>
    ['## Unit', `**Timestamp**: 2026-10-17T0${at}:00:00Z`, `**Event**: ${event}`, `**Stage**: ${stage}`, `**Unit**: ${unit}`, ''].join('\n'),
  )
  return ['# AI-DLC Audit Log', '', blocks.join('\n---\n\n')].join('\n')
}

function state(claimed: boolean): string {
  const rows = ['functional-design', 'nfr-requirements', 'nfr-design', 'infrastructure-design', 'code-generation', 'build-and-test', 'ci-pipeline'].map(
    slug => `- [ ] ${slug} — EXECUTE`,
  )
  const text = s.stateOf({
    lifecycle: 'CONSTRUCTION',
    current: 'nfr-requirements',
    progress: { Initialization: 'Verified', Ideation: 'Verified', Inception: 'Verified', Construction: 'Active' },
    phases: {
      INITIALIZATION: ['- [x] workspace-detection — EXECUTE', '- [x] state-setup — EXECUTE', '- [x] practices-baseline — EXECUTE'],
      IDEATION: ['- [x] intent-capture — EXECUTE', '- [x] feasibility — EXECUTE', '- [x] scope-definition — EXECUTE', '- [x] rough-mockups — EXECUTE'],
      INCEPTION: [
        '- [-] reverse-engineering — SKIP',
        ...['practices-discovery', 'requirements-analysis', 'user-stories', 'refined-mockups', 'domain-design', 'units-generation', 'contract-design', 'delivery-planning'].map(
          slug => `- [x] ${slug} — EXECUTE`,
        ),
      ],
      CONSTRUCTION: ['Per unit: [TBD]', ...rows],
      OPERATION: ['- [-] deployment-pipeline — SKIP'],
    },
  })
  const extra = ['- **Construction Checkpoints**: enabled', ...(claimed ? ['- **Active Unit**: u3-day-page', '- **Unit State**: in-progress'] : [])]
  return text.replace('- **Revision Count**: 3', ['- **Revision Count**: 3', ...extra].join('\n'))
}

/** The model the provider builds for the workspace, with or without U3 claimed at this checkout. */
export async function unitsModel(claimed: boolean): Promise<PanelModel> {
  const tree = {
    files: {
      [s.paths.statePath]: state(claimed),
      [`${s.ROOT}/aidlc/spaces/default/intents/active-intent`]: `${s.INTENT}\n`,
      [`${s.ROOT}/aidlc/.aidlc-sessions/${s.SESSION}.binding.json`]: JSON.stringify({ space: 'default', intent: s.INTENT, boundAt: '2026-10-17T00:00:00Z' }),
      [`${UNITS_DIR}/unit-of-work-dependency.md`]: dependency,
      [`${UNITS_DIR}/unit-of-work.md`]: index,
      [`${INTENT_DIR}/unit-points.csv`]: points,
      [`${INTENT_DIR}/audit/host-a.md`]: audit([
        ['UNIT_COMPLETED', 'code-generation', 'u1-api-core'],
        ['UNIT_STARTED', 'functional-design', 'u3-day-page'],
        ['UNIT_COMPLETED', 'functional-design', 'u3-day-page'],
        ['UNIT_STARTED', 'nfr-requirements', 'u3-day-page'],
      ]),
    },
  }
  const ctx = ctxOf(tree, s.ROOT, s.SESSION, OPTIONS, mockHost())
  const detection = await aidlc.detect(ctx)
  if (!detection) throw new Error('no AI-DLC workspace detected')
  return aidlc.load(ctx, detection)
}
