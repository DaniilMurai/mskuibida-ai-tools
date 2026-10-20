---
name: approval-gates
description: Use at every AI-DLC approval gate, right after `aidlc engine orchestrate report --result awaiting-approval` (or `--result revised`) and before the Approval question — publish the stage's documents as a page in the developer's "AI-DLC approval gates" artifact and send its link in a message of its own before the gate question. Also when the developer chose Request Changes, to read the notes they left in the page.
---

# Approval gates

Every approval gate gets a page, always. The engine's gate stays exactly as the engine prescribes:
the completion message, then the Approval question with `AskUserQuestion`, then the end of your turn.
The page, `approval-gate.html` next to this file, is where the developer **reads** the stage's
documents, each in a view made for its kind, and may leave a note per document. The decision itself
is given in chat; the page holds none. Its header comment is the data contract. Never generate,
restyle or edit a page per stage.

## 1. The artifact (once per developer)

`Artifact` → `action: "list"` → the artifact titled **AI-DLC approval gates**. If the developer
has none, publish `approval-gate.html` from this skill's directory once: `capabilities: {db: {}}`,
`icon: "document"`, description "Read a stage's AI-DLC documents at its approval gate; notes come back
to Claude." Reuse its URL for every gate from then on. After a plugin update, republish the page from
this file to the same URL once: the rows stay.

## 2. At every gate

After the `awaiting-approval` (or `revised`) report, and after the review brief was printed when the
stage has a reviewer:

1. Write your Part-2 summary of the stage (Markdown) to a file in the scratchpad folder.
2. Build the rows. Inside a skill the plugin root is `${CLAUDE_PLUGIN_ROOT}`:
   ```
   python3 "${CLAUDE_PLUGIN_ROOT}/scripts/gate_bundle.py" --stage <slug> [--unit <u>] --why <first|revision|stale> \
     --summary-file <the summary file> --out <a folder in the scratchpad>
   ```
   Use `--why revision` after a Request Changes round, `stale` when the review was out of date, otherwise
   `first`. It prints `{"id", "stage", "unit", "documents", "writes", "batches", "round"}` and writes
   `writes.json` next to the rows. Without a path it reads the project from `$CLAUDE_PROJECT_DIR`.
3. Send the rows with **one** `ArtifactData` `batch`: the `writes` array of `writes.json` as it is
   (`file_path` entries, no `if_version`, these are new rows). When the script says the writes do not
   fit one batch, send the files named in `batches`, in order. If a write is refused because the id exists,
   run the script again a minute later: an id is a time stamp.
4. Present the gate as the protocol says. The completion message gets the line
   `**Read:** <artifact url>#<id>` next to the `**Review:**` line; that message is where the link lives.
   Then ask the engine's question exactly as the protocol words it ("Delivery Planning complete. How
   would you like to proceed?"): no link, no URL and no gate id in the question text, so the dialog stays
   readable. The options stay the engine's. End the turn.

The plan checkpoint of Code Generation (Approve Plan) is a gate too: the same steps, with its
`code-generation-plan.md`.

## 3. After the answer

- `Approve`: the engine's approved report, as usual.
- `Request Changes`: first `ArtifactData` `get` of `gates/<id>`. If `notes` holds anything, quote it
  (each note under its document's title) in the rejected report's `--reason`, together with what the
  developer typed in chat. If the page holds nothing and the chat answer has no feedback, ask what
  should change, as the protocol says.
- After the revision and the new review, the `revised` report opens a fresh gate: § 2 again, with a new id.

## 4. Never

Never write `notes` (they are the developer's) or any decision field (the decision is given in chat),
and never update a row: each presentation is a fresh id.

## 5. The guard

`hooks/gate_guard.py` refuses the Approval question and the approved, rejected or accepted report until
a `gates` row for the stage was written in this session after the gate was opened, and refuses a question
that carries the page's link: the link goes in a message of its own. The developer clears it with `/approval-gates:release`.
