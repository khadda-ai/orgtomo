# Verification status

Orgtomo's own rule is that nothing is claimed without proof. This page applies that rule to Orgtomo itself. It is updated with every release.

Version 0.1.0, 2026-11-19.

## Verified by the automated test suite (offline)

Run with `npm test`. The suite uses a stand-in Salesforce CLI that keeps each "org" as a folder of metadata and answers with the same JSON shape as the real CLI.

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

The control panel was exercised in a headless browser: all ten sections render without console errors, an approval and a model change made in the UI reach the engine, and requests without the token or with a foreign Host header are refused.

## Verified against documentation, not yet against a live session

These rest on vendor documentation read on 2026-11-19, and need one confirming run on a real machine.

| Item | Based on | Confirm by |
|---|---|---|
| Hook events, input fields and output shapes | Claude Code hooks reference | `/orgtomo:ping` records which event delivered the command and which fields arrived |
| `updatedInput` on an allowed Bash call carries the caller identity | Claude Code hooks reference | Run any `orgtomo` command as an agent; `orgtomo evidence list` shows the actor |
| Agent frontmatter: `tools` with `Agent(...)` and `mcp__server__*`, `skills`, `model`, `effort`, `maxTurns` | Claude Code sub-agents reference | `orgtomo start`, then `/agents` |
| Plugin `bin/` puts `orgtomo` on PATH for Bash calls | Claude Code plugins reference | An agent runs `orgtomo version` |
| Marketplace entries pinned by commit (`git-subdir` with `sha`) | Claude Code plugin marketplaces reference | `/plugin install salesforce-development@orgtomo` |
| Playwright MCP tool names and flags | microsoft/playwright-mcp README | `/mcp` lists the tools; adjust `capabilities.yaml` if names differ |
| Granola MCP endpoint and tool names | Granola documentation | `/mcp` after enabling meetings |
| Salesforce plugin environment switches (`DO_NOT_TRACK`, `SF_DISABLE_TELEMETRY`, `SF_PLUGIN_SKILLS_FIRST`) | forcedotcom/sf-skills at the pinned commit | Plugin start-up output |

## Not yet verified

| Item | Why it matters | Status |
|---|---|---|
| Real Salesforce CLI JSON for deploy failures and test results across CLI versions | The engine reads specific fields; a renamed field would lose detail, not safety | Needs a run against a sandbox |
| E-mail canary (`Messaging.reserveSingleEmailCapacity`) across deliverability settings and editions | Decides whether data may be written in `blocked` mode | A known practitioner technique; if it answers `unknown`, state the setting by hand. An unknown answer blocks writes, never allows them. |
| Interplay with the Salesforce plugin's own hooks (skills-first enforcement, deploy gate) | Two sets of hooks judge the same calls | Expected to compose (a deny from either side wins); needs observation |
| Flow generator default-org check (`.sf/config.json`) | Keeps the hosted generator on the build org | The file location is the CLI's documented project config; confirm on your CLI version |
| Model behaviour: do agents follow the playbooks well, how many attempts stages take, token cost per ticket | Quality and cost | Needs real tickets; the learning ledger will show it |
| Red-team run on a real sandbox | Guards are tested against commands we thought of | Planned before 1.0 |
| Zoom and Google Meet connectors | No verified tool names | Use the `file` provider or add your connector's tools to `capabilities.yaml` |
| Windows | Paths and shell analysis were written and tested on Linux and macOS | Untested |

## Known limits by design

See [SAFETY.md](SAFETY.md#limits). In short: guards inspect what an agent asks to run; they are not an operating-system sandbox. The strongest protections are the ones that do not depend on inspection: a production login that is itself read-only (recommended in setup), the engine asking the org whether it is a sandbox before any write, and target orgs being deployed by you.
