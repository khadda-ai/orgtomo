# Verification status

Orgtomo's own rule is that nothing is claimed without proof. This page applies that rule to Orgtomo itself. It is updated with every release.

Version 0.2.0, 2026-11-21.

## Verified by the automated test suite (offline)

Run with `npm test`: 54 tests. The suite uses a stand-in Salesforce CLI that keeps each "org" as a folder of metadata and answers with the same JSON shape as the real CLI. Since 0.2.0 the stand-in also applies the real CLI's rules for where a retrieve may write and where a default org may be set, with the real error names, because version 0.1.0 passed its tests while breaking both rules.

| Area | What the tests prove |
|---|---|
| Full ticket | One bug ticket from open to done: import with redaction, masked reads, every stage's gates, the Lead's check, two human approvals, deploy packs for two targets, a failing parity check before the "human" really deployed, retest, learning, close. |
| Evidence gate | Unknown evidence ids and guessing language are rejected. |
| Runner | Stage ownership, attempt limit, blocking questions routed to the human, an unreproduced bug stopping the ticket, a reproduction "proven" only by reading metadata being rejected, the Lead's mismatch, loop back and the stop at the loop limit with a written report, resume with a direction. |
| Lite path | Decided from contract facts; an optimistic flag on an Apex change is ignored; gates are identical on both paths. |
| Build gates | Scope, backup, naming, comment, format, forbidden patterns, stale deploy; deploy refused without backup and outside the build org's source. |
| Production | Masked and bounded reads; every write path refuses; an org that answers "not a sandbox" is refused whatever the configuration says. |
| Guards | About ninety adversarial shell commands (production spelled ten ways, variables, eval, xargs, nested shells, scripts, raw API, tokens), protected state, file ownership, MCP deny-by-default, browser fence, data guard, masking. |
| Hooks | Protocol output shape, identity injection into engine commands, stage gate on spawns, submit enforcement, human actions recorded once when two events fire for one prompt, production closed with guards off. |
| Knowledge | Org Brain facts, links, save order, canvas, staleness, drift, context pack; lessons only from recorded observations, auto-apply threshold, merge, recurrence; people profiles; meeting links. |
| Sync and CLI | Generated agents, skills, settings and MCP file follow the configuration; idempotent; comments in configuration survive edits; human verbs refused to agents. |
| Blocked status | A reported block and a command failing twice both stop the ticket without counting an attempt; resume continues it. |
| Retrieve | Staging inside the project, relative output folder, copy out, clean-up; a backup into the ticket folder. |
| Data guard | Malformed addresses, shape-preserving masks, text already in the backup allowed and new text refused, shell writes held to file ownership, here-document bodies. |
| Org identity | An alias answering with another org id stops writes until a human confirms; the answer expires. |
| Discovery | Each object in exactly one area, stable question ids, an unlinked statement in a process note refused. |
| Models, browser | Alias resolution, effort levels per model, catalogue refresh against a stand-in endpoint; navigation rewritten to a sign-in link for a sandbox and never for production. |

The control panel was exercised in a browser: all eleven sections render without script errors on a workspace built from a real sandbox (982 components); the Org Brain search, a component view and an object view work; a business question answered in the panel and a model changed in the panel reach the engine. A request without the token is refused; the test suite also covers a request from a foreign origin.

## Verified against the real Salesforce CLI and a real sandbox (read-only)

Run by hand on 2026-11-20 and 2026-11-21 with a scratch workspace wired to one sandbox. Nothing was written to the org.

| Item | Result |
|---|---|
| `orgtomo brain sync` | Retrieve and build completed. |
| `orgtomo doctor --orgs` | The retrieve probe passed. |
| `orgtomo org backup` into a ticket folder | Worked; this is the call that failed in 0.1.0. The staging folder was removed afterwards. |
| `orgtomo discover run --retrieve` | All twenty discovery metadata types retrieved, record totals read, areas and questions written. |
| Tooling API query for the newest version of a flow | Field names confirmed. |
| CLI rules the engine depends on | A retrieve output folder outside the project, or inside a package directory, is refused; setting a default org outside a project is refused; `sf org open --url-only` returns a link. |

## Verified against documentation, not yet against a live session

