# Command reference

Orgtomo has two kinds of commands.

- **Slash commands** (`/orgtomo:...`) are typed by the human inside Claude Code.
- **Engine commands** (`orgtomo ...`) are run by agents through Bash, or by the human in a terminal. They print JSON.

Some actions are **human only**: approve, reject, hold, resume, answer, deployed, feedback, rule, and every change to configuration. The engine records them from the slash command, the UI, or `orgtomo human ...` in a real terminal. An agent that tries them is refused.

## Slash commands

| Command | Purpose |
|---|---|
| `/orgtomo:ticket <KEY>` | Start or continue a ticket |
| `/orgtomo:status [KEY]` | Where tickets stand and what waits for you |
| `/orgtomo:approve [KEY] [note]` | Approve the stage that waits (human) |
| `/orgtomo:reject [KEY] <reason>` | Reject it with a reason (human) |
| `/orgtomo:answer [KEY] [Q1\|repro] <text>` | Answer a blocking question (human) |
| `/orgtomo:deployed <org> [KEY]` | You finished a deploy to that org (human) |
| `/orgtomo:hold <KEY>` / `/orgtomo:resume [KEY] [direction]` | Park, continue, or redirect after a stop (human) |
| `/orgtomo:feedback [KEY] good\|bad <agent> <text>` | Record feedback as learning evidence (human) |
| `/orgtomo:rule <agent> <rule>` | State a rule; it becomes a lesson at once (human) |
| `/orgtomo:lessons [approve\|retire <L-id>]` | Lessons and recurring patterns |
| `/orgtomo:models [<agent> <model> [effort]]` | Model and effort per agent |
| `/orgtomo:features <name> on\|off` | Feature and support-agent switches (human) |
| `/orgtomo:autonomy low\|medium\|high` | How often the team stops for approval (human) |
| `/orgtomo:brain [status\|build\|sync\|drift\|search]` | Org Brain |
| `/orgtomo:meetings [sync\|confirm <M-id>\|reject <M-id>]` | Meeting notes and ticket links |
| `/orgtomo:people [set ...\|confirm <P-id>\|remove <Name>]` | Reader profiles |
| `/orgtomo:restore <KEY>` | Put the ticket's backed-up versions back into the build org (human) |
| `/orgtomo:canary <org> blocked\|enabled` | State a sandbox's e-mail deliverability (human) |
| `/orgtomo:doctor [--orgs]`, `/orgtomo:sync`, `/orgtomo:ping`, `/orgtomo:setup`, `/orgtomo:help` | Health, regenerate, hook check, setup help |

## Terminal (human)

| Command | Purpose |
|---|---|
| `orgtomo setup [folder]` | Create a workspace (asks questions; `--yes` takes defaults) |
| `orgtomo start` | Open Claude Code with the Lead (`claude --agent tomo-lead`) |
| `orgtomo ui [--port 4310]` | Local control panel |
| `orgtomo doctor [--orgs]` | Health check |
| `orgtomo human approve\|reject\|hold\|resume\|answer\|deployed\|feedback\|restore\|canary\|lesson\|model ...` | Human actions without Claude Code |

## Engine commands (agents)

### Tickets

| Command | Purpose |
|---|---|
| `orgtomo ticket open <KEY> [--lite]` | Create the ticket |
| `orgtomo ticket import <KEY> --json '<ticket>'` | Store the tracker content (redacted) |
| `orgtomo next <KEY>` | What happens now, and who does it |
| `orgtomo submit <KEY> <stage>` | Run the stage's gates on your output |
| `orgtomo verify <KEY> <stage> --claim C1 --evidence E012 --result match\|mismatch [--note ...]` | The Lead's re-check |
| `orgtomo status [KEY]` | Summary |
| `orgtomo baseline check <KEY>` | Validate `00-baseline.json` |

### Orgs

| Command | Purpose |
|---|---|
| `orgtomo org info <org>` | Sanitised facts; asks the org whether it is a sandbox |
| `orgtomo org query <org> "<SELECT ... LIMIT n>" [--ticket KEY] [--tooling]` | Read-only, masked, recorded |
| `orgtomo org retrieve <org> "<Type:Name>" ... [--ticket KEY]` | Read metadata |
| `orgtomo org backup <KEY> "<Type:Name>" ...` | Back up build-org components before a change |
| `orgtomo org deploy <KEY> <paths...> [--check] [--test <Class>]` | Deploy to the build org (Builder, build stage, backup required) |
| `orgtomo org apex-run <org> --file <f> [--ticket KEY]` | Anonymous Apex after data guard and e-mail gate |
| `orgtomo org test <org> --class <C> [--test <C.m>] [--ticket KEY]` | Run named Apex tests |
| `orgtomo org canary <org>` | Can this sandbox send e-mail right now |

### Evidence

| Command | Purpose |
|---|---|
| `orgtomo evidence list <KEY>` / `show <KEY> <E#>` | The ledger |
| `orgtomo evidence brain <KEY> <Type:Name> [--org <org>]` | Cite a fresh Brain fact |
| `orgtomo evidence doc <KEY> --url <official url> --quote "<text>"` | Cite official documentation |
| `orgtomo evidence file <KEY> --path <file> [--kind browser\|analyzer] [--note ...]` | Record a capture or report |

### Org Brain

`orgtomo brain retrieve <org>`, `build <org>`, `status [org]`, `search <org> <words>`, `fact <org> <Type:Name>`, `drift <base> <other>`, `pack <KEY> [words]`.

### Handoff

`orgtomo handoff pack <KEY>` builds the deploy pack for the next target. `orgtomo handoff parity <KEY>` compares the target with the build after the human confirmed the deploy.

### Learning, people, meetings

`orgtomo learn list | patterns | observations [KEY] | propose <KEY>`  
`orgtomo people list | show <Name> | brief <Name> ... | propose --person <Name> --note <text> --basis <where>`  
`orgtomo meetings plan | list | pending | ingest --file <contract.json>`

### Other

`orgtomo sync`, `orgtomo config show`, `orgtomo models`, `orgtomo version`.
