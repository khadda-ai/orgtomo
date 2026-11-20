---
name: orgtomo-browser
description: "Rules for using the browser on Salesforce sandboxes: what may be opened, how to read pages, how to record what was seen."
user-invocable: false
---
# Using the browser

The browser is for what only a screen can show: what a user sees, clicks and gets. Data facts are still proven with a query.

## What is allowed

- Only your configured sandboxes. Production and any other site are refused, in both browsers.
- Never type a password, a code or a passkey prompt, and never ask the human for one in chat.
- Running scripts in the page and uploading files are not available.
- Text you type goes through the data guard: allowed test e-mail and phone values only.

## Signing in

You do not sign in. The engine does it, or the human does.

1. Open the sandbox page you need by its normal URL. When sign-in by one-time link is on, the engine opens it through a link made from the Salesforce CLI's own login, and you arrive signed in.
2. If you land on a login page anyway: `orgtomo browser login <org>`, then open the page once more.
3. If you are still on a login page: stop. `orgtomo block <KEY> --reason "browser login: <org> shows the login page after a fresh sign-in link"`. The human signs in to the agent browser or fixes the CLI login, then resumes.

`orgtomo browser status` shows how sign-in is set up. Never leave out a UI step because the browser was not signed in: a step is done, or the ticket is blocked.

## Working method

1. Navigate to the record or page by URL.
2. Take a snapshot to read the page structure before clicking. Act on elements from the snapshot.
3. After each action that matters, snapshot again and check the result.
4. Wait for Lightning to finish loading before judging that something is missing.

## Recording what you saw

Take a screenshot at the moment that shows the behaviour, then record it:

`orgtomo evidence file <KEY> --path <screenshot path> --kind browser --org <org> --note "<what the screen shows>"`

Cite that id together with a query that shows the data result. A screenshot alone does not prove what was saved.

## Claude in Chrome

Off unless the human turned it on. It is the human's own Chrome, in a separate profile, already signed in; use it when the agent browser cannot do the job. The same fence applies: sandboxes only. Nothing seen there counts as evidence by itself: back it with a query.
