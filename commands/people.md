---
description: Show people profiles, or set / confirm one
argument-hint: '[set <Name> role="..." side=client salesforce_knowledge=basic detail_level=short prefers="...;..."] | [confirm|reject <P-id>] | [remove <Name>]'
---
With no arguments: run `orgtomo people list` and show profiles and waiting proposals. If the feature is off, say so and how to turn it on (`/orgtomo:features people on`).

`set`, `confirm`, `reject` and `remove` are human actions recorded by the engine. Report them only if an `[Orgtomo engine]` note in this turn confirms it.

Profiles hold work-communication facts only: role, side (internal, client, partner), Salesforce knowledge (none, basic, admin, developer, architect), detail level (short, medium, detailed), what they prefer, what to avoid. Nothing personal.
