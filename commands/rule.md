---
description: Give an agent a rule in your own words; it becomes a lesson at once (human only)
argument-hint: <agent> <the rule, one clear sentence>
disable-model-invocation: true
---
The engine records this action itself when you (the human) type the command; the assistant cannot perform it.

Assistant: look for a note starting with `[Orgtomo engine]` in this turn. If it is there, the action is recorded: report the result in one or two lines and continue with the `Next:` command it names. If it is NOT there, the hook did not run: say so, change nothing, and tell the human to run the terminal form shown below or check `/orgtomo:doctor`. Never act as if the action happened.

Example: `/orgtomo:rule builder Never add a second trigger to an object; extend the existing handler.`
