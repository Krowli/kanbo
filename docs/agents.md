# Using kanbo with agents

An agent reaches a kanbo board in one way: the `kanbo mcp` server. You register it once, in your own agent settings, and it serves every project:

```bash
kanbo connect claude        # or codex, cursor, gemini, all
```

The server explains itself. When a client connects, it sends the rules as its MCP [server instructions](mcp.md#server-instructions): call `kanbo_prime` first, take work from `kanbo_ready`, claim a card with `kanbo_card_claim`, write status lines and comments, hand the card to a person with `kanbo_wait_approval`, finish the run, and leave approving to a person. kanbo writes no instruction file into your project and none into your own `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`. Your own policy — which agent takes which column, when to hand a card over — belongs in your own instruction files; [orchestrator examples](orchestrator.md) has a text to start from.

The client configuration below was checked against each tool's documentation (links in [Sources](#sources)); if your client version differs, its own docs win.

## Agents and people

kanbo treats a shell as a person's unless it says otherwise:

- **Claude Code, Codex, Gemini CLI and Cursor's agent terminals are recognised on their own** by a mark each tool leaves (`CLAUDECODE=1`, `CODEX_THREAD_ID`, `GEMINI_CLI=1`, `CURSOR_AGENT`) — Claude Code's, Gemini CLI's and Cursor's are documented by the tool itself; Codex's is not, seen instead in its source and in headless runs. `KANBO_ACTOR_KIND=person` overrides a mark in your own terminal. See [configuration](configuration.md#agent-shells-kanbo-recognises).
- **`KANBO_ACTOR_KIND=agent`** marks a shell (and every process started from it) as an agent's. Then `kanbo approve`, `kanbo return`, `kanbo sprint close`, `kanbo columns rules`, `kanbo columns flow` and the column changes (`kanbo columns add|rename|move|remove|template|add-standard`) exit with code `4` without touching the board, column entry rules refuse a card instead of warning, and a Postgres binding's agent connection string is used.
- **`kanbo mcp` is always an agent.** Its client is an agent by definition, whatever the environment says. It has no tool that approves, returns or closes a sprint.
- **`KANBO_ACTOR_ID`** sets the name an agent's writes are filed under (default: the agent tool in an agent's shell, `claude`, `codex`, `cursor` or `gemini`; under `kanbo mcp` the MCP client's own name; the OS user name only in a person's shell. Rows written earlier keep the name they were written with). Give each agent its own, e.g. `KANBO_ACTOR_ID=reviewer`.
- On a **shared Postgres board**, give agents the `kanban_agent` login (`kanbo init --agent-url …`). Then the database itself refuses an agent that tries to take a card out of waiting or write an approval, whatever client it uses. See [storage](storage.md#roles).

A board file cannot enforce anything beyond kanbo's own code: an agent that edits the SQLite file directly can write anything. Use Postgres roles when that matters.

**Approve and return are a person's.** An agent calls `kanbo_wait_approval` and ends its turn. You answer with `kanbo approve <card> [--comment …]` or `kanbo return <card> --comment "why"` in your own terminal, or with the buttons on the `kanbo serve` page.

## Connecting agents: `kanbo connect`

`kanbo connect` registers kanbo's MCP server with one agent or several at a time — `claude`, `codex`, `cursor`, `gemini`, or `all`:

```bash
kanbo connect                        # in a terminal: pick agents, untick changes, confirm
kanbo connect claude --yes           # claude mcp add --scope user kanbo -- kanbo mcp
kanbo connect codex cursor --yes     # each one's own configuration
kanbo connect claude --project       # this project's .mcp.json instead, for a team to commit
kanbo connect --check                # agent | MCP | scope, and any old kanbo section still in a file
kanbo connect cursor --remove        # take kanbo out of Cursor's settings again
kanbo connect claude --dry-run       # show what would change, change nothing
```

Every change is shown first and written only after you say yes (or pass `--yes`). The server goes into your own configuration by default, so one registration serves every project; `--project` writes the project's files instead, and `--global` spells out the default.

| Agent | MCP server: your own (default) · `--project` |
| --- | --- |
| Claude Code | `claude mcp add --scope user kanbo -- kanbo mcp` (stored in `~/.claude.json`; printed for you to run when `claude` is not on `PATH`) · `.mcp.json` |
| Codex | `[mcp_servers.kanbo]` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) · `.codex/config.toml`, which Codex loads only for a trusted project |
| Cursor | `~/.cursor/mcp.json` · `.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` (entries without `type`) · `.gemini/settings.json` |

Commit project files if you use `--project`; none of them holds a secret. The board connection stays in `.kanbo/binding.json`, which is never committed.