These rest on vendor documentation read on 2026-11-19, and need one confirming run on a real machine.

| Item | Based on | Confirm by |
|---|---|---|
| Hook events, input fields and output shapes | Claude Code hooks reference | `/orgtomo:ping` records which event delivered the command and which fields arrived |
| `updatedInput` on an allowed Bash call carries the caller identity | Claude Code hooks reference | Run any `orgtomo` command as an agent; `orgtomo evidence list` shows the actor |
| Agent frontmatter: `tools` with `Agent(...)` and `mcp__server__*`, `skills`, `model`, `effort`, `maxTurns` | Claude Code sub-agents reference | `orgtomo start`, then `/agents` |
| Plugin `bin/` puts `orgtomo` on PATH for Bash calls | Claude Code plugins reference | An agent runs `orgtomo version` |
| Marketplace entries pinned by commit (`git-subdir` with `sha`) | Claude Code plugin marketplaces reference | `/plugin install salesforce-development@orgtomo` |
| Playwright MCP tool names and flags (`--user-data-dir`, `--extension`, `--blocked-origins`) | The help output of the pinned package version | `/mcp` lists the tools; adjust `capabilities.yaml` if names differ |
| Plugin install scope (`--scope project`) and uninstall | `claude plugin install --help`, `claude plugin uninstall --help` | `orgtomo doctor` reports the scope |
| Models endpoint and its fields | Anthropic API reference | `orgtomo models refresh` with your key |
| Granola MCP endpoint and tool names | Granola documentation | `/mcp` after enabling meetings |
| Salesforce plugin environment switches (`DO_NOT_TRACK`, `SF_DISABLE_TELEMETRY`, `SF_PLUGIN_SKILLS_FIRST`) | forcedotcom/sf-skills at the pinned commit | Plugin start-up output |

## Not yet verified

| Item | Why it matters | Status |
|---|---|---|
| Real Salesforce CLI JSON for deploy failures and test results across CLI versions | The engine reads specific fields; a renamed field would lose detail, not safety | Needs a run against a sandbox |
| The single-use sign-in link in an org that requires a passkey or another second step | Decides whether browser steps run without a human | Salesforce documents that the link signs in without asking again; whether an org's own login policy adds a step is not verified. Try it once per sandbox. An agent that lands on a login page blocks the ticket. |
| Playwright started with blocked origins, and attached to a running browser, in a live session | A second line behind the navigation fence | The flags exist in the pinned version; behaviour in a session is not yet observed |
| `orgtomo models refresh` against the real endpoint | Fills the model list for a workspace | Tested against a stand-in only |
| `orgtomo obsidian install` | Convenience | The machine used for testing had no package manager; only the "not available" path ran |
| A full ticket through the new gates with real agents | Quality of intake and self-review in practice | Needs real tickets |
| E-mail canary (`Messaging.reserveSingleEmailCapacity`) across deliverability settings and editions | Decides whether data may be written in `blocked` mode | A known practitioner technique; if it answers `unknown`, state the setting by hand. An unknown answer blocks writes, never allows them. |
| Interplay with the Salesforce plugin's own hooks (skills-first enforcement, deploy gate) | Two sets of hooks judge the same calls | Expected to compose (a deny from either side wins); needs observation |
| Flow generator default-org check (`.sf/config.json`) | Keeps the hosted generator on the build org | The file location is the CLI's documented project config; confirm on your CLI version |
| Model behaviour: do agents follow the playbooks well, how many attempts stages take, token cost per ticket | Quality and cost | Needs real tickets; the learning ledger will show it |
| Red-team run on a real sandbox | Guards are tested against commands we thought of | Planned before 1.0 |
| Zoom and Google Meet connectors | No verified tool names | Use the `file` provider or add your connector's tools to `capabilities.yaml` |
| Windows | Paths and shell analysis were written and tested on Linux and macOS | Untested |

## Known limits by design

See [SAFETY.md](SAFETY.md#limits). In short: guards inspect what an agent asks to run; they are not an operating-system sandbox. The strongest protections are the ones that do not depend on inspection: a production login that is itself read-only (recommended in setup), the engine asking the org whether it is a sandbox before any write, and target orgs being deployed by you.
