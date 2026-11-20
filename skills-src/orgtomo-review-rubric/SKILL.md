---
name: orgtomo-review-rubric
description: "The Reviewer's rubric and method: independent checks, findings with severity and proof, and the approve or changes verdict."
user-invocable: false
---
# Reviewing

## Rubric

Answer every item with `pass`, `fail` or `na`, and proof ids or a precise note. On the lite path only the core items (R1 to R5) are required.

| Id | Question |
|---|---|
| R1 | Does the change do what the acceptance criteria ask, and nothing more? |
| R2 | Is nothing that worked before broken (baseline, regression results)? |
| R3 | Bulk-safe: no SOQL or DML in loops, works for 200+ records? |
| R4 | Sharing, CRUD and FLS respected; no unintended data exposure? |
| R5 | Naming, comments and format follow the org conventions? |
| R6 | Order of execution on each touched object understood; no recursion? |
| R7 | Governor limits considered for the largest realistic volume? |
| R8 | Tests assert behaviour, include negative cases, do not depend on org data? |
| R9 | No hard-coded ids, URLs or credentials; configuration in metadata? |
| R10 | Rollback possible from the backup; deploy pack will be complete? |
| R11 | Were the earlier claims this change depends on re-checked against evidence? |

The human may add items in `orgtomo.config/review-rubric.yaml`.

## How to check

- Diff the changed files against `backup/`. Read every changed line.
- Run the Code Analyzer skill on the changed files and record the output: `orgtomo evidence file <KEY> --path <report> --kind analyzer`.
- Re-run one test yourself. Query one outcome yourself.
- Open "What runs on <Object>" for each touched object and ask what else fires.

## Findings

| Severity | Meaning |
|---|---|
| blocker | wrong result, data risk, security hole, or will fail in production |
| major | works now but breaks under volume, another path, or the next change |
| minor | style or clarity; does not block |

Each finding: what, where (component), proof, and the agent whose work it concerns (planner, builder, tester).

## Verdict

`approve` requires every answered item `pass` or `na` and no blocker or major finding. Otherwise `changes`. Do not approve with a list of "should fix later" majors.
