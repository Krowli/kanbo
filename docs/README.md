# Documentation

- [Getting started](getting-started.md) — a numbered walkthrough: the setup wizard, the home screen, connecting an agent, what it does, approving a card, the board page
- [Installation](installation.md) — npm, npx, from source, native module notes, upgrading, uninstalling
- [Using kanbo with agents](agents.md) — global setup, per project, per agent; the agent-vs-person rules
- [Orchestrator examples](orchestrator.md) — an instruction file, Claude Code subagents, a Codex profile, a shell loop, a worked session
- [CLI reference](cli.md) — every command and flag, taken from `kanbo <command> --help`
- [MCP reference](mcp.md) — every `kanbo_*` tool, its inputs and aliases, and what a list answers with
- [Configuration](configuration.md) — every `KANBO_*` environment variable, the update check, `.kanbo/binding.json`
- [HTTP API](http-api.md) — `kanbo serve`, routes, the security model, the board page
- [Storage](storage.md) — board files, shared Postgres/Supabase, roles, schema, migrations
- [Troubleshooting](troubleshooting.md) — `kanbo doctor` findings and error messages, Windows, WSL, Alpine, npx
- [FAQ](faq.md) — short answers to the questions people ask first
- [Performance](performance.md) — latency on boards of 100 to 10,000 cards, statements per read, MCP answer sizes, how to run the bench
- [Agent efficiency](agent-efficiency.md) — the questions an agent asks, one call each: filters, pages, compact cards

See also the [README](../README.md), [Contributing](../CONTRIBUTING.md), [Security](../SECURITY.md) and [Changelog](../CHANGELOG.md) in the project root.
