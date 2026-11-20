---
name: orgtomo-brain-keeper
description: "The Cartographer's procedures for the Org Brain: retrieve, build, staleness, drift and writing understanding notes that link to facts."
user-invocable: false
---
# Keeping the Org Brain

## Commands

| Task | Command |
|---|---|
| Retrieve and rebuild in one step | `orgtomo brain sync <org>` |
| Pull metadata of an org into `source/<org>/` | `orgtomo brain retrieve <org>` |
| Generate or refresh fact notes | `orgtomo brain build <org>` |
| Everything about one object | `orgtomo brain object <org> <Object>` |
| Tests that touch a component | `orgtomo brain tests <org> <Type:Name> ...` |
| Is it present and current | `orgtomo brain status [org]` |
| Find components | `orgtomo brain search <org> <words>` |
| One component with freshness | `orgtomo brain fact <org> <Type:Name>` |
| Compare two orgs | `orgtomo brain drift <base> <other>` |

The types retrieved are listed in `pipeline.yaml` (`brain.types`, `brain.standard_objects`). If something the team needs is missing from the Brain, tell the human which type to add; you cannot change configuration.

## What the Brain contains

- `facts/<Type>/<Name>.md`: generated. Key facts, "Uses", "Used by".
- `objects/<Object>.md`: generated hub. One page per object that links its fields, automation, tests, tickets and understanding notes. Start here.
- `facts/_automation/<Object>.md`: everything that runs on an object, in save order.
- `maps/<Object>.canvas`: the same as a picture.
- `understanding/`: your notes.
- `vault/log.md`: what changed at each build.

Dependencies come from static analysis of the source. They can miss dynamic references (dynamic SOQL, names built at run time). Say so when it matters.

## Understanding notes

Write for a colleague who joins tomorrow:

- one note per process ("Case escalation", "Lead assignment") or per object area
- what happens, in order, in plain language
- each statement followed by the link to its fact note
- a short "not yet understood" list at the end instead of filling gaps

Frontmatter: `type: understanding`, `org`, `covers` (list of objects), `reviewed` (date). Update the note when the facts it links to change (see `log.md`).
