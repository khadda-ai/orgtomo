# Knowledge

Five kinds of knowledge live in the vault. All of them are plain Markdown. You can browse the Org Brain in the control panel (`orgtomo ui`), or open the folder in [Obsidian](https://obsidian.md), a free viewer and editor for a folder of notes. Orgtomo does not depend on it, and Obsidian has no assistant of its own: the notes are written by the engine and its agents.

## Org Brain

A generated map of an org.

```bash
orgtomo brain sync uat         # metadata into source/uat/, then notes, index, maps
orgtomo brain status
orgtomo brain object uat Case  # everything on one object
orgtomo brain drift uat prod
```

| File | Content |
|---|---|
| `orgs/<org>/facts/<Type>/<Name>.md` | Key facts of one component, what it uses, what uses it. Frontmatter carries the source path and its hash. |
| `orgs/<org>/objects/<Object>.md` | The hub page of an object: counts, where to start, a table of everything on it, the tests that touch it, the tickets that changed it, the notes about it |
| `orgs/<org>/facts/_automation/<Object>.md` | Everything that runs on the object, grouped in the order of a record save; process metadata (approvals, assignment and escalation rules, paths) is listed after it without a claim about order |
| `orgs/<org>/maps/<Object>.canvas` | The same as a JSON Canvas map |
| `orgs/<org>/Components.base` | An Obsidian Base (table view) over the fact notes |
| `orgs/<org>/_index.json` | Machine index used by gates and context packs |
| `orgs/<org>/understanding/` | Plain-language notes by the Cartographer; every statement links to a fact |
| `orgs/<org>/drift-vs-<base>.md` | Differences between two orgs |
| `log.md` | What changed at each build |

What is parsed in detail: Apex classes and triggers, flows, custom objects and fields, validation rules, record types, Lightning web components, permission sets and profiles. Process, access and app metadata (approval processes, assignment, escalation and auto-response rules, workflow, paths, queues, roles, permission set groups, quick actions, pages, layouts, apps, tabs, custom metadata records, named credentials, connected apps, installed packages) is read by a generic reader: single values become facts, repeated values become lists, repeated structures are counted. It does not depend on the element names of a type, so it does not go wrong when Salesforce adds one.

Rules:

- **Facts are generated, never written by hand.** The next build overwrites them.
- **A fact is evidence only while fresh.** `orgtomo evidence brain` re-hashes the source and refuses a stale note.
- **Base org.** Build the Brain from the org closest to production that is safe to work with, normally UAT. Production is retrieved read-only for drift checks.
- **Dependencies are static.** Dynamic references can be missed.

### Context packs

`orgtomo brain pack <KEY>` writes `tickets/<KEY>/context-pack.md`: components matching the ticket, what is one step away from them, the automation notes and hub pages of the objects involved, and pointers to meeting updates and lessons. Agents start from it instead of searching the org blind.

How a component gets into the pack:

- **API names written anywhere in the ticket** (title, description, criteria) are looked up first. A field, validation rule or record type is stored as `Object.Name`, and a ticket names it without the object, so the part after the dot counts as an exact match.
- **Other words of the title** count by how rare they are in this org. A word that matches one component says more than a word that matches fifty.
- Every line says why it matched.
- After the Analyst has named the affected components, the engine **rebuilds the pack around them**.

## Business discovery (optional)

```bash
orgtomo discover run uat --retrieve
```

What does this company use the org for? Three parts answer that, each by whoever can answer it honestly.

| Part | By | Files in `orgs/<org>/business/` |
|---|---|---|
| What exists | the engine | `Overview.md`; `domains/<area>.md` with every object of the area, its record total, record types, the steps a record goes through, what runs on it |
| How it works | the Cartographer | `processes/<area>.md`: how a record moves, what happens automatically, who does what, which other systems are involved |
| What only a person knows | you | `Questions.md`; answer with `/orgtomo:discover answer <org> <Q id> <text>` or in the control panel |

Every object is put into exactly one area: by what it is (a known standard object, a package's object), then by what its lookup fields point to, and only then by the app that shows it. Apps are a weak signal, because one company often has many apps over the same objects.

A process note is checked statement by statement (`orgtomo discover check`). Each list item must link to a fact or hub page, or end with `(inferred)` or `(ask)`. A statement that is none of these is refused. That is the difference between a map and a story.

Discovery reads metadata and record totals. It never reads record values. Metadata shows what the system does; it does not show why the business wants it, which is why part three exists.

## Self-learning

Two layers.

**Observations** are written only by the engine, at the moment something happens:

| Source | Example |
|---|---|
| gate | "Gate comment-lint failed at build (attempt 1): no change line for ABC-12" |
| gate | "All 9 gates of build passed on the first attempt" |
| lead | "Lead re-checked claim C2 of plan and the org did not match the report" |
| engine | "test sent the ticket back to plan (loop 1): ..." |
| reviewer | a finding from a review, with its proof ids |
| human | your `/orgtomo:reject` reason, your `/orgtomo:feedback`, your direction after a stop |

**Lessons** are short rules for one agent. The Coach proposes them at the close stage; each must cite observation ids, and a lesson citing an unknown id is rejected.

| A lesson applies when | |
|---|---|
| You stated it | `/orgtomo:rule <agent> <rule>` or a lesson built on your feedback |
| Enough evidence backs it | at least `self_learning.auto_apply_min_observations` (default 2) observations of the same kind for that agent |
| You approve it | `/orgtomo:lessons approve L-0003` or the control panel |

Applied lessons are written into the agent's `lessons-<agent>` skill, which it loads in full at the start of every run. If the same mistake is observed again after its lesson was applied, the lesson's repeat count goes up and the skill says so; that is the signal to sharpen or replace it. Retire a lesson with `/orgtomo:lessons retire <id>`.

Everything is readable in `vault/learning/`: `Lessons.md`, one note per lesson with its evidence, and observations per ticket.

## Meeting notes (optional)

Turn on with `/orgtomo:features meetings on` and choose the provider in `features.yaml` or the control panel.

| Provider | How |
|---|---|
| `granola` | Granola's MCP server; added to `.mcp.json` by sync. Authenticate once with `/mcp`. |
| `zoom`, `google-meet` | Add your connector's read tools under `meetings.read` in `capabilities.yaml`, or export notes and use `file`. |
| `file` | Drop notes or transcripts (Markdown or text) into `vault/meetings/inbox/`. |

At session start the Lead has the Notetaker bring in meetings since the last run. For each meeting the engine stores a note in `vault/meetings/` with summary, decisions and action items, and links tickets:

- the ticket key appears in the meeting: the update is appended to `tickets/<KEY>/updates.md` at once, even if the ticket has not been opened yet;
- the Notetaker only infers a link: it waits for you (`/orgtomo:meetings`, or the control panel).

Agents working a ticket receive `updates.md` among their inputs, and the Analyst marks criteria that come from it as `source: meeting`. Transcripts are not read or stored unless `store_transcripts` is on. Addresses and numbers are redacted on the way in.

## People profiles (optional)

Turn on with `/orgtomo:features people on`.

A profile holds what the Scribe needs to write for a reader, and nothing else:

```
/orgtomo:people set Dana Lee role="Support lead" side=client salesforce_knowledge=basic detail_level=short prefers="plain words;what changes for agents" avoid="API names"
```

| Field | Values |
|---|---|
| `side` | internal, client, partner |
| `role`, `company`, `language` | text |
| `salesforce_knowledge` | none, basic, admin, developer, architect |
| `detail_level` | short, medium, detailed |
| `prefers`, `avoid` | short phrases, separated by `;` |

The schema is closed: there is no free-form field for personal details. Agents can only propose a note with its source (for example a preference someone stated in a meeting); it changes a profile when you confirm it. With the feature off, the Scribe writes one non-technical and one technical draft.

## Your own notes

Write anywhere in the vault outside `orgs/*/facts`. `decisions/` is meant for your architecture and process decisions; agents read it and do not write there.
