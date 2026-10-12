# model-fit

Before the first real task of a session, a quick Haiku check asks whether the model you are on fits
it, in both directions. When it does not, you get a small dialog **before anything runs**:

```
Model fit
Switch to Opus 5.5 for this task?

  Switch to Opus 5.5    concurrent writes with a crash-safety requirement
  Stay on Sonnet 5.5    Run it on Sonnet 5.5 as selected.
```

- **Too hard** for the current model: it offers the tier up.
- **Too easy** (a strong model grinding through mechanical work): it offers the tier down.
- **It fits**: a one-line toast (`Sonnet 5.5 fits this task`) and your prompt goes on untouched.

Conversation and quick questions are not tasks; the check waits for the first real one and then
never repeats in that session, even if the work changes.

## What the window decides

Four tiers, cheapest first. The classifier decides by numbered rules (the full text is
`CLASSIFIER_SYSTEM` in `hooks/classify.ts`; it is the same file the evals measure):

| Tier | Fits | Rules |
|---|---|---|
| Haiku | No decision left to make: find, rename, reformat, translate, an exact spelled-out edit, run a command and report | `H1`-`H4` |
| Sonnet | The default working tier: a competent engineer knows how, it takes judgment but the path is clear (features, bug fixes with a findable cause, refactors, tests, reviews, docs) | `S1`-`S4` |
| Opus | Known territory where correctness hinges on reasoning tests rarely catch: concurrency, failure and data integrity, security against an adversary, cross-system architecture, a root cause that is unknown and spans layers | `O1`-`O5` |
| Fable | No known path even for an expert: invent a new algorithm or protocol, an open research question, a whole new system from scratch with nothing to check against | `F1`-`F3` |

The first rule that matches decides, size never raises the tier, and the person's own adjectives
("simple", "critical") decide nothing. Every classification, the first one and each recheck, is three cheap Haiku calls made in parallel
and the majority wins (about $0.0006 a check), so a single odd answer cannot decide it. A request that only points at content it does not show
(`read PROMPT.md, implement`) is "not enough" yet: see [When the prompt isn't enough](#when-the-prompt-isnt-enough).

## The highest model

`highestModel` (a setting of the plugin, in `/config`) is the strongest model model-fit may suggest:
`auto` (default), `fable`, `opus`, `sonnet` or `haiku`. The plugin checks what it can before it
suggests a model: your cap, your `availableModels` setting, and in `auto` a probe once a day per
model. It cannot tell every failure apart, so it is a best effort and not a guarantee that a
suggested model works on your plan. The allowed tiers are those at or below the cap, narrowed by:

1. **Your `availableModels` setting**, read the way Claude Code reads it. When it is a non-empty
   list, a tier is allowed only if some entry is its alias (`opus`), is the model's id or a
   prefix of it up to a dash (`claude-opus-5` admits `claude-opus-5-5`), or is its display name
   (`Opus 5.5`). An entry for another version (`claude-opus-4-1`) does not admit `claude-opus-5-5`.
   Haiku obeys the list like the other tiers.
2. **In `auto` only, a probe**, for the one tier about to be suggested, when its answer is not
   remembered. The plugin sends that model a short question (16 tokens, low effort) and reads the
   reply by what it says about the model:
   - **Available, remembered 24 hours:** it answered, or replied with no text.
   - **Not available, remembered 1 hour:** the error kind is `model_not_found` (any status), or the
     status is 403 and the kind is not billing, authentication, rate limit or overload, or Claude
     Code refused to send the call because the model is blocked or not allowed.
   - **Counted as available, not remembered:** everything else. A 400, a billing or authentication
     error, 401, 402, 413, 429, a 5xx, no status at all, a timeout, or a refusal to send that is
     not an allowlist block say nothing sure about the model, so the plugin lets the model through
     and asks again next time.
   The answer is kept per model id in the plugin's store (Claude Code exposes no account to key it
   by, so a different login on the same machine shares it until it expires). With a cap set to
   anything but `auto` there is no probe: the cap and the allowlist decide. Haiku is never probed.
   Set a cap if your plan lacks a model.

**The fallback.** If the tier the classifier wants is not allowed, the plugin offers the nearest
allowed tier between your current model and that one, and the window says why: `Fable 5.1 would fit
best but isn't available; Opus 5.5 is the closest`, in place of the classifier's reason. If there is
none, you get `Opus 5.5 is the best available model for this task` instead of "fits". So a Fable
verdict on a plan without Fable offers Opus from Sonnet and shows that line on Opus, and an
unavailable model never turns into a downgrade the classifier did not ask for. The window names the
model it actually offers.

