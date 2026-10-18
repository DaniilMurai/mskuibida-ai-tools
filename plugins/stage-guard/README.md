# stage-guard

One AI-DLC stage per branch and pull request. Each Ideation and Inception stage runs on its own
branch, opens one pull request and is merged before the next stage starts; Construction has one
branch and pull request per Unit. The AI-DLC workflow itself does not know about branches: its
approval question only says "Continue to <next stage>", and resuming starts the next stage wherever
the checkout is. This plugin is a Claude Code hook that enforces the branch discipline around it.

It is meant for projects that adopt the rule on purpose, so install it at project scope (see
[Install](#install)). Outside an AI-DLC workspace (no `aidlc/spaces/` in the project) the hook does
nothing at all.

```
hooks/hooks.json         PreToolUse on Bash, Edit, MultiEdit, Write, NotebookEdit; UserPromptSubmit
hooks/stage_guard.py     the check, the config reader and the fold/confirmation recorder (Python 3, standard library only)
commands/fold.md         /stage-guard:fold, typed by the developer only
commands/confirm-start-check.md   /stage-guard:confirm-start-check, typed by the developer only
scripts/start_check.py   drafts an intent's start-check.md (only with "startCheck": true)
tests/                   python3 -m unittest discover -s plugins/stage-guard/tests   (from the repository root)
```

## Configuration: `.stage-guard.json`

An optional file at the git top level of the project. Every key is optional; a missing file means
all defaults. The file is read on every guarded call, so a change applies at once.

| Key | Default | Meaning |
| --- | --- | --- |
| `developers` | any prefix matching `[a-z0-9]+(-[a-z0-9]+)*` | The allowed branch prefixes, for example `["ann", "bob"]`. Suggested commands use the first one, or the placeholder `<you>` when the list is absent. |
| `ticket` | none | A regular expression for the ticket key, matched as a whole path segment (no anchors; for example `"PRJ-\\d+"`). When set, stage branches are `<dev>/<ticket>/<stage>` and Unit branches `<dev>/<ticket>/<name>`, and the intent's key is the one on its first stage pull request (or, before there is one, on the current branch). When absent there is no ticket segment: `<dev>/<stage>` and `<dev>/<name>`, and no key is checked. |
| `mainBranch` | `main` | The trunk: where stage branches start from and what they must contain. |
| `startCheck` | `false` | When `true`, a Construction or Operation stage needs a confirmed `start-check.md` in the intent's record ([Confirming a start check](#confirming-a-start-check)). |
| `prTemplate` | `.github/pull_request_template.md` | A pull-request template, named in messages only when the file exists; otherwise the messages just say "open the pull request". |
| `rulesRef` | none | Free text, appended to every refusal in parentheses, for example `"CONTRIBUTING.md, Branches"`. Without it, a refusal ends with a short neutral statement of the rule. |
| `startCheckSources` | `[]` | Repo-relative Markdown files that `scripts/start_check.py` reads open items from. |

A config file that exists but is not valid JSON, or has a value of the wrong type, refuses every
guarded call with a message naming `.stage-guard.json` (the hook fails closed); a fold or a
confirmation typed meanwhile is not recorded and says why.

A project with Jira-style tickets and two developers:

```json
{
  "developers": ["ann", "bob"],
  "ticket": "PRJ-\\d+",
  "mainBranch": "main",
  "startCheck": true,
  "prTemplate": ".github/pull_request_template.md",
  "rulesRef": "CONTRIBUTING.md, AI-DLC stages",
  "startCheckSources": ["docs/open-items.md"]
}
```

Stage branches are then `ann/PRJ-5/scope-definition`, a fold branch
`ann/PRJ-5/refined-mockups--folded--requirements-analysis,user-stories`, a Unit branch
`bob/PRJ-9/menu-carousel`.

A project without tickets, using the defaults (no file at all gives the same):

```json
{}
```

Stage branches are `<you>/scope-definition`, fold branches
`<you>/refined-mockups--folded--requirements-analysis,user-stories`, Unit branches `<you>/menu-carousel`,
with any prefix, and Construction needs no start check.

## What it refuses

Every `aidlc engine orchestrate next` call (also `orchestrate.ts next`, and calls wrapped in
`bash -c '…'` or `eval '…'`) that starts or continues a stage, when:

- the checkout is on the main branch (or a detached HEAD);
- an Ideation or Inception stage would run on a branch other than `<dev>/<ticket>/<stage>`
  (`<dev>/<stage>` without a `ticket`). The ticket is the intent's: the key on the intent's first
  stage pull request, or, before there is one, the one on the current branch. Nothing is
  hard-coded, so the next intent uses its own key;
- the previous Ideation or Inception stage's pull request is still open, or that stage has no
  merged pull request at all (`gh pr list --state all`). Only pull requests created since the
  intent's Start Date count, so an earlier intent's branch of the same name is never taken for
  this one's;
- a stage that has not started yet would run on a branch that does not contain `origin/<mainBranch>`
  (the hook fetches it first);
- a Construction or Operation stage would run on a branch not shaped `<dev>/<ticket>/<name>`
  (`<dev>/<name>` without a `ticket`). There is no check of the previous Unit's pull request, so
  Units can proceed in parallel;
- with `"startCheck": true`, a Construction or Operation stage in an intent whose record has no
  `start-check.md`, whose `**Blockers:**` line is not `none`, or whose current text the developer
  has not confirmed. The hook checks the lines and the confirmation, not whether the list is
  complete;
- an earlier completed stage has drifted: its artifacts, or the ones it read, changed after its
  approval without a new one. The hook runs `aidlc engine status --project-dir <checkout>` and
  reads its Validity lines: a stage under "Directly stale" or "Revalidate" that comes before the
  stage `next` works on refuses it. The workflow itself only warns about this. The refusal names
  the earliest such stage and how to reopen it (the backward jump, then resume; on a stage branch,
  the fold below as the alternative to its own branch), or to revert the change. A drifted stage
  at or after the one being run passes, because it runs again anyway: so the reopened stage itself
  runs. Stages with no fingerprint ("Untracked", like the initialization stages) do not count.
  When `aidlc` is missing, the status fails, prints no Validity line, or says the inspection is
  unavailable, the hook refuses;
- an earlier stage, reopened by a backward jump, would run on a later stage's branch. The
  refusal names its own branch, and the fold below as the alternative; the refusal after an
  approval offers the fold for the next stage too;
- a fold branch (below) without a fold approval for that exact name, whose folded stages are not
  in stage order, or whose stages, with the main stage, are not consecutive in the plan;
- an Edit, MultiEdit, Write or NotebookEdit of `stage-folds.json` or `start-check-approval.json`,
  and a shell command that names either, unless it starts with a reader (`git`, `cat`, `grep`,
  `ls`, …), does not redirect into it and is not `git checkout`, `restore`, `mv`, `rm`, `apply`,
  `stash` or `reset`;
- a shell command that runs the hook itself, which could hand it a forged UserPromptSubmit
  event: `stage_guard.py` executed directly or by a Python interpreter (as its script, from
  stdin, as `-m stage_guard`, or imported in `-c` code), also behind `env`, `exec`, `uv run`,
  `bash -c` or `eval`. Reading, linting or testing it (`sed`, `ruff`, `mypy`, `unittest`) passes;
- everything, when it cannot check: `gh` or `aidlc` missing, `gh` not signed in, GitHub not
  answering, the stages' validity unreadable, an invalid `.stage-guard.json`, an internal error.
  The hook fails closed. `python3` missing refuses too.

The stage it checks is the one `next` works on, read from the active intent's `aidlc-state.md`:
the stage in progress (`[-]`, `[?]`, `[R]`), else the next stage the plan runs, or the one named
by `--stage` / `--phase`. The previous stage is the last completed Ideation or Inception stage
before it.

Each refusal says what to do. Right after a stage is approved the workflow calls `next` for the
following stage; on the approved stage's branch the refusal gives the sequence after approval:
commit everything, push, open the pull request (from the template, when `prTemplate` exists), then
`aidlc engine orchestrate park` until it is merged. Once it is merged: `git switch <main> && git pull
--ff-only && git switch -c <dev>/<ticket>/<next stage>` and resume.

## Folding several stages into one pull request

By the developer's decision, several consecutive stages may share one branch and one pull request,
whatever the size of the change: an earlier, merged stage reopened into the stage on the current
branch, the next stages run on it, or both. An agent may propose a fold and never assumes one.
Only the developer approves it, by typing in the session, on the branch whose pull request carries
it:

```
/stage-guard:fold user-stories        reopen an earlier stage into this pull request (or /fold 2.4)
/stage-guard:fold units-generation    carry the next stage on this branch too
/stage-guard:fold 2.3 2.4             several at once
```

The plugin's UserPromptSubmit hook sees only what the person typed, so an agent cannot give this
approval; the command is not available to the model either (`disable-model-invocation`). The hook
records the approval in the intent's `stage-folds.json`, keyed by the fold branch, which names the
stage it was opened for first and then the folded stages in stage order,
`<dev>/<ticket>/<stage>--folded--<stage>[,<stage>…]`. The workflow runs stages in order, so the
stages between the named ones are filled in. The hook then tells the agent the steps:

1. move the branch to the fold branch's name. The hook asks GitHub whether the current branch is
   the head of an open pull request, because renaming a branch on GitHub retargets the pull
   requests whose base it is but closes the one whose head it is:
   - with an open pull request from it: rename the branch locally, push the new name, open a new
     pull request from it whose description links the old one, close the old one with a comment
     linking the new one, and only after that delete the old remote branch. The old pull request
     keeps its review as history; the new one starts without an approval and needs a new review;
   - with none: rename it locally and, if it is pushed, on GitHub
     (`gh api -X POST repos/{owner}/{repo}/branches/<old>/rename -f new_name=<new>`);
   - when `gh` cannot answer, the step gives both cases and the `gh pr list --head <old>` that
     tells them apart;
2. when the fold reaches back, jump to its earliest stage, `aidlc engine jump execute --target
   <stage> --direction backward --scope <scope>`, as a Bash call of its own;
3. unpark if parked, resume, and run, review and approve every stage of the fold, in order;
4. commit `stage-folds.json` with the work, open the pull request (or update the open one) and
   name the folded stages in its description.

On the fold branch the guard lets every stage it names run; a stage carried on the branch needs
no merged pull request of its own for the next one to start, and the fold branch's own pull
request never counts as a merged one. After its last stage is approved, the fold branch is
treated like any stage branch: open the pull request, park, merge.

## Confirming a start check

Only with `"startCheck": true`. Once an intent's `start-check.md` reads `**Blockers:** none`, the
developer confirms it by typing, in the session:

```
/stage-guard:confirm-start-check              the active intent
/stage-guard:confirm-start-check <slug|dir>   another intent
```

Like the fold, it is a typed command that the UserPromptSubmit hook records and an agent cannot
give (`disable-model-invocation`, and the hook sees only what the person typed). The hook writes
`start-check-approval.json` next to the file with the file's sha256, the developer's git name and
the time. The confirmation is bound to the text: rerunning `start_check.py` or any edit makes the
hash differ, and Construction is refused until it is typed again. A list that still has blockers
is not confirmed, and neither is a file with no `**Blockers:**` line or with more than one (a note
cannot stand in for the Result line). Commit both files with the work. Without `startCheck`, the
command only says that the start check is not enabled for the project.

`scripts/start_check.py --intent <slug>` drafts the file from the intents in `intents.json` and,
when `startCheckSources` lists any, from numbered open items in those Markdown files. An item is
`## <n>. <title>` with exactly one Decided line, either `**Decided:** —` (open) or
`**Decided (<date> …):**` (decided; any other form stops the tool, so a malformed line never reads
as decided), and, when open, a `**Blocks:**` paragraph naming the intents it blocks in backticks,
or "every intent", or "every intent whose …" for a condition only the developer can judge.
`--help` lists the judgements the tool takes (`--touches`, `--not-touches`, `--overlaps`,
`--no-overlap`). It writes nothing but `start-check.md`, so running it again means a new
confirmation.

## What it lets through

- Read-only and settings calls: `--status`, `--doctor`, `--version`, `--help`, `--config`,
  `config`, `intent`, `space`, `plugin`, `knowledge`, `unit`, `--claim`, `--release`, `compose`,
  `--new-scope`, `--new-intent`, `--guard-policy`, `--sensors`, `--learnings`,
  `--summary-confirmation`; and isolated runs (`--single`), which never move the workflow.
- `report`, `park` and `continue`: they finish or pause work that `next` already let start.
- Initialization stages, and a workspace with no active intent yet (the first run creates it).
- Text that only mentions the command: a commit message, a pull-request body, a `grep`.
- Outside an AI-DLC workspace (no `aidlc/spaces/` in the project) the hook does nothing at all.

## What it does not see

- A stage run on a machine without the plugin. A CI check on the pull request is the backstop: for
  example, fail a pull request whose `aidlc-state.md` changes mark more than one Ideation or
  Inception stage done, or mark one done from a branch other than the stage's own.
- The protection of `stage-folds.json` and `start-check-approval.json` matches text in tool calls.
  It stops an agent from writing the files on its own initiative, not a deliberate bypass on the
  machine.
- `.stage-guard.json` is an ordinary file: the plugin does not stop an agent from editing it, so
  review changes to it like any other rule file.
- Branches and pull requests on a host other than GitHub: the previous-stage check uses `gh`.

## Install

The guard should act only in projects that adopt it, so install at project scope:

```
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install stage-guard@mskuibida-tooling --scope project
```

This enables it in the project's `.claude/settings.json`; commit that file so the whole team gets
the plugin. Accept the trust and install prompts, then restart Claude Code. Add a
`.stage-guard.json` if the defaults do not fit. Do not install it for your whole user. If it is
missing in a session, `/plugin` shows its state. Requirements: `python3`, `git`, the GitHub CLI
`gh` (signed in) and the `aidlc` command on the `PATH`.
