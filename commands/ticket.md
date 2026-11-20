---
description: Start (or continue) work on a ticket with the Orgtomo team
argument-hint: <TICKET-KEY> [--lite]
---
Work on ticket `$ARGUMENTS`.

1. If it is not open yet: `orgtomo ticket open $ARGUMENTS`, read the issue with your tracker tools, then `orgtomo ticket import <KEY> --json '<ticket contract>'` (copy the ticket as written; type is bug, feature, config or question) and `orgtomo brain pack <KEY>`.
2. Run `orgtomo next <KEY>` and follow it exactly: spawn the agent it names, then ask again.
3. Stop at every human gate and tell the human, in their language, what was done, what you verified yourself, and the command they type next.