The dialog is Claude Code's own question dialog, raised by the plugin itself with no model turn in
between, so it appears in the window between pressing Enter and the task starting. The Switch
option shows the classifier's one-line reason (or a plain default when it gave none); if the
context is large it also says what the switch re-reads. The options are named with the model they
mean, for example `Switch to Opus 5.5` and `Stay on Sonnet 5.5`.

**Esc, or dismissing the dialog, is Stay, and your prompt still runs** on the current model. So is
typing your own text under "Other".

## How Switch works

It depends on whether the session has a terminal, because who owns the model differs.

**In a terminal** (the CLI, or any session with a terminal surface attached):

1. **This task runs on the chosen model at once.** Every request of the task's turn (the main
   loop; subagents keep their own models) is sent to the model you picked. The model also gets one
   context line saying you switched, so it does not misname itself. Switching down also drops the
   turn's `effort` setting, so the cheaper model's own default applies; switching up keeps it.
2. **The routing ends with that turn.** Only the turn started by the prompt you switched on is
   routed; the next turn is not. When the turn ends the plugin runs `/model <alias>` so the picker
   and status line agree with what you are running. If that is refused, a toast asks you to pick
   the model in the picker.

**In the desktop app, VS Code or the phone app** (a session with no terminal surface), the app owns
its model, so the mod hands the switch to the picker. Switch holds your prompt:

1. The prompt does not run. Your text is put back in the prompt box, and a message says
   `Pick Opus 5.5 in the model picker, then press Enter — your prompt is back in the box`. If the
   box cannot take the text, the message says `… then send your prompt again`.
2. Pick the model in the picker and send the prompt. The session is already marked checked, so the
   resent prompt goes straight through on whatever model the picker now shows.

Why the app is different: the engine's `/model` never reaches the app's own model picker (the app
keeps its own model state, so the picker would go on showing the old model and revert on restart),
and the app refuses a session changing its own model. So nothing is routed and no `/model` is run
there.

If another plugin drops the prompt, or you change the model yourself during a routed turn, the
routing ends: your own choice always wins.

## When the prompt isn't enough

Some prompts cannot be judged from their words: `read PROMPT.md, implement`, `continue`, `do the
plan`. The classifier also says whether it has **enough** to decide. If not, there is no window and
no toast, the prompt runs as typed, and the session is **not** marked checked. The check then looks
again as the turn goes on:

- On each step of the task's turn after new tool results arrived (never the first step, never a
  subagent's), the classifier is asked again with your prompt plus **only the tool results that
  arrived since your prompt or the last check**: the head of each (about 2,000 characters, 8,000 in
  all), as data. If nothing new arrived, or it is the very same evidence as last time, no call is
  made and nothing is counted.
- It asks **at most four times per session** (all prompts and turns together), then stops quietly
  and the session runs as selected. A vague prompt also counts as one of the session's three
  classifier attempts. A turn that ends while it is still unsure hands the question to the next
  turn. Prompts you send **between turns** are added to the text it judges.
- It lets go, leaving the session unchecked so your next prompt is judged afresh, when you change
  the model yourself, or when more than two turns pass without a recheck being made.
- When it decides, it behaves as above: a toast if the model fits or a switch is not worth it, the
  same window if it does not. In a terminal, Switch routes the rest of that turn to the new model
  (starting with the step that is about to be sent) and runs `/model` when the turn ends.
- In the desktop app (no terminal) a mid-turn Switch **stops the turn**, puts `continue` in the
  prompt box and says `Pick Opus 5.5 in the model picker, then press Enter to continue`. If you
  have already typed something in the box it is left alone and the message says `… then send
  "continue"`. Pick the model and send; the session is already checked, so it just goes through.

## Cost-aware

Switching models throws away the prompt cache: whatever is already in context is re-read uncached.

- Under **20,000 tokens** of context a switch is cheap, so any mismatch is offered.
- At **20,000 tokens or more** a mismatch is offered only when it is **two tiers** (Haiku to Opus
  or back; Opus to Fable is one tier). The Switch option then notes `re-reads ~45k tokens`.
- Above **180,000 tokens** nothing is offered, whatever the gap: re-caching is huge, and a
  long-context (`[1m]`) session would overflow a smaller window.
- When the rule holds a mismatch back you see `Staying on <model> — a switch now would re-read the
  whole context` instead of "fits".

## Once per session

The session is marked checked the moment the dialog (or the toast) is shown. A short list of the
last 100 checked session ids is kept in the plugin's store, so a resumed session is not checked
again. Only one check runs at a time: a prompt sent while the dialog is waiting goes straight
through.

## It never blocks a prompt

