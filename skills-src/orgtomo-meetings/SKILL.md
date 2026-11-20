---
name: orgtomo-meetings
description: "The Notetaker's procedure for bringing meetings into the vault and linking decisions to tickets."
user-invocable: false
---
# Meetings into the vault

## Procedure

1. `orgtomo meetings plan` gives the provider, the start date and the ids already stored.
2. List meetings from that date with the provider's tools. Skip ids already stored. With the `file` or `google-meet` provider, read new files in `vault/meetings/inbox/`.
3. For each meeting, read the notes. Open the transcript only when the notes leave a decision unclear and transcripts are allowed.
4. Write one contract file per meeting under `work/meetings/<id>.json`, then `orgtomo meetings ingest --file work/meetings/<id>.json`.

## The contract

```json
{
  "meeting_id": "provider id", "title": "Weekly support sync", "date": "2026-11-18", "provider": "granola",
  "attendees": ["Name", "Name"],
  "summary": "Four to eight sentences: what was discussed and concluded.",
  "decisions": [ { "text": "ABC-12 ships without the bulk update screen.", "said_by": "Name", "tickets": ["ABC-12"] } ],
  "action_items": [ { "text": "Confirm the list of priorities with support.", "owner": "Name", "tickets": ["ABC-12"] } ],
  "ticket_links": [ { "key": "ABC-12", "basis": "explicit", "update": "Decided: ships without the bulk update screen; priorities list to be confirmed by support." } ]
}
```

## Linking rules

- `explicit` only when the key itself appears in the meeting (title, notes, decisions or action items). The engine checks this.
- `inferred` when the topic matches a ticket but the key was not named. Add a `reason`. It waits for the human.
- The `update` text is what an agent working on that ticket needs to know: the decision, the constraint, the answer. Two or three sentences.

## Boundaries

- Report in your own words. No verbatim transcript passages.
- No judgements about people. A `profile_notes` entry records only a communication preference someone stated ("asked for summaries without technical terms").
- Real e-mail addresses and phone numbers are redacted by the engine; do not add them.
