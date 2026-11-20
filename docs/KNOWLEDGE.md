# Knowledge

Four kinds of knowledge live in the vault. All of them are plain Markdown that opens in [Obsidian](https://obsidian.md). Obsidian is a viewer and editor for a folder of notes; Orgtomo does not depend on it running.

## Org Brain

A generated map of an org.

```bash
orgtomo brain retrieve uat     # metadata into source/uat/
orgtomo brain build uat        # notes, index, maps
orgtomo brain status
orgtomo brain drift uat prod
```

| File | Content |
|---|---|
| `orgs/<org>/facts/<Type>/<Name>.md` | Key facts of one component, what it uses, what uses it. Frontmatter carries the source path and its hash. |
| `orgs/<org>/facts/_automation/<Object>.md` | Everything that runs on the object, grouped in the order of a record save |
| `orgs/<org>/maps/<Object>.canvas` | The same as a JSON Canvas map |
| `orgs/<org>/Components.base` | An Obsidian Base (table view) over the fact notes |
| `orgs/<org>/_index.json` | Machine index used by gates and context packs |
| `orgs/<org>/understanding/` | Plain-language notes by the Cartographer; every statement links to a fact |
| `orgs/<org>/drift-vs-<base>.md` | Differences between two orgs |
| `log.md` | What changed at each build |

What is parsed today: Apex classes and triggers, flows, custom objects and fields, validation rules, record types, Lightning web components, permission sets and profiles. Other retrieved types get a note with path and hash.

Rules:

- **Facts are generated, never written by hand.** The next build overwrites them.
- **A fact is evidence only while fresh.** `orgtomo evidence brain` re-hashes the source and refuses a stale note.
- **Base org.** Build the Brain from the org closest to production that is safe to work with, normally UAT. Production is retrieved read-only for drift checks.
- **Dependencies are static.** Dynamic references can be missed.

### Context packs

`orgtomo brain pack <KEY>` writes `tickets/<KEY>/context-pack.md`: components matching the ticket, what is one step away from them, the automation notes of the objects involved, and pointers to meeting updates and lessons. Agents start from it instead of searching the org blind.

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
