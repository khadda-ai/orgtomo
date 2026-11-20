---
name: orgtomo-lessons
description: "The Coach's rules for turning recorded observations into lessons: evidence required, one actionable rule, no invention."
user-invocable: false
---
# Lessons from evidence

## Sources you may use

Only the observation ledger: `orgtomo learn observations <KEY>` and `orgtomo learn patterns`. Each observation has an id (`O-0007`), an agent, a kind (mistake, good, feedback), a source (gate, lead, human, reviewer, engine) and a fact.

## A lesson is

- for one agent
- one sentence that agent can act on next time, specific to this org or this kind of work
- backed by observation ids
- `avoid` (a mistake not to repeat) or `keep` (a practice that demonstrably worked)

Good: "Before planning a change to a class, list every caller from the Brain's Used by section; a caller was missed on ABC-12 and review sent the ticket back."

Not a lesson: "Be more careful." "Write better tests." Anything you cannot tie to an observation.

## When not to write one

- the gate that caught it already enforces the rule completely (the agent just needs the gate report)
- it happened once and looks like an accident, with no human feedback behind it
- an existing lesson covers it: cite the new observations on that lesson instead, by proposing the same rule text again

## What happens next

`orgtomo learn propose <KEY>` stores the lessons. A lesson backed by enough engine-recorded observations, or by the human's own words, applies at once: it appears in that agent's lessons skill. Others wait for the human (`/orgtomo:lessons approve <id>`). If a mistake recurs after its lesson was applied, the lesson shows a repeat count; sharpen it.
