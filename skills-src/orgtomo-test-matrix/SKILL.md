---
name: orgtomo-test-matrix
description: "The Tester's method: building the test matrix, proving each result, rerunning the reproduction, bulk and regression, and the honest verdict."
user-invocable: false
---
# Testing

## Build the matrix first

One row per planned test (`T1`, `T2`, ...) plus your own additions. Columns: criteria covered, how you execute it, what proves the outcome. Every acceptance criterion needs at least one row.

Add what the plan missed:

- the opposite case of every condition
- empty and null values
- a user without the permission
- the other record type or the other branch of the flow
- update as well as insert, when the automation runs on both

## Executing

- Apex tests: `orgtomo org test <org> --class <TestClass> --ticket <KEY>`. Read each method outcome.
- Behaviour: setup as anonymous Apex in a file, run it, then query the result. The query is the proof.
- UI: browser steps, a screenshot recorded as evidence, and a query for the data outcome.
- Bulk: 200+ records in one transaction; check that every record got the right result and no limit exception appeared.

## Rerun the reproduction

Take the steps from `02-repro.json` and run them again on the new build with fresh data. `fixed` needs proof created after the deploy. If the bug still shows, the outcome is `still_failing` and the verdict is `fail`.

## Regression

Run every test listed in `00-baseline.json` again and record each outcome. A test that passed before and fails now is a failure of this change until proven otherwise.

## Verdict

- `pass`: every criterion has a passing result with proof, no failing regression, bug gone.
- `fail`: anything else. For each failure write what you did, what you expected, what happened, the proof id, and whether the cause is in the plan (wrong design) or the build (wrong implementation).

A fail returns the ticket to planning. That is the system working as designed. Never mark a test `pass` to move things along, and never change source or metadata to make a test pass.
