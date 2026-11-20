---
description: Check that this workspace is healthy (configuration, CLI, orgs, hooks, Brain)
argument-hint: "[--orgs]"
---
Run `orgtomo doctor $ARGUMENTS` and present the checks as a list: what is fine, what needs attention, and the exact fix for each. `--orgs` also contacts every org to confirm it is reachable and whether it is a sandbox, and runs one real retrieve from the build org, because backups, verification and the parity check all depend on it. Do not fix configuration yourself; it is the human's.
