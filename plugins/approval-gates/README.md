# approval-gates

At every AI-DLC approval gate, the stage's documents become one readable page in a private
artifact, **AI-DLC approval gates**, published once per developer from the template in this plugin.
The agent writes the documents as rows, sends the page's link in a message before the gate question, and the developer
reads them there: the summary, the review brief, then every document of the stage in a view made for
its kind. A note per document goes back to the agent, which quotes it when the developer chooses
Request Changes. The decision itself is given in chat; the engine's gate question is unchanged and the
page holds no decision.

```
skills/approval-gates/SKILL.md            the procedure the agent follows at every gate
skills/approval-gates/approval-gate.html  the template — the data contract is in its header
skills/release/SKILL.md                   /approval-gates:release
scripts/gate_bundle.py                    builds the rows for one gate from the intent's files
hooks/gate_guard.py                       the guard (hooks/hooks.json registers it)
```

## What you see

A page per gate, newest first in a list grouped by intent. A gate uses the whole width: a compact
header with the stage, round and what comes next; an outline on the left (every document and its
sections, with Expand all and Collapse all); and a column of collapsible blocks: the agent's summary,
the review (verdict, open-finding count, a findings table whose rows open to the finding, where and
required action), then every document, each with its sections collapsible and a Note button for a
note to Claude. JSON, questions and review copies start collapsed. A document longer than a database
row is split at its headings and joined back on the page.

Each document kind has its own view, with a Text switch back to the document as written:

- **entities.md**: an entity diagram from the `entities:` block's relations, then a section per entity
  with its attributes (type, required, unique, default, limits, allowed values), constraints and
  relations.
- **rules.md**: the `rules:` block as a table per group (BR1, BR2, …), filterable by category and
  searchable; a row opens to the rule's logic, trigger, violation and source.
- **components.md**, **logical-components.md**: a dependency graph (calls solid, events dashed) and a
  card per component with what it does, what it depends on, who uses it and its entities.
- **unit-of-work-dependency.md**: the `units:` block as build layers, first the Units with no
  dependencies. **unit-of-work.md**: a section per Unit with its facts. **unit-of-work-story-map.md**:
  the map grouped by Unit.
- **stories.md**: cards by epic with priority, traces and every acceptance criterion split into
  Given, When and Then. **requirements.md** and the NFR files: a table per group, searchable.
- **decisions.md**: a card per ADR with its status, the Decision open and Context, Consequences and
  Alternatives folded. **bolt-plan.md**: a strip of Bolts with their points, then each Bolt.
- **contract-summary.md**: a section per contract; an OpenAPI block becomes an operations table, a type
  sheet a table per type. **traceability.json**: coverage by status.

- **Ideation and Inception documents**: **requirements.md** reads the table, the `- **FR1.1**` bullet
  and the titled `- **NFR1 Title:**` bullet (sub-bullets and source tags kept) as one table per group;
  **feasibility-assessment.md** shows the verdict as a banner and each area's rating as a chip;
  **raid-log.md**, **constraint-register.md**, **stakeholder-map.md** and the risk register of
  **risk-and-sequencing-rationale.md** are grids with the id linked, likelihood, impact and severity as
  chips, and a tally strip over the sections; **team-practices.md** and **team-allocation.md** fold each
  labelled practice under its label; **discovered-rules.md** marks ALWAYS and NEVER lines;
  **user-stories-assessment.md** shows the decision as a banner; **wireframes.md**, **mockups.md** and
  the other screen documents frame every ASCII screen with its heading as caption and add an "All
  screens" section that shows them side by side. **intent-statement.md**, **scope-document.md**,
  **intent-backlog.md**, **evidence.md**, **user-flow.md** (Mermaid flows drawn),
  **interaction-spec.md**, **design-system-mapping.md** and **accessibility-checklist.md** get a facts
  row from their bold-label lines, tables as grids (a filter bar over 8 rows), numbered lists as
  steppers and every H2 as a collapsible section. Source tags such as `[Q3]` or `[assumption]` are
  quiet tags, and a `Q` id links to its question.

Every id that names something in the gate (FR1.2, BR3.5, US1.1, AC1.1.2, ADR-003, U3, C4, R-02, an
entity or component name) is a link: hover for the text, click to jump. A document whose shape is not
recognised is Markdown with every H2 a collapsible section.

## What the agent does

After `aidlc engine orchestrate report --result awaiting-approval` (or `revised`), it runs
`gate_bundle.py`, writes the rows with one `ArtifactData` batch, sends you `<artifact url>#<gate id>` in a
message of its own, and then asks the Approval question. After Request Changes it reads `gates/<id>` and quotes your notes in
the `--reason` of the rejected report. It never writes your notes, and never updates a row.

## What the hook refuses

- The Approval question (header `Approval`, an option such as Approve, Approve Plan or Accept as-is, no
  pull request named) until a `gates` row for the stage was written after the gate opened.
- The same question until a message of the agent in the session's transcript carries the page's link
  `<artifact url>#<gate id>`: you get the link before the question, every time.
- The same question with the page's link in its text: the link goes in a message of its own, so the dialog stays readable.
- `aidlc engine orchestrate report … --result approved|rejected|accepted` before that row exists.
- A write to `gates/<id>` that carries `notes` (or a decision field: the page records none).

It does nothing outside an AI-DLC project (no `aidlc/spaces`), on input it cannot read, and in the
after-call and prompt hooks it never fails. Its state is `~/.claude/approval-gates/<session>.json`
(`APPROVAL_GATES_DIR` changes the folder). To clear it, type `/approval-gates:release`.

## Data contract, in brief

```
gates/<id>                  {title, stage, stageName, phase?, intent, project?, unit?, round, why?, status,
                             createdAt, summary?, brief?, review?, nextStage?, options, documents: [index]}
gates/<id>/documents/<key>  {n, key, title, path, kind, text}
page writes                 gates/<id>.notes[<key>]
```

`<id>` is `<intent>-<stage>[-<unit>]-<YYYYMMDDTHHMM>`, new for every presentation. The full contract is
the header of `approval-gate.html`.

## Install

```bash
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install approval-gates@mskuibida-tooling
```

## Pairs with

`question-forms` (the same artifact style, and the questions files that come before a gate). The
`aidlc` CLI is needed only for the review brief; without it `gate_bundle.py` leaves the brief out.

## Tests

```bash
python3 -m unittest discover -s plugins/approval-gates/tests
```

Python 3 standard library only. The tests use a fake project under `tests/fixtures/project` and a
stand-in for `aidlc` (`$APPROVAL_GATES_AIDLC`).
