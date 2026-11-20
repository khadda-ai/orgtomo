# Safety model

What Orgtomo protects, how, and where the protection ends.

## The rules

| Rule | Enforced by |
|---|---|
| Production is read-only and masked | Org access layer refuses every write verb for a production org; shell policy denies every raw CLI call that targets it; browser fence refuses its hosts; configuration that tries to make it writable is invalid. Holds even with `ORGTOMO_GUARDS=off`. |
| An org is written to only if the org itself says it is a sandbox | Before a write, the engine queries `Organization.IsSandbox`. "Not a sandbox" with a non-production role stops everything. The answer is trusted for a limited time (`verify_org_max_age_minutes`, 12 hours) and is tied to the org id: an alias that starts answering with a different org id stops every write until a human confirms. |
| Metadata reaches target orgs only through a human | Raw deploy commands are denied; the engine deploys only to the build org, only during the build stage; other orgs get a deploy pack. |
| Every metadata change has a backup first | `orgtomo org deploy` refuses components without a recorded backup; a gate checks that the backup predates the deploy. |
| No real person's e-mail or phone in test data | Data guard on shell commands that write, files they reference, Write/Edit content, browser typing, stage outputs and drafts. Broken addresses (a stray dot on either side of the @) are treated as addresses. Text that a component already contained before the ticket is the product's own text and is allowed; anything new is not. |
| No e-mail leaves a sandbox by accident | `blocked` mode: data writes need a fresh canary result saying the org cannot send mail. `allowlist_only`: data guard everywhere. |
| What agents read from orgs is masked | Query results pass the masker before they are shown or stored, Tooling API results included. Raw `sf data query` is closed while masking is on. A masked address keeps its shape (every dot and the @ stay in place) so that a ticket about a misplaced dot stays readable. |
| Agents cannot approve, reject, confirm deploys or change configuration | Human-only actions run in the prompt hook, the UI or a real terminal. The shell policy denies the engine's human verbs; the CLI refuses them without a TTY or when called from Claude Code. |
| Agents cannot write configuration, engine state, evidence, backups or their own definitions | Write guard and shell policy on protected paths. |
| Agents work only in their turn and only on their own files | Stage gate on spawns; write guard by file owner; Builder may edit source only while a ticket is in the build stage. The same ownership rules apply to shell commands that write a file (a redirect, `cp`, `mv`, `tee`, `rm`, `sed -i`). |
| A broken tool stops the work instead of being worked around | `orgtomo block` and the engine's own block after two failures put the ticket in `blocked` with the reason. Nothing pushes agents on while it is blocked. |
| Trackers and chat are read-only | MCP guard is deny-by-default; only read tools are listed. Messages are drafts. |
| Tokens are never shown | `sf org display`, `org open`, login and auth commands are denied to agents; `orgtomo org info` returns sanitised facts. |
| Agents never handle a password, a code or a passkey | The engine signs the agent browser in to a sandbox through a single-use link made by the Salesforce CLI. Only the engine asks for the link, only for a configured sandbox, and it is not stored or recorded as evidence. |
| The browser stays on your sandboxes | Navigation fence from the hosts in `orgs.yaml`, for both the Playwright browser and Claude in Chrome; the Playwright browser is started with the production origins blocked; a deny list for sensitive Setup pages; page scripting and uploads are never granted. |
| Documentation evidence comes from official hosts | `WebFetch` and `orgtomo evidence doc` accept only `official_doc_hosts`. |

## How the shell policy reads a command

It splits a command line into simple commands (through `&&`, `;`, pipes, `bash -c`, `xargs`, wrappers such as `env` and `npx`), then judges each:

- Salesforce CLI calls must name a configured org literally with `--target-org`. Variables, substitutions, `eval`, legacy flags and default-org tricks are denied.
- A fixed list is always denied (login, tokens, raw deploys, raw API, mass export, destructive commands, CLI configuration).
- Reads and test runs on sandboxes are allowed; data writes pass the data guard and the e-mail gate; anything not recognised is denied.
- Scripts that are run are read first; a script that calls the Salesforce CLI or a Salesforce library is denied.
- Commands touching protected paths must be pure reads.

The test suite (`tests/guards.test.mjs`) holds the cases this was built against. Add a case there when you find a gap.

## Recommended setup, in order of value

1. **Log in to production with a read-only user.** This is the one protection that does not depend on Orgtomo at all.
2. Use a dedicated folder as the workspace and run only Orgtomo's team in it.
3. Keep `email_mode: blocked` and set sandbox deliverability to *System email only* or *No access*.
4. Keep `mask_sandbox_reads: true` unless your sandbox data is synthetic.
5. Keep the Reviewer on a different model from the Builder.
6. Run `orgtomo doctor --orgs` after any change to orgs.

## Limits

Read these before trusting the system with anything important.

- **Guards inspect requests; they are not a sandbox.** They run as Claude Code hooks under your own user account. A command that hides its intent well enough (for example a program that builds a path or a CLI call at run time) can get past string inspection. The guards are written to fail closed on what they cannot parse, and the test suite covers many evasions, but "many" is not "all". This is why the first recommendation above matters.
- **Hooks must be active.** If the plugin is not enabled in the folder, nothing is guarded. `/orgtomo:ping` and `orgtomo doctor` tell you. The session banner appears only when hooks run.
- **`ORGTOMO_GUARDS=off`** (set by you before starting Claude Code) switches off everything except the production rules, the browser fence and protected state. It exists for maintenance. The banner says when it is on.
- **Approvals are protected by process separation, not cryptography.** An agent cannot run the human verbs or write the state files through any guarded path. Someone with shell access as your user can; so can you.
- **The e-mail canary is a probe, not a guarantee.** It asks the org whether single e-mail could be sent. If the answer is unclear it reports `unknown`, which blocks writes. Automation that sends through other channels (for example an external service called by a flow) is outside what it sees.
- **Masking is pattern-based.** Fields are masked by name pattern and by recognising addresses and numbers in values. Free text can carry personal data in forms no pattern catches. Do not paste production exports into the workspace.
- **The browser fence controls navigation requests,** not redirects that happen inside a page. The blocked production origins add a second line, and Playwright itself states that origin lists are not a security boundary and do not affect redirects.
- **The one-time sign-in link passes through the browser tool.** The agent asks for a normal sandbox URL and the engine swaps in the link, but the tool's own output can show the address it opened. The link works once and for about a minute, and by then it has been used. Treat tool output as you treat any log.
- **The data guard reads text.** An address that a script assembles at run time is invisible to it. The protection that does not depend on reading text is a sandbox that cannot send e-mail (`email_mode: blocked`).
- **Static analysis in the Org Brain can miss dynamic references** (dynamic SOQL, names built at run time). "Used by: nothing found" means nothing was found, not that nothing exists.
- **Parity compares the components of the ticket** in source form. It does not prove that nothing else changed in the target org.
- **Model judgement is not removed.** Gates check form, proof and consistency. Whether a design is wise is still judged by models and by you.

## Reporting a problem

Security issues: see [SECURITY.md](../SECURITY.md). A guard that let something through is a security issue.
