# question-forms

Every AI-DLC questions file becomes a form in one private artifact, **AI-DLC question
forms**, published once per developer from the template in this plugin. The agent writes the
questions as rows, the developer answers in the page, the agent reads one document back and
copies the answers word for word into the file's `[Answer]:` tags. Besides questions with options it
renders text-only questions and board forms (cards sorted into 2–4 boxes, used by `pr-review`). One template, so every form
looks the same on every machine; no HTML is generated per stage.

```
skills/question-forms/SKILL.md           the procedure the agent follows at every questions file
skills/question-forms/question-form.html the template — the data contract is in its header
```

A change to the look or the data contract is a PR on the template.

## Install

```bash
claude plugin marketplace add maksymskuibida/mskuibida-ai-tools
claude plugin install question-forms@mskuibida-tooling
```

## Pairs with

`SKILL.md` § 5 (board forms) and § 5b (the form check and the summary) refer to a `pr-review`
plugin — its `review-pr`, `address-review` and `self-review` skills and its `review_flow` hook.
That plugin is not in this marketplace. Without it, questions files and text questions work as
described; the board-form procedure is there for whichever skill opens a board.
