# story-points

Keeps an [AI-DLC](https://github.com/awslabs/aidlc-workflows) intent's `unit-points.csv` in step with
the developers' story-point estimates. Jira is optional: with it, the estimates are synced from Jira;
without it, a developer types them with `/story-points:set`.

- `/story-points:set U3 5` records a developer's estimate. No tracker needed.
- `/story-points:sync` copies the estimates from Jira's story-point field into the file.
- Both can check a Unit before it is claimed: it has a developer's estimate, and (with Jira) the other
  Units of its epic do too, or the developer approves explicitly.
- With Jira configured, a hook refuses any Jira write that sets the story-point field: an assistant
  suggests, the developers estimate.

It pairs with the `project-panel` plugin from the same marketplace, which reads `unit-points.csv`.

## The file

`unit-points.csv` sits next to the intent's `aidlc-state.md`:

```
# comments and blank lines are kept as they are
unit,points,source
U1,8,ai
U3,5,human
```

- `unit`: `U<n>`.
- `points`: the estimate, on the scale (default 1, 2, 3, 5, 8; a bigger one is split, not estimated).
- `source`: `human` is a developer's estimate, `ai` an assistant's suggestion. Only `human` rows count
  for the claim check.

Whatever the plugin changes, every other line stays byte for byte. A value off the scale is written,
since it is the developers' number, and reported.

## Configuration: `.story-points.json`

An optional file in the project root (`$CLAUDE_PROJECT_DIR`, else the git toplevel, else the current
directory). Without it every default applies and there is no tracker.

```json
{
  "scale": [1, 2, 3, 5, 8],
  "intents": "aidlc/spaces/default/intents",
  "tracker": {
    "type": "jira",
    "server": "jira",
    "site": "example.atlassian.net",
    "project": "PRJ",
    "issueType": "Unit",
    "field": "customfield_10016",
    "fieldName": "Story point estimate"
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `scale` | `[1, 2, 3, 5, 8]` | The accepted estimates. Anything else is written but reported. |
| `intents` | `aidlc/spaces/<space>/intents` | Where the intent records are. `<space>` is the content of `aidlc/active-space`, else `default`. |
| `tracker` | none | The Jira connection. Leave it out to work without Jira. |
| `tracker.type` | required | Only `"jira"` is supported. |
| `tracker.site` | required | The Jira site, as the MCP server lists it in its accessible resources. |
| `tracker.project` | required | The project key whose issues are read. |
| `tracker.field` | required | The id of the story-point field (`customfield_...`; differs per site). |
| `tracker.server` | `jira` | The name of the MCP server the skill uses: only its `mcp__<server>__*` tools, never another connector. |
| `tracker.issueType` | `Unit` | The issue type of a Unit. |
| `tracker.fieldName` | `Story point estimate` | The field's display name; the skill checks the id against it, and the hook also guards it. |

A config that is not valid JSON, has a wrong type, or a tracker block missing `site`, `project` or
`field` is an error that names the file. The hook then refuses Jira-looking writes instead of
guessing.

## Without Jira

1. The developer estimates a Unit: `/story-points:set U3 5` (or `3`, `u3`; `--intent <slug>` picks
   another intent than the active one). The row gets source `human`. The assistant only ever runs it
   with a number the developer typed; if they ask for a suggestion, the assistant says one and, if
   asked to record it, uses `--source ai`, which is never taken as an estimate.
2. The changed file is committed on its own, the way the project reviews such changes.
3. Before a Unit is claimed: `git fetch origin main`, then `points.py claim U3`. The row on
   `origin/main` (`--ref` picks another) must have source `human`, or the Unit is blocked. There is no
   epic to check.

`plan` reports that no tracker is configured, and `apply` exits 2 with the same message.

## With Jira

Units are Jira issues of the configured type whose title starts `U<n> ` (`U12 web-login - ...`);
an epic is the parent of its Units.

```
/story-points:sync                 every Unit in the file, and every Unit issue in Jira
/story-points:sync U3 U12          only these Units
/story-points:sync --source ai     only the rows that still hold an assistant's suggestion
/story-points:sync --claim U12     before U12 is claimed: synced, then checked with its epic
```

`--intent <slug>` picks another intent; `--dry-run` shows the change without writing. A Unit's
estimate replaces the row's points with source `human`, and a Unit with no row gets one. The row
stays as it is when the estimate is empty, when the Unit has no issue, or when two issues claim it.

The script never reaches Jira itself: the skill reads the issues through the configured MCP server,
saves them to a scratch file, and the script applies them. Nothing is written to Jira. Finished
issues (status category Done) are left out of the query.

The claim check reads the file as it is on `origin/main`, so a sync counts once its change is merged.
Exit 0: the Unit may be claimed. Exit 1: blocked (no estimate in Jira, or the row on `origin/main` is
not synced). Exit 3: the Unit is estimated but other open Units of its epic are not; the skill names
them and claims only on the developer's explicit approval. Exit 2: an error.

### The guard

With a tracker configured, a `PreToolUse` hook watches every MCP server's Jira writes: any tool
whose name creates, edits, updates or transitions an issue (`createJiraIssue`, `jira_update_issue`,
...), and `executeWrite` or `executeDestructive`. It refuses a call whose input names the story-point
field (the configured `field` id or `fieldName`, or a name like `story_points`) as a key or as the
`id`, `key`, `fieldId` or `name` of an entry. Text that only mentions story points, such as a comment,
passes. Without a config, or without a tracker in it, the hook does nothing. When `python3` is
missing and a config exists, it refuses those writes.

## Layout

```
skills/set/SKILL.md          /story-points:set - record an estimate; the claim check without Jira
skills/sync/SKILL.md         /story-points:sync - read the Unit issues through the Jira MCP server, then run the script
scripts/points.py            plan, apply, set and claim (Python 3, standard library only)
hooks/hooks.json             PreToolUse on Jira create, edit, update and transition calls of any MCP server
hooks/story_point_guard.py   refuses a call that sets the story-point field
tests/test_points.py         python3 -m unittest discover -s plugins/story-points/tests
```

## Install

```
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install story-points@mskuibida-tooling --scope project
```

Restart Claude Code afterwards. `project-panel` comes from the same marketplace.
