---
name: orgtomo-ship
description: "Rules for anything that will reach an org a human deploys to: order of steps, rollback, data changes, deletions and the check after the deploy."
user-invocable: false
---
# Shipping: what a human will deploy must be safe to deploy

Orgtomo builds in the build org and hands a deploy pack to a human. These rules make that pack something a careful person can run without having been in the room.

Your company's own rules (which tools are standard, who approves what) are in the `org-standards` skill. They win over anything general here.

## Order and prerequisites

Write the steps in the order they must happen, and for each step what must already exist at that point. A field deploys before anything writes to it. A permission is granted before a test relies on it. Name any scheduled job or flow that may run in between and what it would do to a half-finished change.

## The rollback is a change too

- Say exactly what is restored, by whom, and which signal means "roll back now".
- The rollback gets the same checks as the change: the same pre-check, the same read-back.
- A rollback nobody has tried is a hope. Where it can be tried in the build org, try it.

## Changing existing records

Changing data in a target org is never a hand edit and never part of an agent's work. When a ticket needs it, the plan lists it under `data_changes` and the deploy pack carries it as a kit for the human:

1. **Pre-check**: a query that shows the records have exactly the values the change expects. If they do not, stop.
2. **Snapshot**: the affected rows, saved before anything is written.
3. **Dry run** and **commit** as two separate scripts. Nobody edits a flag to turn one into the other.
4. **Read-back**: a query that proves the result.
5. **Rollback**: its own dry run and commit, restoring from the snapshot.

Before proposing one: list the related records and what happens to each (cascade, orphaned lookup, changed roll-up), and size it with a count. Records that carry real work need their owner's explicit decision.

A write whose effect depends on today's date is rehearsed on the day it will run.

## Deleting

Nothing is deleted beyond the exact list a human approved. Capture the full list first, delete only what was approved, then compare what is gone with the approved list, item by item, and report that comparison.

## Tests match the change

Run the tests that cover what changed, by name. Running everything is not safer, only slower; running nothing is not a test level.

## After the deploy

A successful deploy says the files arrived. It does not say the org behaves. Check that each changed component in the target equals the build (`orgtomo handoff parity`), and for a flow that the active version is the one you built. A flow can arrive inactive or with an older version still active, depending on the org's settings; look instead of expecting.

## What must not travel

- Changes that belong to another ticket. A component in the pack contains this ticket's lines and nothing else.
- Unrelated edits picked up by saving a layout or a page in a builder. Edit as metadata.
- A bypass switch left on. Switch it on for the step that needs it and off again in the same step.
