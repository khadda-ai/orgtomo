# Contributing

Thank you for looking at Orgtomo. This project handles access to Salesforce orgs, so changes are reviewed with safety first.

## Before you start

- For anything larger than a small fix, open an issue first and describe the problem you want to solve.
- Security problems (a guard that lets something through, a way for an agent to take a human action) are reported privately. See [SECURITY.md](SECURITY.md).

## Setup

```bash
git clone https://github.com/khadda-ai/orgtomo.git
cd orgtomo
npm test          # offline suite, no org and no network needed
npm run check     # cross-references between specs, agents, skills and commands
```

Node.js 20 or newer. There are no dependencies to install.

## Branches and pull requests

- `main` is what users install. `develop` is where work lands. **Pull requests target `develop`.**
- Branch names: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `fix(policy): deny sf commands piped through tee`.
- One logical change per pull request. Keep it reviewable in about fifteen minutes.
- Topic branches are squash-merged into `develop`; releases are merged from `develop` to `main` with a merge commit and tagged `vX.Y.Z`.

## What a good change includes

| Change | Also needed |
|---|---|
| A guard rule | Adversarial cases in `tests/guards.test.mjs`: what must be denied and what must stay allowed |
| A gate | An entry in `spec/gates.yaml`, a passing and a failing case in the tests |
| A stage or contract change | Schema in `spec/schemas/`, the agent template and playbook that produce it, the end-to-end test |
| A new CLI command | `docs/COMMANDS.md`, and the policy guard if it is human-only |
| Behaviour that depends on Claude Code, the Salesforce CLI or another vendor | A source in the pull request description, and a line in `docs/VERIFICATION.md` saying whether it was run for real |

## Ground rules for the code

- No runtime dependencies. If a library is truly needed, discuss it first.
- Guards fail closed. When in doubt, deny and explain how to allow.
- Nothing is hard-coded that a user might need to change: orgs, tools, names, limits and wording of rules live in `spec/` or the workspace configuration.
- No claims in documentation that the tests or a cited source do not back.
- Fixtures use invented data only. No real names, e-mail addresses, org ids or host names.

## Moving the Salesforce skills pin

`sf-skills.lock` and `.claude-plugin/marketplace.json` pin `forcedotcom/sf-skills` to one commit. To move it: read the upstream changelog between the two commits, update the sha in both files and the plugin versions, run `npm test` and `npm run check`, try one ticket in a sandbox, and say in the pull request what changed upstream that matters to Orgtomo.

## License

By contributing you agree that your contribution is licensed under the MIT License of this repository.
