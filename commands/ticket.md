---
description: Start (or continue) work on a ticket with the Orgtomo team
argument-hint: <TICKET-KEY> [--lite]
---
Work on ticket `$ARGUMENTS`.

1. If it is not open yet: `orgtomo ticket open $ARGUMENTS`, read the issue with your tracker tools, then import it the way `orgtomo next <KEY>` shows: the ticket contract as JSON on standard input, inside a quoted here-document (`orgtomo ticket import <KEY> --file - <<'ORGTOMO_TICKET'`), so that quotes and backticks in the ticket stay plain text. Copy the ticket as written; type is bug, feature, config or question; `source` is required. Then `orgtomo brain pack <KEY>`.
2. Run `orgtomo next <KEY>` and follow it exactly: spawn the agent it names, then ask again.
3. If a tool, a login or an org is broken, block the ticket with the exact reason (`orgtomo block <KEY> --reason "..."`) and tell the human. Do not retry in a loop.
4. Stop at every human gate and tell the human, in their language, what was done, what you verified yourself, and the command they type next.
