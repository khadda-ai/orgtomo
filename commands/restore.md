---
description: Put the backed-up versions of a ticket's components back into the build org (human only)
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---
The engine records this action itself when you (the human) type the command; the assistant cannot perform it.

Assistant: look for a note starting with `[Orgtomo engine]` in this turn. If it is there, report what was restored, and list any components the ticket created that are still in the org (they are not deleted automatically). If it is NOT there, the hook did not run: say so, change nothing, and give the terminal form below.

This restores the build org only. Other orgs are restored with your deploy tool, from its own history. Terminal form: `orgtomo human restore <KEY>`
