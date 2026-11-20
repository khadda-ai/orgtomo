---
description: Show or change which model and effort each agent uses
argument-hint: "[<agent> <model> [effort]]"
---
With no arguments: run `orgtomo models` and show the table of agents, models and effort levels.

With arguments (`$ARGUMENTS`), the change is a human action recorded by the engine. Look for an `[Orgtomo engine]` note in this turn. If it is there, report the new setting and remind the human that it applies from the next session. If it is not there, do not change anything: tell the human the terminal form `orgtomo human model <agent> <model> [effort]` or to use the UI.

Models: an alias (sonnet, opus, haiku, fable; always the newest version your Claude Code offers), `inherit`, or a full `claude-...` id for one fixed version. `orgtomo models catalogue` lists what is known, with the version each alias stands for and the effort levels each model offers. Effort: low, medium, high, xhigh, max; not every model offers every level. The Reviewer must differ from the Builder unless that rule is turned off.
