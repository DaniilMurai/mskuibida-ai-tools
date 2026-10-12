import { describe, expect, test } from 'claude-code/testing'
import { matchPrs } from '../../src/providers/ledger/match'
import { pickNext } from '../../src/providers/ledger/next'
import { legendOf, parseLedger, statusOf } from '../../src/providers/ledger/parse'
import { WORD_ID, citationsOf, isTableId, leadCitationsOf } from '../../src/providers/ledger/text'
import * as md from '../../fixtures/ledger/status-md'
import { pr } from './helpers'

const parsed = parseLedger(md.ledgerText)
const byId = new Map(parsed.items.map(i => [i.id, i]))
const numbers = (prs: { number: number }[]) => prs.map(p => p.number)
const bang = { citePrefix: '!' } as const

describe('word ids', () => {
  test('hyphenated all-caps ids are ids, bare words and lowercase are not', () => {
    for (const ok of ['FEAT-BCP47-LANGUAGES', 'FIX-MODAL-SAFE-AREA', 'CHORE-STORE-BUILD-7', 'T-QA-SESSION-URL', 'D15-TYPE-SCALE', 'FIX-T4C']) {
      expect(WORD_ID.test(ok)).toBe(true)
      expect(isTableId(ok)).toBe(true)
    }
    for (const bad of ['FIX', 'API', 'Fix-It', 'FIX--X', '-FIX-X', 'FIX-']) expect(WORD_ID.test(bad)).toBe(false)
  })
})

describe('status ledger: items', () => {
  test('title, phase and the rows that become items', () => {
    expect(parsed.title).toBe('Build status')
    expect(parsed.items.map(i => i.id)).toEqual([
      'T1', 'T2', 'T4', 'T4b', 'FIX-T4-IDENTIFY-DEFECTS', 'T7a', 'T6', 'T10', 'T14', 'T16', 'T19', 'T20', 'T21', 'T22',
      'FEAT-BCP47-LANGUAGES', 'CHORE-STORE-BUILD-7', 'DOCS-DEMO-PARITY', 'T-QA-SESSION-URL', 'D15-TYPE-SCALE',
      'FIX-MODAL-SAFE-AREA', 'T25a',
    ])
    expect(parsed.phases).toEqual(['1 · Foundation'])
    expect(parsed.checkboxCount).toBe(0)
  })
  test('the Piece, Why and Ask tables yield no items, and a bare-word id is not an id', () => {
    expect(byId.has('FIX')).toBe(false)
    for (const it of parsed.items) expect(it.phase).toBe('1 · Foundation')
    expect(parsed.items.some(i => /Flow A|Wallet|Shift|Dark|Brand|localCopy/.test(i.id + i.title))).toBe(false)
  })
  test('titles come from the id cell, cut at the first dash or sentence end', () => {
    expect(byId.get('T1')?.title).toBe('Scaffold, stack, router shell, theme')
    expect(byId.get('T4')?.title).toBe('Identify')
    expect(byId.get('T4b')?.title).toBe('Identify')
    expect(byId.get('T16')?.title).toBe('Capability switches')
    expect(byId.get('T6')?.title).toBe('Top-up') // a bold span later in the cell is not the id
    expect(byId.get('FEAT-BCP47-LANGUAGES')?.title).toBe('BCP-47 language codes for the locale list')
    expect(byId.get('FIX-T4-IDENTIFY-DEFECTS')?.title).toBe('The three T4 defects QA found, plus a fourth')
  })
  test('a Notes column is never read as dependencies or size', () => {
    for (const it of parsed.items) {
      expect(it.deps).toEqual([])
      expect(it.size).toBeNull()
    }
  })
  test('declared status comes from the Status column, through the legend and the glyph defaults', () => {
    const declared = (id: string) => byId.get(id)?.declared
    expect(declared('T1')).toBe('done')
    expect(declared('FEAT-BCP47-LANGUAGES')).toBe('done')
    expect(declared('T14')).toBe('open') // 🔨 **in flight** — MR open, stacked on !61
    expect(declared('T19')).toBe('held') // 🔒 **not built, OUT OF v1**
    expect(declared('T20')).toBe('held') // 🔒 **not built, in v1**
    expect(declared('T21')).toBe('open') // 🔄 is not in the legend
    expect(declared('T22')).toBe('open') // 🟡 is not in the legend
    expect(declared('T-QA-SESSION-URL')).toBe('open')
    expect(declared('FIX-MODAL-SAFE-AREA')).toBe('open')
  })
})

