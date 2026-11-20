# Configuration

All configuration is YAML in `orgtomo.config/` in your workspace. Defaults ship in `spec/defaults/`; your files override them key by key (lists are replaced whole). `orgs.yaml` is yours alone and has no defaults merged in.

Three ways to change a value: edit the file, use the control panel (`orgtomo ui`), or a slash command. The engine validates every change before saving and keeps your comments. After a change that affects agents, `orgtomo sync` regenerates their files; the UI and slash commands do this for you.

Agents cannot write configuration.

## orgs.yaml

```yaml
company: "Acme"
orgs:
  dev:  { alias: acme-dev,  role: build,      host: "acme--dev.sandbox.my.salesforce.com", data_write: true }
  uat:  { alias: acme-uat,  role: test,       host: "acme--uat.sandbox.my.salesforce.com", data_write: true }
  prod: { alias: acme-prod, role: production }
```

| Key | Meaning |
|---|---|
| `alias` | Salesforce CLI alias |
| `role` | `build` (one org), `test`, `reference`, `production` |
| `host` | My Domain host; needed only for browser steps. Lightning, Setup and site domains are derived from it. |
| `data_write` | Whether agents may create test data there. Ignored for production. |

Two orgs, three or more: add as many entries as you have. Exactly one has role `build`.

## pipeline.yaml

| Key | Default | Meaning |
|---|---|---|
| `build_org` | `dev` | Where agents build |
| `brain_base` | `uat` | The org the Org Brain is built from |
| `drift_check` | `[prod]` | Orgs compared read-only against the base |
| `targets` | uat, prod | Ordered list of `{ org, tool, retest }`. Tools: `blue-canvas`, `change-set`, `git-cli`, `generic` |
| `loop.max` | 2 | Failed test or review rounds before the team stops. Values above 3 are treated as 3. |
| `attempts.max` | 2 | Times one agent may redo a stage whose gates fail |
| `autonomy` | `medium` | `low`: approve every stage. `medium`: plan and review. `high`: review only. Review approval cannot be removed. |
| `lite` | on | `max_components`, `allowed_types` for the lite path |
| `brain.types`, `brain.standard_objects` | see file | What `orgtomo brain retrieve` pulls |
| `api_version` | empty | Used for deploy packs when `sfdx-project.json` has no `sourceApiVersion` |
| `keep_going` | true | The Lead does not stop between stages until a human gate |

## safety.yaml

| Key | Default | Meaning |
|---|---|---|
| `email_mode` | `blocked` | `blocked` or `allowlist_only` |
| `allowed_emails` | example address | Globs allowed. An allow-all pattern is rejected. |
| `allowed_email_domains`, `allowed_phones` | | |
| `test_person` | Test Orgtomo | Name and company agents use for test records |
| `canary_max_age_minutes` | 30 | How long a canary result is trusted |
| `mask.field_patterns`, `mask.keep_fields` | see file | Masking by field name |
| `mask.mask_sandbox_reads` | true | Mask sandbox query results too |
| `browser.provider` | `playwright` | or `none` |
| `browser.claude_in_chrome` | false | Opt-in |
| `browser.deny_path_patterns` | see file | Pages agents never open |
| `protected_paths` | see file | Never writable by agents |
| `official_doc_hosts` | Salesforce documentation sites | Accepted documentation sources. Add a practitioner site you trust here if you want it accepted. |
| `sf_allow_extra` | none | Extra Salesforce CLI commands to allow for sandboxes, as patterns, for example `sf lightning dev *`. Never applies to production. |

## agents.yaml

See [AGENTS.md](AGENTS.md#models-and-effort). Also `max_turns.default`.

## features.yaml

| Key | Default | Meaning |
|---|---|---|
| `lite_path` | true | |
| `self_learning.enabled` | true | |
| `self_learning.auto_apply_min_observations` | 2 | |
| `meetings.enabled` / `provider` / `store_transcripts` / `lookback_days` | off / granola / false / 2 | |
| `people_profiles.enabled` | false | |
| `sf_skills.flow_generator` | true | Salesforce-hosted Flow generation, build org only |
| `sf_skills.telemetry` | false | The Salesforce plugin's telemetry |
| `sf_skills.skills_first` | `enforce` | The Salesforce plugin's own setting |
| `tracker.provider` | `atlassian` | or `none` |

## conventions.yaml

Your org's style. Agents load it as skills; lint gates enforce it on new components and on changed lines.

```yaml
naming:
  apex_class:  "^[A-Z][A-Za-z0-9]+(Service|Selector|Handler|Batch|Util|Controller)$"
  apex_test:   "^[A-Z][A-Za-z0-9]+Test$"
  flow:        "^[A-Za-z0-9]+_(BeforeSave|AfterSave|Screen|Scheduled|Autolaunched)_[A-Za-z0-9_]+$"
  flow_element: { decisions: "^Is_|^Has_", recordLookups: "^Get_", recordUpdates: "^Update_" }
comments:
  class_header_required: true
  class_header_tags: ["@description"]
  change_line: "// {date} | {ticket} | {author} | {what}"
  change_line_required: true
  flow_description_required: true
format:
  indent: 4
  indent_style: space
  max_line: 120
  sharing_default: "with sharing"
forbidden:
  - { id: hard-coded-id, pattern: "...", files: "*.cls,*.trigger", why: "..." }
```

- Naming rules are regular expressions. An empty value means no rule.
- `change_line` placeholders: `{date}` (YYYY-MM-DD), `{ticket}`, `{author}`, `{what}`.
- Existing components are never renamed to fit a rule; lints look at new names and changed lines.
- `forbidden` entries: `pattern` (regular expression), `files` and optional `except` (globs on the file name), `why`.

## capabilities.yaml

```yaml
mcp_servers:
  linear: { type: http, url: "https://example.invalid/mcp" }      # your own server
capabilities:
  tracker.read:
    provider: linear
    tools: [mcp__linear__get_issue, mcp__linear__list_comments]   # exact names from /mcp
grants:
  lead: { tools: [Read, Grep, Glob, Bash], capabilities: [tracker.read] }
sf_skills:
  builder: [platform-apex-generate, platform-apex-test-generate]
```

- A tool that no capability lists is denied to every agent.
- `never` lists tools that are not granted even if a wildcard would include them.
- List only read tools under `tracker.read`. Orgtomo never posts.
- Tool names differ between connectors and versions. `/mcp` in Claude Code shows the real ones.

## Stage machine and rubric

Copy `spec/stages.yaml` or `spec/review-rubric.yaml` into `orgtomo.config/` to override them for one workspace. Gate implementations stay in the engine.
