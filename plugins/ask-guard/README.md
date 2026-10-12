# Ask Guard

The question dialog (`AskUserQuestion`) draws its question as **plain text**. Markdown stays raw
and line breaks are ignored, so when the model packs a plan into the question you get a wall of
text you can't read:

> All 12 cards stayed in Fix in this PR; no board follow-up. Plan for #40: reopen Domain Design
> (2.6) on this branch (backward jump as its own call, unpark, orchestrate next --resume). Then a
> new questions file … Go ahead?

This mod sends any question longer than **250 characters** back to the model before the dialog
opens. Its error message tells the model how to ask instead:

1. write the context (plan, findings, lists) as a normal message first, where markdown renders;
2. put per-option detail in the option's `description` or `preview`;
3. ask again in one line, e.g. "Go ahead with the plan above?".

You never see the rejected dialog. You see the formatted message, then a short question.

Only the model's own questions are checked. Dialogs that other plugins open (model-fit's
Switch or Stay, for example) pass through untouched. If the guard itself throws an error, the
question goes through as-is, so a bug in the guard can never cost you a question.

## Install

Requires a Claude Code build with function-hooks (mod) support. CI pins 2.1.295.

```bash
/plugin install ask-guard@mskuibida-tooling
```

## Options

| Option | Default | What it does |
|---|---|---|
| `maxQuestionChars` | `250` | The most characters one question may have. Set it in the plugin's config menu. |

## Pairs with

[`response-format`](../response-format) 2.1.0 adds the same rule to its writing guidance, so the
model usually keeps questions short from the start. This mod catches the times it doesn't.

## Develop

```bash
claude plugin validate plugins/ask-guard
```

```bash
claude plugin test plugins/ask-guard
```