describe('legend and status cells', () => {
  test('the legend line (wrapped, bold, with parentheses) gives each glyph its meaning', () => {
    const legend = legendOf(md.ledgerText)
    expect(legend.get('✅')).toBe('done')
    expect(legend.get('🔨')).toBe('open')
    expect(legend.get('⛔')).toBe('held')
    expect(legend.get('🔒')).toBe('held')
    expect(legend.has('🔄')).toBe(false)
  })
  test('a file may redefine a glyph; legend words feed the built-in vocabulary', () => {
    const legend = legendOf('> Legend: 🟢 in progress · 🔴 done\n\n| Unit | Status |\n')
    expect(legend.get('🟢')).toBe('open')
    expect(legend.get('🔴')).toBe('done')
    expect(statusOf('🟢', legend)).toBe('open')
    expect(statusOf('🟢', new Map())).toBe('done')
  })
  test('a legend with no Status or Legend line is empty', () => {
    expect(legendOf('# Title\n\n| Unit | Status |\n').size).toBe(0)
  })
  test('the first recognised glyph wins, then the first words, otherwise null', () => {
    const legend = new Map()
    expect(statusOf('⚠️ ✅ ⛔', legend)).toBe('done')
    expect(statusOf('✔️', legend)).toBe('done')
    expect(statusOf('⏳ waiting', legend)).toBe('open')
    expect(statusOf('⬜', legend)).toBe('planned')
    expect(statusOf('**Done** on main', legend)).toBe('done')
    expect(statusOf('In progress', legend)).toBe('open')
    expect(statusOf('not built yet', legend)).toBe('held')
    expect(statusOf('maybe later', legend)).toBeNull()
    expect(statusOf('', legend)).toBeNull()
  })
})

describe('citations', () => {
  test('landed via / merged in / merged `sha` (!N)', () => {
    expect(citationsOf('landed via !60. More')).toEqual([{ prefix: '!', number: 60 }])
    expect(citationsOf('merged via #12 and landed in !7, merged in !8')).toEqual([
      { prefix: '#', number: 12 }, { prefix: '!', number: 7 }, { prefix: '!', number: 8 },
    ])
    expect(citationsOf('merged `003723f` (!14). Done')).toEqual([{ prefix: '!', number: 14 }])
    expect(citationsOf('landed via **!47**')).toEqual([{ prefix: '!', number: 47 }])
    expect(citationsOf('landed via !5, landed via !5')).toEqual([{ prefix: '!', number: 5 }])
  })
  test('citations inside backticks and bare mentions are ignored', () => {
    expect(citationsOf('see `landed via !99`')).toEqual([])
    expect(citationsOf('stacked on !61, and !7 follows')).toEqual([])
  })
  test('only a citation that opens a cell counts: leadCitationsOf', () => {
    expect(leadCitationsOf('landed via !70. Later: landed in !52')).toEqual([{ prefix: '!', number: 70 }])
    expect(leadCitationsOf('✅ **landed via !52**')).toEqual([{ prefix: '!', number: 52 }])
    expect(leadCitationsOf('— merged `e561b11` (!43). Closes')).toEqual([{ prefix: '!', number: 43 }])
    expect(leadCitationsOf('Closes the seam that landed in !52')).toEqual([])
    expect(leadCitationsOf('`landed via !9`')).toEqual([])
  })
  test('a row cites only how its own unit landed, not the MRs it mentions', () => {
    const rows = [
      '| Unit | Status | Notes |',
      '|---|---|---|',
      '| T13a · Store setup | ✅ | landed via !70. Reuses the dark theme that landed in !52 (`QA-T13A-IOS`, landed via !72). |',
      '| T17 · Shell | ✅ | landed via !65. Home is a hub (landed via !97; later). |',
      '| T18 · Status in its own cell | ✅ **landed via !52** | Notes only. |',
    ].join('\n')
    const items = new Map(parseLedger(rows).items.map(i => [i.id, i]))
    expect(items.get('T13a')?.citations).toEqual([{ prefix: '!', number: 70 }])
    expect(items.get('T17')?.citations).toEqual([{ prefix: '!', number: 65 }])
    expect(items.get('T18')?.citations).toEqual([{ prefix: '!', number: 52 }])
  })
  test('rows carry their citations; items from other shapes carry none', () => {
    expect(byId.get('T7a')?.citations).toEqual([{ prefix: '!', number: 66 }])
    expect(byId.get('FEAT-BCP47-LANGUAGES')?.citations).toEqual([{ prefix: '!', number: 275 }])
    expect(byId.get('FIX-T4-IDENTIFY-DEFECTS')?.citations).toEqual([{ prefix: '!', number: 14 }])
    expect(byId.get('T25a')?.citations).toEqual([{ prefix: '!', number: 114 }])
    expect(byId.get('T1')?.citations).toEqual([])
    expect(byId.get('T14')?.citations).toEqual([])
    const heading = parseLedger('#### T01 — Thing\n\nlanded via !4\n')
    expect(heading.items[0]?.citations).toEqual([])
  })
})

