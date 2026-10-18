# rule-guard

Keeps the `## Corrections` heading out of an AI-DLC project's `team.md` and `project.md`. The
framework's learnings step saves a kept lesson with its own tool and, by default, files general
lessons under `## Corrections`, where they pile up apart from the rules they change. With this
plugin each lesson goes into the section it belongs to, and every rule lives in one place.

```
hooks/hooks.json     PreToolUse on Bash, Edit, MultiEdit and Write
hooks/rule_guard.py  the check (Python 3, standard library only)
tests/               python3 -m unittest discover -s plugins/rule-guard/tests
```

There is nothing to configure: the allowed sections are the `##` headings each file already has,
read from `aidlc/spaces/<active space>/memory/` (the space named in `aidlc/active-space`, else
`default`) at the moment of the call.

## What it refuses

- A `learnings persist` call whose selections file routes a learning to a heading the target file
  does not have yet. An empty heading is refused too, because the tool files it under
  Corrections; a misspelled one is refused because the tool would create a new section for it.
  The refusal lists the sections each file has.
- The same checks for a call wrapped in `bash -c '…'` (or `sh`, `zsh`, `dash`, `ksh`) or `eval '…'`.
- A `learnings persist` call whose selections file, or whose target `team.md` / `project.md`, it
  cannot read: pass the selections file as a literal path, written in a separate step.
- An edit or write to `aidlc/spaces/<space>/memory/team.md` or `project.md` that adds a
  `## Corrections` heading, in any case.
- Everything, when `python3` is missing: the hook fails closed rather than letting writes through
  unchecked. Outside an AI-DLC workspace (no `aidlc/spaces/` in the project) the hook does
  nothing at all, so other projects on the machine are never affected.

## What it lets through

- Text that only mentions the command: a commit message, a pull-request body, a `grep`.
- Lessons that install a check (sensor selections).
- The `(learned …) <!-- cid -->` ending the tool adds to a saved line. It stays on purpose: the
  `cid` is the content hash that ties the line to the tool's `RULE_LEARNED` audit row and stops
  the same lesson being saved twice.

## What it does not see

Shell commands that write into the rule files directly. A check in CI that greps the two files for
the heading catches those, and machines without the plugin.

Re-running Practices Discovery rewrites the sections it owns in `team.md` and drops lessons saved
under them; the audit rows stay, and a lesson that still matters is saved again.

## Install

Install it for the project, not for your user, so the guard acts only in projects that adopt the
rule:

```bash
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install rule-guard@mskuibida-tooling --scope project
```

Or commit it to the project's `.claude/settings.json`, so everyone who opens the project gets it:

```json
"extraKnownMarketplaces": {
  "mskuibida-tooling": { "source": { "source": "git", "url": "https://github.com/maksymskuibida/mskuibida-ai-tools.git" } }
},
"enabledPlugins": { "rule-guard@mskuibida-tooling": true }
```

Then restart Claude Code: hooks load when a session starts.
