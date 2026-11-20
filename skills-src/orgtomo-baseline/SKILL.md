---
name: orgtomo-baseline
description: "How the Baseline agent records backups and existing test results before a change."
user-invocable: false
---
# Baseline

## Backups

`orgtomo org backup <KEY> "<Type:Name>" "<Type:Name>"` takes the current org version of each component into `vault/tickets/<KEY>/backup/<build org>/`. Components that do not exist yet are reported as new. One command may list all planned components.

If the command fails, the fault is in a tool, not in your work. Record `"status": "failed"` with the exact message in `"reason"`, run `orgtomo block <KEY> --reason "<the exact message>"`, and stop. Never fill the backup folder by hand.

## Existing tests

Run the classes the plan lists in `regression_tests`. If it lists none, ask the Brain: `orgtomo brain tests <build org> "<Type:Name>" ...` returns, for a class, its own tests, and for anything on an object (a flow, a rule, a field, a trigger), every test class that touches that object.

Run them with `orgtomo org test <build org> --class <A> --class <B> --ticket <KEY>`. If the list is very long, say how long and block the ticket for a human decision before you run it.

Record every method with its outcome. Do not leave out failing ones.

## 00-baseline.json

```json
{
  "key": "ABC-12",
  "backups": [ { "ref": "ApexClass:CaseService", "status": "backed_up", "evidence": "E010" },
               { "ref": "ApexClass:CaseRouting", "status": "new" } ],
  "tests":   [ { "name": "CaseServiceTest.appliesEscalationInBulk", "outcome": "pass", "evidence": "E011" } ],
  "notes": "One existing test already fails before the change: ..."
}
```

Then `orgtomo baseline check <KEY>`.