The check looks only at prompts you type or send from a remote client or the desktop app (origins
`composer`, `bridge` and `sdk`) that are at least 12 characters and are not a slash command
(`/compact`; a path such as `/Users/me/app.ts fix this` is a task). It is skipped for a prompt typed
over a running turn, for a session with no surface to show a dialog on (a plain `claude -p` run:
no Haiku call is made), and for a session model whose id does not start with `claude-` (Bedrock,
Vertex or gateway names would make the routing target wrong). If the classifier does not answer,
answers with something unreadable, or anything in the plugin throws, the prompt goes through
unchanged. After three failed attempts in a session it stops trying.

## Requirements and install

A Claude Code build with mod (function hooks) support. **Claude Code 2.1.295 or newer is
required**: older builds do not know Haiku 5.5, which Switch can route to. Builds without mod
support load nothing from this plugin; there is no fallback.

```
/plugin install model-fit --marketplace maksymskuibida/mskuibida-ai-tools
```

Answer `y` to add the marketplace, then pick a scope.

## Limits

- **The classifier is Haiku's judgment** on the text of one message. A missed or needless
  suggestion is a judgment call, not a bug; Stay costs one keypress.
- **One routed turn runs with a system prompt that still names the old model** (terminal only).
  The context line tells the model what it is running as, but its system prompt is not rewritten.
- **`/model` cannot run from inside the prompt hook**: the engine refuses it, because it would wait
  on the turn the hook is holding. That is why, in a terminal, Switch routes the task first and
  switches the session when the turn ends.
- **Where there is no terminal, Switch is a hold, not a switch.** The mod cannot set the desktop
  app's model, so you pick it in the picker and resend. If you pick nothing and resend, the prompt
  runs on the current model: the session is already checked and will not ask again.
- **The routed turn uses a full model id, not an alias.** The engine does not resolve an alias in a
  per-request rewrite, so the id comes from the `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` or `ANTHROPIC_DEFAULT_FABLE_MODEL` variable when set, else from
  the table in `hooks/classify.ts`. That table needs bumping when new model versions ship, and a
  strict `availableModels` allowlist could refuse the id. (`/model` at the end of the turn takes
  the alias and resolves it itself.)
- **"Other" counts as Stay.** Free text typed under the dialog's "Other" is not a Switch.
- **One check, then trust.** If the session later shifts to very different work, nothing re-checks
  it; start a fresh session or switch by hand.
- **Rechecks cost Haiku calls.** Each recheck is one call, at most four in a whole session, and a
  vague prompt also counts as one of the session's three classifier attempts, so a session of
  vague prompts stops being checked.
- **Steps before the decision ran on the original model.** A recheck happens after the model has
  already read what the prompt pointed at, so those steps were not routed. A terminal switch also
  sends no context line naming the new model (there is no prompt to attach it to); the system prompt
  still names the old one.
- **On the desktop a mid-turn Switch stops the turn.** The work done so far stays in the
  conversation; you continue after picking the model. If the turn cannot be stopped the step goes
  on and the toast just points at the picker.
- **No Python fallback.** 2.0 replaces the 1.x command hooks entirely; builds without mod support
  get nothing.
- **A chat is classified every time** until the first real task, one cheap Haiku call per message
  of 12 characters or more.

## Development

```bash
claude plugin validate plugins/model-fit
claude plugin test plugins/model-fit
node plugins/model-fit/evals/check-prompt-sync.mjs
```

`check-prompt-sync.mjs` fails when `CLASSIFIER_SYSTEM` in `hooks/classify.ts` is not byte-identical to
`evals/prompts/candidate.txt`; CI runs it. Change the prompt in `candidate.txt`, measure it with the
evals, then copy it into `classify.ts` (the file is a plain template literal with no escapes).

**Evals.** `evals/` measures how well the Haiku classifier picks a tier: each case is sent to Haiku
through `claude -p` under one or more prompts and graded against the expected kind, enough and tier.
Running them needs a logged-in `claude` and makes real model calls (`python3 evals/run.py
--dry-run --iteration 0` checks the pipeline with no calls). See `evals/README.md` for the flags and
the report files.

Type-check with TypeScript 5.4 or newer against the declaration file Claude Code writes when it
loads the plugin from a folder (`--plugin-dir`, into `.claude-plugin/types/`, which is git-ignored),
using the tsconfig from the header of that file: `es2023`, `strict`, `jsx: react` with `h` as the
factory, `include` covering the declaration file and the plugin's `hooks`, `types` and `tests`.

Files: `hooks/register.tsx` (the hooks), `hooks/classify.ts` (prompt, parser and tier arithmetic,
pure), `hooks/copy.ts` (every string a person reads), `types/index.d.ts` (the plugin's state).
