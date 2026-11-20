---
description: Show what the team has learned, or approve / retire a lesson
argument-hint: "[approve|retire <L-id>]"
---
With no arguments: run `orgtomo learn list` and `orgtomo learn patterns`. Show lessons grouped by agent with status, the number of observations behind each, and how often the mistake came back after the lesson. Then list patterns that have no lesson yet. Point to `vault/learning/Lessons.md` for the full record.

With `approve` or `retire`: that is a human action recorded by the engine. Report it only if an `[Orgtomo engine]` note in this turn confirms it; otherwise give the terminal form `orgtomo human lesson approve <L-id>`.
