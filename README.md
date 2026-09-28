# kanbo

[![CI](https://github.com/Krowli/kanbo/actions/workflows/ci.yml/badge.svg)](https://github.com/Krowli/kanbo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/kanbo-cli.svg)](https://www.npmjs.com/package/kanbo-cli)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-orange.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.11-brightgreen.svg)](docs/installation.md)

**A Kanban board your AI agents drive, and you watch.** kanbo is a board that lives next to your code — a SQLite file in the project, or a shared Postgres/Supabase database — with a command line and an MCP server made for coding agents. Agents take cards, move them, write a one-line status at every step, split work into subtasks and link their pull requests; when they need you, they hand the card over and stop. Only a person approves or sends a card back, and kanbo enforces that rather than asking nicely. You follow along in a terminal or on a small board page in your browser.

## Features

- **Agent-first CLI and MCP server.** Sixteen `kanbo_*` MCP tools and a `kanbo` command for every one of them, so agents with or without MCP work the same board.
- **Human approval that holds.** `approve`, `return`, `sprint close` and column rules are a person's; an agent's shell (`KANBO_ACTOR_KIND=agent`) is refused with exit code `4`, and on Postgres the database roles enforce it too.
- **Status lines and runs.** Every card says what it is doing right now, and every launch of a card is recorded as a run with an attempt number.
- **Subtasks, comments, pull request links, sprints** and **column entry rules** (`checklist_complete`, `pull_request_linked`, `ci_green`, `approved`).
- **Storage you choose.** A board file in the project (`.kanbo/board.db`), or an external Postgres database such as Supabase shared by a team, with `kanban_person` / `kanban_agent` roles.
- **MCP alone is enough to start.** `kanbo mcp` sends the board's basic rules as MCP server instructions when a client connects, so an agent needs no instruction file for the basics.
- **One-command project setup.** `kanbo init` binds the project, writes an instruction block into `CLAUDE.md` or `AGENTS.md`, and registers the MCP server with Claude Code, Codex or Cursor.
- **The instructions without a trip to GitHub.** `kanbo instructions` prints the text to give an agent (`--copy` puts it on the clipboard); `kanbo instructions orchestrator` prints the orchestrator file.
- **Board over HTTP.** `kanbo serve` answers a JSON API and serves a board page on `http://127.0.0.1:4318`, loopback-only and token-guarded.
- **Machine-readable capabilities.** `kanbo capabilities --json` describes every tool, command, rule and limit for an orchestrator to read.

## Quick start

Requires Node.js `^22.19.0` or `>=24.11.0`. See [installation](docs/installation.md) for other ways to install.

```bash
npm install -g kanbo-cli
cd your-project && kanbo
```

`kanbo` in a project with no board starts the setup (the same as `kanbo init`). It asks a few questions in the terminal: where the board lives (a file in the project, or a shared Postgres database), what card numbers start with, which columns the board starts with, and which of your coding agents to connect. It shows exactly which files it will write and writes nothing until you say yes. Then tell your agent: **"take the next card from kanbo"**.

Run `kanbo` again later for the home screen: what is on the board, the cards waiting for you (approve them or send them back right there), which agents are connected, and a menu that shows the command behind every item.

kanbo checks npm for a newer version as it starts and offers to update when one is out; `KANBO_NO_UPDATE_CHECK=1` turns that off ([details](docs/configuration.md#update-check)).

Without a terminal (a script, CI, an agent's shell), `kanbo` asks nothing: it prints the command to run. `kanbo init --yes` takes the defaults: a board file with the standard columns, and no agent files. The same answers as flags:

```bash
kanbo init --yes --key APP --columns standard --connect claude --first-card "Add rate limiting"
kanbo doctor                    # checks the binding, board, instructions and MCP setup
kanbo board                     # the board in this terminal
kanbo serve                     # opens the board in your browser
kanbo columns                   # change the columns (a small menu)
```

Your agent reads the kanbo section in its instructions, runs `kanbo prime`, takes a card from `kanbo ready`, and works it. When it runs `kanbo card wait-approval`, you answer with `kanbo approve <card>` or `kanbo return <card> --comment "..."` — or with the buttons on the board page.

## How it works

```
   you (terminal or browser)                     your agents (Claude Code, Codex, Cursor, scripts)
   kanbo approve / return                        kanbo CLI            kanbo mcp (stdio)
   kanbo serve  ── board page                    KANBO_ACTOR_KIND=agent
          │                                             │                    │
          └──────────────────────┬──────────────────────┴────────────────────┘
                                 ▼
                    board operations (one implementation)
                    numbering · columns · status lines · runs
                    approval rules · entry rules · sprints
                                 │
               ┌─────────────────┴──────────────────┐
               ▼                                    ▼
      .kanbo/board.db (SQLite)          external Postgres / Supabase
      one project, one machine          shared; kanban_person / kanban_agent roles
```

Every entry point — the CLI, the MCP server, the HTTP server — calls the same operations, so a card moved by an agent over MCP and a card moved by you in a terminal tell the same story.

## Documentation

- [Installation](docs/installation.md) — npm, npx, from source, native module notes, upgrading
- [Using kanbo with agents](docs/agents.md) — global setup, per project, per agent; the agent-vs-person rules
- [Orchestrator examples](docs/orchestrator.md) — instruction files, Claude Code subagents, Codex, a shell loop, a worked session
- [CLI reference](docs/cli.md) — every command and flag
- [MCP reference](docs/mcp.md) — every `kanbo_*` tool and its inputs
- [HTTP API](docs/http-api.md) — `kanbo serve`, routes, security model, the board page
- [Storage](docs/storage.md) — board files, shared Postgres/Supabase, roles, schema, migrations
- [Configuration](docs/configuration.md) — `KANBO_*` environment variables and `.kanbo/binding.json`
- [Performance](docs/performance.md) — latency on boards of 100 to 10,000 cards, statements per read, MCP answer sizes, how to run the bench
- [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal, research, educational and other noncommercial use. Commercial use — selling it, or building it into a paid product or service — needs a separate license: write to lionmause999@gmail.com.

Versions up to and including 0.2.0 were released under MIT and stay under MIT.
