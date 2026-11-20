---
name: orgtomo-evidence
description: "How to produce and cite evidence in Orgtomo: the proof levels, the command for each, and how claims reference them."
user-invocable: false
---
# Evidence

Evidence is created only by the engine when it runs something for you. Each item gets an id (`E001`, `E002`, ...). In your contract, every claim and every proof field lists those ids.

## Proof levels, strongest first

| Level | What it proves | Command |
|---|---|---|
| Live org | what the org contains or does right now | `orgtomo org query <org> "SELECT ... LIMIT n" --ticket <KEY>` (add `--tooling` for Tooling API objects) |
| Execution | behaviour | `orgtomo org apex-run <org> --file <f> --ticket <KEY>`, `orgtomo org test <org> --class <C> --ticket <KEY>` |
| Deploy | the metadata compiles and is in the build org | `orgtomo org deploy <KEY> <paths> [--check]` |
| Metadata | exact content of a component | `orgtomo org retrieve <org> "<Type:Name>" --ticket <KEY>` |
| Org Brain | structure and dependencies, if fresh | `orgtomo evidence brain <KEY> <Type:Name>` (refused when the note is stale) |
| Official docs | platform behaviour | `orgtomo evidence doc <KEY> --url <official url> --quote "<sentence>"` |
| Capture | what a screen showed | `orgtomo evidence file <KEY> --path <screenshot> --kind browser --note "<what it shows>"` |

`orgtomo evidence list <KEY>` shows the ledger. `orgtomo evidence show <KEY> E007` shows one item.

## Writing claims

```json
{ "id": "C1", "text": "CaseTrigger runs before insert and before update on Case.", "proof": ["E004"] }
```

- One fact per claim. If it needs "and", make two claims.
- The proof must actually show the claim. A query that returned zero rows proves absence only for exactly that filter.
- Browser captures support a claim; they do not replace a query when the fact is data.
- Failed evidence (a failed deploy, a failing test) may be cited only for a claim that says it failed.
- Query results are masked. Masked values (`j***@c***.com`) are expected; do not try to unmask them.
