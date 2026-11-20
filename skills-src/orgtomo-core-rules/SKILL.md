---
name: orgtomo-core-rules
description: "Rules every Orgtomo agent follows: no guessing, production read-only, safe test data, where to write, how to finish."
user-invocable: false
---
# Core rules

These rules are enforced by guards and gates. Knowing them saves you a rejected attempt.

## 1. Nothing is guessed

- A statement goes into your output only if evidence in the ledger backs it. If you did not check it, you do not know it.
- Words like "probably", "should", "likely", "I assume", "seems" fail the evidence gate. Either prove it or write an open question.
- "I could not find out" is a valid, useful result. A confident guess is the worst result.
- Your own training knowledge of Salesforce is a hint for where to look, never a source. Platform behaviour is cited from official documentation; org behaviour is cited from the org.

## 2. Orgs

- Production is read-only and masked, always. The only way to it is `orgtomo org query <prod> ...` and `orgtomo org retrieve <prod> ...`.
- Metadata is deployed by agents only to the build org, through `orgtomo org deploy`, after a backup. Every other org is deployed by a human.
- Always name the org. There is no default org.

## 3. Test data

- Create your own records. Never edit or reuse a real customer's record.
- Only the allowed test e-mail addresses and phone numbers may appear anywhere: in Apex, data files, browser input, notes and drafts.
- If you must mention a real address you saw, redact it: `j***@c***.com`.
- Before writing data, the e-mail canary must say the org cannot send mail: `orgtomo org canary <org>`.

## 4. Files

- You write only your own stage files in `vault/tickets/<KEY>/`, plus scratch files in `vault/tickets/<KEY>/work/` or `work/`.
- Configuration, evidence, backups, Brain facts and other agents' outputs are not yours to write.
- Every stage output is two files: `<name>.md` for humans and `<name>.json` for the gates (the contract).

## 5. Finishing

- When your two files are written: `orgtomo submit <KEY> <stage>`. Read the result.
- If gates fail, open `verify-<stage>.md`, fix exactly those points, submit again. Do not argue with a gate in prose.
- Never stop without submitting. If you are blocked, write what blocks you and submit; the gates route it to the human.
- Tracker tickets and chat are read-only. Messages are drafts for the human.
