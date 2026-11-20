# Setup

About twenty minutes for a first workspace, most of it waiting for the metadata retrieve.

## 1. Prerequisites

| Need | Check |
|---|---|
| Node.js 20+ | `node --version` |
| Salesforce CLI | `sf --version` |
| Each org logged in under an alias | `sf org list` |
| Claude Code | `claude --version` |

Log in to each org yourself (`sf org login web --alias my-dev --instance-url https://test.salesforce.com` for sandboxes). Agents cannot log in, log out or see tokens.

**For production, log in with a user that can only read** (a profile or permission set without create, edit, delete or Modify All). Orgtomo never writes to production, and its guards block agents from trying; a read-only login makes that true even if a guard were ever bypassed.

## 2. Install the engine

```bash
npm install -g github:khadda-ai/orgtomo
orgtomo version
```

This puts `orgtomo` on your PATH for terminal use. Inside Claude Code the plugin provides the same command to agents.

## 3. Create a workspace

A workspace is one folder per company or client. It holds configuration, the vault and the source mirrors of your orgs. Keep it out of any shared repository; it contains org metadata.

```bash
mkdir my-company && cd my-company
orgtomo setup
```

The wizard asks for:

- **Orgs**: a short name, the CLI alias, and a role.
  - `build`: your dev sandbox. Agents deploy and create test data here.
  - `test`: UAT or QA. You deploy; agents retest.
  - `production`: read-only and masked, always.
  - `reference`: any other org, read-only.
- **My Domain host** of each sandbox, if you want browser steps (for example `acme--dev.sandbox.my.salesforce.com`).
- **How you deploy** to each non-build org: `blue-canvas`, `change-set`, `git-cli` or `generic`.
- **Allowed test e-mail addresses and phone numbers.** Globs work: `you+*@example.com`.
- **Meeting notes** and **people profiles**: both off unless you want them.

Everything can be changed later in `orgtomo.config/` or in the control panel.

## 4. Check

```bash
orgtomo doctor --orgs
```

`--orgs` contacts every org and asks it whether it is a sandbox. An org that answers "not a sandbox" while configured as `build` or `test` is an error: Orgtomo will not write to it.

## 5. E-mail safety

Default mode is `blocked`: agents write test data only while the sandbox cannot send e-mail. In each sandbox agents will write to, set **Setup > Email > Deliverability > Access level** to *No access* or *System email only*. Then:

```bash
orgtomo org canary dev
```

If the probe answers `unknown` in your org, state what Setup shows: `orgtomo human canary dev blocked`.

Prefer `allowlist_only` if your sandbox must send mail: then only your allowed addresses may ever appear in data, and that is enforced on every write path.

## 6. Build the Org Brain

```bash
orgtomo brain retrieve uat
orgtomo brain build uat
orgtomo brain retrieve dev && orgtomo brain build dev
```

The metadata types retrieved are listed in `pipeline.yaml` under `brain`. Standard objects are not covered by a wildcard; list the ones you customised under `brain.standard_objects`.

Open the `vault/` folder as a vault in Obsidian to browse the result. Start at `Home.md`.

## 7. Install the plugins in Claude Code

Start Claude Code in the workspace folder and run:

```
/plugin marketplace add khadda-ai/orgtomo
/plugin install orgtomo@orgtomo
/plugin install salesforce-development@orgtomo
/plugin install salesforce-code-quality@orgtomo
```

The two Salesforce plugins come from `forcedotcom/sf-skills`, pinned to the commit in `sf-skills.lock`.

Connect your tracker (`/mcp`, authenticate `atlassian`) and, if you use browser steps, let the Playwright server start once. The first time an agent opens a sandbox page, a browser window shows the login screen: sign in yourself. The session stays in a profile folder inside the workspace.

For the Salesforce Flow generator, set the project default org to your build org once: `sf config set target-org <build alias>` in the workspace folder. The guard refuses the generator otherwise.

## 8. First session

```bash
orgtomo start
```

```
/orgtomo:ping          confirms that hooks are active in this folder
/orgtomo:doctor
/orgtomo:ticket ABC-123
```

`orgtomo ui` opens the control panel at any time. It shows what is waiting for you and lets you change models, switches and safety settings.

## Updating

```bash
npm install -g github:khadda-ai/orgtomo
orgtomo sync
```

and `/plugin marketplace update orgtomo` in Claude Code. Your workspace configuration is never overwritten.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/orgtomo:approve` does nothing | Plugin not enabled in this folder. Run `/orgtomo:ping`, then `/orgtomo:doctor`. Terminal fallback: `orgtomo human approve <KEY>`. |
| "Sandbox reads are masked. Use: orgtomo org query" | Working as designed. Raw `sf data query` is closed while `mask_sandbox_reads` is on. |
| "E-mail safety: no canary result" | Run `orgtomo org canary <org>`. |
| "is not granted to ..." for an MCP tool | The tool name is not listed under a capability. Check the real name with `/mcp` and add it in `capabilities.yaml`. |
| Browser refuses a sandbox URL | `host:` missing or different in `orgs.yaml`. |
| An agent cannot be spawned | It is not its turn. `orgtomo next <KEY>` says whose turn it is. |
