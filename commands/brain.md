---
description: Build, refresh, check or compare the Org Brain
argument-hint: "[status] | [sync <org>] | [build <org>] | [drift <base> <other>] | [search <org> <words>] | [object <org> <Object>]"
---
Org Brain task: `$ARGUMENTS`

- `status` (default): run `orgtomo brain status` and report per org: built when, how many components, how many notes are out of date.
- `sync <org>`: spawn the cartographer to run `orgtomo brain sync <org>` (retrieve, then build), then report counts and the change list from `vault/log.md`.
- `build <org>`: rebuild the notes from the metadata that is already in `source/<org>/`.
- `object <org> <Object>`: run `orgtomo brain object` and show everything on that object: counts, automation, tests, tickets.
- `drift <base> <other>`: spawn the cartographer to compare and summarise.
- `search <org> <words>`: run `orgtomo brain search` and list the matches with their note paths.

The vault is the folder `vault/`. The human can browse it in the control panel (`orgtomo ui`, Org Brain) or open it in Obsidian.
