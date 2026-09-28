# kanbo

[![CI](https://github.com/Krowli/kanbo/actions/workflows/ci.yml/badge.svg)](https://github.com/Krowli/kanbo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/kanbo-cli.svg)](https://www.npmjs.com/package/kanbo-cli)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-orange.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.11-brightgreen.svg)](docs/installation.md)

**A Kanban board your coding agents work, and you approve.**

## Quick start

```bash
npm install -g kanbo-cli
cd your-project && kanbo
```

Then tell your agent: **"take the next card from kanbo."**

`kanbo` with no board here starts a short setup wizard; run it again any time for the home screen. See [Getting started](docs/getting-started.md) for the walkthrough — every question it asks, what your agent does, and how to approve a card.

## What you get

- **A board in a file, or a shared Postgres database.** `.kanbo/board.db` next to your code for one project on one machine, or an external Postgres (Supabase works) for a team of people and agents. See [storage](docs/storage.md).
- **Agents work it over MCP or the CLI.** Sixteen `kanbo_*` MCP tools, and a `kanbo` command for every one of them — an agent with or without MCP works the same board. See [MCP reference](docs/mcp.md) and [CLI reference](docs/cli.md).
- **You approve. kanbo enforces it, not just asks.** `approve`, `return` and column changes are a person's; an agent's shell is refused with exit code `4`, and on Postgres the database roles refuse it too. See [agents](docs/agents.md#agents-and-people).
- **Watch it in a terminal, or in your browser.** `kanbo board` and the interactive home screen, or `kanbo serve` for a board page over HTTP. See [HTTP API](docs/http-api.md).

## Works with

Claude Code, Codex, Cursor, Gemini CLI — and anything else that can run a shell command or speak MCP over stdio. See [using kanbo with agents](docs/agents.md).

## Documentation

- [Getting started](docs/getting-started.md) — the wizard, the home screen, connecting an agent, approving a card
- [Installation](docs/installation.md) — npm, npx, from source, native module notes, upgrading
- [Using kanbo with agents](docs/agents.md) — global setup, per project, per agent; the agent-vs-person rules
- [Orchestrator examples](docs/orchestrator.md) — instruction files, Claude Code subagents, Codex, a shell loop, a worked session
- [CLI reference](docs/cli.md) — every command and flag
- [MCP reference](docs/mcp.md) — every `kanbo_*` tool and its inputs
- [HTTP API](docs/http-api.md) — `kanbo serve`, routes, security model, the board page
- [Storage](docs/storage.md) — board files, shared Postgres/Supabase, roles, schema, migrations
- [Configuration](docs/configuration.md) — `KANBO_*` environment variables and `.kanbo/binding.json`
- [Performance](docs/performance.md) and [Agent efficiency](docs/agent-efficiency.md) — how fast, and how many tool calls an agent needs
- [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)
- [Full index](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for noncommercial use (personal, research, educational, and more; read the [license](LICENSE) for the exact terms). Commercial use — selling it, or building it into a paid product or service — needs a separate license: write to lionmause999@gmail.com.

Versions up to and including 0.2.0 were released under MIT and stay under MIT.
