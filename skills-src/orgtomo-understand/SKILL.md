---
name: orgtomo-understand
description: "The Analyst's method and output format: plain and technical summaries, acceptance criteria, examples, open questions, lite candidates."
user-invocable: false
---
# Understanding a ticket

## Three hats

- **Business analyst**: what outcome does the person want, and why? What happens today?
- **Functional consultant**: which Salesforce feature area is this (objects, automation, security, UI)? Is there a standard way?
- **Product owner**: what is the smallest acceptable result? What is explicitly not asked?

## Before anything else: intake

Check the ticket against the system (skill `orgtomo-intake`) and fill the `intake` block. The acceptance criteria you write afterwards rest on names you have confirmed, not on names the ticket happened to use.

## For the human's page

The engine turns your contract into a page a person can read in a minute. Feed it:

- `one_line`: the whole ask in one sentence.
- `today` and `wanted`: two short paragraphs, plain words.
- per example: `input` (the exact value or situation), `today` (what happens now), `expected` (what should happen), `covers` (the criteria it shows).

## 01-understanding.md

1. In one sentence: what is asked.
2. For a non-technical reader: today / wanted / why it matters. No API names.
3. For a developer: the objects, fields and automation involved, by API name, each linked to its Brain note.
4. Acceptance criteria table (id, text, source).
5. Examples: given / when / then, one or more per criterion, with invented data.
6. A Mermaid diagram if a flow or a before/after makes it clearer.
7. Open questions, blocking ones first.
8. Risk and why.

## Acceptance criteria

- Testable: someone can say pass or fail by looking at the org.
- One behaviour each. Number them AC1, AC2, ...
- Keep the reporter's wording for `source: ticket`. Your additions are `derived` and need a reason.
- Decisions from meetings (`updates.md`) are `source: meeting`.

## Open questions

Ask when the ticket is silent on something that changes the solution: which records, which users, what happens to existing data, what about the other record type. One question per item, answerable in a sentence. `blocking: true` only when starting without the answer risks building the wrong thing.

## Lite candidate

`lite_candidate: true` only when all are true: one to three components, configuration only (label, layout, list view, picklist value, help text), no automation touched, risk low. The engine decides from your `affected` list; an optimistic flag changes nothing.

## Contract reminders

`affected[].component` is `Type:Name` exactly as in the Brain. Every `affected` entry and every claim carries proof ids.
