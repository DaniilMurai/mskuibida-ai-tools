import { describe, expect, test } from 'claude-code/testing'
import { isSendable, ledgerCandidates, pickLedger, readDeliveryFrontMatter } from '../../src/providers/ledger/discover'
import * as checkbox from '../../fixtures/ledger/checkbox'
import * as rem from '../../fixtures/ledger/reminders'

/** A reader backed by a map that records every path it is asked for. */
function reader(files: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    read: async (p: string): Promise<string | null> => {
      reads.push(p)
      return files[p] ?? null
    },
  }
}

describe('readDeliveryFrontMatter', () => {
  test('reads key: value lines between the leading fences', () => {
    const text = ['---', 'task-ledger: docs/WORKPLAN.md', 'level: "review"', '# comment', '- list', '---', 'task-ledger: ignored.md'].join('\n')
    expect(readDeliveryFrontMatter(text)).toEqual({ 'task-ledger': 'docs/WORKPLAN.md', level: 'review' })
  })
  test('no leading fence, or no closing fence, means no front matter', () => {
    expect(readDeliveryFrontMatter('task-ledger: x.md')).toEqual({})
    expect(readDeliveryFrontMatter('---\ntask-ledger: x.md\nbody')).toEqual({})
    expect(readDeliveryFrontMatter('')).toEqual({})
  })
  test('tolerates a BOM, leading blank lines and CRLF', () => {
    expect(readDeliveryFrontMatter('﻿\r\n---\r\ntask-ledger: A.md\r\n---\r\n')).toEqual({ 'task-ledger': 'A.md' })
  })
})

describe('ledgerCandidates', () => {
  test('root names first, then docs/ names, then docs plan*.md, each group in priority order', () => {
    const tracked = ['src/a.ts', 'docs/plan-notes.md', 'docs/WORKPLAN.md', 'TODO.md', 'ROADMAP.md', 'workplan.md', 'docs/sub/Plan-2.md', 'docs/TODO.md']
    expect(ledgerCandidates(tracked)).toEqual([
      'workplan.md',
      'ROADMAP.md',
      'TODO.md',
      'docs/WORKPLAN.md',
      'docs/TODO.md',
      'docs/plan-notes.md',
      'docs/sub/Plan-2.md',
    ])
  })
  test('only tracked paths are candidates; nested names are not root candidates', () => {
    expect(ledgerCandidates(['packages/x/WORKPLAN.md', 'README.md'])).toEqual([])
  })
  test('no duplicates when docs/PLAN.md matches twice', () => {
    expect(ledgerCandidates(['docs/PLAN.md'])).toEqual(['docs/PLAN.md'])
  })
})

describe('isSendable', () => {
  const tracked = new Set(['src/a.ts', '.env', '.env.production', 'config/.env.local', 'PROGRESS.local', 'docs/x.local', '.git/config', 'a/.git/x', 'docs/WORKPLAN.md', '../up.md'])
  test('tracked ordinary files are sendable', () => {
    expect(isSendable('src/a.ts', tracked)).toBe(true)
    expect(isSendable('docs/WORKPLAN.md', tracked)).toBe(true)
  })
  test('untracked paths never are', () => {
    expect(isSendable('src/b.ts', tracked)).toBe(false)
  })
  test('.env* in any segment and *.local are rejected even when tracked', () => {
    for (const p of ['.env', '.env.production', 'config/.env.local', 'PROGRESS.local', 'docs/x.local']) expect(isSendable(p, tracked)).toBe(false)
  })
  test('.git contents and parent escapes are rejected', () => {
    expect(isSendable('.git/config', tracked)).toBe(false)
    expect(isSendable('a/.git/x', tracked)).toBe(false)
    expect(isSendable('../up.md', tracked)).toBe(false)
  })
})

describe('pickLedger', () => {
  test('docs/DELIVERY.md front matter wins when its path is tracked', async () => {
    const r = reader({
      'docs/DELIVERY.md': '---\ntask-ledger: notes/LEDGER.md\n---\n',
      'WORKPLAN.md': rem.ledgerText,
    })
    const picked = await pickLedger(['docs/DELIVERY.md', 'WORKPLAN.md', 'notes/LEDGER.md'], r.read)
    expect(picked).toEqual({ path: 'notes/LEDGER.md', via: 'delivery' })
    expect(r.reads).toEqual(['docs/DELIVERY.md'])
  })
  test('a delivery path that is not tracked is ignored; discovery takes over', async () => {
    const r = reader({ 'docs/DELIVERY.md': '---\ntask-ledger: gone.md\n---\n', 'WORKPLAN.md': rem.ledgerText })
    expect(await pickLedger(['docs/DELIVERY.md', 'WORKPLAN.md'], r.read)).toEqual({ path: 'WORKPLAN.md', via: 'discovered' })
  })
  test('a delivery path that is unsendable is ignored', async () => {
    const r = reader({ 'docs/DELIVERY.md': '---\ntask-ledger: PLAN.local\n---\n', 'WORKPLAN.md': rem.ledgerText })
    expect(await pickLedger(['docs/DELIVERY.md', 'PLAN.local', 'WORKPLAN.md'], r.read)).toEqual({ path: 'WORKPLAN.md', via: 'discovered' })
    expect(r.reads).not.toContain('PLAN.local')
  })
  test('the first candidate that parses as a ledger wins; thin files are skipped', async () => {
    const r = reader({ 'TODO.md': '- [ ] one\n- [ ] two\n', 'docs/WORKPLAN.md': rem.ledgerText })
    expect(await pickLedger(['TODO.md', 'docs/WORKPLAN.md'], r.read)).toEqual({ path: 'docs/WORKPLAN.md', via: 'discovered' })
    expect(r.reads).toEqual(['TODO.md', 'docs/WORKPLAN.md'])
  })
  test('five checkboxes are enough; fewer real-id rows are not', async () => {
    const r = reader({ 'ROADMAP.md': checkbox.ledgerText })
    expect(await pickLedger(['ROADMAP.md'], r.read)).toEqual({ path: 'ROADMAP.md', via: 'discovered' })
    const thin = reader({ 'PLAN.md': '| **A1** | t | — | S |\n| **A2** | t | — | S |\n' })
    expect(await pickLedger(['PLAN.md'], thin.read)).toBeNull()
  })
  test('untracked files are never read, even when they exist', async () => {
    const r = reader({ 'WORKPLAN.md': rem.ledgerText, 'ROADMAP.md': rem.ledgerText })
    expect(await pickLedger(['ROADMAP.md'], r.read)).toEqual({ path: 'ROADMAP.md', via: 'discovered' })
    expect(r.reads).toEqual(['ROADMAP.md'])
    expect(await pickLedger(['src/index.ts'], r.read)).toBeNull()
    expect(r.reads).toEqual(['ROADMAP.md'])
  })
  test('a candidate that cannot be read is skipped', async () => {
    const r = reader({ 'docs/WORKPLAN.md': rem.ledgerText })
    expect(await pickLedger(['WORKPLAN.md', 'docs/WORKPLAN.md'], r.read)).toEqual({ path: 'docs/WORKPLAN.md', via: 'discovered' })
  })
})
