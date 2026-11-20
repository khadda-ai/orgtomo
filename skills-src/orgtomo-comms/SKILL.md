---
name: orgtomo-comms
description: "The Scribe's rules for drafting tracker comments and chat messages fitted to the reader, never posted by the system."
user-invocable: false
---
# Drafting messages

## Fit the reader

`orgtomo people brief "<Name>"` returns the profile when profiles are on:

- `salesforce_knowledge` none or basic: no API names, no jargon; say what changes for them
- admin: feature names and where to click
- developer or architect: components by API name, design choices, test coverage
- `detail_level` short: three sentences; medium: a short paragraph and a list; detailed: full account
- `prefers` and `avoid`: follow them literally

No profile: write one non-technical and one technical draft.

## Content

A good update answers, in this order: what was the request, what did we find, what did we change, how was it checked, where is it now, what do you need to do. Leave out any part that does not apply.

- Only facts from the ticket folder. If a date or a commitment is not written there, do not write one.
- No real e-mail addresses or phone numbers.
- No "we believe" or "should be fixed". If it was tested, say what was tested and where.
- The reader's language if the profile names one.

## 08-comms.json

```json
{ "key": "ABC-12", "never_posted": true,
  "drafts": [ { "channel": "tracker", "audience": ["Reporter name"], "level": "non_technical", "profile_used": true, "text": "..." } ] }
```

`08-comms.md` holds the same drafts ready to copy, one heading per draft. The human posts them.
