---
name: set
description: Use to record a developer's story-point estimate for a Unit in an intent's unit-points.csv without Jira — "/story-points:set U3 5", "U3 is a 5", "put 8 on U12" — and to check a Unit before it is claimed when the project has no Jira tracker ("claim U12"). Runs only with numbers the developer typed. Arguments: a Unit id, the points, optional --intent <slug>.
---

# Record a story-point estimate

`unit-points.csv` (`unit,points,source`) sits next to the intent's `aidlc-state.md`. A row with
source `human` is the developers' estimate; a row with source `ai` is an assistant's suggestion. When
the project has a Jira tracker in `.story-points.json`, the estimates live in Jira and
`/story-points:sync` copies them in; this skill is for projects without one, and for a developer
who wants to type an estimate straight into the file. The exact work is
`${CLAUDE_PLUGIN_ROOT}/scripts/points.py`. Run it from the project root. Below, `POINTS` stands
for `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/points.py"`.

## The rule

**The assistant never invents, suggests or rounds a `human` estimate.** Run `set` with a number only
when the developer typed it in this conversation ("U3 5", "make U12 an 8"). When they only name a
Unit, ask for the number; do not propose one.

An assistant's own suggestion is a different row: only when the developer asked for a suggestion
("what would you estimate U4 at?"), say the number and why, and if they want it recorded, run `set`
with `--source ai`. It is never recorded as `human`, and the developer's own estimate replaces it
later.

## 1. Record

```
POINTS set <Unit> <points> [--intent <slug>] [--source ai]
```

`<Unit>` is `U3`, `u3` or `3`. The row is added or updated and the rest of the file stays byte for
byte; a missing file is created with its header. Show the line it prints.

- **Exit 0:** written.
- **Exit 1:** written, but the value is off the scale (`scale` in `.story-points.json`, default
  1, 2, 3, 5, 8). Say so; above the top of the scale the Unit is split rather than estimated.
- **Exit 2:** an error (not a number, an unknown intent, a bad `.story-points.json`). Show it and stop.

When a Jira tracker is configured, say that the next `/story-points:sync` replaces this row with
Jira's estimate.

## 2. Commit

Offer to commit the changed `unit-points.csv` on its own, with no other file, in the way the
project's rules ask for such a change. Never commit without the developer's yes.

## 3. Before a Unit is claimed (no tracker)

```
git fetch origin main
POINTS claim <Unit> [--intent <slug>]
```

The check reads the file as it is on `origin/main` (`--ref` picks another): the Unit's row must have
source `human`. Show what it prints.

- **Exit 0:** the Unit may be claimed.
- **Exit 1, `BLOCKED`:** the Unit has no developer estimate on `origin/main`: the developers give
  one (step 1), the change is merged, and the check runs again. Never claim it, and never offer a
  number for it.
- **Exit 2:** an error. Show it and stop.

With a Jira tracker configured, the claim check belongs to `/story-points:sync --claim`, which also
checks the Unit's epic.
