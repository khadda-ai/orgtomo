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

To install one fixed version, name its branch: `npm install -g github:khadda-ai/orgtomo#release/v0.2.0`. Every released version keeps a branch of that form.

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
- **Allowed test e-mail addresses and phone numbers.** Globs work: `you+*@example.com`. Use addresses and numbers made for testing; anything on this list may appear in test records.
- **Meeting notes** and **people profiles**: both off unless you want them.
- **Business discovery** (optional): which org Orgtomo should study to learn how the business works. See step 7.
- **Obsidian** (optional): whether to install it. See step 8.

Everything can be changed later in `orgtomo.config/` or in the control panel. Setup ends by printing the next commands to run.

## 4. Check

```bash
orgtomo doctor --orgs
```

`--orgs` does three things a plain `doctor` does not:

- It contacts every org and asks it whether it is a sandbox. An org that answers "not a sandbox" while configured as `build` or `test` is an error: Orgtomo will not write to it. A login that has expired is reported with the command to renew it.
- It runs **one real retrieve from the build org**, the same way a backup does. Backups, the Lead's verification and the parity check all depend on it, so it is better to find a problem here than in the middle of a ticket. (This needs metadata in the build org's source folder; run it again after step 6.)
- It notices when an alias now points to a different org than the last time (a refreshed sandbox, or another login under the same alias). Nothing is written to that org until you confirm: `orgtomo human org-changed <org>`.

`doctor` also says where the plugins are installed, whether telemetry is on outside the workspace, and how the agent browser signs in.

## 5. E-mail safety

Default mode is `blocked`: agents write test data only while the sandbox cannot send e-mail. In each sandbox agents will write to, set **Setup > Email > Deliverability > Access level** to *No access* or *System email only*. Then:

```bash
orgtomo org canary dev
```

If the probe answers `unknown` in your org, state what Setup shows: `orgtomo human canary dev blocked`.

Prefer `allowlist_only` if your sandbox must send mail: then only your allowed addresses may ever appear in data, and that is enforced on every write path.

The data guard reads text. It cannot see an address that a script puts together at run time. A sandbox that cannot send mail is the protection that does not depend on reading text, which is why `blocked` is the default.

## 6. Build the Org Brain

```bash
orgtomo brain sync uat
orgtomo brain sync dev
```

`sync` retrieves the metadata and rebuilds the notes in one step. The metadata types retrieved are listed in `pipeline.yaml` under `brain`. Standard objects are not covered by a wildcard; list the ones you customised under `brain.standard_objects`.

Browse the result in the control panel (`orgtomo ui`, **Org Brain**): search for a name, click a component to see what it uses and what uses it, click an object to see everything on it. Or open the vault in Obsidian (step 8).

## 7. Business discovery (optional)

```bash
orgtomo discover run uat --retrieve
```

Orgtomo studies one org end to end, in three parts:

| Part | Done by | Result in `vault/orgs/<org>/business/` |
|---|---|---|
| What exists | the engine, from metadata and record totals | `Overview.md`, one page per area in `domains/` |
| How it works | the Cartographer, one area per run | `processes/<area>.md`, every statement linked to a fact or marked as inferred or open |
| What only you know | you | `Questions.md` |

It retrieves more metadata than the Brain needs for tickets (approval processes, assignment and escalation rules, paths, queues, roles, apps, layouts, installed packages; the list is `pipeline.yaml` > `discover.types`), and reads how many records each object holds. It never reads record values.

Then, in Claude Code:

```
/orgtomo:discover uat                          has the next process note written
/orgtomo:discover answer uat Q3 <your answer>  answers one of its questions
```

You can also answer in the control panel under **Business**. Metadata shows what the system does, not why the business wants it; the questions are where that part comes from. Run discovery for the org closest to production that is safe to read.

## 8. Obsidian (optional)

The vault is plain Markdown. Obsidian is a free app that shows it well:

- a graph of which component is connected to which
- for every object, a map of what runs when a record is saved
- sortable, filterable tables of components and tickets
- click-through from a field to every flow, class and rule that uses it
- search across the vault, and a place for your own notes

It adds no assistant of its own, and nothing in Orgtomo depends on it.

```bash
orgtomo obsidian status     # is it installed, has this vault been opened
orgtomo obsidian install    # installs it with Homebrew when Homebrew is there; otherwise says where to download it
```

One step is always by hand: open Obsidian, choose **Open folder as vault**, and pick the `vault/` folder. Start at `Home.md`. For a coloured graph, open Graph view and add groups by path, for example `path:orgs/uat/facts/Flow`. A large org has thousands of notes, and the full graph becomes slow; the per-object maps and the hub page of each object (`orgs/<org>/objects/`) are the better way in.

## 9. Install the plugins in Claude Code

Install them **for this workspace only**. Run these in the workspace folder:

