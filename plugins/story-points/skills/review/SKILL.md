---
name: review
description: Use when the developers want to see, verify or change an intent's story points without Jira — "/story-points:review", "let me review the story points", "show me all Units to estimate", "verify the AI estimates", "I want to change the points in a form". Opens every Unit as a card in the developer's "AI-DLC story points" artifact, where they press 1, 2, 3, 5, 8 (the project's scale) per Unit, sends the link, asks for `form is done` in a separate message, then records their picks as human rows in unit-points.csv. Arguments: optional --intent <slug>.
---

# Review story points in a form

`unit-points.csv` (`unit,points,source`) sits next to the intent's `aidlc-state.md`. This skill shows
every Unit of the intent as a card in one artifact, with its current value marked (amber sparkle:
AI suggestion; navy person: developer estimate). The developer presses a number per Unit. Pressing
the number an AI row already holds confirms it as theirs. Their picks are then written with
`points.py set`, so they become `human` rows.

The page is `points-review.html` next to this file; its header comment is the data contract. Never
generate, restyle or edit a page per review. Below, `POINTS` stands for
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/points.py"`, run from the project root.

**The developer's press is the estimate.** A pick from the form counts as a number the developer
gave, the same as `/story-points:set U3 5` typed in chat. Never write a pick they did not make,
never fill a Unit they left empty, and never change a value they picked.

## 1. What is there

```
POINTS show [--intent <slug>]
```

It prints the file, the intent, the Unit documents (`unitDocs`), the `scale` and the row that counts
for each Unit. An error (no intent, a bad `.story-points.json`): show it and stop.

When `tracker` is not null, the estimates live in Jira and the next `/story-points:sync` replaces
any row this form writes. Say so and stop: the developers change the estimate in Jira, then run
`/story-points:sync`.

## 2. The Units

Read the `unitDocs` (`unit-of-work.md`, `unit-of-work-dependency.md`). The Units are the ```` ```yaml
units: ```` block of the dependency file, in its order. Each Unit's `U<n>` id is the `Unit ID` column of
the index table in `unit-of-work.md`. Take every Unit from there, plus any row in the file whose Unit
is not in the documents. When there are no Unit documents, the rows alone are the Units.

For each Unit write, from the documents and in the developer's terms:

- `title`: one line a person understands without the ids ("Guests pay by card at checkout", not
  "U3 api-billing").
- `ctx`: what the Unit builds and what makes it big or small, in two to five short blocks: paragraphs,
  or `- ` lists with a **bold** lead-in, as the template's header comment allows. Copy facts as the
  documents state them. No estimate, and no opinion on the size.
- `dependsOn`: the `U<n>` ids of its dependencies.

## 3. The artifact (once per developer)

`Artifact` → `action: "list"` → the artifact titled **AI-DLC story points**. If the developer has
none, publish `points-review.html` from this skill's directory once:
`capabilities: {db: {}}`, `icon: "cards"`, description "Review an AI-DLC intent's story points
Unit by Unit; Claude writes the picks into unit-points.csv." Reuse its URL from then on.

## 4. Open the review

The review id is the intent directory name, lowercased (`[a-z0-9._-]+`). Read `reviews/<id>` and
its `units` collection first. When they exist, pass each one's `version` as `if_version`, and
delete the unit rows that are no longer Units. Then write them with `ArtifactData` `batch`
(at most 50 writes per batch; split larger ones):

- `reviews/<id>`: `set` `{title: <the intent's name>, intent: <directory name>, file: <show's file>,
  scale: <show's scale>, status: "open", createdAt: <now ISO>, picks: {}}`. Reopening starts with
  no picks: the file already holds every pick recorded earlier.
- `reviews/<id>/units/<U<n>>`: `set` `{n, unit, name, title, ctx, dependsOn, points, source}`, with
  `points` (a number) and `source` (`"ai"` or `"human"`) from the row `show` printed, both `null`
  when the Unit has no row.

## 5. Send the link, then ask for `form is done`

Two messages, always in this order:

1. The link `<artifact url>#<id>`, the number of Units, and how many still hold only an AI suggestion
   or nothing. One or two lines.
2. **A separate message, always**: ask the developer to send `form is done` once they press Done in
   the form. In the Claude desktop app, end the turn with `mcp__ccd_turn__wrap_up`: `ask`
   `Send "form is done" when you've pressed Done in the form.`, one action
   `{"label": "Form is done", "message": "form is done"}`, `blocked: true`. Nothing goes after it.
   Without that tool, write the same sentence as its own message and end the turn.

Never read the form, or write anything, before the developer says the form is done.

## 6. Read back

One `ArtifactData` `get` of `reviews/<id>`. When `status` is not `"done"`, say the review is not
marked Done, and ask again exactly as in step 5.2.

`picks` maps a Unit to `{points, at}`, or to `null` when the developer cleared it. For every Unit
with a pick, in Unit order:

```
POINTS set <Unit> <points> [--intent <slug>]
```

Each run writes the row as `human`, or says it is already in the file. Exit 1: written, but off the
scale; above the top of the scale the Unit is split rather than estimated. Exit 2: show it and stop.
A Unit with no pick keeps its row as it is.

Then report one table: Unit, title, before (`points source`, or `-`), after, and the Units that
still hold only an AI suggestion or nothing.

## 7. Commit

Offer to commit the changed `unit-points.csv` on its own, with no other file, in the way the
project's rules ask for such a change. Never commit without the developer's yes. A Unit counts for
the claim check (`/story-points:set`, step 3) once that change is merged.

## Changing an open review

When Units change while the review is open, write the unit rows again (step 4's `units` part, with
`if_version`). Set the review's `status` back to `"open"` in the same batch, so the developer
presses Done again, and send the link again as in step 5.
