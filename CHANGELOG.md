# Changelog

All notable changes to kanbo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] — 2026-09-27

### Changed

- **License: MIT → PolyForm Noncommercial 1.0.0.** Free for personal, research, educational and other noncommercial use; selling kanbo or building it into a paid product or service needs a separate license from the author. Versions up to and including 0.2.0 were released under MIT and stay under MIT.

## [0.2.0] — 2026-09-27

### Removed (breaking)

- The board-copy API: `readBoardSlice`, `writeBoardSlice`, `deleteBoardSlice`, `emptyCopyCounts` and the `BoardSlice` / `BoardCopyCounts` types. Nothing in kanbo used them; copying a workspace's board between storages belongs to the application that owns those storages.
- Six `BoardErrorCode` values kanbo never raises, and their `BOARD_ERROR_RESPONSES` rows: `board_copy_conflict`, `board_mixed_workspaces`, `board_storage_not_configured`, `board_storage_not_empty`, `board_storage_not_prepared` and `board_storage_unavailable`.

### Added

- `assertReturnable(issueId, { toStatusName? }, actor)` on `createBoardOps(...)`: every reason `returnCard` would refuse, asked on reads alone, resolving to the column the card would go back to. `returnCard` runs the same check inside its write.
- Releases are published to npm from GitHub Actions with npm trusted publishing and provenance.

## [0.1.3] — 2026-09-26

### Added

- `kanbo init --global`: sets up your own agent tools for every project. Writes a global instruction block to `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md` (or `~/.codex/AGENTS.md`), and to `~/.gemini/GEMINI.md` when asked for (`--instructions claude,codex,gemini`); registers `kanbo mcp` with Claude Code (`claude mcp add --scope user kanbo -- kanbo mcp`, printed when `claude` is not on `PATH`), Codex (`[mcp_servers.kanbo]` in `$CODEX_HOME/config.toml`) and Cursor (`~/.cursor/mcp.json`). The global block binds no board and no board is created: it tells agents to use kanbo in projects that have `.kanbo/`. Shows a preview and asks unless `--yes`; reports `written` / `unchanged`.
- `kanbo doctor [--json]`: checks the kanbo version, another `kanbo` earlier on `PATH`, `better-sqlite3`, the project binding, that the board opens with a current schema, that every instruction block is the one this version writes, that every `kanbo` MCP registration's command is on `PATH`, a real MCP `initialize` handshake with `kanbo mcp`, and `KANBO_ACTOR_KIND=agent` in your own shell. Each finding is `ok`, `warn` or `fail` with a fix; exits `1` on any `fail`.
- `kanbo uninstall [--project|--global] [--purge] [--yes] [--json]`: removes the marked instruction blocks and the `kanbo` MCP entries (JSON and TOML), leaving everything else in those files; runs or prints `claude mcp remove kanbo --scope user`. Never touches boards unless `--purge`, which removes `.kanbo/binding.json` and deletes the project's board file only after a confirmation naming it (`--yes` does not answer it).

### Changed

- A stale instruction block is rewritten by running `kanbo init` again; `kanbo doctor` says which command. Blocks are not refreshed automatically.

## [0.1.2] — 2026-09-26

### Added

- `kanbo mcp` sends MCP server `instructions` in its initialize result: what kanbo is, to call `kanbo_prime` first and take work from `kanbo_ready`, the board's rules (move the card yourself, status lines, comments, subtasks, `kanbo_wait_approval`, never approve yourself), and where the full manifest is (`kanbo://capabilities.md`). An agent with only the MCP server connected knows how to work the board. Exported from `kanbo/mcp` as `KANBO_MCP_INSTRUCTIONS`.

### Changed

- The `kanbo init` instruction block, `kanbo prime`, the MCP instructions and the `kanbo_card_create` description read their rule sentences from one place. The init block now says each rule in the same words as `kanbo prime`, with the command beside it; rerun `kanbo init --instructions …` to refresh an existing block.

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

[0.2.1]: https://github.com/Krowli/kanbo/releases/tag/v0.2.1
[0.2.0]: https://github.com/Krowli/kanbo/releases/tag/v0.2.0
[0.1.3]: https://github.com/Krowli/kanbo/releases/tag/v0.1.3
[0.1.2]: https://github.com/Krowli/kanbo/releases/tag/v0.1.2
[0.1.1]: https://github.com/Krowli/kanbo/releases/tag/v0.1.1
[0.1.0]: https://github.com/Krowli/kanbo/releases/tag/v0.1.0
