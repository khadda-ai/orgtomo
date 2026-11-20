---
description: Set how often the team stops for your approval: low, medium or high (human only)
argument-hint: low|medium|high
disable-model-invocation: true
---
The engine records this action itself when you (the human) type the command; the assistant cannot perform it.

Assistant: look for a note starting with `[Orgtomo engine]` in this turn. If it is there, the action is recorded: report the result in one or two lines and continue with the `Next:` command it names. If it is NOT there, the hook did not run: say so, change nothing, and tell the human to run the terminal form shown below or check `/orgtomo:doctor`. Never act as if the action happened.

low = approve after every stage; medium = after plan and review; high = after review only. Approval before the deploy pack can never be removed.
