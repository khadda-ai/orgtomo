---
name: orgtomo-build
description: "The Builder's procedure: backup, minimal change, tests, engine deploy, declared deviations and the build contract."
user-invocable: false
---
# Building

## Sequence

1. `orgtomo org backup <KEY> "<Type:Name>" ...` for every planned component (new ones are recorded as new).
2. If the source folder is behind the org, retrieve the component first so you edit the current version.
3. Change source. Smallest diff that satisfies the plan.
4. `orgtomo org deploy <KEY> <paths> --check`. Fix errors.
5. `orgtomo org deploy <KEY> <paths>`.
6. Run your new tests once for yourself: `orgtomo org test <build org> --class <TestClass> --ticket <KEY>`.
7. Write `04-build.md/json` and submit.

If you edit a file after the deploy, deploy again. The gate compares file hashes with the deploy.

## Apex checklist

- Bulk: collections in, collections out. No SOQL, DML or callouts inside loops.
- One trigger per object, logic in the handler class the org already uses.
- Sharing keyword on every class. `without sharing` only with a reason declared as a deviation.
- No hard-coded ids, URLs, profile names or record type ids. Use custom metadata, labels, `Schema` describe.
- Null-safe. Selective queries. No `System.debug` left behind.
- Tests: `@IsTest`, data created in the test, `Assert` methods with messages, one 200-record case, one negative case, no `SeeAllData=true`.

## Comments and names

New files get the header from `org-comments`. Modified files get the change line with today's date and the ticket key. Names follow `org-naming`. The lint gates check exactly this.

## Deviations

The plan is the scope. If you must touch a component that is not in it, or skip one that is, add it to `deviations` with the reason. Small and justified deviations are read by the Lead; large ones mean the plan was wrong: stop and say so.

## Contract reminders

`components[].path` is the file (or the bundle folder for LWC) relative to the workspace. `deploy.evidence` is the id of the real deploy, not the check-only one. `unit_tests_added` lists test class names.
