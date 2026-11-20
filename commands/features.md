---
description: Turn a feature or a support agent on or off (human only)
argument-hint: <lite|learning|meetings|people|flow-generator|telemetry|transcripts|chrome|baseline|scribe|coach|notetaker> on|off
disable-model-invocation: true
---
The engine records this action itself when you (the human) type the command; the assistant cannot perform it.

Assistant: look for a note starting with `[Orgtomo engine]` in this turn. If it is there, the action is recorded: report the result in one or two lines and continue with the `Next:` command it names. If it is NOT there, the hook did not run: say so, change nothing, and tell the human to run the terminal form shown below or check `/orgtomo:doctor`. Never act as if the action happened.

With no arguments, the assistant runs `orgtomo config show` and lists the current switches from features.yaml.
