---
name: orgtomo-plan-grounding
description: "The Planner's method: grounding every component in the Org Brain, citing official documentation, test planning, rollback and the plan contract."
user-invocable: false
---
# Planning a change

## Ground every component

For each entry in `components`:

- `modify` or `delete`: it must exist. `orgtomo evidence brain <KEY> <Type:Name>` and read its "Used by" list; everything on that list is in your blast radius.
- `new`: check that the name is free and follows the naming rules.
- Read "What runs on <Object>" for each object you touch. Decide where in the save order your change belongs and say so.

## Choose the smallest correct design

Ask in this order: can existing configuration do it; can an existing flow or class be extended; is new automation really needed. One automation per purpose per object. Do not add a second trigger to an object that has one.

## Cite the platform

When the design relies on platform behaviour, find the official page and record the sentence you rely on with `orgtomo evidence doc`. Typical cases: order of execution, governor limits, sharing and `with sharing`, record-triggered flow behaviour, mixed DML, asynchronous Apex limits. If the documentation does not say, write that it does not and plan a test that settles it.

## Test plan

| Kind | When required |
|---|---|
| apex / data | every acceptance criterion |
| negative | every validation or guard condition |
| bulk | any trigger, class or record-triggered flow change: 200+ records |
| regression | existing tests of the components you touch |
| ui | when a criterion is about what a user sees |

Each test has an id (T1, T2, ...) and lists the criteria it covers.

`regression_tests` names the existing test classes to run before and after the change. Get them from `orgtomo brain tests <org> "<Type:Name>" ...`. If you leave a related class out, or need none, say why in `regression_note`. The gate refuses a plan that changes something tests touch and names no test.

## Also in the plan

- `order`: deploy order of the components.
- `manual_steps`: anything metadata cannot carry (data fix, permission assignment, activation), marked `pre` or `post`.
- `risks` with mitigation. `out_of_scope` so nobody is surprised.
- `rollback`: how to return to the backed-up state.
- `alternatives_rejected`: one line each.
- `data_changes`: any change to existing records in a target org: which org, what, which records, whether it can be undone. The deploy pack turns each into a kit the human runs (skill `orgtomo-ship`).
- `self_review`: where else the same pattern exists, whether today's behaviour is deliberate, what you dropped while checking (skill `orgtomo-self-review`).

## Second round

If `updates.md` or a `verify-*.md` lists reasons from a failed test or review, start the plan with a section that answers each reason. A second plan that repeats the first fails again.
