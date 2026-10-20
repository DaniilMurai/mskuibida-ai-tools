# project-panel

A side pane for any repo with a plan: **sections**, **items**, and **what blocks the next one**. Which
plan it reads is a *provider*: **AI-DLC v2** ([awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows))
and a plain **task ledger** (`WORKPLAN.md`) read against the repository's pull or merge requests (GitHub through `gh`,
GitLab through `glab`, self-hosted included). AI-DLC wins when both exist.

```
SHOP-MVP-RESTART          checked 12s ago [ ↻ Refresh ]

╭──────────────────────────────────────────────────────────╮
│ Now  Inception, 5 of 8                                   │
│ ○ domain-design                                  up next │
│ main: refined-mockups in review, PR #33                  │
│                                                          │
│ Next /aidlc                            [ Put in prompt ] │
│ Execute Domain Design                                    │
╰──────────────────────────────────────────────────────────╯

Needs attention (2)
‖ PR #33 not merged         Inception, after refined-mockups
‖ Parked at domain-design   Inception, after refined-mockups

◑  Plan  45% done, 10 of 22
▸ Initialization                                     ● 3/3 ✓
▸ Ideation                                           ● 4/4 ✓
▾ Inception                                            ◑ 3/8
    – reverse-engineering                          skipped
    ✓ practices-discovery [#27]
    ✓ requirements-analysis [#30]
    ✓ user-stories [#32]
    ◐ refined-mockups [#33]                      in review
    ╭──────────────────────────────────────────────────────╮
    │ ‖ PR #33 not merged                                  │
    │ domain-design can't start on main until it lands.    │
    ╰──────────────────────────────────────────────────────╯
    ╭──────────────────────────────────────────────────────╮
    │ ‖ Parked at domain-design                            │
    │ Waiting on PR #33 to merge; parked 2026-10-11 06:32. │
    │ Resume with /aidlc once it lands.                    │
    ╰──────────────────────────────────────────────────────╯
  › ○ domain-design                                up next
    ○ units-generation
    ○ contract-design
    ○ delivery-planning
▸ Construction                                         ○ 0/7
▸ Operation                                          skipped
```

Top to bottom the pane answers, in order: where am I (the header), what am I on and what is next (the **Now
card**, with the **Next** command and a *Put in prompt* button), what blocks (**Needs attention**), and how far
along the plan is (**Plan**, with its sections). The pane sizes to its content, so it follows the width the
surface gives it, in three steps:

| Columns | | Layout |
|---|---|---|
| under 48 | **narrow** | one column. The header is the title and a lone `↻`; the badge and the "checked" stamp move to a second row. Next stacks its button under the command. Attention rows are two lines (title, then where). Items show their first chip and a dim `+N`, and no status word except `local only`, `reopened`, `stale` and a PR's review state (cut, down to 8 columns, before the title is). Done-folding after 6 items, at most 8 open items; no status strip |
| 48 to 79 | **medium** | one column. `↻ Refresh`, the badge and the stamp share the title's row, and the title is what gets cut (`…`). Every chip and the status words show. Done-folding after 10 items, at most 12 open items; a collapsed section of 10+ items gets a status strip (64 px wide, or 10 cells on the terminal) |
| 80 and up | **wide** | with sections, two columns: the Now card, actions and attention on the left (40%), the plan on the right. The left column lays out for its own width (40% less the gap), so it uses the narrow layouts (stacked Next, two-line Attention rows) until the pane is 125 columns wide. Done-folding after 16 items, at most 20 open items; the strip is 96 px wide |

**Glyphs.** Items: `✓` done (for AI-DLC: merged on the default branch), `◐` in progress, partial, in review (an open PR) or pushed and not merged, `◌` local only (this worktree, no PR), `○` planned, `✕` failed, `–` skipped, `↻` revising, `?` awaiting a person, `↺` reopened (was done, being redone), an amber `✓` stale (done, but after a reopened item);
`›` marks the current one. An item whose PR is open says where the review stands in its status word (see *Pull request
review*): `in draft`, `awaiting dev-b`, `changes requested`, `approved`, `approved with comments`, `no reviewer`.
Attention and gates: `⊘` blocks, `‖` parked or only a warning (also changes requested, and your PR not sent for
review), `?` waits on an answer or an approval, or on your review, `✓` your PR is approved (with or without comments)
and waits on you to merge, `!` the check itself failed, `≠` the plan and the repo disagree. Several stages sharing one PR carry a fold
gutter on the right: `┐`, `│` between, `┘`. Rings: `○ ◔ ◑ ◕ ●` for 0, 1-37, 38-62, 63-99 and 100 percent.

**Done-folding.** A section with more items than the cap for its width (6, 10, 16) hides its done items behind one
row, `✓ 6 done, show`, at the top of the list. It never hides the current item, any item with a fold chip, or one with a
gate after it. Pressing the row shows them all (and a `Hide done` row, in the same place at the top, puts them back). If the fold row's text
is empty, nothing is hidden.

**The open-items cap.** A big ledger (one section may hold about a hundred open items) is not drawn as a wall. After
done-folding, an expanded section shows at most 8 items on a narrow pane, 12 on a medium one and 20 on a wide one (the
current item stays, in its place), then a row `Show 32 more` that shows the rest; `Show fewer` at the foot puts them back.
The two are independent, so both rows can appear (done on top, more at the bottom). A gate after an item that is left out
is not drawn in the list, but it stays under Needs attention. Fold gutters are computed over the items drawn. An empty
label hides nothing.

**The strip.** A collapsed section of 10 or more items shows how its items stand, next to the ring: done in green,
in progress and partial in the accent, failed in red, the rest in the track tone (a 6 px bar of rounded segments on
the desktop, a 10-cell `█▓▒░` bar on the terminal; any group that exists keeps at least one cell).