```bash
claude plugin marketplace add khadda-ai/orgtomo
claude plugin install orgtomo@orgtomo --scope project
claude plugin install salesforce-development@orgtomo --scope project
claude plugin install salesforce-code-quality@orgtomo --scope project
```

`--scope project` matters. Without it the plugins are installed for your whole user account, and then their skills and hooks load in every folder you open: the Salesforce plugin, for example, would steer `sf` commands in projects that have nothing to do with Orgtomo. If you installed them that way before, remove the user-wide copies (`claude plugin uninstall <name>@orgtomo --scope user`) and install them again as above. `orgtomo doctor` tells you which scope each plugin has.

The two Salesforce plugins come from `forcedotcom/sf-skills`, pinned to the commit in `sf-skills.lock`.

Connect your tracker (`/mcp`, authenticate `atlassian`).

For the Salesforce Flow generator, set the project default org to your build org once. Run it **in the build org's source folder**, which is the folder that holds `sfdx-project.json`; in the workspace root the command fails because there is no project there:

```bash
cd source/dev && sf config set target-org <build alias>
```

## 10. The agent browser

Browser steps need a `host:` for the sandbox in `orgs.yaml`. There are three ways for the browser to be signed in. Use the first that works for you; the setting is `browser` in `safety.yaml`.

| Way | Setting | What happens |
|---|---|---|
| One-time link (default) | `provider: playwright`, `login: frontdoor` | When an agent opens a sandbox page, the engine opens it through a single-use link that the Salesforce CLI makes from its own login. No password, no passkey, no code. The link is valid for about a minute and the agent never asks for it. |
| Your own running browser | `provider: playwright-extension` | The browser tools attach to a Chrome or Edge you already run and are signed in to. Needs the Playwright browser extension. Use a separate browser profile for this. |
| You sign in | `login: manual` | A browser window shows the login page; you sign in yourself. The session ends when the browser closes, so expect to do it again. |

Claude in Chrome (`browser.claude_in_chrome: true`) is a fourth option for the Reproducer and the Tester. It uses your own Chrome and is fenced to the same sandboxes.

Signing in once and staying signed in for good is not possible: Salesforce ends a session when the browser closes or after the org's timeout. That is why the default renews the sign-in by itself.

**Try the one-time link once per sandbox before you rely on it.** Salesforce documents that the link signs the browser in without asking for credentials again. Whether your org's own login policies add a step on top is something only your org can show. If an agent still lands on a login page, it blocks the ticket with that reason instead of skipping the browser steps.

If Salesforce asks to verify a new browser the first time, do that once in the agent browser window; the profile in `.orgtomo/browser-profile` remembers it.

Production is never opened: the navigation guard refuses it, and the browser itself is started with the production origins blocked.

## 11. First session

```bash
orgtomo start
```

```
/orgtomo:ping          confirms that hooks are active in this folder
/orgtomo:doctor
/orgtomo:ticket ABC-123
```

`orgtomo ui` opens the control panel at any time. It shows what is waiting for you, lets you change models, switches and safety settings, and holds the Org Brain browser, the understanding page of each ticket and the business questions.

## Updating

```bash
npm install -g github:khadda-ai/orgtomo
orgtomo sync
```

and `claude plugin marketplace update orgtomo` in the workspace. Your workspace configuration is never overwritten. New settings take their default until you change them.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A ticket shows **blocked** | A tool, a login or an org failed in a way no agent can fix. The reason is on the ticket. Fix it, then `/orgtomo:resume <KEY> <what you fixed>`. |
| `/orgtomo:approve` does nothing | Plugin not enabled in this folder. Run `/orgtomo:ping`, then `/orgtomo:doctor`. Terminal fallback: `orgtomo human approve <KEY>`. |
| "now answers as org ..." | The alias points to another org than before. If you refreshed the sandbox or logged in again on purpose: `orgtomo human org-changed <org>`. |
| "Sandbox reads are masked. Use: orgtomo org query" | Working as designed. Raw `sf data query` is closed while `mask_sandbox_reads` is on. |
| "E-mail safety: no canary result" | Run `orgtomo org canary <org>`. |
| "Data guard" on a deploy of a file you did not put an address in | The address is new compared with the backup. Text that was already in the component is allowed; a new address is not. |
| "is not granted to ..." for an MCP tool | The tool name is not listed under a capability. Check the real name with `/mcp` and add it in `capabilities.yaml`. |
| Browser refuses a sandbox URL | `host:` missing or different in `orgs.yaml`. |
| The agent lands on a login page | See step 10. `orgtomo browser status` shows how sign-in is set up. |
| An agent cannot be spawned | It is not its turn. `orgtomo next <KEY>` says whose turn it is. |
| Orgtomo skills show up in other projects | The plugins are installed user-wide. See step 9. |
