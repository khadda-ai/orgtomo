---
name: orgtomo-baseline
description: "How the Baseline agent records backups and existing test results before a change."
user-invocable: false
---
# Baseline

## Backups

`orgtomo org backup <KEY> "<Type:Name>" "<Type:Name>"` takes the current org version of each component into `vault/tickets/<KEY>/backup/<build org>/`. Components that do not exist yet are reported as new. One command may list all planned components.

## Existing tests

Find them from the Brain: the test classes in the "Used by" list of each planned class, and classes named `<ClassName>Test`. Run them with `orgtomo org test <build org> --class <A> --class <B> --ticket <KEY>`.

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
