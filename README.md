# mskuibida-ai-tools

A small marketplace of Claude Code plugins.

## Install

```bash
/plugin marketplace add https://github.com/maksymskuibida/mskuibida-ai-tools
```

```bash
/plugin install response-format@mskuibida-tooling
```

Then **start a new session** (or `/clear`). Plugin output styles are read once when a session
starts, so nothing changes in the session you installed from.

To hack on a checkout instead of the published repo, point the marketplace at a local path — the
same two commands otherwise:

```bash
/plugin marketplace add ~/mskuibida-ai-tools
```

Both forms are verified working with the `claude` CLI (`claude plugin marketplace add …`,
`claude plugin install …`), which is the non-interactive equivalent of the slash commands.

### Updates

Auto-update is **off by default** for this marketplace. Turn it on in the terminal `claude` with
`/plugin` → Marketplaces → `mskuibida-tooling` → Enable auto-update, or in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "mskuibida-tooling": {
    "source": { "source": "git", "url": "https://github.com/maksymskuibida/mskuibida-ai-tools.git" },
    "autoUpdate": true
  }
}
```

Updates land in the background, up to ~10 minutes after the first message of a session, and apply
from the next session. To pull one now:

```bash
claude plugin marketplace update mskuibida-tooling
claude plugin update <plugin>@mskuibida-tooling
```

**Releasing:** bump `version` in the plugin's `plugin.json` and its `marketplace.json` entry on every
user-facing change — users only receive a plugin when its version changes. CI enforces it.

## Plugins

| Plugin | What it does |
|---|---|
| [`response-format`](plugins/response-format) | One self-contained, fully linked report — Needs you / Done / Next / Risks — at hand-back or when you are needed; one plain line mid-flight. Applies automatically on enable, from the next session. |
| [`model-fit`](plugins/model-fit) | A mod (needs a Claude Code build with function-hooks support). Before the first real task of a session a quick Haiku check asks whether the session model fits it; on a mismatch a Switch or Stay dialog appears before anything runs, and Switch runs the task on the other model at once. |
| [`worktree-cleanup`](plugins/worktree-cleanup) | Reclaim disk from orphaned git worktrees without deleting unpushed work or a worktree a session is using. |
| [`project-panel`](plugins/project-panel) | A side pane for any repo with a plan — sections, items, progress rings and the gates that block the next item. Providers: AI-DLC v2 (which intent this session works on, every phase and stage) and a task ledger read against its PRs; each open PR's review state, and the `pr-review` command it asks of you. Opens with `/panel`. |
| [`ask-guard`](plugins/ask-guard) | A mod. The question dialog draws its text plain, so a question longer than 250 characters (configurable) is sent back to the model: context in a markdown message first, then a one-line question. Other plugins' dialogs pass untouched. |
| [`question-forms`](plugins/question-forms) | Every AI-DLC questions file as a form in one private artifact, **AI-DLC question forms**: the agent writes the questions as rows, you answer in the page, and the agent copies your answers word for word into the file. Also text-only questions and board forms (cards sorted into boxes). |
| [`story-points`](plugins/story-points) | For AI-DLC projects. Keeps each intent's `unit-points.csv`, which `project-panel` reads, with the developers' estimates: typed with `/story-points:set`, picked per Unit in a review form with `/story-points:review`, or synced from Jira when `.story-points.json` names a tracker. Checks a Unit is estimated before it is claimed. |
| [`approval-gates`](plugins/approval-gates) | For AI-DLC projects. At every approval gate the stage's documents, the review brief and the completion summary become one page in the developer's private artifact **AI-DLC approval gates**, linked from the gate question; notes and a draft decision left in the page come back to the agent. A hook refuses the gate question and the approved or rejected report until the page exists. |
| [`review-findings`](plugins/review-findings) | Whenever review findings reach the developer (an AI-DLC stage review brief at a gate, or `/code-review`'s findings), the agent shows a compact summary inline and asks one question: Fix, Accept (only when nothing is blocking) or Open in form, where each finding is sorted into fix, accept or reject with a reason. A hook enforces the order. |
| [`aidlc-session-titles`](plugins/aidlc-session-titles) | For AI-DLC projects. Every session that runs the workflow is titled by what it is on — `<unit> — <stage>` on a Construction Unit, else `<phase> — <stage>` — read from the project's state, never from the agent. Set at each prompt; in the desktop app also renamed mid-turn when a stage or Unit claim moves on. |

## Adding another plugin

Create `plugins/<name>/.claude-plugin/plugin.json`, drop in `skills/`, `agents/`, `commands/`,
`hooks/` or `output-styles/` as needed, then add an entry to `.claude-plugin/marketplace.json`.
Run `/plugin marketplace update` to pick up changes.

Validate before pushing:

```bash
claude plugin validate . && claude plugin validate plugins/<name>
```

## Repo permissions

`.claude/settings.json` at the repo root grants two Bash permission allow rules so agent sessions
working in this repo can apply PR labels and merge approved PRs without the auto-mode classifier
stopping them:

- `Bash(gh pr edit *)`
- `Bash(gh pr merge *)`

That's it — no force-push variant (`git push --force`, `-f`, or otherwise) is included. A rewritten
public branch is exactly the class of action that should keep prompting, so that stays excluded on
purpose.

This is a **project-scoped, tracked** file rather than a rule in `~/.claude/settings.json`. A
user-level rule would let any session on this machine merge PRs in *any* repo, including unrelated
work repos; scoping it to this repo's checked-in settings keeps the blast radius to `claude-plugins`
and keeps the grant visible in git history and reviewable in a PR.

**It takes effect from your next session.** Project settings are read when a session starts, and
the settings watcher only watches directories that already contained a settings file at session
start — so a session already running in this repo (or in a worktree of it) when this merges will
not pick the rules up. It needs a restart or a new session.
