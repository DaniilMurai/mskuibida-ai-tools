# model-fit classifier evals

Measures how well the Haiku task classifier (`hooks/classify.ts`) picks a tier. Each case is sent to
Haiku through `claude -p` under one or more classifier prompts; the reply is graded against the
case's `expected` (`kind`, `enough`, `tier`).

This directory is exempt from the plugin version-bump guard (`scripts/check-versions.py` lists
`evals`), and `workspace/` is git-ignored.

## Run

```bash
cd plugins/model-fit/evals

# pipeline check, no login and no calls
python3 run.py --dry-run --iteration 0 --overwrite

# real run: candidate vs the shipped prompt, 3 reps each (needs `claude` logged in)
python3 run.py --iteration 1

# one prompt, a few cases, no viewer
python3 run.py --prompt candidate --only 12,40 --reps 5 --skip-viewer
```

Flags: `--evals` (default `evals.json`), `--prompt candidate|v2.1.0|<path>` (repeatable; default
both), `--reps` (3), `--jobs` (8), `--iteration`, `--workspace`, `--only id,id`, `--dry-run`,
`--overwrite`, `--skip-viewer`, `--model`/`--effort` (haiku/low), `--claude-arg` (extra CLI flag per
call). Output lands in `workspace/iteration-N/`: `summary.md`, `summary.json`, `benchmark.json`, and
`review.html` (open it in a browser).

Each call is `claude -p --model haiku --effort low --system-prompt-file <prompt> --tools ""
--no-session-persistence --output-format json --max-turns 1`, with the built prompt on stdin and the
working directory a scratch folder. It also passes `--setting-sources project --disable-slash-commands
--strict-mcp-config` and sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, so none of your CLAUDE.md, hooks,
plugins or skills reach the classifier. If the CLI is not logged in the run stops with exit code 2.

## Configs

| Config dir | Prompt | Reply format |
|---|---|---|
| `with_skill` | `prompts/candidate.txt` (`candidate`) | `{"kind","enough","rule","tier","reason"}`, tiers haiku, sonnet, opus, fable |
| `old_skill` | `prompts/v2.1.0.txt` (`v2.1.0`), the shipped `CLASSIFIER_SYSTEM` | `{"tier":"chat\|haiku\|sonnet\|opus","enough","reason"}` |

The baseline reply is normalised: `chat` becomes kind chat, tier haiku. It has no fable tier, so its
`opus` is scored right for an expected opus or fable, and `summary.md` reports that separately.
Any other `--prompt <path>` becomes a config named after the file.

`prompts/v2.1.0.txt` is regenerated from a `classify.ts` with `node extract-baseline.mjs <classify.ts>
prompts/v2.1.0.txt` (for the shipped one: `git show origin/main:plugins/model-fit/hooks/classify.ts`).

## Cases

`evals.json` follows the skill-creator shape: `id`, `name`, `prompt`, optional `context` (a string, or a
list, one tool result each), `expected {kind, enough, tier}`, `tier_uncertain`, `assertions`. The
prompt is built as the plugin builds it (`<request>`, then an optional `<context>` of `<result>` blocks,
with the same truncation). Assertions are graded from `expected`; the tier check is skipped when
`tier_uncertain` is true, and `expected.tier` may be a list of acceptable tiers. `evals.sample.json` is
a three-case file for developing the harness.

The aggregator's delta is `old_skill` minus `with_skill` (alphabetical order), so a negative delta
means the candidate is ahead.

## Results (3.0.0, Haiku 5.5, 5 runs per case)

The rules in `prompts/candidate.txt` were tuned against `evals.json`, so its numbers are in-sample.
`holdout.json` (40 cases, six of them prompt-injection attempts) was written separately, from the tier
intent alone, and never used for tuning: it is the honest number. "Majority of 3" is what the plugin
ships: three calls at once, the most common verdict wins (`vote()` in `hooks/classify.ts`), scored over
every 3-subset of the 5 runs.

| | Tuned set (100) | Held-out set (40) |
|---|---|---|
| One call, fully right (kind, enough, tier) | 98.0% | 99.5% |
| Majority of 3, fully right | 98.3% | 100% |
| Same window outcome on haiku, sonnet, opus and fable | 98.3% | 100% |
| All five runs identical | 94% | 97.5% |
| 2.1.0 prompt, majority of 3, for comparison | 52% | 64% |

Reproduce: `python3 run.py --reps 5` and `python3 run.py --evals holdout.json --workspace
workspace-holdout --reps 5` (about $0.15 together).