`kanbo mcp` resolves the board from the directory the client starts it in. In a folder with no board the server still starts and the client connects, and every tool answers "This folder has no kanbo board yet. Ask a person to run kanbo here." Once a board is set up in that folder, the next tool call finds it — no restart needed. The same goes for a folder whose board cannot be opened right now (an app's database that is older than this kanbo, or a project the database does not know): the server starts, and each tool says why.

**Windows.** `kanbo` there is npm's `kanbo.cmd`, which clients that start programs without a shell (Codex) cannot run. So on Windows the project's `.mcp.json` keeps the portable `kanbo mcp`, and the registration in your own configuration names the Node that runs kanbo and kanbo's own script — `node.exe C:\…\kanbo-cli\dist\cli.cjs mcp` — which every client can start. When a Node upgrade or a reinstall leaves such a registration pointing at a file that is gone, `kanbo doctor` fails it, and `kanbo doctor --fix` (or `kanbo connect <agent>`) rewrites its `command` and `args`. kanbo owns only the entries in the exact shapes it writes — `kanbo mcp` (with or without `"type": "stdio"`, and with the empty `env` Claude Code adds), or a Node by full path running `…/kanbo-cli/dist/cli.cjs mcp` — with no other field but Codex's `default_tools_approval_mode = "approve"`. Any other `kanbo` entry — `cmd /c kanbo mcp`, `npx -y kanbo-cli mcp`, one with an `env` variable or a `[mcp_servers.kanbo.env]` table — is yours and is never overwritten: `connect` reports "your own kanbo entry — left as is", and `doctor` warns only when it cannot start. See [what kanbo changes](cli.md#what-kanbo-changes-and-what-it-leaves-alone).

To register by hand instead, the entries `kanbo connect` writes are:

```toml
# $CODEX_HOME/config.toml (or: codex mcp add kanbo -- kanbo mcp, then add the last line)
[mcp_servers.kanbo]
command = "kanbo"
args = ["mcp"]
default_tools_approval_mode = "approve"
```

`default_tools_approval_mode = "approve"` lets Codex call the board's tools without asking. `codex exec` never asks, so without it every `kanbo_*` tool call is refused ("approval policy is never"). It is part of the entry kanbo writes and owns; the same key with another value (`"prompt"`) makes the entry yours.

```json
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "kanbo": { "type": "stdio", "command": "kanbo", "args": ["mcp"] }
  }
}
```

Run `kanbo connect --check` or `kanbo doctor` afterwards to check it. `kanbo uninstall` takes it all out again.

### Mark every agent shell as an agent's

A shell an agent starts for its own commands should say it is an agent's, so it cannot approve:

| Client | How |
| --- | --- |
| Claude Code | `"env": { "KANBO_ACTOR_KIND": "agent" }` in `~/.claude/settings.json` |
| Codex | `[shell_environment_policy]` with `set = { KANBO_ACTOR_KIND = "agent" }` in `~/.codex/config.toml` |
| Cursor | Rely on the MCP server (always an agent); if Cursor's agent also runs `kanbo` in a terminal, start Cursor from a shell where `KANBO_ACTOR_KIND=agent` is exported |

Claude Code, Codex, Gemini CLI and Cursor's Agent already mark their shells ([recognised marks](configuration.md#agent-shells-kanbo-recognises)) — Codex's mark is undocumented by Codex itself, so setting `KANBO_ACTOR_KIND=agent` for it explicitly (as the table above does) is the more certain route; for the others it does no harm alongside the mark they already leave.

Do **not** export `KANBO_ACTOR_KIND=agent` in your own shell profile — then you could not approve anything yourself.

To mark agent shells per project instead: `"env": { "KANBO_ACTOR_KIND": "agent" }` in the project's `.claude/settings.json` (Claude Code applies project `env` after the folder is trusted), or `[shell_environment_policy] set = { KANBO_ACTOR_KIND = "agent" }` in `.codex/config.toml`.

## One specific agent only

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
2. `kanbo_card_claim` the card: your run starts and it moves to in_progress in one step.
3. Write a `kanbo_status_line` before and after every step that takes a while.
4. Put decisions and open questions on the card with `kanbo_card_comment`.
5. Link any pull request with `kanbo_card_link_pr`.
6. When done, `kanbo_card_move` to in_review, `kanbo_wait_approval` with a one-line summary, `kanbo_run_finish` with `finished`, and stop.
Never approve or return a card.
```

`tools` limits the subagent to these tools; `mcp__kanbo` allows every tool of the `kanbo` MCP server. Leave out `Bash` if the agent has no other use for a shell.

### A Codex profile

Codex profiles are separate files selected with `--profile`: `~/.codex/board-worker.config.toml` holds top-level keys, e.g.

```toml
model_reasoning_effort = "medium"

[shell_environment_policy]
set = { KANBO_ACTOR_KIND = "agent", KANBO_ACTOR_ID = "board-worker" }
```

and `codex --profile board-worker` starts Codex with it. Put the agent's own instructions in the prompt, or in the project's `AGENTS.md`; the kanbo tools are there through the registration `kanbo connect codex` made.

### Any agent, by environment

For a script or any other agent that speaks MCP, start it with the variables set:

```bash
KANBO_ACTOR_KIND=agent KANBO_ACTOR_ID=nightly-triage my-agent --task "triage the backlog"
```

Everything it writes through `kanbo mcp` is then filed under `nightly-triage`, and it cannot approve.

## Upgrading from 0.6 or earlier

Versions up to 0.6 wrote a kanbo section between `<!-- KANBO_START … -->` and `<!-- KANBO_END -->` markers into `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` (in the project, and with `--global` in your own files), and they gave agents `kanbo prime`, `kanbo claim`, `kanbo card …` and `kanbo run …` commands. From 0.7 agents use the MCP server alone and the section is dead text. `kanbo connect <agent>` or `kanbo doctor --fix` takes it out; the rest of each file is kept as it was. A section you edited is kept, with a note, and `kanbo connect --remove --yes` removes it. `kanbo connect --check` lists the files that still carry one.

## Sources

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code settings (`env`): https://code.claude.com/docs/en/settings and https://code.claude.com/docs/en/settings-reference#env
- Codex MCP (`config.toml`, `codex mcp add`): https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Codex profiles and `shell_environment_policy`: https://learn.chatgpt.com/docs/config-file/config-advanced
- Cursor MCP: https://cursor.com/docs/context/mcp
- Gemini CLI MCP servers (`settings.json`): https://geminicli.com/docs/tools/mcp-server/
