---
description: List Orgtomo commands
---
Show the human this list.

| Command | What it does | Who |
|---|---|---|
| `/orgtomo:ticket <KEY>` | start or continue a ticket | you ask, team works |
| `/orgtomo:status [KEY]` | where things stand | anyone |
| `/orgtomo:approve [KEY]` / `reject [KEY] <reason>` | decide at a gate | human |
| `/orgtomo:answer [KEY] [Q1] <answer>` | answer a blocking question | human |
| `/orgtomo:deployed <org> [KEY]` | you finished a deploy | human |
| `/orgtomo:hold <KEY>` / `resume [KEY] [direction]` | park, continue, redirect, or continue after a block | human |
| `/orgtomo:restore <KEY>` | put backed-up versions back into the build org | human |
| `/orgtomo:feedback [KEY] good\|bad <agent> <text>` | record feedback as evidence | human |
| `/orgtomo:rule <agent> <rule>` | give a rule; applies at once | human |
| `/orgtomo:lessons` | what the team learned; approve or retire | human decides |
| `/orgtomo:models [<agent> <model> [effort]]` | model and effort per agent | human decides |
| `/orgtomo:features <name> on\|off` | feature and support-agent switches | human |
| `/orgtomo:autonomy low\|medium\|high` | how often to stop for approval | human |
| `/orgtomo:brain ...` | Org Brain: status, sync, drift, search, one object | team |
| `/orgtomo:discover <org>` | study how the business uses an org; `answer <org> <Q id> <text>` answers its questions | team works, human answers |
| `/orgtomo:meetings`, `/orgtomo:people` | meeting notes, reader profiles | mixed |
| `/orgtomo:doctor`, `/orgtomo:sync`, `/orgtomo:ping` | health, regenerate, hook check | anyone |

In a terminal: `orgtomo setup`, `orgtomo start`, `orgtomo ui`, `orgtomo doctor --orgs`, `orgtomo models refresh`, `orgtomo obsidian install`.
