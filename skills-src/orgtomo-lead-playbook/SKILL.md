---
name: orgtomo-lead-playbook
description: "The Lead's operating procedure: asking the engine, briefing agents, verifying claims, human gates and escalation reports."
user-invocable: false
---
# Lead playbook

## Starting a ticket

1. Human types `/orgtomo:ticket <KEY>`. Run `orgtomo ticket open <KEY>`.
2. Read the issue with your tracker tools. Copy title, description, acceptance criteria and a neutral summary of comments exactly; do not interpret. Type is one of bug, feature, config, question.
3. `orgtomo ticket import <KEY> --json '<ticket contract>'`, then `orgtomo brain pack <KEY>`, then `orgtomo next <KEY>`.

## Briefing an agent

Keep the brief short and factual:

- the ticket key and the stage
- the files to read (the `inputs` list from `orgtomo next`)
- the mode (`full` or `light`) and, on a redo, the path of `verify-<stage>.md` with the instruction to fix exactly those points
- the output files and the submit command

Do not put your own opinion of the solution in a brief. Do not summarise the ticket for the agent; point at the files.

## Verifying

After a stage passes its gates and `orgtomo next` asks you to verify:

1. Open the stage's `.json`. Pick the claim the next stage depends on most (the root cause, the existence of a component, the deploy, the key test result).
2. Run its proof again yourself: an `orgtomo org query`, `orgtomo org test`, `orgtomo org retrieve` or `orgtomo evidence brain`. Use a fresh command, not the agent's evidence id.
3. Compare what you got with what the claim says.
4. `orgtomo verify <KEY> <stage> --claim <C#> --evidence <your E#> --result match|mismatch --note "<one line>"`.

A mismatch is not a failure on your part; it is the system working.

## Human gates

When `orgtomo next` shows `who: human`, write to the human, in their language:

- what stage finished and what it found (three to six lines, plain words)
- what you verified yourself and how
- anything the human should look at before deciding (deviations, risks, open minor findings)
- the exact command to type

Then stop.

## When the ticket is stopped

Read `escalation.md` and give the human the whole picture: what was tried in each round, what failed each time with the gate or test name, what you believe the real obstacle is, and the options. Do not soften it and do not retry on your own.

## Other duties

- Meetings on: at session start spawn the notetaker before ticket work.
- Brain stale (`orgtomo brain status`): spawn the cartographer.
- The human asks for a message: spawn the scribe.
- The human gives feedback in words: tell them `/orgtomo:feedback <KEY> good|bad <agent> <what>` records it, or `/orgtomo:rule <agent> <rule>` makes it a lesson at once.
