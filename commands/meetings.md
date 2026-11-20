---
description: Bring in new meeting notes, list them, or confirm a suggested ticket link
argument-hint: "[sync] | [confirm|reject <M-id>]"
---
With no arguments or `sync`: if the feature is on (`orgtomo meetings plan`), spawn the notetaker to bring in meetings since the last run, then show `orgtomo meetings pending` so the human can confirm suggested links. If it is off, say how to turn it on (`/orgtomo:features meetings on`, provider in features.yaml).

`confirm` and `reject` are human actions recorded by the engine. Report them only if an `[Orgtomo engine]` note in this turn confirms it.
