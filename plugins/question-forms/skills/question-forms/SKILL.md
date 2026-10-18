---
name: question-forms
description: Use at every AI-DLC questions file, before the developer is asked to answer it — turn the file into a form in the developer's "AI-DLC question forms" artifact (rows in the artifact's database, never a new page), give the link, and when the developer says the form is done copy the saved answers word for word into the file's [Answer]: tags. Also for adding, changing or removing questions in an open form, and for follow-up questions.
---

# Question forms

Every questions file gets a form, always. The file stays the record and the engine keeps
reading it; the form is how the developer fills it. The template, `question-form.html` next to
this file, is the one page; its header comment is the data contract. Never generate, restyle or
edit a form page per stage.

## 1. The artifact (once per developer)

`Artifact` → `action: "list"` → the artifact titled **AI-DLC question forms**. If the
developer has none, publish `question-form.html` from this skill's directory once:
`capabilities: {db: {}}`, `icon: "form"`, description "Fill a stage's AI-DLC questions file in
a form; Claude copies the saved answers word for word into the file." Reuse its URL for every
form from then on.

## 2. Open a form (at every questions file)

As soon as the questions file is written, one `ArtifactData` `batch` (no `if_version`
on new documents):

- `forms/<id>` — `{title, stage, file, status: "open", createdAt}`; `id` is `[a-z0-9._-]+`,
  `<intent>-<stage-slug>` (a unit's file adds `-<unit>`). `title` is the stage name, `file` the
  repo-relative path.
- `forms/<id>/questions/<qid>` per question — `{n, text, ctx?, kind: "single"|"multi",
  options: [{k, t}], proposed?: {k, why}, hint?}`, copied from the file **as written**: the
  heading text, the context, the option letters and labels, the `**Proposed:**` line as
  `proposed`. Leave `X. Other` out; the page adds it. `kind: "multi"` when the question says
  select all that apply.
- A question with no real options is `kind: "text"` — `{n, text, ctx?, kind: "text", hint?,
  proposed?: {t}}`: only a text field, no Other. Never invent options to fill the space; a
  question whose honest answer is free text is a text question. `proposed.t` is a suggested
  answer the developer can take with one press.
- `ctx` keeps the questions file's paragraphs and bullet lists, written in the page's Markdown
  subset (the template's header comment): blocks separated by a blank line (`\n\n`); a list is
  a block of `- ` lines only, each with a **bold** lead-in; inside both, inline `` `code` `` and
  `**bold**`. A sentence that introduces a list is its own block, with a blank line before the
  list. Never `•`, `–` or numbered items and never indented sub-bullets: the page renders no
  other list, so they show as plain lines or collapse into one level. Never flatten a list into
  one paragraph. A long context is grouped under short **bold** lead-ins, one paragraph or
  bullet each. `text`, option texts, `hint` and `proposed` take the inline subset only.

Put the link `<artifact url>#<id>` beside the file path in the message that presents the
questions. Nothing is pre-selected (a board's cards are the one exception, § 5); a proposal is shown apart and adopted only by the developer's
press; the engine's own mode question is unchanged, and answers from the form count as the
developer editing the file.

## 3. Change a form

Adding, changing or removing a question, follow-ups included, is a row write to the same form
(`set` a new row, `update`/`delete` an existing one with its `version` as `if_version`). The
page is live; the link does not change. Follow-ups go into the same form.
A form that was done and that you change goes back to `status: "open"` in the same write, so
the developer presses Done again.

## 4. Read back (when the developer says the form is done)

One `ArtifactData` `get` of `forms/<id>`. `answers[qid]` is `{k: [letters], note, at}` and
`status` is `"done"` when they pressed Done. Copy each answer into its tag:

- `[Answer]: A` · `[Answer]: A, C` (multi) · `[Answer]: X` — each followed by ` — <note>` when
  a note was written (`[Answer]: B — only after the spike`, `[Answer]: X — <their words>`).
- A text question's tag is the note itself (`[Answer]: <their words>`); an empty note keeps it
  open.
- A tag already filled in the file is not overwritten; if file and form disagree, ask. An answer
  with no letters keeps its question open.
- Record the copy as one `aidlc engine log answer` for the form, naming the form id and
  `savedAt`.

## 5. Board forms (sorting items into boxes)

When the developer has to sort items rather than answer questions — a pull request review, on both
sides (`pr-review` plugin: `review-pr` for the reviewer, `address-review` for the author, both followed by § 5b; `self-review` for the author's own AI review pass, a Fix now / Dismiss board that gets the form check of § 5b A and is not part of the flow guard) — the form is a board: 2–4 boxes
side by side on a wide page, stacked on a narrow one, each item a card that starts in the box the
agent proposes and can be moved by button or drag.

- `forms/<id>` adds `view: "board"` and `boxes: [{k, t, hint?, tone?, group?, sink?}]`; `tone` is
  `ink`, `accent`, `warn` or `muted`. The box labels are data, written by the skill that opens the
  board.
- A grouped board adds `groups: [{k, t, hint?}]` and gives each box a `group`, or `sink: true`.
  Groups stand side by side with their boxes stacked; sink boxes take a full-width row below. A
  card can move only between the boxes of its proposed box's group, or to a sink box, and the page
  shows that while dragging. On a wide window the page scrolls until the header is gone and the
  board fills the screen; then each box scrolls on its own. Cards show their id, title and move
  buttons; details open per card or all at once from the bar.
- `forms/<id>/questions/<qid>` per card — `{n, text, ctx?, kind: "card", from?, group?, proposed:
  {k, why?}, outcomes?: {<box k>: "…"}}`; `group` is needed only when the proposed box is a sink. `text` is a short title a person understands without
  knowing the IDs (not "AC 3 of US2.1", but "Guests can't tell which dish is vegan"); `from` one
  line on who asked for what; `outcomes` says what happens when the card sits in each box. A
  card's `ctx` follows the § 2 rule: paragraphs and `- ` bullets with **bold** lead-ins, never
  one run-on paragraph; `text`, `from`, `outcomes` and `proposed.why` take the inline subset only. On a
  grouped board the group alone decides where a card can go; on a board without groups,
  `outcomes` also limits the boxes offered to its keys (plus the proposed box).
- A board is never opened with zero cards: when there is nothing to sort, no board and no follow-up
  form are made and the skill that would open it goes on to its next step.
- A board has no questions file; the skill that opens it says where its result is recorded.
  Read-back: `answers[qid].k[0]` is the card's box, `note` the developer's note. On Done every
  card is written, moved or not.

### 5b. After a review board is sent: the form check and the summary

A review board or its follow-up form (`<…>-pr<n>-review-draft`, `<…>-pr<n>-answer`, each also with
`-followup`) is never followed straight by the next step. The `pr-review` plugin's `review_flow`
hook enforces this order and records each step itself from what the harness reports; nothing you
write unlocks a step, and you never write `status: "done"` yourself.

**A. The form check.** Right after the form is sent, ask one `AskUserQuestion`: question `Look at the
form and pick one from above: <artifact url>#<form id>`, header `Form`. The first option is
`Saved in the form` ("I sorted the cards and pressed Done in the form."); it is the only answer
that goes on. The tool needs a second option besides its own Other: you choose it on the fly (for
example "Request changes to the form": the form itself is wrong, a missing card, a wrong box, a
wrong question), and Other carries what exactly is wrong.

Only `Saved in the form` goes on, and only once the form is also marked done in the database. Read
that with a filter, not by trusting the answer: `ArtifactData` `query` on collection `forms` with
`where: [["status", "eq", "done"]]` — the form must be listed. Not listed: say the form is not
marked Done and wait. Any other answer: if it says what is wrong, fix the form (the same `batch`
sets its `status` to `"open"`) and ask the same question again; a bare choice of your second
option says nothing, so ask in chat what to change. Never continue on your own. Until both hold, the hook refuses every change the skill would
make with `Answer the form to continue: <link>`.

**B. The summary of your understanding.** After you read the saved answers back (and after every
follow-up form, which is checked the same way), show the developer, as plain text in chat, what you
understood from them: for each card its id, title and the box it ended in, any note, and what that
means for what you will do or post. Then ask `AskUserQuestion`: question `Summary of my
understanding of your answers` (the key lines in the question itself, the app collapses text before
it), header `Understood`, options `Matches` and `Not quite`. Only `Matches` is recorded. Changing
a form takes the record back. The verdict gate (Approve, Merge, …) is not asked, and nothing is
posted, merged or sent, before it is recorded. The gate question names the pull request by number
(`#<n>`; for a Unit every linked pull request it merges or reviews, as `owner/repo#<n>`): the hook counts only a question that names
the round's pull request as this round's gate, so an AI-DLC gate with the same labels is left alone,
and a post, merge or review of another pull request is refused. In a round that spans two repositories a
bare number in a `gh pr` command is refused, also after a `cd`: name the repository (URL or `-R owner/repo`). The round ends with its last post
(the last of its merges, the Slack verdict, the re-review request); the next pull request starts its own.

**C. A verdict given too early, or the flow not followed.** If the developer gives a verdict before
the summary was read, in chat or by choosing it, do not accept it: show the summary again and add
this block after it — "The workflow requires reviewing the summary of my understanding of your
answers before going further, so that you and I are sure we agree." — then ask B. If the developer
asks to skip the form, to go straight to the fixes or to the verdict, say what the flow is and why:
the workflow requires the agent to present the form before addressing fixes, and a verdict given
before the summary was reviewed sends the summary again. Then continue the flow at the step that is
open.

Approval gates and every other checkpoint (the Consolidated Summary Confirmation, Plan
Approval) stay `AskUserQuestion`; they never go through a form.
