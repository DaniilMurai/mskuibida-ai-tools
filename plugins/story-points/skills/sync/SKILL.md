---
name: sync
description: Use to bring an intent's unit-points.csv up to date with the developers' story-point estimates in the project's Jira — "/story-points:sync", "sync the story points", "update unit-points.csv from Jira", "re-check the ai rows", and before a Unit is claimed ("claim U12", "take U12"). Needs a Jira tracker in .story-points.json; without one, estimates are recorded with /story-points:set. Reads the Unit issues through the configured Jira MCP server only and never writes to Jira. Arguments: optional Unit ids (U3 U12), optional --source ai|human, optional --intent <slug>, or --claim <Unit> for the check before claiming.
---

# Sync story points from Jira

The developers' estimate lives in Jira's story-point field; `unit-points.csv` (`unit,points,source`)
next to the intent's `aidlc-state.md` carries it for tools that read the file, such as the
`project-panel` plugin. This skill copies Jira's estimates into the file as source `human`. The
exact work is `${CLAUDE_PLUGIN_ROOT}/scripts/points.py`; its header is the full behaviour. Run it
from the project root. Below, `POINTS` stands for `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/points.py"`.

**Read only on Jira.** Use the `mcp__<server>__*` tools of the server the plan names and nothing
else: never another Atlassian connector or CLI, even when one is connected. Never call a Jira write
tool from this skill, and never set the story-point field anywhere (the plugin's hook refuses it).

With `--claim <Unit>`, run steps 1 to 4 for that Unit, then step 6.

## 1. Plan

Pass the developer's arguments through unchanged:

```
POINTS plan [UNIT ...] [--source ai|human] [--intent <slug>]
```

It prints the file, which Units will be checked and, with a tracker, the MCP `server`, the `site`,
the JQL, the fields to ask for and the story-point field's id and name. An error (no file, an
unknown intent, a bad Unit id, a bad `.story-points.json`): show it and stop.

When the plan says `"tracker": null`, there is no Jira to read: tell the developer that estimates
are recorded with `/story-points:set U3 5` and stop.

## 2. Connection

Call the server's `getAccessibleAtlassianResources` once. The resource whose `url` is the plan's
`site` gives the `cloudId`; when there is none, the connector is signed in to another site: stop and
tell the developer to sign in again to the configured site (`/mcp` and the plan's `server`). When
the tools are missing or answer unauthenticated, say the same and stop. Never fall back to another
connector.

## 3. Read the Unit issues

- The server's `searchJiraIssuesUsingJql` with the plan's `jql`, `fields` as the plan lists them,
  `maxResults` 100. While `pageInfo.hasNextPage` is true, ask again with `nextPageToken` set to
  `pageInfo.endCursor`. Always read every Unit issue, whatever the plan's Units: the script picks the
  Units, so a Unit is never missed because of a fuzzy search, and the claim check sees every Unit of
  the epic.
- Once per run, check the field: the server's `getJiraIssue` on the first issue with
  `expand: names` and `fields: [<field>]`. When `names[<field>]` is not the plan's `fieldName`,
  stop: the `field` in `.story-points.json` is wrong, and only a change to that file fixes it.
- Save what came back with the Write tool to a file in the session's scratchpad or temp directory
  (never in the repository): either the responses as returned, as a JSON list of pages, or a JSON
  list of `{"key": "PRJ-130", "summary": "U1 api-shell - ...", "points": 5, "parent": "PRJ-125"}`
  with `points` `null` when the field is empty and `parent` the epic's key (`null` without one).
  Copy keys, summaries and numbers exactly; never fill in a value Jira did not give.

## 4. Apply

```
POINTS apply --issues <saved file> [the same arguments as the plan]
```

Add `--dry-run` when the developer asked only to see what would change. Show every line it prints.
Exit 1 means a line under "needs a look": list each one with what resolves it (two issues for one
Unit: the developers retitle or close one; points off the scale: the developers re-estimate, and
above the top of the scale the Unit is split). Exit 2 is an error: show it and stop.

## 5. Commit

When the file changed, offer to commit it on its own, with no other file, in the way the project's
rules ask for such a change (a branch, a pull request, a review). Never commit without the
developer's yes.

## 6. Before a Unit is claimed

One Unit waits for its own estimate; the project as a whole does not wait for every Unit. After
step 4 for the Unit, with the same saved file:

```
git fetch origin main
POINTS claim --issues <saved file> <Unit> [--intent <slug>]
```

The check reads `unit-points.csv` as it is on `origin/main` (`--ref` picks another), not the working
copy: a row synced in step 4 counts only once the change that carries it (step 5) is merged.

Show what it prints.

- **Exit 0:** the Unit may be claimed.
- **Exit 1, `BLOCKED`:** the Unit is not claimed. Either the developers estimate it in Jira first,
  or its row on `origin/main` does not hold that estimate with source `human` yet: sync it (step 4),
  merge that change (step 5), fetch, and run this check again. The line says when the working copy
  is already synced and only the merge is missing. Never claim it, and never offer to set the points.
- **Exit 3, `WARN`:** the Unit is estimated, but the other Units its line names, in the same epic,
  have no story points in Jira. Name them, then ask with one `AskUserQuestion`:
  **Claim anyway** / **Not yet**. Claim the Unit only on **Claim anyway**. That approval covers
  this Unit at this moment; it is not a standing exception for the epic.
- **Exit 2:** an error, for example the Unit has no issue or two. Show it and stop.

Claiming is the developer's own step in Jira; this skill only says whether it may happen, and writes
nothing to Jira.
