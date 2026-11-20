---
name: orgtomo-self-review
description: "How every agent tries to break its own result before submitting: label each claim, give every zero a control, name what was counted, look for the same thing elsewhere, ask whether it is deliberate."
user-invocable: false
---
# Self-review: try to break your own result

Almost every wrong finding has one of two shapes.

1. **A claim stated more firmly than its proof allows.** You read the source and reported what happens at run time. You read one version and reported the current one. Your query answered a narrower question than the sentence you built on it.
2. **A zero treated as a finding.** No rows, no match, nothing found. Until shown otherwise, that means the question was asked wrongly.

Before you submit, go through your own output looking for both. The gates check part of this; you check all of it.

## Label every claim

Each claim can carry a `basis`:

| basis | Meaning | What you must add |
|---|---|---|
| `measured` | You ran it in this ticket and saw the result | proof you produced yourself |
| `carried` | You took it from the ticket, an earlier stage or someone's comment | `source`: where from |
| `inferred` | You reasoned it from metadata or code | `confirm_by`: what would confirm it |

A carried or inferred claim is fine. A carried claim dressed up as measured is how wrong work gets built. Re-measure anything a deploy, a deletion or a message to a customer depends on.

## Every zero needs a control

If a query that supports a claim returned no rows, add a second query on the same org that does return rows, and cite both. A filter on a value that does not exist also returns zero. The evidence gate refuses a claim that rests on an empty result alone.

"Not found by this search" is all one search proves. Write that, and not "does not exist".

## Say what was counted

Every number carries its population in the same sentence: which object, which filter, which org, at what time. Then check that this is exactly the population the claim is about.

- When a count drives a decision, show it next to the same count without the filter. If they differ, say which one you mean.
- Count by Id, not by name. Names change; Ids do not.
- "How many were changed" comes from history or job records. "How many match the criteria now" is a different number.

## Measure late

A count, a version number and a record's status are true at the moment you read them. Re-read anything that can move just before you submit, and prefer "re-count at deploy time" over naming example records that may change.

## Look for the same thing elsewhere

When you find a defect or decide on a design, search for the same pattern in sibling flows, classes and rules on the same object, and for other tickets that touch the same field. Write what you searched and what you found in `self_review.elsewhere`. A result that names only the component in front of you has not done this.

## Ask whether it is deliberate

Before calling something broken, look for the setting, comment or decision that made it this way. Write what you found in `self_review.intent`. If you found nothing, write that you found nothing; do not invent a reason.

## A cause needs its mechanism

"X causes Y" cites the element that does it: the flow element, the line of Apex, the formula. Two things happening at the same time is not a mechanism. A component's name is not a mechanism.

## Record what you dropped

`self_review.withdrawn` lists the statements you removed while checking, each with the reason. A review that withdrew nothing usually did not happen. `self_review.not_verified` lists what you could not check and what would settle it.

```json
"self_review": {
  "elsewhere": "Searched the Brain for other writers of Escalation_Reason__c: one more flow, Case_AfterSave_Notify_Owner, which only reads it.",
  "intent": "No custom setting, description or comment says Medium cases are meant to be stamped.",
  "withdrawn": ["That the trigger also runs on delete: the trigger lists insert and update only."],
  "not_verified": ["Behaviour for cases created by the e-mail channel: no test data path in dev."]
}
```
