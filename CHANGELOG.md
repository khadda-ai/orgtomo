# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-19

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

[Unreleased]: https://github.com/khadda-ai/orgtomo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/khadda-ai/orgtomo/releases/tag/v0.1.0
