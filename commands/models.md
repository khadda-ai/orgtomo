---
description: Show or change which model and effort each agent uses
argument-hint: "[<agent> <model> [effort]]"
---
With no arguments: run `orgtomo models` and show the table of agents, models and effort levels.

With arguments (`$ARGUMENTS`), the change is a human action recorded by the engine. Look for an `[Orgtomo engine]` note in this turn. If it is there, report the new setting and remind the human that it applies from the next session. If it is not there, do not change anything: tell the human the terminal form `orgtomo human model <agent> <model> [effort]` or to use the UI.

Models: sonnet, opus, haiku, fable, inherit, or a full `claude-...` id. Effort: low, medium, high, xhigh, max. The Reviewer must differ from the Builder unless that rule is turned off.
