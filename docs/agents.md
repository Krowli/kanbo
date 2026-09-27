# Using kanbo with agents

An agent needs three things to work a kanbo board:

1. **Instructions** — what the board expects of it (take a card, move it, write status lines, hand it back).
2. **A way to reach the board** — the `kanbo` command in its shell, or the `kanbo mcp` server as MCP tools.
3. **To be known as an agent** — so it cannot approve its own work.

An agent that only has the `kanbo mcp` server connected already gets the first one: the server sends the basic rules as its MCP [server instructions](mcp.md#server-instructions) when the client connects. An instruction file is still worth writing for anything beyond the basics — your orchestrator's policy, which agent takes which column, when to hand a card over — and for agents that reach the board through the `kanbo` command instead.

You can set these up once for every agent you run, per project, or for one specific agent. The client configuration below was checked against each tool's documentation (links in [Sources](#sources)); if your client version differs, its own docs win.

## Agents and people

kanbo treats a shell as a person's unless it says otherwise:

- **Claude Code, Gemini CLI and Cursor's agent terminals are recognised on their own** by the marks those tools document (`CLAUDECODE=1`, `GEMINI_CLI=1`, `CURSOR_AGENT`); Codex's are not. `KANBO_ACTOR_KIND=person` overrides a mark in your own terminal. See [configuration](configuration.md#agent-shells-kanbo-recognises).
- **`KANBO_ACTOR_KIND=agent`** marks a shell (and every process started from it) as an agent's. Then `kanbo approve`, `kanbo return`, `kanbo sprint close`, `kanbo columns rules` and `kanbo run clear-session` exit with code `4` without touching the board, column entry rules refuse a card instead of warning, and a Postgres binding's agent connection string is used.
- **`kanbo mcp` is always an agent.** Its client is an agent by definition, whatever the environment says. It has no tool that approves, returns or closes a sprint.
- **`KANBO_ACTOR_ID`** sets the name an agent's writes are filed under (default: the OS user name). Give each agent its own, e.g. `KANBO_ACTOR_ID=reviewer`.
- On a **shared Postgres board**, give agents the `kanban_agent` login (`kanbo init --agent-url …`). Then the database itself refuses an agent that tries to take a card out of waiting or write an approval, whatever client it uses. See [storage](storage.md#roles).

A board file cannot enforce anything beyond kanbo's own commands: an agent that edits the SQLite file directly can write anything. Use MCP or the CLI, and Postgres roles when that matters.

**Approve and return are a person's.** An agent runs `kanbo card wait-approval <card>` and ends its turn. You answer with `kanbo approve <card> [--comment …]` or `kanbo return <card> --comment "why"` in your own terminal, or with the buttons on the `kanbo serve` page.

## Connecting agents: `kanbo connect`

`kanbo connect` does the setup for you, one agent or several at a time — `claude`, `codex`, `cursor`, `gemini`, or `all`:

```bash
kanbo connect                        # in a terminal: pick agents, untick files, confirm
kanbo connect claude --yes           # CLAUDE.md + .mcp.json in this project
kanbo connect codex cursor --yes     # AGENTS.md (shared) + each one's MCP server
kanbo connect all --global --yes     # your own files, for every project
kanbo connect --check                # agent | instructions | MCP | scope
kanbo connect cursor --remove        # take kanbo out of Cursor's files again
kanbo connect claude --dry-run       # show what would change, change nothing
```

Every change is shown first and written only after you say yes (or pass `--yes`). Each agent gets two things, which `--no-instructions` and `--no-mcp` leave out:

| Agent | Instructions: project · `--global` | MCP server: project · `--global` | MCP by default |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` · `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude/CLAUDE.md`) | `.mcp.json` · `claude mcp add --scope user kanbo -- kanbo mcp` (stored in `~/.claude.json`; printed for you to run when `claude` is not on `PATH`) | project |
| Codex | `AGENTS.md` · `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) | `.codex/config.toml` · `[mcp_servers.kanbo]` in `$CODEX_HOME/config.toml` | your own: Codex loads a project's `.codex/config.toml` only for a trusted project |
| Cursor | `AGENTS.md` · Cursor Settings → Rules → User Rules (not a file; paste the block yourself) | `.cursor/mcp.json` · `~/.cursor/mcp.json` | project |
| Gemini CLI | `GEMINI.md` · `$GEMINI_CLI_HOME/.gemini/GEMINI.md` (default `~/.gemini/GEMINI.md`) | `.gemini/settings.json` · `~/.gemini/settings.json` (entries without `type`) | project |

Instructions go into the project unless you pass `--global`; the MCP server goes where the last column says unless you pass `--project` or `--global`. Commit the project files; none of them holds a secret. The board connection stays in `.kanbo/binding.json`, which is never committed.

Codex and Cursor share a project's `AGENTS.md`: `kanbo connect cursor --remove` leaves its kanbo section in place unless Codex is removed in the same command (`kanbo connect codex cursor --remove`, or `kanbo connect --remove` for every agent), and says so.

**Windows.** `kanbo` there is npm's `kanbo.cmd`, which clients that start programs without a shell (Codex) cannot run. So on Windows every agent's MCP server goes into your own configuration by default, naming the Node that runs kanbo and kanbo's own script — `node.exe C:\…\kanbo-cli\dist\cli.cjs mcp` — which every client can start. A project file (`--project`) is shared with other machines and keeps the portable `kanbo mcp`; `kanbo connect` says so when it writes one on Windows. When a Node upgrade or a reinstall leaves such a registration pointing at a file that is gone, `kanbo doctor` fails it and `kanbo connect <agent>` rewrites its `command` and `args`. kanbo owns only the entries in the exact shapes it writes — `kanbo mcp` (with or without `"type": "stdio"`), or a Node by full path running `…/kanbo-cli/dist/cli.cjs mcp` — with no other field. Any other `kanbo` entry — `cmd /c kanbo mcp`, `npx -y kanbo-cli mcp`, one with an `env` or a `[mcp_servers.kanbo.env]` table — is yours and is never overwritten: `connect` reports "your own kanbo entry — left as is", and `doctor` warns only when it cannot start. See [what kanbo changes](cli.md#what-kanbo-changes-and-what-it-leaves-alone).

`kanbo init --instructions … --mcp …` and `kanbo init --global` still work, and plan the same changes.

## 1. Globally, for all your agents

```bash
kanbo connect all --global
```

It binds no board and creates none; a project gets a board with a plain `kanbo init`. The global block binds nothing:

```markdown
<!-- KANBO_START v2 h=4b740256 -->
## Kanbo boards

In a project with a `.kanbo/` folder, before starting a task, run `kanbo prime` (or call the `kanbo_prime` tool) and follow what it prints.
Take work with `kanbo ready`. Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.
A project without `.kanbo/` has no board: ignore this section there, and do not create one — a person sets a board up with `kanbo init`.
<!-- KANBO_END -->
```

`kanbo mcp` resolves the board from the directory the client starts it in, so one global registration serves every project that has run `kanbo init`. In a folder with no board the server still starts and the client connects, and every tool answers "This folder has no kanbo board. Ask a person to run `kanbo` here to set one up." Once a board is set up in that folder, the next tool call finds it — no restart needed.

Run `kanbo connect --check --global` or `kanbo doctor` afterwards to check it. `kanbo uninstall --global` takes it all out again. After upgrading kanbo, `kanbo doctor` warns about a block written by the old version; run `kanbo connect <agent> --global --yes` to rewrite it.

To register by hand instead, the entries `kanbo connect --global` writes are:

```toml
# $CODEX_HOME/config.toml (or: codex mcp add kanbo -- kanbo mcp)
[mcp_servers.kanbo]
command = "kanbo"
args = ["mcp"]
```

```json
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "kanbo": { "type": "stdio", "command": "kanbo", "args": ["mcp"] }
  }
}
```

### Mark every agent shell as an agent's

| Client | How |
| --- | --- |
| Claude Code | `"env": { "KANBO_ACTOR_KIND": "agent" }` in `~/.claude/settings.json` |
| Codex | `[shell_environment_policy]` with `set = { KANBO_ACTOR_KIND = "agent" }` in `~/.codex/config.toml` |
| Cursor | Rely on the MCP server (always an agent); if Cursor's agent also runs `kanbo` in a terminal, start Cursor from a shell where `KANBO_ACTOR_KIND=agent` is exported |

Claude Code, Gemini CLI and Cursor's Agent already mark their shells ([recognised marks](configuration.md#agent-shells-kanbo-recognises)); setting `KANBO_ACTOR_KIND=agent` for them as well does no harm. Codex needs it.

Do **not** export `KANBO_ACTOR_KIND=agent` in your own shell profile — then you could not approve anything yourself.

## 2. Per project

From the project root:

```bash
kanbo init --yes                     # a board file of this project's own
kanbo connect claude codex --yes     # CLAUDE.md, AGENTS.md, .mcp.json, and Codex's own config
```

Pass `--project` to put every MCP server into the project's files, Codex's included. Rerunning replaces the block in place.

The block `kanbo connect` writes is a short pointer; the rules themselves come from `kanbo prime` (which, on the command line, also lists the commands) or from the MCP server:

```markdown
<!-- KANBO_START v2 h=4842e336 -->
## Kanbo board

This project tracks its work on a kanbo board. Before starting a task, run `kanbo prime` (or call the `kanbo_prime` tool) and follow what it prints.
Take work with `kanbo ready`. Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.
<!-- KANBO_END -->
```

The start marker carries the block's version and a hash of its text. kanbo replaces a block it wrote — current, from an older version, or the bare `<!-- KANBO_START -->` block of kanbo 0.1–0.2 when its text is word for word one those versions wrote — in place. A block you edited between the markers is replaced only when you answer yes to "You changed the kanbo section in … Replace it with the current one?" (default no); with `--yes` or without a terminal it is left alone, with a note. A block from `kanbo instructions orchestrator --markers` (or any text but `short`/`global`) says `k=<kind>` on its marker and is kept; a block from a newer kanbo is kept; a file whose markers do not pair up is not touched at all.

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
- Gemini CLI GEMINI.md: https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html
- Gemini CLI MCP servers (`settings.json`): https://geminicli.com/docs/tools/mcp-server/
