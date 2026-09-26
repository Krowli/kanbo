# Changelog

All notable changes to kanbo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] — 2026-09-26

### Changed

- `kanbo serve` on loopback generates a token for the run when none is given (`--token` / `KANBO_SERVE_TOKEN`), prints the board page link `http://127.0.0.1:<port>/#token=<token>` and opens it in the default browser. The page takes the token from the link's fragment and removes it from the address bar. A token you gave is never printed. New flag `--no-open`. In an agent's shell (`KANBO_ACTOR_KIND=agent`) or when stdout is not a terminal, the token is never printed and no browser is opened. A server off loopback still refuses to start without a token.
- `kanbo card list`, `kanbo card get`, `kanbo ready`, `kanbo approve` and `kanbo return` name a card written as a description alone by the first line of its description, as the board page does. `--json` output is unchanged.

## [0.1.0] — 2026-09-26

First public release.

### Added

- `kanbo` command line: `init`, `capabilities`, `prime`, `ready`, `columns`, `card` (list, get, create, update, move, status-line, comment, wait-approval, pr add/list/remove), `approve`, `return`, `run` (start, attach-session, clear-session, finish), `sprint` (list, create, close), `migrate`, `roles` (print, apply), `mcp`, `serve`.
- MCP server over stdio with sixteen `kanbo_*` tools and the `kanbo://capabilities` / `kanbo://capabilities.md` resources.
- Board storage in a project's own SQLite file (`kanbo init --file`, `.kanbo/board.db`) or an external Postgres database (Supabase works), with `kanban_person` / `kanban_agent` roles and database-enforced approval rules.
- Person-only actions (approve, return, close a sprint, set column rules, clear a run's log); a shell with `KANBO_ACTOR_KIND=agent` is refused with exit code 4.
- Status lines, runs with attempt numbers and external session references (`claude:<id>`, `codex:<id>`), subtasks, comments, relations, pull request links, sprints, and column entry rules (`checklist_complete`, `pull_request_linked`, `ci_green`, `approved`).
- `kanbo init` writes the project binding (`.kanbo/binding.json`), an instruction block for `CLAUDE.md` or `AGENTS.md`, and MCP registrations for Claude Code, Codex and Cursor.
- `kanbo serve`: the `/issues` HTTP API and a board page, loopback by default, bearer token, CORS allow-list, 1 MB body limit.
- Library entry points `kanbo`, `kanbo/sqlite`, `kanbo/sqlite/schema`, `kanbo/postgres` and `kanbo/mcp` (ESM and CJS with types).

[0.1.1]: https://github.com/Krowli/kanbo/releases/tag/v0.1.1
[0.1.0]: https://github.com/Krowli/kanbo/releases/tag/v0.1.0
