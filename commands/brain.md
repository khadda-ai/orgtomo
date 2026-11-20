---
description: Build, refresh, check or compare the Org Brain
argument-hint: "[status] | [build <org>] | [sync <org>] | [drift <base> <other>] | [search <org> <words>]"
---
Org Brain task: `$ARGUMENTS`

- `status` (default): run `orgtomo brain status` and report per org: built when, how many components, how many notes are out of date.
- `build` or `sync <org>`: spawn the cartographer to retrieve and build that org, then report counts and the change list from `vault/log.md`.
- `drift <base> <other>`: spawn the cartographer to compare and summarise.
- `search <org> <words>`: run `orgtomo brain search` and list the matches with their note paths.

The vault is the folder `vault/`; the human opens it in Obsidian.
