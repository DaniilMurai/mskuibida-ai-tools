# approval-gates

At every AI-DLC approval gate, the stage's documents become one readable page in a private
artifact, **AI-DLC approval gates**, published once per developer from the template in this plugin.
The agent writes the documents as rows, puts the page's link in the gate question, and the developer
reads them there: the summary, the review brief, then every document of the stage with its tables and
diagrams. A note per document and a draft decision go back to the agent, which reads them when the
developer chooses Request Changes. The decision itself is still given in chat, and the engine's gate
question is unchanged.

```
skills/approval-gates/SKILL.md            the procedure the agent follows at every gate
skills/approval-gates/approval-gate.html  the template — the data contract is in its header
skills/release/SKILL.md                   /approval-gates:release
scripts/gate_bundle.py                    builds the rows for one gate from the intent's files
hooks/gate_guard.py                       the guard (hooks/hooks.json registers it)
```

## What you see

A page per gate, newest first in a list grouped by intent. A gate shows its stage, round and review
verdict, the agent's summary, the review brief, and a document list on the left (chips on a phone).
Markdown renders with tables and Mermaid diagrams; JSON is collapsible. At the bottom a bar holds a draft
decision (Approve or Request changes, with a note). It saves as you press, and says to answer in chat.

## What the agent does

After `aidlc engine orchestrate report --result awaiting-approval` (or `revised`), it runs
`gate_bundle.py`, writes the rows with one `ArtifactData` batch, and asks the Approval question with
`<artifact url>#<gate id>` in it. After Request Changes it reads `gates/<id>` and quotes your notes in
the `--reason` of the rejected report. It never writes your notes or decision, and never updates a row.

## What the hook refuses

- The Approval question (header `Approval`, an option such as Approve, Approve Plan or Accept as-is, no
  pull request named) until a `gates` row for the stage was written after the gate opened.
- The same question without the link `<artifact url>#<gate id>` in its text.
- `aidlc engine orchestrate report … --result approved|rejected|accepted` before that row exists.
- A write to `gates/<id>` that sets `status: "decided"` or carries `decision` or `notes`.

It does nothing outside an AI-DLC project (no `aidlc/spaces`), on input it cannot read, and in the
after-call and prompt hooks it never fails. Its state is `~/.claude/approval-gates/<session>.json`
(`APPROVAL_GATES_DIR` changes the folder). To clear it, type `/approval-gates:release`.

## Data contract, in brief

```
gates/<id>                  {title, stage, stageName, phase?, intent, project?, unit?, round, why?, status,
                             createdAt, summary?, brief?, review?, nextStage?, options, documents: [index]}
gates/<id>/documents/<key>  {n, key, title, path, kind, text}
page writes                 gates/<id>.notes[<key>], gates/<id>.decision {k, note, at}, status "decided"
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
