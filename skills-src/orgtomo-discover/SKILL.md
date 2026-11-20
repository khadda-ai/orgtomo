---
name: orgtomo-discover
description: "How the Cartographer writes a process note for one business area during discovery: what happens, in order, each statement linked to a fact or openly marked as inferred or as a question."
user-invocable: false
---
# Writing a process note

Discovery answers one question: how does this company use this org? The engine has already listed what exists (`business/domains/<area>.md`) and written down what only a person can answer (`business/Questions.md`). You write how it works.

Metadata shows what the system does. It never shows why the business wants it. Keep those two apart in every sentence you write.

## One area per run

1. `orgtomo discover next <org>` names the area, the files to read and the file to write.
2. Read the domain page, the hub page of each object, the "What runs on" notes, and every answered question.
3. Write `vault/orgs/<org>/business/processes/<slug>.md`.
4. `orgtomo discover check <org> <slug>`. Fix what it lists. Then stop; the next area is another run.

## The note

Frontmatter: `type: process`, `domain: <exact area name>`, `org: <org>`, `reviewed: <date>`.

Sections, in this order:

1. **In one paragraph**: what this area is for. Use the human's answer if there is one, and say that it is their answer.
2. **How a record moves**: a numbered list from creation to the end. Who or what creates it, which steps it goes through, what runs at each step, who owns it then, how it ends.
3. **What happens automatically**: the flows, triggers and rules that matter, each with what it does in plain words.
4. **Who does what**: roles, queues and teams, as far as the metadata shows.
5. **Other systems**: what is sent out or comes in.
6. **Not understood yet**: an honest list.

## The rule the check enforces

Every list item is one of three kinds:

- **A fact**: it contains a link to a fact note or a hub page: `[[orgs/<org>/facts/Flow/Case_AfterSave_Notify_Owner|Case_AfterSave_Notify_Owner]]`.
- **An inference**: it ends with `(inferred)`. You reasoned it from names, order or structure. Say from what.
- **A question**: it ends with `(ask)`. You could not establish it. It should also be something the human can answer.

A list item that is none of these is refused. Do not turn an inference into a fact by attaching a loosely related link.

```markdown
2. A new case goes to a queue chosen by its type, set by [[orgs/uat/facts/AssignmentRules/Case|the Case assignment rules]].
3. Support agents pick cases from the queue by hand. (inferred) No automation changes the owner after assignment.
4. Whether a case may be closed without a resolution note. (ask)
```

## Writing

Write for a colleague who joins tomorrow and knows Salesforce but not this company. Plain words. API names only inside links. No guesses about intent: "the flow sets the status to Escalated after two days", not "the business wants fast escalation".
