# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-21

Fixes from the first day of real use, a way to study how a business uses its org, and four new playbooks.

### Added

- **Blocked status.** A broken tool, login or org stops the ticket with the reason (`orgtomo block`, or the engine after the same command fails twice). It is not counted as an attempt or a mistake, and the human resumes it.
- **Business discovery** (`orgtomo discover`, `/orgtomo:discover`). The engine sorts every object into one area and writes a page per area from metadata and record totals; the Cartographer writes one process note per area, checked statement by statement; questions only a person can answer are collected and answered by the human.
- **Hub page per object** in the Org Brain, `orgtomo brain object`, `orgtomo brain tests` and `orgtomo brain sync` (retrieve and build in one step).
- **Org Brain browser** in the control panel: search, component view, object view, and a Business view.
- **Understanding page** for each ticket, written by the engine from the Analyst's contract and shown in the control panel.
- **Sign-in for the agent browser** through a single-use link made by the Salesforce CLI, plus a mode that attaches to a browser you already run. `orgtomo browser status|login`.
- **Model catalogue** (`spec/models.json`, `orgtomo models catalogue|refresh`): the control panel shows which version an alias stands for and which effort levels a model offers.
- **Obsidian helper** (`orgtomo obsidian status|install`) and an optional question in setup.
- **Playbooks** `orgtomo-intake`, `orgtomo-self-review`, `orgtomo-ship`, `orgtomo-discover`, and an `org-standards` skill generated from `conventions.yaml`.
- **Gates** `intake-check` (understand) and `self-review` (plan), and review rubric point R12.
- `orgtomo contract show <name>`; `--file -` reads a contract or a ticket from standard input.
- Deploy packs now include `AFTER-DEPLOY.md` and, when the plan changes data, `DATA-CHANGES.md`.
- Generic reader for process, access and app metadata (approval processes, assignment and escalation rules, paths, roles, permission set groups, installed packages and more).
- `doctor --orgs` runs one real retrieve from the build org, reports the scope each plugin is installed in, and notices telemetry switched on outside the workspace.

### Changed

- Retrieves are staged inside the Salesforce project and copied out, so backups, the Lead's verification and the parity check work with the real CLI's rule that the output folder must be inside the project.
- The ticket is imported through a quoted here-document, so quotes and backticks in a ticket stay plain text.
- The data guard compares against the backed-up copy: text a component already contained is allowed, new addresses are not. It also recognises malformed addresses, and masking keeps the shape of an address.
- Shell commands that write a file follow the same ownership rules as the Write and Edit tools. The body of a quoted here-document is treated as data.
- The context pack looks up API names from the whole ticket first, weights other words by how rare they are, says why each component matched, and is rebuilt after the Analyst names the affected components.
- "The org says it is a sandbox" is tied to the org id and trusted for a limited time; an alias that answers as another org stops writes until a human confirms.
- The evidence gate asks for a control next to a query that returned no rows, and claims carry a basis (measured, carried or inferred).
- A missing, invalid or failed baseline is told apart, and a plan that touches components with known tests must name its regression tests.
- A parity check warns when the newest version of a flow in the target org is not the active one.
- Tooling API results are masked like other reads.
- "Reviewer differs from Builder" compares the models behind the names.
- The browser fence also covers Claude in Chrome; the Playwright browser is started with production origins blocked and with a profile inside the workspace.
- Setup recommends installing the plugins for the workspace only (`--scope project`) and ends with the next commands to run.
- A failing command prints one line of JSON; a stack trace needs `ORGTOMO_DEBUG=1`.
- Reading a missing or broken JSON file reports which file, instead of failing with an internal error.

### Fixed

- Three findings of the code scanner: the documentation check now strips script blocks whose end tag carries spaces or attributes; a backslash in a fact value is escaped in the fact table; a ticket key in a meeting link is matched as text, never as a pattern.

### Removed

- `max_turns.lite` in `agents.yaml`; `max_turns.default` applies to both paths.

### Upgrade notes

- `orgtomo models` now prints `{ agents, catalogue }` instead of the agents alone.
- The understanding contract needs an `intake` block and the plan contract a `self_review` block; `orgtomo contract show understanding` lists every field.
- Run `orgtomo sync` after updating. Workspace configuration is not overwritten; new settings take their default.

## [0.1.0] - 2026-11-20

First version.

### Added

- Engine that interprets the stage machine (`spec/stages.yaml`): open, understand, repro, plan, build, test, review, handoff, close.
- Twenty-three gates of seven types, including contract validation, the evidence gate, reproduction proof, plan grounding against the org map, convention lints, deploy check, the test referee and the review rubric.
- Evidence ledger written only by the engine; claims must cite it.
- Lead verification step after gated stages, with mismatch handling.
- Loop control: failing test or review returns to plan, configurable limit with a hard cap of three, then a written stop report.
- Guards as Claude Code hooks: shell policy, write guard, data guard, MCP guard with browser fence, stage gate on agent spawns, and recording of human-only actions.
- Org access layer: masked bounded reads, backup-enforced deploys to the build org, restore from backup, anonymous Apex and tests with data and e-mail checks, a live sandbox check before any write.
- Org Brain: generated fact notes, dependency links, automation-per-object notes, JSON Canvas maps, Obsidian Base views, staleness and drift.
- Deploy packs for Blue Canvas, change sets, Git with the CLI, and a generic checklist; read-only parity check after the human deploy.
- Self-learning from recorded observations, with lessons that cite them and recurrence tracking.
- Optional features: lite path, meeting notes, people profiles.
- Twelve agent templates, sixteen playbook skills, twenty-four slash commands.
- Local control panel (`orgtomo ui`), doctor and setup wizard.
- Offline test suite with a stand-in Salesforce CLI, a complete ticket and adversarial guard cases.

[Unreleased]: https://github.com/khadda-ai/orgtomo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/khadda-ai/orgtomo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/khadda-ai/orgtomo/releases/tag/v0.1.0