describe('status ledger: matching', () => {
  const m = matchPrs(parsed.items, md.prs, bang)

  test('word ids match merge-request-like PRs by branch and by title', () => {
    expect(numbers(m.get('FEAT-BCP47-LANGUAGES')?.prs ?? [])).toEqual([275])
    expect(m.get('T-QA-SESSION-URL')).toMatchObject({ status: 'open', source: 'pr' })
    expect(numbers(m.get('T-QA-SESSION-URL')?.prs ?? [])).toEqual([290])
    expect(numbers(m.get('FIX-MODAL-SAFE-AREA')?.prs ?? [])).toEqual([301])
  })
  test('without a cite prefix the id matches alone decide', () => {
    const plain = matchPrs(parsed.items, md.prs)
    expect(numbers(plain.get('T7a')?.prs ?? [])).toEqual([310])
    expect(plain.get('T7a')?.status).toBe('open')
  })
  test('a cited PR wins over a title match: merged citation beats an open polish PR', () => {
    expect(numbers(m.get('T7a')?.prs ?? [])).toEqual([66])
    expect(m.get('T7a')).toMatchObject({ status: 'done', source: 'pr' })
    expect(numbers(m.get('T7a')?.followups ?? [])).toEqual([310])
  })
  test('a cited open PR makes the item open even though the ledger says done', () => {
    expect(byId.get('CHORE-STORE-BUILD-7')?.declared).toBe('done')
    expect(m.get('CHORE-STORE-BUILD-7')).toMatchObject({ status: 'open', source: 'pr' })
    expect(numbers(m.get('CHORE-STORE-BUILD-7')?.prs ?? [])).toEqual([281])
  })
  test('a citation with the other prefix is ignored', () => {
    const hash = matchPrs(parsed.items, md.prs, { citePrefix: '#' })
    expect(numbers(hash.get('T7a')?.prs ?? [])).toEqual([310])
  })
  test('a cited PR missing from the list falls back to normal matching', () => {
    const only = matchPrs(parsed.items, [pr(400, 'feat/FEAT-BCP47-LANGUAGES', { state: 'MERGED' })], bang)
    expect(numbers(only.get('FEAT-BCP47-LANGUAGES')?.prs ?? [])).toEqual([400])
    const none = matchPrs(parsed.items, [], bang)
    expect(none.get('FEAT-BCP47-LANGUAGES')).toMatchObject({ status: 'done', source: 'declared', prs: [] })
  })
  test('a cited PR that was closed unmerged does not decide', () => {
    const closed = matchPrs(parsed.items, [pr(275, 'claude/x', { state: 'CLOSED' }), pr(401, 'feat/FEAT-BCP47-LANGUAGES', { state: 'OPEN' })], bang)
    expect(numbers(closed.get('FEAT-BCP47-LANGUAGES')?.prs ?? [])).toEqual([401])
    expect(closed.get('FEAT-BCP47-LANGUAGES')?.status).toBe('open')
  })
  test('qa:failed on a cited PR fails the item', () => {
    const failed = matchPrs(parsed.items, [pr(60, 'claude/x', { labels: ['qa:failed'] })], bang)
    expect(failed.get('T16')?.status).toBe('failed')
  })
  test('T1 never matches T10', () => {
    expect(m.get('T1')).toMatchObject({ status: 'done', source: 'declared', prs: [] })
    expect(numbers(m.get('T10')?.prs ?? [])).toEqual([12])
    expect(m.get('T10')?.status).toBe('done')
  })
  test('items with no evidence keep their declared status', () => {
    expect(m.get('T19')).toMatchObject({ status: 'planned', source: 'declared' })
    expect(m.get('T14')).toMatchObject({ status: 'open', source: 'declared' })
  })
  test('a held item (🔒 not built, ⛔ blocked) counts as planned but is never next', () => {
    const items = parseLedger(
      ['| Unit | Status | Notes |', '|---|---|---|', '| T1 · Cash sale | 🔒 not built | out of v1 |', '| T2 · Blocked one | ⛔ | waits |', '| T3 · Store build | ⬜ | |'].join('\n'),
    ).items
    const matches = matchPrs(items, [])
    expect(matches.get('T1')?.status).toBe('planned')
    expect(pickNext(items, matches)?.itemId).toBe('T3')
  })
})

