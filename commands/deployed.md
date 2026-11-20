---
description: Tell Orgtomo you finished deploying a ticket to an org (human only)
argument-hint: <org> [TICKET-KEY]
disable-model-invocation: true
---
The engine records this action itself when you (the human) type the command; the assistant cannot perform it.

Assistant: look for a note starting with `[Orgtomo engine]` in this turn. If it is there, the action is recorded: report the result in one or two lines and continue with the `Next:` command it names. If it is NOT there, the hook did not run: say so, change nothing, and tell the human to run the terminal form shown below or check `/orgtomo:doctor`. Never act as if the action happened.

After this the team compares that org with the build (read-only) and retests where configured. Terminal form: `orgtomo human deployed <KEY> <org>`
