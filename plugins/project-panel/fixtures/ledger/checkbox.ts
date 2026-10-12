// Fixture: a synthetic checkbox ledger (phases as `## `, items as task-list entries). No PRs.
import type { Pr } from '../../src/providers/ledger/types'

/** Sanitised excerpt of the ledger: links, run ids, hostnames and long prose are gone; ids, sizes, deps and headings are kept. */
export const ledgerText: string = [
  '# Roadmap',
  '',
  'A synthetic checkbox ledger used to exercise the parser.',
  '',
  '## Phase 1 — Foundations',
  '',
  '- [x] **API-3** Rate limiting',
  '- [ ] API-4: Pagination',
  '- [x] Project scaffolding',
  '- [ ] **API-30** Audit log',
  '  - [x] Nested sub-item without an id',
  '- [X] DOC-1 — Write the README',
  '* [ ] Star bullet item',
  '',
  '```md',
  '- [ ] not an item',
  '## not a phase',
  '```',
  '',
  '## Phase 2 — Launch',
  '',
  '- [ ] Beta signup form',
  '- [ ] **WEB-12:** Landing page',
  '- [x] Pricing page',
  '',
  '## Empty phase',
  '',
  'Just prose, no tasks here.',
].join('\n')

export const prs: Pr[] = []
