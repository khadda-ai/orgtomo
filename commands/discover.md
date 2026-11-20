---
description: Study how the business uses an org, or answer one of its questions
argument-hint: "<org> | answer <org> <Q id> <answer> | status"
---
Business discovery: `$ARGUMENTS`

- `status` (or nothing): run `orgtomo discover status` and show, per org, the areas, which have a checked process note, and the open questions.
- `<org>`: if no discovery exists for that org yet, spawn the cartographer to run `orgtomo discover run <org> --retrieve`. Then spawn the cartographer once per area: it runs `orgtomo discover next <org>`, writes that one process note and checks it with `orgtomo discover check <org> <area>`. Repeat until `next` says every area is done. After each area, tell the human in two lines what was learned and which questions are still open.
- `answer <org> <Q id> <answer>`: this is a human action recorded by the engine. Look for an `[Orgtomo engine]` note in this turn and report it. If it is not there, tell the human the terminal form: `orgtomo human discover-answer <org> <Q id> <answer>`.

Discovery reads metadata and record totals, never record values. What it writes is in `vault/orgs/<org>/business/`: what exists is generated, how it works is written by the cartographer with a link behind every statement, and what only a person knows is asked in `Questions.md`.
