---
name: orgtomo-repro-data-first
description: "Data-first reproduction and safe test data: how to prove behaviour in a sandbox without touching real customer records or sending mail."
user-invocable: false
---
# Reproduce with data, safely

## Order of work

1. Canary: `orgtomo org canary <org>` must report `blocked`.
2. Write the setup as anonymous Apex in a file under `vault/tickets/<KEY>/work/`. Create every record the scenario needs: account, contact, the record under test. Use the allowed e-mail and phone values and the test person from your instructions.
3. Run it: `orgtomo org apex-run <org> --file <file> --ticket <KEY>`.
4. Read the outcome back with a query. That query is the proof of "actual".
5. State "expected" from the ticket or the acceptance criteria, never from your own idea of correct.

## Rules for test records

- Names that explain themselves: `Orgtomo ABC-12 medium priority case`, at least three words.
- Never update or delete a record you did not create in this ticket.
- Record what you created in `data_used` (`created_by_ticket: true`).
- No real person's name, address, e-mail or phone, even if you saw one in a masked read.

## Finding the cause

A cause is proven when one of these shows it:

- a debug line or exception from your run that points at the component
- a query on the configuration (a validation rule formula, a flow version, a field default) that explains the outcome
- a small experiment: change one input, the outcome changes as the cause predicts

"The code looks wrong" is a hypothesis. Test it.

## UI reproduction

Use the browser when the bug is about what a user sees or clicks. Prove data outcomes with a query afterwards as well.

## When it does not reproduce

Vary one thing at a time: profile or permission set, record type, field values named in the ticket, the path (UI or API). Write down each attempt. After honest attempts, report `reproduced: false` with the list. Ask for what you are missing: user, record id, exact steps, time.
