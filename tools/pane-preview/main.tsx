// The preview page: project-panel's real renderPane over the test worlds' models, drawn by the desktop kit in a
// dark and a light pane side by side, at a width you pick. Folds and presses work; "Put in prompt" is logged.
import { createElement, Fragment, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { renderPane } from '../../plugins/project-panel/src/render'
import { item, ledgerModel, section, sideJobModel, stageModel, idleModel } from '../../plugins/project-panel/tests/world'
import type { Gate, PanelModel } from '../../plugins/project-panel/types'
import manifest from '../../plugins/project-panel/.claude-plugin/plugin.json'
import { ADVANCE, desktopKit } from './kit'

// The panel's modules are compiled with `h` as their JSX factory (the engine's); here it is React's.
Object.assign(globalThis, { h: createElement, Fragment })

const NOW = Date.UTC(2026, 9, 17, 10, 0, 0)

/** The pane in the screenshot this preview was calibrated on: a side job, stages local only, Construction not counted. */
function screenshotModel(): PanelModel {
  const local = { landing: 'local' as const, statusWord: 'local only' }
  const inception = section('INCEPTION', 'Inception', 'active', [
    item('reverse-engineering', 'skipped', { ordinal: '2.1' }),
    item('practices-discovery', 'open', { ordinal: '2.2', ...local }),
    item('requirements-analysis', 'open', { ordinal: '2.3', ...local }),
    item('user-stories', 'open', { ordinal: '2.4', isCurrent: true, ...local }),
    item('refined-mockups', 'planned', { ordinal: '2.5' }),
    item('domain-design', 'planned', { ordinal: '2.6' }),
    item('units-generation', 'planned', { ordinal: '2.7' }),
    item('contract-design', 'planned', { ordinal: '2.8' }),
    item('delivery-planning', 'planned', { ordinal: '2.9' }),
  ], { ordinal: '2', percent: 25, counts: { done: 2, total: 8 } })
  const construction = section('CONSTRUCTION', 'Construction', 'planned', [item('functional-design', 'planned')], { ordinal: '3', isUncounted: true })
  delete construction.counts
  delete construction.percent
  return sideJobModel({
    header: {
      title: 'daily-page-mvp',
      mode: 'side-job',
      subtitle: 'Inception · user-stories',
      badge: 'Side job',
      caption: 'This session is not bound to a stage of daily-page-mvp. Progress below is the intent the workspace points at.',
      updatedAt: '',
      context: [{ text: 'on main' }],
    },
    overall: { percent: 60, counts: { done: 9, total: 15 } },
    sections: [
      section('INITIALIZATION', 'Initialization', 'built', ['a', 'b', 'c'].map(id => item(id, 'done')), { ordinal: '0' }),
      section('IDEATION', 'Ideation', 'built', ['d', 'e', 'f', 'g'].map(id => item(id, 'done')), { ordinal: '1' }),
      inception,
      construction,
      section('OPERATION', 'Operation', 'skipped', [item('deployment-pipeline', 'skipped')], { ordinal: '4' }),
    ],
    gates: [],
  })
}

/** The design canvas's sample (direction A): a stage session, a PR in review, a park waiting on it. */
function designModel(): PanelModel {
  const pr = (number: number, tone: 'success' | 'accent' = 'success') => ({ kind: 'pr' as const, label: `#${number}`, tone, href: `https://github.com/acme/shop/pull/${number}` })
  const inception = section('INCEPTION', 'Inception', 'active', [
    item('reverse-engineering', 'skipped', { ordinal: '3.1' }),
    item('practices-discovery', 'done', { ordinal: '3.2', landing: 'merged', chips: [pr(27)] }),
    item('requirements-analysis', 'done', { ordinal: '3.3', landing: 'merged', chips: [pr(30)] }),
    item('user-stories', 'done', { ordinal: '3.4', landing: 'merged', chips: [pr(32)] }),
    item('refined-mockups', 'open', { ordinal: '3.5', landing: 'in-pr', chips: [pr(33, 'accent')], statusWord: 'awaiting dev-b', review: 'awaiting' }),
    item('domain-design', 'planned', { ordinal: '3.6', isCurrent: true, statusWord: 'up next' }),
    item('units-generation', 'planned', { ordinal: '3.7' }),
    item('contract-design', 'planned', { ordinal: '3.8' }),
    item('delivery-planning', 'planned', { ordinal: '3.9' }),
  ], { ordinal: '3' })
  const construction = section('CONSTRUCTION', 'Construction', 'planned', [item('functional-design', 'planned')], { ordinal: '4', isUncounted: true })
  delete construction.counts
  delete construction.percent
  const gates: Gate[] = [
    { id: 'pr:33', kind: 'pr-not-merged', tone: 'warning', title: 'PR #33 not merged', caption: "domain-design can't start on main until it lands.", sectionId: 'INCEPTION', afterItemId: 'refined-mockups', href: 'https://github.com/acme/shop/pull/33' },
    { id: 'parked', kind: 'parked', tone: 'warning', title: 'Parked at domain-design', caption: 'Waiting on PR #33 to merge; parked 11 Oct, 06:32.', sectionId: 'INCEPTION', afterItemId: 'refined-mockups', command: '/aidlc' },
  ]
  return stageModel({
    header: { title: 'shop-mvp-restart', mode: 'stage', subtitle: 'Inception · domain-design', badge: 'stage', caption: '', updatedAt: '', base: 'main: refined-mockups in review, PR #33' },
    next: { command: '/aidlc', reason: 'Execute Domain Design' },
    overall: { percent: 45, counts: { done: 10, total: 22 } },
    sections: [
      section('INITIALIZATION', 'Initialization', 'built', ['a', 'b', 'c'].map(id => item(id, 'done')), { ordinal: '1' }),
      section('IDEATION', 'Ideation', 'built', ['d', 'e', 'f', 'g'].map(id => item(id, 'done')), { ordinal: '2' }),
      inception,
      construction,
      section('OPERATION', 'Operation', 'skipped', [item('deployment-pipeline', 'skipped')], { ordinal: '5' }),
    ],
    gates,
  })
}

const SCENARIOS: Record<string, () => PanelModel | null> = {
  'Design sample (stage, PR in review)': designModel,
  'Screenshot: side job, local only': screenshotModel,
  'Test world: stage': () => stageModel(),
  'Test world: side job': () => sideJobModel(),
  'Test world: ledger': () => ledgerModel(),
  'Test world: idle': () => idleModel(),
  'No plan': () => null,
}

function Pane({ theme, width, model }: { theme: 'dark' | 'light'; width: number; model: PanelModel | null }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const columns = Math.floor((width - 36) / ADVANCE)
  const tree = renderPane(
    desktopKit as never,
    'desktop',
    columns,
    model,
    expanded,
    {
      onRefresh: () => undefined,
      onToggle: (id, isOpen) => setExpanded(folds => ({ ...folds, [id]: isOpen })),
      onAction: () => undefined,
      onFillNext: command => console.log('put in prompt:', command),
    },
    { now: NOW, checkedAt: NOW - 2_000 },
    manifest.version,
  )
  return (
    <div className={`pane ${theme}`} style={{ width }}>
      <div className="chrome">
        <span>Project</span>
        <span className="icons">⤢ ✕</span>
      </div>
      <div className="body">{tree as never}</div>
      <div className="meta">
        {theme} · {width}px · {columns} columns
      </div>
    </div>
  )
}

function App() {
  const [scenario, setScenario] = useState(() => localStorage.getItem('scenario') ?? Object.keys(SCENARIOS)[0]!)
  const [width, setWidth] = useState(() => Number(localStorage.getItem('width') ?? 414))
  const model = (SCENARIOS[scenario] ?? designModel)()
  return (
    <div className="page">
      <div className="controls">
        <select
          value={scenario}
          onChange={event => {
            setScenario(event.target.value)
            localStorage.setItem('scenario', event.target.value)
          }}
        >
          {Object.keys(SCENARIOS).map(name => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <label>
          width
          <input
            type="range"
            min={300}
            max={1100}
            value={width}
            onChange={event => {
              setWidth(Number(event.target.value))
              localStorage.setItem('width', event.target.value)
            }}
          />
          {width}px
        </label>
      </div>
      <div className="panes" key={scenario}>
        <Pane theme="dark" width={width} model={model} />
        <Pane theme="light" width={width} model={model} />
      </div>
    </div>
  )
}

const css = `
  body { margin: 0; background: #e9e8e4; font: 14px/19px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; }
  .page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .controls { display: flex; gap: 16px; align-items: center; font-size: 13px; }
  .controls label { display: flex; gap: 8px; align-items: center; }
  .panes { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .pane { border-radius: 12px; overflow: hidden; background: var(--bg); color: var(--text); border: 1px solid var(--frame); }
  .pane .chrome { display: flex; justify-content: space-between; padding: 10px 16px; color: var(--dim); font-size: 13px; }
  .pane .body { padding: 6px 18px 18px; }
  .pane .meta { padding: 6px 16px; font-size: 11px; color: var(--dim); border-top: 1px solid var(--frame); }
  .dark { --bg: #1d1d1c; --frame: #333331; --text: #ecebe6; --dim: #9b9a95; --inactive: #9b9a95; --subtle: #4a4946;
    --success: #4eba65; --error: #ff6b80; --warning: #e5a83a; --claude: #d97757; --suggestion: #b1b9f9; --merged: #af87ff;
    --permission: #b1b9f9; --inverseText: #1d1d1c; --btn: #2c2c2a; --btnBorder: #444340; }
  .light { --bg: #ffffff; --frame: #dedcd5; --text: #1a1915; --dim: #6b6a63; --inactive: #6b6a63; --subtle: #c9c6bc;
    --success: #2c7a39; --error: #ab2b3f; --warning: #966c1e; --claude: #c4643f; --suggestion: #5769f7; --merged: #8a5cf5;
    --permission: #5769f7; --inverseText: #ffffff; --btn: #f6f5f1; --btnBorder: #d6d3ca; }
  button.plain { all: unset; cursor: pointer; display: block; min-width: 0; }
  button.plain:hover { text-decoration: underline; }
  button.native { font: inherit; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 7px;
    border: 1px solid var(--btnBorder); background: var(--btn); color: var(--text); cursor: pointer; white-space: nowrap; }
  button.native.primary { background: var(--claude); border-color: var(--claude); color: #fff; }
  button.native kbd { font: 11px ui-monospace, Menlo, monospace; border: 1px solid var(--btnBorder); border-radius: 4px; padding: 0 4px; color: var(--dim); }
`
const style = document.createElement('style')
style.textContent = css
document.head.append(style)
createRoot(document.getElementById('root')!).render(<App />)
