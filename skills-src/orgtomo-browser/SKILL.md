---
name: orgtomo-browser
description: "Rules for using the browser on Salesforce sandboxes: what may be opened, how to read pages, how to record what was seen."
user-invocable: false
---
# Using the browser

The browser is for what only a screen can show: what a user sees, clicks and gets. Data facts are still proven with a query.

## What is allowed

- Only your configured sandboxes. Production and any other site are refused.
- The human signs in once in the browser profile. If you land on a login page, stop and ask the human to sign in; never type credentials.
- Running scripts in the page and uploading files are not available.
- Text you type goes through the data guard: allowed test e-mail and phone values only.

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

Off unless the human turned it on. It uses a real, separate Chrome profile; nothing seen there counts as evidence.
