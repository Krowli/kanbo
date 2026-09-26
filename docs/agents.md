# Using kanbo with agents

An agent needs three things to work a kanbo board:

1. **Instructions** — what the board expects of it (take a card, move it, write status lines, hand it back).
2. **A way to reach the board** — the `kanbo` command in its shell, or the `kanbo mcp` server as MCP tools.
3. **To be known as an agent** — so it cannot approve its own work.

You can set these up once for every agent you run, per project, or for one specific agent. The client configuration below was checked against each tool's documentation (links in [Sources](#sources)); if your client version differs, its own docs win.

## Agents and people

kanbo treats a shell as a person's unless it says otherwise:

- **`KANBO_ACTOR_KIND=agent`** marks a shell (and every process started from it) as an agent's. Then `kanbo approve`, `kanbo return`, `kanbo sprint close`, `kanbo columns rules` and `kanbo run clear-session` exit with code `4` without touching the board, column entry rules refuse a card instead of warning, and a Postgres binding's agent connection string is used.
- **`kanbo mcp` is always an agent.** Its client is an agent by definition, whatever the environment says. It has no tool that approves, returns or closes a sprint.
- **`KANBO_ACTOR_ID`** sets the name an agent's writes are filed under (default: the OS user name). Give each agent its own, e.g. `KANBO_ACTOR_ID=reviewer`.
- On a **shared Postgres board**, give agents the `kanban_agent` login (`kanbo init --agent-url …`). Then the database itself refuses an agent that tries to take a card out of waiting or write an approval, whatever client it uses. See [storage](storage.md#roles).

A board file cannot enforce anything beyond kanbo's own commands: an agent that edits the SQLite file directly can write anything. Use MCP or the CLI, and Postgres roles when that matters.

**Approve and return are a person's.** An agent runs `kanbo card wait-approval <card>` and ends its turn. You answer with `kanbo approve <card> [--comment …]` or `kanbo return <card> --comment "why"` in your own terminal, or with the buttons on the `kanbo serve` page.

## 1. Globally, for all your agents

### Instructions

Put the rules in your user-level instructions so every project gets them. Paste the block `kanbo init --instructions …` writes (shown under [per project](#2-per-project)) into:

| Client | User-level instructions |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`) |
| Cursor | Cursor Settings → Rules → User Rules |

A shorter global version, which leaves the per-project details to the project's own block:

```markdown
## Kanbo boards

When a project has a `.kanbo/` directory, its work is tracked on a kanbo board.
- Run `kanbo prime` (or the `kanbo_prime` tool) before starting, and take work from `kanbo ready`.
- Move your card yourself the moment its state changes, and write a status line at every step.
- Put findings, decisions and questions on the card as comments.
- When you need a person, run `kanbo card wait-approval <card>` and end your turn. Never approve your own work.
- `kanbo capabilities` lists every tool, command and rule.
```

### Mark every agent shell as an agent's

| Client | How |
| --- | --- |
| Claude Code | `"env": { "KANBO_ACTOR_KIND": "agent" }` in `~/.claude/settings.json` |
| Codex | `[shell_environment_policy]` with `set = { KANBO_ACTOR_KIND = "agent" }` in `~/.codex/config.toml` |
| Cursor | Rely on the MCP server (always an agent); if Cursor's agent also runs `kanbo` in a terminal, start Cursor from a shell where `KANBO_ACTOR_KIND=agent` is exported |

Do **not** export `KANBO_ACTOR_KIND=agent` in your own shell profile — then you could not approve anything yourself.

### Register the MCP server for every project

`kanbo mcp` resolves the board from the directory the client starts it in, so one global registration serves every project that has run `kanbo init`.

**Claude Code** (stored in `~/.claude.json`):

```bash
claude mcp add --scope user kanbo -- kanbo mcp
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.kanbo]
command = "kanbo"
args = ["mcp"]
```

or `codex mcp add kanbo -- kanbo mcp`.

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kanbo": { "type": "stdio", "command": "kanbo", "args": ["mcp"] }
  }
}
```

In a folder that is not bound to a board, the tools fail with the "No board found" message; run `kanbo init` there first.

## 2. Per project

From the project root:

```bash
kanbo init --file --identifier APP --instructions claude --mcp claude,codex,cursor --yes
```

| Flag | Writes |
| --- | --- |
| `--instructions claude` / `agents` | The instruction block in `CLAUDE.md` / `AGENTS.md`, between `<!-- KANBO_START -->` and `<!-- KANBO_END -->`. Rerunning replaces the block in place. Codex and Cursor read `AGENTS.md`; recent Claude Code reads it too. |
| `--mcp claude` | `.mcp.json` (Claude Code project scope) |
| `--mcp codex` | `.codex/config.toml` (Codex project config — Codex loads it only for a trusted project) |
| `--mcp cursor` | `.cursor/mcp.json` |

Commit these files; none of them holds a secret. The board connection stays in `.kanbo/binding.json`, which is never committed.

The block `kanbo init` writes:

```markdown
<!-- KANBO_START -->
## Kanbo board

Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` — it prints the board's columns and what each one means.

- Take a card from `kanbo ready`.
- Move the card yourself (`kanbo card move <id> <column>`) — a card in the wrong column is a lie.
- Write a status line at every step (`kanbo card status-line <id> --text "..."`).
- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card's id), not separate top-level cards. (`kanbo card create --description "..." --parent <id>`).
- Findings, decisions and questions go on the card (`kanbo card comment <id> --content "..."`).
- When you need a person, run `kanbo card wait-approval <id>` and end your turn. Never approve your own work, and never take a card out of a column where it is waiting for a person.
- Started the work yourself, not launched by an app that tracks the run? Pass your own session to `kanbo run start --session` — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints).
- Run `kanbo capabilities` for the full list of tools, commands and rules.
<!-- KANBO_END -->
```

To mark agent shells per project instead of globally: `"env": { "KANBO_ACTOR_KIND": "agent" }` in the project's `.claude/settings.json` (Claude Code applies project `env` after the folder is trusted), or `[shell_environment_policy] set = { KANBO_ACTOR_KIND = "agent" }` in `.codex/config.toml`.

## 3. One specific agent only

### A Claude Code subagent

`.claude/agents/board-worker.md` (or `~/.claude/agents/` for all projects):

```markdown
---
name: board-worker
description: Works one kanbo card from start to hand-off. Use when a card key (like APP-012) is given.
tools: Read, Grep, Glob, Edit, Write, Bash, mcp__kanbo
model: sonnet
---

You work exactly one card on this project's kanbo board. The card key is in your task.

1. `kanbo_card_get` the card. If it is waiting for a person, stop and say so.
2. `kanbo_run_start` with your name, then `kanbo_card_move` it to in_progress.
3. Write a `kanbo_status_line` before and after every step that takes a while.
4. Put decisions and open questions on the card with `kanbo_card_comment`.
5. Link any pull request with `kanbo_card_link_pr`.
6. When done, `kanbo_card_move` to in_review, `kanbo_wait_approval` with a one-line summary, `kanbo_run_finish` with `finished`, and stop.
Never approve or return a card.
```

`tools` limits the subagent to these tools; `mcp__kanbo` allows every tool of the `kanbo` MCP server. Leave out `Bash` if the agent should reach the board only through MCP.

### A Codex profile

Codex profiles are separate files selected with `--profile`: `~/.codex/board-worker.config.toml` holds top-level keys, e.g.

```toml
model_reasoning_effort = "medium"

[shell_environment_policy]
set = { KANBO_ACTOR_KIND = "agent", KANBO_ACTOR_ID = "board-worker" }
```

and `codex --profile board-worker` starts Codex with it. Put the agent's own instructions in the prompt, or in the project's `AGENTS.md`.

### Any agent, by environment

For a script or any other CLI agent, start it with the variables set:

```bash
KANBO_ACTOR_KIND=agent KANBO_ACTOR_ID=nightly-triage my-agent --task "triage the backlog"
```

Everything it runs through `kanbo` is then filed under `nightly-triage`, and it cannot approve.

## Sources

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code memory (CLAUDE.md, AGENTS.md): https://code.claude.com/docs/en/memory
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code settings (`env`): https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/settings-reference#env
- Codex MCP (`config.toml`, `codex mcp add`): https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex profiles and `shell_environment_policy`: https://learn.chatgpt.com/docs/config-file/config-advanced
- Cursor MCP: https://cursor.com/docs/context/mcp
- Cursor rules and AGENTS.md: https://cursor.com/docs/context/rules
