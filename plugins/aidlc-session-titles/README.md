# AI-DLC session titles

Units and stages are worked on in parallel, one session each, and you find them by title. This plugin keeps the
title of every session that runs an AI-DLC workflow in step with what it is on:

| The session is on | Title | Example |
|---|---|---|
| a Construction Unit (a per-Unit stage) | `<unit> — <stage>` | `u4-day-navigation — Functional Design` |
| anything else in the workflow | `<phase> — <stage>` | `Inception — Requirements Analysis` |

The title is read from the project, never from the agent's memory:

- **Intent** — this session's binding (`aidlc/.aidlc-sessions/<session>.binding.json`), else the space's
  `active-intent`, else its one live intent.
- **Stage** — `Unit Stage` in `aidlc-state.md`, else the engine's active directive when it is newer than the
  state file, else `Current Stage`.
- **Unit** — only on `functional-design`, `nfr-requirements`, `nfr-design`, `infrastructure-design` and
  `code-generation`: this checkout's claim (`aidlc/.aidlc-unit-scope.json`, same intent), else the directive's
  unit, else `Active Unit`.
- **Names** — the project's `.claude/tools/data/stage-graph.json` (`name`, `phase`); else the stage's
  `### <PHASE> PHASE` heading in the state file and the slug title-cased.

In a git worktree the worktree's own `aidlc/` wins over the main checkout's, so a claimed Unit's worktree is
titled by its Unit.

## When a session counts

Only sessions that run the workflow are renamed: once a session runs an `aidlc engine|unit|--claim` command,
invokes an `aidlc*` skill, gets a prompt starting with `/aidlc`, or has a binding file of its own. Other
sessions in the same repository keep their titles.

## How the rename happens

1. **Every prompt and session start** — the hook returns the title as `hookSpecificOutput.sessionTitle`, which
   the harness applies. Only when it changed, so a title you set by hand is not overwritten on every prompt.
2. **Mid-turn, in the desktop app** — a stage or a Unit claim usually moves on without a new prompt. After each
   `Bash` or `Skill` call the hook compares the title the project calls for with the last one the desktop
   confirmed and, once per new title, tells the agent to call
   `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`. A success is recorded; a declined or
   failed call is not asked for again.
3. **Backstop** — the `Stop` hook refuses the end of a turn once per title while the desktop title is behind.

If you renamed the session yourself, the desktop app asks you before replacing your title; declining keeps it.

State per session lives in `~/.claude/aidlc-session-titles/<session>.json` (`AIDLC_SESSION_TITLES_DIR`
overrides it); files untouched for 14 days are swept. Subagents are left alone (they cannot rename the session
they run in). Outside an AI-DLC project (no `aidlc/spaces`) the hook exits before Python starts.

## Install

```bash
/plugin install aidlc-session-titles@mskuibida-tooling
```

Needs `python3` (standard library only). Takes effect from the next session.

## Develop

```bash
python3 -m unittest discover -s plugins/aidlc-session-titles/tests
```

```bash
claude plugin validate plugins/aidlc-session-titles
```