**Small things.** Next's reason and the Attention titles (drift labels included) wrap, since their tails carry the meaning; only the where is cut. The header's `subtitle` is a dim line under the title row (under row 2 on a narrow pane) that wraps, and is left out
when the Now card already names the current item, because the card's place says the same. The plan heading's summary wraps beside its
ring too, so a long label breaks onto a second line instead of being cut. On the terminal the big ring is the glyph alone (the summary
carries the percent). A section at 100% or built has no strip, and every section's count column has one width (the widest, such as
`18/18 ✓`) so the rings line up. A chip of 8 characters or fewer never shrinks; a longer one is cut first, down to 6 columns, then the
title. Proposed sections (a ledger's suggested products) sit under one dim "Proposed" divider, each as a dim card without a tag of its own.
A section with no items and nothing counted has no ring and a dim title. A linked title is a `Link` around a truncating `Text`, in a
clipping, shrinking wrapper.

**Version mark (0.14.0).** The pane's last line, dim and on the right, is `project-panel 0.14.0`: the version in the
`plugin.json` the engine loaded the mod from (`$.plugin.root`), read once when the pane first draws. It says which build
is drawing the pane, so a look can be told from an older one after an update. When the manifest cannot be read there is
no mark, and the next draw asks again.

**Freshness.** `renderPane` takes an optional clock (`{ now, checkedAt }`). With one the stamp reads
`checked 12s ago`; without it, `read 12:03`, the time the plan was read. The pane's render never reads `$.clock` itself
(0.14.1): a render that reads the clock is redrawn by it, and each redraw retires the drawn buttons' press handles, so a
click landing across one was lost and a fold took a second click. Its `now` is the refresh engine's latest clock reading
(`now()`), which every poll tick moves; the engine redraws the pane only when the stamp's text would change, also while a
read keeps failing (the stamp then ages: `checked 30s ago`).

**Presses (0.18.0).** A press on the pane is taken by a `ui.press` hook, from the button's key and the state now
(`src/render/press.ts`), not left to the drawing's `onPress` closure: a pane hidden and shown again repaints its last
drawing, whose closures the surface had let go, and the first press on it was lost. A key the pane does not draw now goes
on to the closure.

**Steady press handles (0.21.0).** The hook alone did not stop the lost first press: `<Button>` mints a fresh press
handle on every call, the host retires a drawing's handles when the next drawing arrives, and the host checks the handle
before any `ui.press` hook runs. A press from a drawing the surface had not replaced yet (a poll's redraw, a pane shown
again) named a retired handle and was dropped (`ui_press not handled` in the desktop app's log); the second press, on the
new drawing, worked. Every button now keeps the handle its key was first drawn with (`src/render/steady.ts`, applied in
both render hooks), and the host keeps a handle the plugin draws again, so a press lands on whichever drawing is on
screen. The clock and the error line below come from
the refresh engine (`src/refresh.ts`), which fills `freshness` on the model; `hooks/register.tsx` passes the clock. When the latest re-read or remote
check failed, a red line under the header says so, the same text is the first Attention row, and the panel keeps the
last good model.

On the desktop, vscode and mobile surfaces the rings are real donuts (an `Svg`): 40 px with the percent drawn
inside for the plan, 16 px per section, and each Attention row a bordered card in its tone. The terminal has no
`Svg`, so it draws the glyph rings and plain Attention lines above.

**Phase views (0.12.0).** On those same surfaces a plan of a handful of phases (2 to 7 sections, proposed ones not
counted) gets two more views. A one-column pane (under 80 columns) draws the **phase stepper** between the header and
the Now card: one `Svg` row of numbered nodes joined by a line, each over its title (cut with `…` to the room between
nodes). A built phase is a green check, the current one (holding the current item, else the first active) an accent
ring with its percent as the arc and its title bold in the accent, skipped and uncounted phases (no items, or `not
included yet`) dashed; the line after a built phase is green. The Svg has no size of its own and fits its slot; its
`alt` names every phase and where it stands. The wide pane's plan column draws **phase cards** instead of the section
headings: one bordered card per phase (the open ones in the accent, any under the pointer too) with a 20 px ring, the
count (`skipped`, or `not included yet` in amber), the numbered title and a strip (86 px). The title is the heading's
button under the same key (`section:<id>`), so a press opens or closes that phase as before and the fold carries over
between widths; every open phase draws its items under the cards, under its title, with the same done-folding, cap and
gates. A closed card carries the `‖`/`⊘` of a gate it holds. More than 7 phases, and the terminal, keep the list.

**The desktop look (0.13.0).** The surfaces that draw `Svg` (desktop, vscode, mobile) get the card-and-pill look of
the design canvas; the terminal keeps its glyphs. Tints are translucent 8-digit hex fills of a tone's mid-tone, so they
read on a light and a dark theme alike.

- **Header**: the title, the badge as a pill beside it, Refresh at the end; the stamp and the subtitle dim under it.
- **Cards**: the stepper and the Now card sit on a faint neutral fill under a faint line (a side job keeps its warning
  edge). Card labels are set in capitals (`NOW`, `NEXT`, `THIS SESSION`).
- **Next**: the label, the command as a grey pill and the reason on one wrapping line, the button under them.
- **Needs attention**: the heading with its count as a pill; each card tinted in its tone, the title in the text
  colour, the where, and the gate's caption under it. The cards stand two lines apart. Two or more rows about pull
  requests (the rows that link to a PR) are one card, `Pull requests (5)`, where the first of them stood, in the worst
  of their tones (0.23.0); the count still counts every row. The terminal draws no cards and keeps every row in place.
- **Plan**: `Plan` bold over a dim summary. A section row is the chevron, its ring (a dashed one where nothing is
  counted or it is skipped), the numbered title, the count on the right.
- **Items**: the status as a 14 px icon (its alt the status word), chips as grey pills without brackets, the status
  word as a pill in its tone, and the current row tinted in the accent instead of the `›`. A gate inside the plan is
  one line in its tone; its card, with the caption, is under Needs attention.

It is a **mod**: a TypeScript function-hooks module (`hooks/register.tsx`) the engine draws on the
desktop app's and the terminal's pane surfaces.

## Install

```
/plugin install project-panel --marketplace maksymskuibida/mskuibida-ai-tools
```

The command is **`/panel`**. Where a provider finds a plan the desktop app opens the pane on session
start (`panel: auto`); anywhere, run `/panel`. Where none does, the mod stays silent — no pane, no command.

It is `/panel`, not `/aidlc`: every AI-DLC workspace already ships its own `/aidlc` skill (the workflow's
entry point), and the two would collide. There are no aliases.

**Function hooks without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: unverified.** `claude plugin test` and
`validate` do not prove it for a live session. The only evidence is that the name appears in the claude
2.1.296 binary solely in lists of environment-variable names, never as a read that gates anything.

## Providers

A provider turns one kind of plan into the same neutral `PanelModel` (`types/index.d.ts`); the renderer
draws any model the same way. `src/detect.ts` tries the providers in order and the first hit wins; a
provider that throws counts as a miss.

| Provider | Reads | Status |
|---|---|---|
| `aidlc` | an AI-DLC v2 workspace (`aidlc/spaces/`) | shipped |
| `ledger` | a task ledger (`WORKPLAN.md` and kin) read against its pull requests | shipped (0.4.0) |

A provider is `{ id, detect(ctx), load(ctx, detection), act?(ctx, detection, actionId) }`. `ctx` hands it
file reads (`fsx`), the host (`run` a command, `complete` with a model, `mcp` to call one of the session's MCP
servers, `write` a file, a persistent `store`; anything that would spawn goes through it), the session and the options.

The model is sections (with an optional ring), an overall percent with an optional `overall.label` (display text that
replaces the plan heading's own "45% done, 10 of 22", e.g. "74% of effort · 189/287 tasks"), items (status, chips, links), gates between items (parked,
awaiting approval, later PR-not-merged...), drift flags, a Next command, and optional action buttons. Text
in it is display text the provider resolved through `src/strings/en.ts`; an empty string hides that element.

## The ledger provider

For a repository that keeps its plan in a task ledger: a `WORKPLAN.md`-style file of tasks with ids. It shows
how far the repository has got, task by task, by reading the ledger against the pull requests.

### What it detects

In a git repository, the first of these that parses as a ledger (at least 3 items with ids, or at least 5
checkboxes), looking only at **git-tracked** files:

1. the path named by `task-ledger:` in the front matter of `docs/DELIVERY.md`;
2. a root `WORKPLAN.md`, `ROADMAP.md`, `PLAN.md`, `TODO.md` (any case), in that order;
3. the same names under `docs/`;
4. `docs/**/plan*.md`.

Ledgers may be tables whose first cell starts with a bold id (`| **T04** | Act | T01a, T03 | M |`), headings
(`#### T04 — Act`, a `**Done**` first line marks it done), or checkboxes (`- [x] **API-3** Rate limiting`).
Phases are the `## ` headings. A fenced "order of play" (`done T02 …`, `open T16 …`, `then T04 …`) sets the
status of items the ledger does not otherwise declare.

### How status is derived

| Evidence | Status |
|---|---|
| a merged PR for the task | done |
| an open PR | in progress, with a `#N` chip |
| the PR carries the `qa:failed` label | failed |
| only sub-slice PRs (`T06a`, `T06b` for a task `T06`) | partial if one merged, in progress if only open ones |
| nothing, or only closed PRs | what the ledger declares (`**Done**`, `[x]`, `(implemented)`, an order-of-play line), else planned |

How a PR is matched to a task: the id must appear in the PR title or branch with word boundaries
(`T04` never matches `T04a`; `T1` never matches `T10`), in any case (`qa/t04a-preprod`). The strongest
tier decides: a delivery branch (`feat/T04-…`), then a follow-up branch (`fix/`, `hotfix/`, `qa/`), then a
loose mention, which counts only when the PR title names the id as its subject (`feat(T04):`, `T04 —`,
`[T04]`, a trailing `(T04)`); any other mention is just a chip. Fix PRs on a delivered task stay follow-up
chips. A PR naming a longer id (`fix-T04a-backdate-picker`) belongs to that id only, not to `T04a`. Reverts
never count; they show as chips. Progress is weighted by size: XS 0.5, S 1, M 2, L 3, XL 5 (unknown 1);
done counts 1, partial 0.5.

The header shows `idle` when nothing is in flight, `stage` when the session's branch names a task, and
`inferred` otherwise. **Next** is the first planned task with no open PR whose ledger dependencies are done, unless
the session's task has an open PR that asks something of you (see *Pull request review*). The Attention block lists
the rows tied to you first, then disagreements: the ledger says not done but a PR merged, the ledger says done but a
PR is still open, `qa:failed`. A task in progress shows its PR's review state as its status word, and a `Slack thread`
chip when the PR has one.

### What it runs

All through the host, no shell, from the repository root: `git rev-parse --show-toplevel`, `git ls-files -s -z`,
`git show HEAD:<path>`, `git fetch --quiet origin <default branch>`, `git show origin/<default branch>:<path>`,
`git ls-tree -r -z origin/<default branch>`, `git rev-parse --abbrev-ref HEAD`, `git symbolic-ref`,
`git remote get-url origin`, and the forge's reads (see [Forges](#forges-github-and-gitlab)): on GitHub `gh repo view` and
`gh pr list --state all --limit 1000`, on GitLab `glab api projects/<path>` and `glab mr list --all`, paged. The repository
facts, the request list and the branch lookup run together. On GitHub the list also carries each pull
request's review (`isDraft,reviewDecision,reviewRequests,latestReviews,body,author`; one call, the review rides on it). When
a pull request is open: `gh api user --hostname <host>` (once an hour per repository), `gh api user/teams?per_page=100
--hostname <host>` (only when an open pull request asks a team; once an hour) and `git show HEAD:.claude/settings.json`
(when tracked).
The ledger is read from the default branch (after a fetch) so the pane shows what is merged; if the fetch
fails but the branch is there the header says the ledger may be behind origin, and if the branch cannot be read
it falls back to the committed local copy and says so. When the pull or merge requests cannot be read (no CLI, not
logged in, offline, no origin remote) progress comes from the ledger alone and the header says why. **It never writes
to the repository or the forge**: `git fetch` only updates remote-tracking refs, and every `gh`/`glab` call is a read.

### Forges: GitHub and GitLab

The origin remote (`git remote get-url origin`) says where the requests live. `src/forge/` parses it (scp-like
`git@host:group/sub/repo.git`, `ssh://` with a port, `https://` with or without credentials and a port, `git://`; nested
groups of any depth; credentials are never kept, even a password containing `@`; an ssh port is not the web port; a port
above 65535 is no remote; `ssh.github.com` is `github.com`; an ssh-config alias such as `Host work` is not resolved, so
set the `forge` option for such a remote) and picks the forge in this order,
with **no list of known hosts**:

1. the `forge` option is `none`: no forge, no requests, no complaint;
2. no readable origin: no forge, and the header says so;
3. the `forge` option is `github` or `gitlab`: that forge for the origin's host, no probe;
4. the host is `github.com`: GitHub;
5. `glab auth status --hostname <host>` succeeds: GitLab;
6. `gh auth status --hostname <host>` succeeds: GitHub Enterprise;
7. otherwise GitLab anyway (a self-hosted host that is not GitHub is far more often GitLab), whose calls then report the
   real problem.

A found forge's kind is remembered per repository and origin until the mod reloads (the forge itself is rebuilt from the
current host on each call); the fallback in 7 is remembered for 60 seconds only, so a host with no login does not pay the
two 5-second probes on every load and poll, and logging in is picked up within a minute.

| | GitHub (`gh`) | GitLab (`glab`) |
|---|---|---|
| a change is | pull request, `#33` | merge request, `!275` |
| repository | `gh repo view --json url,defaultBranchRef` | `glab api --hostname <host> projects/<url-encoded path>` |
| list | `gh pr list --state all --limit 1000 --json ...` | `glab mr list -R <web address> --all -F json -P 100 -p <page>`, until a short page, at most 10 pages |
| list, one state (AI-DLC) | `--state open`, `merged` or `closed`, and a `--limit` | no flag for open (glab's default), `--merged` or `--closed` |
| status (open only) | in the same list: review decision, merge state, check rollup | at most 20 open merge requests, five calls at a time: `glab mr view <n> -R ... -F json` (pipeline) and `.../merge_requests/<n>/approvals`; a failed lookup leaves its field empty without probing |
| files of a change | `gh pr view <n> --json files` | `.../merge_requests/<n>/diffs?per_page=100` (paged), else `.../changes` on a GitLab without `/diffs` |
| remote fingerprint | `gh pr list ... --json number,state,mergedAt,headRefOid` | `glab mr list ... -P 30 -o updated_at -S desc` |
| AI-DLC remote fingerprint | the same lists as a load | the lists plus one pipeline lookup per open merge request, **no approvals** (a load asks for those) |
| line links | `<web>/blob/<branch>/<path>#L<n>` | `<web>/-/blob/<branch>/<path>#L<n>` |

Every GitLab merge-request command gets `-R <web address>` (a full URL, which glab accepts for any host, so
`GITLAB_HOST` is not needed); `glab api` gets `--hostname`. Chips, drift lines and links spell a change the way its forge
does (`!275`, not `#275`).

**When a call fails** the header (and the Attention line of the live refresh) names the cause:

| Cause | Meant | Shown as |
|---|---|---|
| missing | the CLI does not start (and `<cli> --version` does not either) | `glab missing` |
| not logged in | the call failed and `<cli> auth status --hostname <host>` fails | `glab not logged in to gitlab.example.test` |
| unreachable | the call timed out, or failed with a network-looking error | `could not reach gitlab.example.test` |
| failed | anything else | `glab failed` |
| no origin | the repository has no readable origin | `no origin remote` |

The causes are found only after a failure, with two cheap probes (`--version`, `auth status`, 5 s each).

### Product sections: AI proposes, you pin

Phases describe delivery, not the product. A proposal asks for 3 to 8 product sections ("Claude plugin",
"API", ...) from `claude-sonnet-5-5`, given the task ids, titles and phases, the headings of tracked
`ARCHITECTURE*`, `README*` and `DESIGN*` docs and the top-level directory names (at most 40).

**Consent.** A ledger named by `task-ledger:` in `docs/DELIVERY.md` is proposed on first load: the repository
declared its plan. A ledger the mod merely *discovered* (a `WORKPLAN.md` it found) sends nothing to a model
until you press **Propose product sections**, which makes exactly one Sonnet call.

The proposal appears dimmed after the phases, tagged *proposed*; **Pin sections** accepts it. Once pinned,
`claude-haiku-5-5` files every task under a section, in batches of at most 120 tasks (one call per batch;
if any batch fails the old result is kept), judges done / partial / planned only for tasks with no PR evidence
(at most 40 per batch, 600 characters of cleaned ledger text each; PR evidence always wins), writes short titles
and captions, may add planned-only sections, and notes where a task's prose and status disagree. It runs
**only when its inputs change**: the ledger text, the set of merged PRs, the directory names, or the pinned
sections (ids, titles and hints). **Propose again** makes one new Sonnet call; the old pin stays in effect until
you pin the new proposal, and a stored result is applied only to the sections it was made for.

A failed or invalid reply is not retried for the same input for 6 hours (a changed input, or pressing Propose,
Propose again or Pin, retries at once). With a previous result the header says grouping is unavailable and the
last result stays; without one it says product grouping needs a model reply and shows the phases. If the PR list
cannot be read (or `forge` is `none`), the ledger has no tasks, or the plugin's store cannot be read, the model layer is skipped
entirely (no calls, nothing written) and the phases stand alone. The result is stored per repository
(`ledger:<repo url>`) in the plugin's store.

### Safety

Repository content is read **only through git**, never from the working directory: a tracked file is read with
`git show HEAD:<path>` or `git show origin/<branch>:<path>`, so a symlink cannot redirect a read and uncommitted
edits are not sent. Only tracked *regular files* count: symlinks and submodules are dropped from the lists
(`git ls-files -s`, `git ls-tree -r`). Nothing is read or sent from a path with a segment equal to `.git`, ending
in `.local` or containing `.local.`, or starting or ending with `.env` (case-insensitive), even if someone
committed it. Untracked and ignored files are never listed. Models see ledger titles, short cleaned excerpts of
the ledger text for tasks without PR evidence, doc headings and directory names, nothing else.

## The AI-DLC provider

### What it reads

From the session's own working tree (its branch, uncommitted changes included):

| Source | Used for |
|---|---|
| `aidlc/spaces/` | detection — walked up from the session root; `aidlc-docs/` (v1) is ignored |
| `aidlc/.aidlc-sessions/<session>.binding.json` | the intent this session is bound to |
| `aidlc/active-space`, `intents/active-intent` | the shared cursor when the session is unbound |
| `intents/intents.json` | the intent's display slug |
| `<intent>/aidlc-state.md` | phases, stages, markers, current stage, parked state |
| `<intent>/.aidlc-engine/active-directive.json` | the step on screen, when fresher than the state |
| `<intent>/inception/units-generation/unit-of-work-dependency.md`, `unit-of-work.md` | the Units, their order and dependencies (the ```` ```yaml units: ```` block), their ID and Jira key (the index's `Unit ID` and `Jira` columns) |
| `<intent>/unit-points.csv`, `.mcp.json` at the workspace root | each Unit's story points, and the Atlassian MCP server to ask for the missing ones (see *Construction by Unit*) |
| `<intent>/audit/*.md`, `<intent>/construction/<unit>/` | how far each Unit has got |
| `.git/HEAD` | the branch, for stage-vs-side-job mode |
| `.claude/settings.json` at the repository's top | whether a `pr-review` plugin is on (only when a PR is open) |

And, since 0.7.0, the second truth (see *Two truths* below), through `git` and the forge layer (see [Forges](#forges-github-and-gitlab): `gh` on GitHub, `glab` on GitLab, self-hosted included). Nothing is written, to the repository or the forge (the one write the provider makes is `unit-points.csv`, below):

| Command | Used for |
|---|---|
| `git show origin/<default>:<intent>/aidlc-state.md` | where each stage stands on the default branch |
| `git remote get-url origin` (then, off github.com, `glab auth status` / `gh auth status`), cached per repository | which forge the origin lives on, and the `forge` option's override |
| open changes with their status: `gh pr list --state open --limit 100 --json ...,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests,latestReviews,body,author`; `glab mr list -R <web address> -F json -P 100`, then per open merge request (at most 20) `glab mr view <n> -F json` (pipeline) and `.../approvals` | stage changes: state, draft, review (on GitHub the full review state, see *Pull request review*), CI, behind. A failed GitLab pipeline names no checks, so it shows as one failing check, `pipeline` |
| merged changes, without status: `gh pr list --state merged --limit 200 --json ...`; `glab mr list ... --merged -F json -P 100`, paged | the stage changes already on the default branch |
| `gh pr view <n> --json files`; `glab api --hostname <host> projects/<path>/merge_requests/<n>/changes` | reopens: an open stage change touching an earlier stage's folder (cached per head commit; the 5 newest open stage changes) |
| `gh repo view --json url,defaultBranchRef`; `glab api --hostname <host> projects/<path>` | the default branch (else `origin/HEAD`, else `main`) |
| `gh api user --hostname <host>` (GitHub) | who you are, for the rows tied to you (only when a pull request is open; kept an hour) |
| `gh api user/teams?per_page=100 --hostname <host>` (GitHub) | the teams you are in, for a review asked of a team (only when an open pull request asks one; kept an hour) |
| `git rev-list --count HEAD..origin/<default>` | how far this session's stage branch is behind, when no PR says so |
| `git ls-remote origin refs/heads/<default>`, `git fetch --quiet origin <default>` | the fingerprint (below); the fetch runs only when origin's tip moved |

Mapping: phases are sections (`verified` built, `active` active, `pending` planned, `skipped` skipped; a
non-active phase with some stages done and some not is partial), stages are items (`[x]` done, `[-]` in
progress, `[?]` awaiting, `[R]` revising, `[ ]` planned, `[S]` or a `SKIP` row skipped). Counts and
percentages cover executed stages only. `Parked` and `[?]` become gates; a parked workflow with no known
stage still shows its gate, at the top of the section the session is in.

### Numbering and Construction's size (0.11.0)

Phases are numbered from 0 in the lifecycle's order (`0 Initialization`, `1 Ideation`, `2 Inception`, `3 Construction`, `4 Operation`) and
stages `<phase>.<stage>` from 1 in the state file's order, skipped rows included (`2.2 requirements-analysis`), so a number
means the same stage whatever is skipped. Unit rows carry none.

Until Units Generation has finished and produced Units, Construction's seven stages are not a size anyone knows: the section
is listed with its stages but carries no count or ring (its row says `not included yet`, in `local only`'s amber), and the plan counts only the other phases. Once the Units exist
(or when Units Generation is skipped), Construction counts again, as below.

### Construction by Unit (0.10.0)

Once Units Generation has cut the intent into Units, Construction is not seven stages. Five of them
(functional-design, nfr-requirements, nfr-design, infrastructure-design, code-generation) run once **per Unit**, and the
engine ticks their checkbox only after every Unit; build-and-test and ci-pipeline run once. So Construction is drawn as
**one row per Unit**, in build order, with its story points, followed by the run-once stages. Build order (0.22.0) is
the dependency graph's: a Unit with no dependency first, then each Unit after the longest chain of Units it waits on
(the step it can be built at), and Units ready at the same step by their number (`U5` before `U12`), so the thin slice
`U31` that most Units wait on sits right after `U1`, not at the end:

```
▾ Construction                       ◔  1/4 units  8/29 pt
  1 of 4 units done, 8 of 29 story points
    ✓ U1 api-core  8 pt
    ◐ U2 web-shell  3 pt               functional-design done
  › ◐ U3 api-billing  13 pt                  nfr-requirements
    ○ U4 web-billing  5 pt, default          waits on U3, U2
    ○ build-and-test
    ○ ci-pipeline
```

**Counted by story points (0.15.0).** The row's count is the story points done of all (`8/29 pt`, not the rows'
`1/6`), with the Units done beside it (`1/4 units`, a grey pill on the desktop), and the caption says both.

**A Unit claimed at this checkout (0.15.0; the claim's source changed in 0.20.0).** When the checkout's
`aidlc/.aidlc-unit-scope.json` names one of the Units (the engine writes it on `aidlc --claim <unit>`, keeps it while
the checkout builds the Unit, and `aidlc unit finish <unit>` deletes it; git ignores it) for this intent (its space, and
its UUID where `intents.json` has one) — a worktree or the main checkout — Construction narrows to that Unit. The state's
`Active Unit` is not the claim: the state is the intent's, and the engine resets it between stages. Construction then:

```
▾ Construction  U3 api-billing                      ◔ 1/5
  U3 api-billing, 13 pt: claimed at this checkout
    ✓ functional-design
  › ◐ nfr-requirements
    ○ nfr-design
    ○ infrastructure-design
    ○ code-generation
▸ Units                              ◔  1/4 units  8/29 pt
```

- **Construction** is the Unit's own walk through the five per-unit stages, each where that Unit stands on it (before the
  stage it is on done, that one in progress or `paused`, the rest planned; all done once it is built), counted one row
  each (`1/5`; no points: the Unit's points are counted once, under Units, and its rows carry no `pt`). A fresh claim, with
  no receipt or artifact yet, is on the workflow's own `Current Stage` (0.19.1). The Unit is a tag beside the title (an accent pill on the desktop). The phase stepper's Construction node shows
  the same progress, and the Now card is on that stage. A stage's own gate (`[?]`) shows on its row, and hangs after it.
- **Units** follows, folded: every Unit with its points, and the stages that run once (build-and-test, ci-pipeline), as
  the unclaimed Construction draws them, with the same counts. It is no phase: the stepper and the wide pane's phase
  cards leave it out, and the plan list keeps it as a row of its own.
- **The plan's percent** counts the Units, never the claimed Unit's stages, so it is the same claimed or not.

- **Where a Unit stands (0.20.0).** Where the state has the engine's `## Unit Progress` table (team ownership,
  unit-major iteration), its row decides, stage by stage: `[x]` done, `[-]` in progress, `[?]` waiting on the person's
  approval, `[R]` revising, `[ ]` not started. A stage whose work is finished but not approved is `[?]` there even though
  its `UNIT_COMPLETED` receipt is written, so it is drawn waiting on approval, never done: `functional-design awaits
  approval` on the Unit's row, one `awaits your approval` row under Needs attention, and Next is `/aidlc`. The engine
  rewrites the table only when `/aidlc` routes, so a stage that started since can still read `[ ]` there: a cell at
  `[ ]` whose latest receipt is `UNIT_STARTED`, `UNIT_RESUMED` or `UNIT_PAUSED` is in progress (0.20.1). So is a cell at `[x]` with such a receipt last: a stage re-opened after its approval
  (`aidlc engine jump reopen`) starts again while the table can still say done (0.21.2). Any other cell past `[ ]`
  stays the table's. A stage a Unit's kind does not owe is `[x]` there too, unrun (0.21.0): units-generation tags each
  Unit `kind: service|spec|ui|packaging|library`, and a per-unit stage none of whose `produces` its `produces_kinds` map
  gives that kind does not apply (the engine's own rule). The panel reads those maps from the workspace's engine install
  (`.claude/aidlc-common/stages/construction/<stage>.md`, or the other agents' install folders) and draws such a stage
  skipped, not done: a packaging Unit nobody has started is not started, and a claimed one counts `0/4`. Without the
  stage files every stage counts as the table says. Without the table, the receipts and artifacts below decide.
- **A Unit is done** when code-generation, its last per-unit stage, is settled for it: a `UNIT_COMPLETED` receipt in the
  audit shards when one is owed (Construction Checkpoints enabled, or any `UNIT_*` row exists), else its four
  code-generation artifacts under `construction/<unit>/code-generation/`. code-generation's own `[x]` means every Unit
  is. The latest row per (stage, Unit) decides, so a restarted stage un-settles it.
- **Its status word** is the stage it is on (`nfr-requirements`), `paused at <stage>`, `<stage> done` between stages,
  or, not started, `waits on <IDs>` while a Unit it depends on is not done. The current row is the state's `Active Unit`,
  else the directive's unit.
- **Story points**, per Unit, in this order:
  1. `<intent>/unit-points.csv`: `unit,points,source` rows, the Unit by its ID (`U3`, any case) or its name, and
     `source` who estimated it, `ai` or `human`. The source is a record for people: the panel never reads it, and a row
     without one counts the same. A header, blank lines and `#` comments are skipped. The **last** row for a Unit wins,
     and while a Unit has more than one row, Needs attention says `unit-points.csv lists a unit more than once` and
     names it.
  2. Jira, for a Unit the file has no row for and whose index row has an issue key: the panel calls the Atlassian MCP
     server the workspace's `.mcp.json` lists (the entry whose URL is on `atlassian.com`) through the session's own
     connection, `getAccessibleAtlassianResources` once, then `getJiraIssue` with `expand: names`, and takes the field
     named *Story Points* or *Story point estimate*. A stage session appends the answer to `unit-points.csv` as
     `U3,13,human` (Jira's points were set by a person), creating the file with its header, or adding `source` to an old
     `unit,points` header; a side job only keeps it in the store. An issue with no points, or a call that fails (server not
     connected, signed out), is asked again after an hour.
  3. `5`, shown as `5 pt, default` in the warning tone.
- **Progress, by story points (0.16.0).** Every stage is 1 story point, a Unit its own points, so the plan weighs
  building at what it was estimated against the stages around it. A Unit counts its points once done, nothing before.
  Construction's ring is its Units' points plus 1 point per run-once stage; the plan's percent is every stage's points
  plus every Unit's, and the heading says so: `23% done by story points, 14 of 62 pt` (15 stages outside Construction,
  45 Unit points, build-and-test and ci-pipeline). Before 0.16.0 the Units shared as many rows as there were Units,
  so 45 points of building weighed what 8 planning stages did.
- **Points shown (0.17.0).** Every phase's count is its points done of all (`7/8 pt`, Construction `0/47 pt`: its 45
  Unit points and its two run-once stages), so the phases add up to the plan's total. Every stage row says what it
  weighs, after its chips (`1 pt`, a grey pill on the desktop, dim on the terminal); a Unit says it in its own chip, and a
  skipped stage, or one of a Construction not counted yet, says nothing. Construction keeps `0/6 units` beside its
  count.
- **`stage-story-points.txt`.** `<intent>/stage-story-points.txt` overrides a stage's points, or the rate for every
  stage it does not name. One `<stage>: <points>` per line (`=`, `,` or spaces work as the separator too), `default:
  <points>` for the rest; blank lines and `#` comments are skipped, names match in any case, and the last line for a
  stage wins. Every ring and the plan follow it, and with the file the heading counts in points even before there are
  Units. A name that is no stage of the plan, or a line that is not `<stage>: <points>`, counts nothing, and Needs
  attention says `stage-story-points.txt has lines that count nothing` and names them. The file is watched: an edit
  re-reads.

  ```
  # design is heavier here
  default: 1
  domain-design: 3
  build-and-test: 2
  ```
- **Commit the file.** While `git status --porcelain` shows `unit-points.csv` changed or new, Needs attention carries
  `unit-points.csv not committed`: the panel may have added Jira's points, and a pre-review check that refuses
  uncommitted files would otherwise be a surprise.
- Before Units Generation has written its dependency block, or with code-generation out of scope, Construction keeps its
  seven stage rows. An open gate (`[?]`) or a park on a per-unit stage hangs after the current Unit.
- A Unit row carries no PR state yet: Units are built in their own repositories, which the panel does not read.

### Selection

Mirrors upstream's `core/hooks/aidlc-statusline.ts` (`readSessionBinding`, `resolveWorkflowSelection`):

- a valid session binding to a live intent wins;
- a binding to an **archived** intent, or `intent: null` with `source: "archive"`, means this session shows
  **no workflow**: an *Idle* card with the archived caption and no sections, whatever the shared cursor names;
- a binding with `intent: null` otherwise is a **side job** on the intent of the *binding's* space (its
  `active-intent`, else its lone intent), not the global active space;
- with no binding: `active-intent`, else the lone non-archived intent of the active space;
- two or more live intents and no cursor: *Idle*, saying that none is selected; none live: *Idle*, nothing in flight.

**Parked, and running (0.19.1).** A `Parked:` line in the state holds only while no audit shard has a `WORKFLOW_UNPARKED`,
`STAGE_STARTED`, `UNIT_STARTED` or `UNIT_RESUMED` row later than it: the engine can resume without clearing the line, and
the panel then shows no park. While the current stage is running (in progress, not parked, not waiting at a gate) the Now
card has no Next: the workflow is doing it. A PR that asks something of you (a review, a merge) still names its command.

**Stage vs side job.** A session bound to an intent (its `aidlc/.aidlc-sessions/<session>.binding.json`) is a
stage session, whatever its branch is called (0.13.0; before, the branch had to match `stageBranchPattern` too).
Anything else in an AI-DLC workspace — unbound, or bound to no intent — is a side job: a "Side job" badge and a
"This session" card saying so.

A side job is not a stage of the plan, so the panel does not point it at the plan (0.9.1):

- **No `/aidlc`.** The card has no Next block, and a parked workflow's row says when it was parked without telling
  the session to resume it.
- **Its own context first.** Under the caption, one dim line each: the branch (`on claude/side-work`), the open PR
  or MR that branch carries as a link with its review word (`PR #25, awaiting dev-b`), and how far the branch is
  from the default branch (`3 ahead, 2 behind main`, behind in warning; one `git rev-list --left-right --count`).
  Without git only the branch is known; a detached HEAD has none.
- **The plan folds.** With a PR or commits to show, the intent's whole plan is one row, `▸ Plan  50% done, 11 of 22`,
  and a press opens it (`▾ Plan` folds it again; the choice is kept like a section's). With nothing to say beyond the
  branch's name (a fresh worktree) the plan stays open as before. The provider asks for the fold with the model's
  `isPlanCollapsed`; a model without it draws the plan open, with no toggle.

A stage session is unchanged.

### Two truths (0.7.0)

A stage done in this worktree is not a stage done. The panel reads the intent's state file twice — the working
tree's copy and `origin/<default>`'s — and maps the repository's PRs onto stages by branch name
(`stageBranchPattern`, `foldSeparator`; never hardcoded). With L the working tree's marker and M main's:

| Landing | When | Drawn |
|---|---|---|
| merged | M is `[x]` | `✓`, the newest stage PR merged since the intent's Start Date as a chip |
| in review | an open PR's branch carries the stage | `◐` with the PR's review state as the word (`awaiting dev-b`, `changes requested`, `approved`, …; `in review` where none applies), a linked `[#33]` chip (`[#33 draft]`), `CI failing` and `Slack thread` chips — never `✓` |
| not merged | the PRs could not be read, and this session's branch carries the stage and is on origin | `◐ not merged` — never `✓` |
| local only | L is ahead of M and nothing above applies | `◌ local only` (`◌ pushed, no PR` when the branch is on origin and the PRs were read) — never `✓` |
| up next | not done on main, current or marked in progress here, and nothing written in its `<phase>/<stage>/` folder yet | `○ up next` — a stage the engine moved to, not work in progress |
| (none) | otherwise | main's own status (running, parked) as before |

Merged stages count as done, in the rings and the plan's percent, and so does every stage **checked off in this checkout's state** but not on main yet (`[x]` here): drawn `◌ local only` or `◌ pushed, no PR` (0.11.0), or `◐ in review` in its open PR (0.19.0). Progress follows the local state; the glyph and the word still say where the work stands. A stage in progress (`[-]`) does not count. Phases take main's Phase Progress, so finished-here work does not turn a phase `partial`.

- **Folds.** A branch carrying several stages (`dev/SHOP-7/domain-design--units-generation`) draws one bracket
  in the gutter across them, the PR chip on the first.
- **Reopens (0.9.4).** A merged stage is **reopened** (`↺`, the word `reopened`, not done) when an open stage PR's branch
  carries it again, when an open stage PR's changed files touch its `<intent>/<phase>/<stage>/`, or when this session's
  own stage branch carries it before any PR exists (a backward jump folded it in). The first two add a
  `↺ reopened in #N` chip (`!N` on GitLab); the merged PR's chip stays. A checkout of the merged PR's own branch is a
  stale branch, not a reopen; without the PR list only a box that went back below `[x]` here reopens. Every stage
  merged **after** the earliest reopened one is **stale** (an amber `✓`, the word `stale`, not done): it was built on
  what is being redone. Stages in progress, in review or not started keep their own status. Neither counts as done
  in the rings or the percent, and a narrow row keeps both words. From the forge's changed-files read; no model call.
- **Phase branches (0.18.0).** A branch whose last segment is a phase's name (`docs/inception`, `semka/Construction`,
  any case) carries every executed stage of that phase: one PR for the whole phase, drawn as a fold, its chip on the first
  stage it still brings. Stages of the phase already on main stay merged (the phase PR is not a redo of them; its changed
  files can still reopen one), and a session on the phase branch does not reopen them either. A phase branch names no
  ticket, so a session on a stage branch still sees it. Only the last segment counts: `inception/mvp-to-refined-mockups`
  may be a part of the phase, and carries nothing unless the stage pattern reads it.
- **Fold names.** After the separator a fold may name stages with commas, and words that are no stage are dropped:
  `dev/ABC-5/refined-mockups--folded--requirements-analysis,user-stories` carries requirements-analysis, user-stories
  and refined-mockups. A fold's stages are consecutive, so the ones between the named ones are carried too.
- **GitLab says merge request.** The same panel on a GitLab origin spells numbers `!275` and says `MR !275 not merged`,
  `CI failing on MR !275`, `main: refined-mockups in review, MR !275`, `pushed, no MR` (the `.gitlab` twins of those
  keys in `src/strings/en.ts`). Its mapping onto the same gates: a failed head pipeline is CI failing; approvals are
  the review (a `requested_changes` merge status is changes requested); `need_rebase` is behind, `conflict` is
  conflicts.
- **Gates between stages**, after the PR's last stage: `PR #33 not merged` ("domain-design can't start on main
  until it lands"), `CI failing on PR #33` (the failing checks), `Changes requested on PR #33` (`… on your PR #33`,
  with `/pr-review:address-review 33`, when you wrote it), and
  `<branch> is behind main` (from the PR's merge state, or `rev-list` for this session's stage branch; never for stages already merged). A PR whose
  stages are all merged already holds nothing back and gets no gate. A park waiting on a PR (the parked stage is
  the next one after it) moves next to that PR's gates and says so.
- **The Now card** says where the work lives — `○ domain-design · up next` before anything is written for it,
  `◌ … · local only, this worktree` once it is — and under it where main stands:
  `main: refined-mockups in review, PR #33` (with the review state when there is one:
  `main: refined-mockups approved with comments, PR #33`). Its **Next** is `/aidlc`, unless the PR the current stage
  is in, or the one it is parked behind, asks something of you (see *Pull request review*).
- **A network that drops** (a laptop's connection to GitHub refusing for a few seconds is common) never blanks
  the PR chips: each list call (`gh pr list`, `glab mr list`) is retried once, and when it still fails the last listing that worked stands in
  (kept in the plugin's store across sessions), with the "PRs may be stale" line until the next good check.
- **Tickets.** On a stage branch of the plan (its branch names a stage the plan has), only PRs of the same ticket count.
  A branch the pattern reads that names no stage (`ms/BM-218/sprint-rules`, side work in its own worktree) is not a
  stage branch: every ticket's stage and phase PRs count there, as on `main` (0.21.1). Closed PRs never count.
- **One truth.** Outside git, without an `origin`, or without `origin/<default>` (after one fetch attempt), the
  provider draws exactly what 0.6.0 drew. A failing `gh` or `glab` (or `forge: none`) leaves the landings from the two files (done on a branch
  with no known PR is *local*) and drops the PR chips and gates.
- **Cost.** After the first read, a load runs one `git rev-parse` (plus a `rev-list` on a stage branch): the repo
  root and intent prefix are asked once, main's copy is re-read only when `origin/<default>` moved, the PR lists
  (open with review/CI/merge state, merged without) are reused for 60 s or until main moves and are refreshed by
  the fingerprint, file lists are kept per head commit, and failures are not retried for 60 s. A missing
  `origin/<default>` is fetched at most once a minute. `gh pr view --json files` sees GitHub's first 100 files; on GitLab the open-merge-request status lookups are capped at 20 per read.
- **Conflicts.** An open stage PR the forge reports as conflicting gets `PR #33 has conflicts with main`.
- **Limits.** Outside a stage branch there is no ticket to filter by, so in a repo where several tickets reuse
  the same stage names a side-job session can pick up another ticket's PRs.

The case that motivated it (a stage PR open, the engine parked on the next stage, nothing written for it yet), medium width, terminal:

```
SHOP-MVP checked just now ↻ Refresh
Now Inception, 4 of 6
○ domain-design up next
main: refined-mockups in review, PR #33
Next /aidlc               Put in prompt
Execute the current stage
Needs attention (2)
‖ PR #33 not merged Inception, after refined-mockups
‖ Parked at domain-design Inception, after refined-mockups
◔ Plan 25% done, 2 of 8
▾ Inception ◔ 2/6
✓ requirements-analysis [#30]
✓ user-stories [#31]
◐ refined-mockups [#33] in review
‖ PR #33 not merged
domain-design can't start on main until it lands.
‖ Parked at domain-design
Waiting on PR #33 to merge; parked 2026-10-06 09:30. Resume with /aidlc once it lands.
› ○ domain-design up next
○ units-generation
○ contract-design
▸ Construction ○ 0/2
```

## Pull request review (0.9.0)

Both providers read where each open PR's review stands, from the `gh pr list` call they already make (the review
fields ride on it; nothing is asked per PR), and say what it asks of **you** — the signed-in `gh` user
(`gh api user`). It was written for the `pr-review` plugin's flow (`/pr-review:request-review` sends a PR for review,
`/pr-review:review-pr` reviews it, `/pr-review:address-review` answers the review and merges), and reads only what
GitHub records, so it works on any repository.

| Review state | When | Status word |
|---|---|---|
| draft | the PR is a draft | `in draft` |
| awaiting | someone is asked to review (first time, or again after changes), until they review | `awaiting DaniilMurai`, `awaiting you`, `awaiting you, DaniilMurai, Core reviewers`: every requested reviewer as GitHub lists them (people by login, teams by name), you first |
| changes | `reviewDecision` is CHANGES_REQUESTED, or (no decision: no branch protection) a latest review is | `changes requested` |
| commented | no verdict, but a latest review is COMMENTED | `commented` |
| stale | approved, but the latest approval was given on an older head commit (`latestReviews[].commit.oid` ≠ `headRefOid`): merging needs a new one | `approved, new commits` |
| approved | approved, and the latest approval's body is only its empty frame (`Add override: None`) | `approved` |
| approved with comments | approved, and the latest approval's body has points | `approved with comments` |
| nobody asked | open, not a draft, no request, no verdict | `no reviewer` (the old `in review` / `in progress` where the commands are off) |

Reviews by the PR's author (their replies) never count; the latest review per person decides. The word is coloured
(accent while reviewed, warning on changes or nobody asked, green once approved) and stays on a narrow row.

**Needs attention**, first, a row per open PR that asks something of you, with the command as a button that puts it
in the prompt:

| Row | When | Command |
|---|---|---|
| `? Your review is requested on PR #40` | you, or a team you are in, are among the requested reviewers (not a draft) | `/pr-review:review-pr 40` |
| `‖ Changes requested on your PR #33` | your PR, changes requested | `/pr-review:address-review 33` |
| `‖ Comments on your PR #33` | your PR, reviewed with comments only | `/pr-review:address-review 33` |
| `‖ PR #33 changed since its approval` | your PR, approved on an older head, no re-review asked | `/pr-review:address-review 33` (its gate offers Ask re-review) |
| `✓ PR #33 approved with comments` | your PR, approved with comments | `/pr-review:address-review 33` |
| `✓ PR #33 approved` | your PR, approved | `/pr-review:address-review 33` (it offers the merge) |
| `‖ Your draft PR #33 is not sent for review` | your draft | `/pr-review:request-review 33` (it marks the draft ready at its gate) |
| `‖ PR #33 is not sent for review` | your PR, open, not a draft, nobody asked, no review | `/pr-review:request-review 33` |

Any review of your PR leads to `address-review`, which reads the review and picks its path; the panel never suggests a
literal merge, since `address-review` checks the approval is on the current head and merges the team's way. The set is
the one the `pr-review` plugin's author defined. A review you already gave on the current head drops you from the
requested reviewers, so `review-pr` is not suggested again until you are asked again.

A row is about every open PR of the repository, in the plan or not: one about a plan item says where
(`Inception, refined-mockups`), one about any other PR says what it is (its title and author). The rows are drawn
under Needs attention only, never in the plan. For AI-DLC, "changes requested on your PR" is the PR's own
changes-requested gate, which then says "your" and carries the command. **Next** follows the same mapping for the PR
the current item is in (AI-DLC: or the PR it is parked behind); otherwise it stays `/aidlc` or the ledger's next task.

The commands are named only where the `pr-review` plugin is in use (`reviewCommands`, `auto` by default: the
repository's committed `.claude/settings.json` enables `pr-review@…`). Without them the rows you can act on by hand
still show, with no command, and "not sent for review" is no row at all. Without a known viewer (`gh api user` fails)
there are no rows, and the words still show. All of this is GitHub's: on GitLab (no `reviewFacts`, no viewer) an MR
shows `in draft`, `changes requested` and `approved` from the forge's own review status, and no rows tied to you.

**Slack.** `/pr-review:request-review` appends `<!-- pr-review:slack channel=<id> ts=<ts> -->` to the PR body; a PR
with that line gets a `Slack thread` chip beside its PR chip. With `slackDomain` set the chip links to the thread's
permalink; without it, it only says the thread exists. No Slack call is made. A PR body is never kept: the plugin's
store (a start during an outage) holds only the thread's channel and timestamp.

The AI-DLC case from the top, with PR #33 approved with comments and a teammate's PR #40 waiting on your review,
medium width, terminal:

```
SHOP-MVP checked just now ↻ Refresh
Now Inception, 4 of 6
◌ domain-design local only, this worktree
main: refined-mockups approved with comments, PR #33
Next /pr-review:address-review 33 Put in prompt
PR #33 approved with comments
Needs attention (4)
? Your review is requested on PR #40 SHOP-9 Fix the login redirect — by dev-b
/pr-review:review-pr 40
✓ PR #33 approved with comments Inception, refined-mockups
/pr-review:address-review 33
‖ PR #33 not merged Inception, after refined-mockups
‖ Parked at domain-design Inception, after refined-mockups
◔ Plan 25% done, 2 of 8
▾ Inception ◔ 2/6
✓ requirements-analysis
✓ user-stories [#31]
◐ refined-mockups [#33] [Slack thread] approved with comments
‖ PR #33 not merged
domain-design can't start on main until it lands.
‖ Parked at domain-design
Waiting on PR #33 to merge; parked 2026-10-06 09:30. Resume with /aidlc once it lands.
› ◌ domain-design local only
○ units-generation
○ contract-design
▸ Construction ○ 0/2
```

**Limits.** `latestReviews` carries a review's body, not its inline comments: an approval whose points are only
inline reads as plain `approved` (`/pr-review:review-pr` also lists every point in the body). A team asked to review
shows by its name; it counts as "your review is requested" when you are in it (`gh api user/teams`, asked only while
an open PR asks a team, kept an hour; it needs the token's `read:org`, and without it a team request is no row). Only
the first 100 of your teams are read. A long reviewer
list is cut on a narrow row (down to 8 columns, after the title keeps its 12). The ledger's one `gh pr list` asks for these fields
for up to 1000 PRs; its fingerprint adds the review fields but not the bodies, so a Slack marker alone shows on the
next load, not the next poll.

## Options

| Option | Default | Meaning |
|---|---|---|
| `panel` | `auto` | `auto`: open by itself when a plan is detected (desktop app only — unasked panes need 144 columns); `command`: only `/panel` or a button; `off`: never (`/panel` says it is off). A pane the person closed is not reopened by `auto` that session; a slim bar above the prompt (*Project panel is closed. Open panel*) or `/panel` reopens it |
| `stageBranchPattern` | `^[^/]+/(?<ticket>[^/]+)/(?<stages>.+)$` | AI-DLC. How a pull request's branch names its ticket and stages (groups `ticket`, `stages`), to map PRs onto stages. Not used to tell a stage session from a side job: the binding decides that |
| `foldSeparator` | `--` | AI-DLC. Separates stages in a branch carrying several (`dev/SHOP-7/a--b`) |
| `forge` | `auto` | Where pull or merge requests are read from. `auto` detects it from the origin (see [Forges](#forges-github-and-gitlab)); `github` / `gitlab` take the origin's host as that forge without probing; `none` reads no requests (the ledger stands alone, no AI grouping, no complaint) |
| `reviewCommands` | `auto` | Whether attention rows and Next name the `pr-review` commands. `auto`: when the repository's `.claude/settings.json` enables a `pr-review` plugin (`"pr-review@<marketplace>": true`); `on`; `off` (the review state still shows) |
| `slackDomain` | `''` | The Slack workspace's domain (`acme` for acme.slack.com): makes a PR's `Slack thread` chip a permalink. Empty: the chip only says the thread exists. Slack is never called |
| `fsPollSeconds` | `10` | How often the open pane stats the plan's files and runs `git rev-parse HEAD` / `git branch --show-current`. Minimum 2; `0` turns the poll off |
| `prPollSeconds` | `180` | How often the open pane asks the provider for its remote `fingerprint`. Minimum 30; `0` turns the poll off. A provider without remote state is never asked |
| `summaryModel` | `claude-haiku-5-5` | enrichment model (milestone 4+); a full id, not the `haiku` alias |

The default `stageBranchPattern` is a 3-segment `<owner>/<ticket>/<stages>` convention for stage PRs' branches. Set it
to empty to map no pull requests onto stages.

## Staying fresh (M2)

The pane re-reads the plan by itself; `src/refresh.ts` is the engine (provider-neutral, `$`-free, ports in).

| Trigger | What happens |
|---|---|
| session start | the first read; the engine adopts it as its baseline |
| `Write` / `Edit` / `MultiEdit` / `NotebookEdit` of a `watch` path, or any path under a watched directory | re-read |
| `Bash` running `aidlc`, `git`, `gh` or `glab` as a command word (`cd x && git pull`, `FOO=1 gh pr view`, `glab mr view 275`, `npx aidlc`, `sudo -u me git`, `timeout 30 gh api`, `bash -lc "git status"`, `$(git ...)`; not `legit`, not `github.com` in an argument) | re-read |
| a turn ending, a surface attaching | re-read, and on attach a remote fingerprint check |
| the file poll (`fsPollSeconds`) | a changed mtime of a `watch` path, or a new git sha or branch, re-reads; a plan that went away keeps its last watch list polled |
| the remote poll (`prPollSeconds`) | a provider's `fingerprint` that differs from the last one re-reads |
| the Refresh button, `/panel` | re-read now (Refresh also redraws "checked ...") |

- **Debounce.** Triggers coalesce: a read already scheduled absorbs later ones (it is never pushed out, so a
  burst cannot starve it) and a read in flight queues exactly one more. 20 tool calls in a turn make one re-read.
- **Redraw only on change.** The model is hashed without `readAt` and `freshness`; an identical re-read writes
  nothing. The header's "checked 12s ago" is the latest check, changed or not: a poll tick that finds nothing
  moves it, and redraws the pane only when the text on screen would change.
- **Errors never break the pane.** A failed re-read (a disk error, not a merely missing file) or remote check
  (including one that hangs for 30 s) keeps the last model and adds one Attention line ("showing the last good
  read" / "Could not check merge requests (glab not logged in to ...); they may be stale"); the next success clears it. A repo without git is normal, not an error.
- **No lost writes.** Mtimes and HEAD are read before a re-read, so a write during it is seen by the next poll;
  a provider action's answer replaces any read still in flight.
- **Only while it is on screen.** Timers run only while `$.ui.panes()` lists the pane as open and placed and
  `panel` is not `off`. Closing it stops them at once; `/panel`, a render or a surface attaching resumes with a
  catch-up read. (The closed flag only keeps `panel: auto` from reopening the pane.)
- **The remote poll exists only for providers with a `fingerprint`.** Both have one; AI-DLC's answers `''`
  outside git or without an `origin`, so a repo with no forge never shows a remote error.
- **The desktop app attaches after session start**, so `panel: auto` opens the pane from the `session.attach`
  hook (once; never when closed, `command`, `off`, or without a plan).

A provider may declare `watch` paths (files or directories) and an optional `fingerprint(ctx, detection)`
(cheap, through `ctx.host.run`, may throw). AI-DLC watches the state file, the engine directive, the binding,
the cursors, the intent directory and `aidlc/`. Its fingerprint (0.7.0) digests every open and merged PR's number, state, draft,
merge time, head commit, review (decision, who is asked, the latest reviews, the Slack marker), merge state and failing
checks, plus `git ls-remote` of the default branch;
when origin's tip differs from the local `origin/<default>` it runs `git fetch --quiet origin <default>` first.
Where the forge has never answered for the repo (no `gh`/`glab`, not logged in from the start, no origin, `forge: none`)
it digests the tip alone, so no permanent "remote" error line appears; where it answered before and now fails, it
throws the forge layer's `ForgeError`, whose cause-specific line ("Could not check merge requests (glab not logged in
to gitlab.example.test); they may be stale.") the refresh engine shows.
So a merge, a new PR or CI going red shows within `prPollSeconds`, with no manual refresh.

## Layout

```
types/index.d.ts                  the contract: Provider, ProviderContext/Host, PanelModel v2, the $.state values
src/fsx.ts                        file-read port helpers (join, parent; $.fs adapter lives in hooks/register.tsx)
src/detect.ts                     PROVIDERS, detectPlan: in order, first hit wins
src/model.ts                      buildModel = detectPlan + provider.load; runAction
src/forge/                        the forge layer: types, remote.ts (origin URL), detect.ts, github.ts (gh), gitlab.ts (glab),
                                  problem.ts (ForgeError, cause text), index.ts (forgeFor)
src/refresh.ts                    the refresh engine: ports in, hash-gated publish, debounce, polls, tool-call classification
src/render.tsx                    renderPane: any PanelModel -> pane tree (deterministic), per breakpoint and surface
src/render/                       its blocks: header, now (card, Next, actions), attention, plan (list, phase cards), item, ring (rings + strip),
                                  stepper (the phase stepper, isPhased), look (the desktop's pills and status icons), kit
src/freshness.ts                  the "checked 12s ago" stamp (pure; the caller hands in the clock)
src/version.ts                    the plugin's own version from its manifest, for the pane's foot (pure)
src/strings/en.ts                 every user-facing string (a mod imports code files only, so not .json)
src/providers/ledger.ts           the ledger Provider (detect, load, pin/rebuild actions)
src/providers/ledger/             the pure core (parse, match, progress, next, drift, discover, hash, ai) and its
                                  adapters (host.ts git and repo facts, l2.ts model inputs and store, view.ts PanelModel)
src/providers/review/             PR review state for both providers: facts.ts (gh row -> review facts, the state; pure),
                                  view.ts (status word, Slack chip, rows tied to the viewer, Next), viewer.ts (the
                                  forge's viewer, the pr-review settings check)
src/providers/aidlc.ts            the AI-DLC Provider
src/providers/aidlc/detect.ts     workspace detection
src/providers/aidlc/git.ts        branch from .git/HEAD (worktrees included)
src/providers/aidlc/select.ts     intent selection + stage/side-job mode
src/providers/aidlc/parse-state.ts  aidlc-state.md -> ParsedState (pure, only type imports; node-runnable)
src/providers/aidlc/load.ts       -> PanelModel
src/providers/aidlc/units.ts      Construction by Unit: the units block, the index's IDs and Jira keys, the audit receipts, progress
src/providers/aidlc/points.ts     each Unit's story points: unit-points.csv, then Jira through the session's MCP, then 5
src/providers/aidlc/stage-points.ts  each stage's story points: 1, or stage-story-points.txt (pure)
src/providers/aidlc/park.ts       whether a park still holds, from the audit shards (pure)
src/providers/aidlc/two.ts        the second truth: main's state file, the PRs, changed files, rev-list (I/O)
src/providers/aidlc/truths.ts     merged / in-pr / local per stage, chips, folds, reopens, gates, base line (pure)
src/providers/aidlc/prs.ts        every forge call of the AI-DLC provider (through src/forge: `gh` or `glab`), its caches, the fingerprint
src/providers/aidlc/types.ts      the provider's private parse/selection shapes
hooks/register.tsx                the hooks; adapts $.fs, $.process, $.model, $.store to the ports
fixtures/                         upstream template + a sanitised workspace + synthetic scenarios, as TS trees
tests/                            `claude plugin test` suites; check-upstream.ts is the CI parse of upstream main
```

## Develop

```bash
claude plugin validate plugins/project-panel
```

```bash
claude plugin test plugins/project-panel
```

```bash
node --experimental-strip-types plugins/project-panel/tests/check-upstream.ts
```

Type-checking needs the engine's declarations, which the engine lays into `.claude-plugin/types/` when it
loads the mod from a dev folder (`claude --plugin-dir plugins/project-panel`); then
`tsc -p plugins/project-panel`.

**See a desktop change before calling it done.** `tools/pane-preview/` draws the real `renderPane` with React, the
way the desktop app draws the pane (cells to px, theme keys to a dark and a light palette, calibrated against
screenshots of the real pane), over the test worlds' models and a sample of the design canvas. Edit, reload:

```bash
cd tools/pane-preview && bun install && bun serve.ts
```

Then open http://localhost:5178, pick a scenario and a width. It is an approximation of the app's renderer, not the
renderer: check the real pane too when spacing matters.

## Roadmap

- **M1** — providers seam, AI-DLC provider, static pane on desktop and terminal, `/panel`, rings, tests.
- **0.4.0** — the `ledger` provider (WORKPLAN.md against PRs, product sections you pin).
- **M2 (0.5.0)** — freshness: re-read on session start, branch change, writes to the `watch` files, turn end, a surface attaching, and an mtime poll; a provider's remote `fingerprint` poll (the ledger's PRs and default-branch tip); redraw only when the model changes; the desktop pane opens when the app attaches.
- **0.6.0** — the pane redesign: header, Now card, Needs attention, Plan; three breakpoints, done-folding and the open-items cap, the status strip.
- **0.23.0** — on the desktop, the rows about pull requests under Needs attention are one card, and the cards stand further apart.
- **0.22.0** — Units are listed in build order (the step of the dependency graph each can be built at, then by number), not in the dependency block's order.
- **0.21.2** — a Unit stage re-opened after its approval (its latest receipt a start) is in progress, even while the engine's table still says `[x]`.
- **0.21.1** — a session on a side branch the stage pattern reads but that names no stage (`ms/BM-218/sprint-rules`) no longer filters PRs by its ticket, so the plan's stage and phase PRs (`ms/BM-5/delivery-planning`) map there too.
- **0.21.0** — buttons keep one press handle per key across redraws, so the first press lands on a drawing the surface has not replaced yet (Put in prompt and folds no longer take a second click); a Unit stage its kind does not owe is skipped, not done, so an unstarted packaging Unit reads not started.
- **0.20.1** — a stage that started after the engine last wrote its Unit Progress table is in progress, not up next, so the stale Next goes too.
- **0.20.0** — the claim is the checkout's `aidlc/.aidlc-unit-scope.json`, not the state's Active Unit; Unit progress follows the engine's `## Unit Progress` table, so a stage waiting on approval is not shown done.
- **0.19.1** — a claimed Unit's stages count `0/5`, with no points; a fresh claim is on the workflow's Current Stage, so the Now card names it; a park the engine left in the state after work resumed (a later `STAGE_STARTED`/`UNIT_STARTED`/`WORKFLOW_UNPARKED` in the audit) is not shown; a running stage names no Next.
- **0.19.0** — progress follows the local state: a stage checked off in this checkout counts as done in its open PR too, not only when local only.
- **0.18.0** — phase branches (`docs/inception`) carry their whole phase; a press on the pane is taken by a `ui.press` hook, so the first press after the pane is shown again lands.
- **0.17.0** — points shown: every phase counts its points (`7/8 pt`), every stage row says what it weighs (`1 pt`).
- **0.16.0** — the plan by story points: every stage 1 point, a Unit its own, overridable per stage in `stage-story-points.txt`.
- **0.15.0** — Construction by Unit counted by story points (`8/29 pt`) with the Units done beside them (`1/4 units`); a Unit claimed at this checkout (`Active Unit`) narrows Construction to its own stages, with every Unit under a folded Units section.
- **0.14.1** — buttons work on the first click: the pane's render no longer reads the clock, which redrew it continually and retired its buttons' press handles under the pointer.
- **0.14.0** — a dim `project-panel <version>` mark at the foot of the pane, read from the manifest the mod was loaded from, so you can tell which build is drawing it.
- **0.13.0** — the desktop look (pills, tinted cards, status icons, ring-first section rows); a session is a stage by its AI-DLC binding alone, whatever its branch.
- **0.12.0** — desktop phase views: the phase stepper on a one-column pane, phase cards in the wide pane's plan column.
- **0.11.1** — Construction's row says `not included yet` until Units exist.
- **0.11.0** — phase and `<phase>.<stage>` numbers; stages finished but local only count as done; Construction is not counted until Units exist.
- **0.7.1** — "in review" instead of "in PR #N", "up next" for a stage nothing is written for yet, pushed work never "local only", and PR lists that survive a flaky network.
- **M3 (0.7.0)** — PRs per stage for the AI-DLC provider: two truths (merged / in PR / local only), PR chips with review and CI, folds across stages, deterministic reopens, gates between stages (PR not merged, CI failing, changes requested, behind main; a park waiting on a PR sits beside it), the Now card's main line, and a remote fingerprint.
- **0.9.4 (this)** — reopened stages: a merged stage carried again (by an open PR, or by this session's fold branch before it has one) is `↺ reopened`, not done, and the merged stages after it are stale; fold names with `--folded--` and comma lists.
- **0.9.1** — side jobs: no `/aidlc` suggested, the session's own context (branch, its PR, distance from the default branch) in the Now card, and the intent's plan folded behind a toggle once there is context to show.
- **0.9.0** — pull request review state for both providers (GitHub): the status word per review state (draft, awaiting, changes requested, commented, approved with new commits, approved with or without comments), the rows tied to you under Needs attention with the `pr-review` command to run, Next for the current item's pull request, the Slack thread chip.
- **0.8.0** — GitLab: a forge layer (`src/forge/`) so the ledger and the AI-DLC provider read merge requests through `glab` (self-hosted included) as well as pull requests through `gh`; the `forge` option; `!275` vs `#33` spelled by the forge; named causes when the requests cannot be read.
- **M4** — Haiku enrichment (structured JSON only, cached), side-job titles, own-session summary; gates for questions unanswered and guard refusals.
- **M5** — other sessions' summaries + "Ask session", mobile layout, status line.