describe('review regressions', () => {
  test('prose is not a task: word-id headings, checkboxes and non-ledger tables make no items', () => {
    const text = [
      '### NON-GOALS — what we skip',
      '### PRE-PROD: notes',
      '- [ ] E2E-TESTS: add',
      '',
      '| Env | Status |',
      '|---|---|',
      '| PRE-PROD - staging | ✅ |',
      '| API-V2: deprecated | ⛔ |',
      '| Q3 - launch | ⬜ |',
    ].join('\n')
    expect(parseLedger(text).items.filter(i => i.hasRealId).map(i => i.id)).toEqual([])
  })
  test('an id column keeps the other separators; a ` · ` row needs no header', () => {
    const withHeader = parseLedger(['| ID | Status |', '|---|---|', '| FEAT-AUTH - Sign in | ✅ |'].join('\n'))
    expect(withHeader.items.map(i => i.id)).toEqual(['FEAT-AUTH'])
    const dotted = parseLedger(['| Thing | Status |', '|---|---|', '| FEAT-AUTH · Sign in | ✅ |'].join('\n'))
    expect(dotted.items.map(i => i.id)).toEqual(['FEAT-AUTH'])
  })
  test('a word id does not claim the PRs of a longer word id; a lower-case slug after it is fine', () => {
    const items = parseLedger(['| Unit | Status |', '|---|---|', '| FEAT-AUTH · Sign in | ⬜ |'].join('\n')).items
    const longer = matchPrs(items, [pr(9, 'feat/FEAT-AUTH-SSO', { title: 'FEAT-AUTH-SSO: add sso' })])
    expect(longer.get('FEAT-AUTH')?.status).toBe('planned')
    const slugged = matchPrs(items, [pr(10, 'feat/FEAT-AUTH-add-login', { title: 'Add login' })])
    expect(slugged.get('FEAT-AUTH')?.status).toBe('done')
  })
  test('a `Status: draft` line does not hide the legend that follows it', () => {
    const legend = legendOf(['**Status:** living doc', '', 'Status: **✅ shipped** · **🔨 in flight**'].join('\n'))
    expect(legend.get('✅')).toBe('done')
    expect(legend.get('🔨')).toBe('open')
  })
  test('`pending review` is in progress, not planned', () => {
    expect(statusOf('pending review', new Map())).toBe('open')
    expect(statusOf('pending', new Map())).toBe('planned')
  })
})
