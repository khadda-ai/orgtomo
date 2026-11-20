---
description: How to set up an Orgtomo workspace
---
Setup writes configuration, so the human runs it in their own terminal, in the folder that should become the workspace:

```
orgtomo setup
```

It asks for the orgs (name, sf CLI alias, role), how each target org is deployed, the allowed test e-mail addresses and phone numbers, and which optional features to turn on. Then:

1. `orgtomo doctor --orgs`
2. `orgtomo brain retrieve <base org>` and `orgtomo brain build <base org>`
3. `orgtomo ui` to review everything in the browser
4. `orgtomo start` to open Claude Code with the Lead

Explain these steps to the human and answer questions. Do not try to create or edit configuration yourself.
