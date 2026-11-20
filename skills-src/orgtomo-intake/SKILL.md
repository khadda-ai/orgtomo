---
name: orgtomo-intake
description: "How the Analyst checks a ticket against the real system before anyone trusts it: restate it, confirm every name, measure how big it is, test the assumption it rests on."
user-invocable: false
---
# Intake: check the ticket before you trust it

A ticket is someone's report of a problem. It is not a description of the system. It may name a field that was renamed, ask for a value that was never created, or describe as broken something that was built that way on purpose. Checking that first costs minutes. Finding it after the build costs the whole ticket.

Do this before you write acceptance criteria. The result goes into `intake` in `01-understanding.json`; the gate `intake-check` reads it.

## 1. Restate it in three lines

- `observed`: what happens today, in one sentence.
- `expected`: what should happen instead. For a new feature: what should exist that does not.
- `change_target`: the one thing that most likely has to change, as `Type:Name` when you know it.

If you cannot fill all three from the ticket, that gap is your first open question.

## 2. Confirm every name the ticket uses

Every field, picklist value, flow, class, record type, permission set and setting the ticket mentions goes into `identifiers`, each with proof.

- Check it in the build org and in the Brain base: `orgtomo evidence brain <KEY> <Type:Name>`, or `orgtomo org query <org> "..." --ticket <KEY>`.
- Record what you found per org: `exists`, `missing`, `differs` or `not_checked`. Orgs drift apart. A fix that is correct in one org can fail in the next.
- Watch for a near-twin: two names that differ by a word, where only one is in use. Say which one the ticket means.
- A value the ticket relies on that does not exist is a finding, not a detail. Say it now.

## 3. Note the version you looked at

For a flow or a class, put the version or the last-modified date in `versions`, per org. An analysis of an old version is wrong even when every sentence in it was true once.

## 4. Measure how big it is

When the ticket is about existing records, count them: how many are affected right now. Put the number, what was counted and where in `size`.

- State the population in words: which object, which filter, which org.
- A count of zero proves nothing by itself. Run the same query with a filter you know returns rows, and put that evidence id in `size.control`.
- A sandbox holds a sample. If only production has real volumes, ask for a masked read there, or say the count is from a sandbox.

## 5. Test the one assumption it all rests on

Find the claim that, if false, makes the whole ticket pointless. Test that one first.

- `key_assumption.text`: the claim.
- `held`: `true`, `false` or `not_tested`, with the evidence that tested it.
- If it does not hold, the ticket cannot be built as written. Say what should be done instead in `recommendation`, and raise a blocking question.

## 6. Come back with an answer

- If part of the ticket is already satisfied, say which part (`already_satisfied`).
- If the proposed solution is wrong, propose the better one. An objection without an alternative starts a discussion; an alternative ends one.
- Ask at most one blocking question at a time, with the options and the one you recommend. Everything else is a note.

## Example

```json
"intake": {
  "restated": { "observed": "Cases with a Medium priority get the reason Auto.", "expected": "Only High priority cases get it.", "change_target": "ApexClass:CaseService" },
  "identifiers": [
    { "name": "Escalation_Reason__c", "kind": "CustomField on Case", "orgs": { "dev": "exists", "uat": "exists" }, "proof": ["E002", "E003"] },
    { "name": "Auto", "kind": "picklist value", "orgs": { "dev": "exists", "uat": "missing" }, "note": "uat has the value Automatic instead", "proof": ["E004", "E005"] }
  ],
  "size": { "count": 412, "population": "open Cases with Priority Medium and reason Auto", "org": "uat", "proof": ["E006"] },
  "key_assumption": { "text": "The reason is set by CaseService and by nothing else.", "held": true, "proof": ["E007"] }
}
```
