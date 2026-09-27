# Changelog

All notable changes to kanbo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking — for applications that use kanbo as a library

These change what the column operations of `createBoardOps(...)` do. Signatures only gained optional trailing parameters.

- `deleteColumn(statusId)` refuses a column that still holds cards (`board_column_not_empty`, `details.cardCount`) instead of leaving its cards in no column: move them first, or use `removeColumn(workspaceId, column, { moveCardsTo }, actor)`, which moves them in the same write. It also refuses To Do (`board_column_ready_protected`), and numbers the columns left 0..n-1. A board app whose delete button removed non-empty columns now gets this error.
- `updateColumn(statusId, { name }, actor)` holds a new name to `renameColumn`'s rules: `board_column_name_taken` when another column has its slug, `board_column_ready_protected` when To Do would lose the slug `to_do`, `issue_status_name_empty` for a blank name. Names are trimmed. A name that changes needs a person (`board_column_structure_requires_user`); description and colour stay open to anyone.
- `createColumn(input, actor)` needs a person (`board_column_structure_requires_user`) and refuses a name whose slug another column has. A new column goes one past the highest order (was: the number of columns).
- `deleteColumn`, `reorderColumns` and `addStandardColumns` take an optional trailing `actor`; given and not a person, they are refused with `board_column_structure_requires_user`. Without one they behave as before.
- `BOARD_ERROR_RESPONSES.board_column_not_empty` is `409` (was `400`).
- `BoardStore.statuses.lockById(statusId)` is new (`select … for update` on Postgres, a read on SQLite). A store written by hand must add it.

### Added

- `addColumn(workspaceId, { name, description, color, category, position }, actor)` on `createBoardOps(...)`: a column at its place in one write, its name checked inside the write. `kanbo columns add` uses it.
- `removeColumn` returns `unmetRules` for moved cards that entered a column without meeting its entry rules; `kanbo columns remove` prints the same warning as `kanbo card move`. Moved cards keep `waitingFor`, as a moved card does.

### Changed

- `kanbo serve`: every column change (`POST /issues/statuses`, `PATCH /issues/statuses/:id` with a new name, `DELETE`, `/reorder`, `/standard`) is a person's — a request without the token or with `x-kanbo-actor: agent` gets `403 issue_column_structure_requires_user`. `DELETE /issues/statuses/:id` removes through `removeColumn`: a column holding cards needs `moveCardsTo` (body or query), otherwise `409`; it answers `{ ok, movedCards, unmetRules? }`.
- `kanbo board`, `kanbo card list` and `kanbo card get` strip escape sequences and control characters from what cards and columns carry, and `kanbo board` measures and cuts text by the columns it takes (CJK and emoji two, combining marks none), column headings included.
- The orchestrator guide names no column but To Do by its slug; `kanbo prime` says which column is for what. `kanbo columns rename` says that agents pick the new name up from `kanbo prime`.
- `kanbo columns` menu: "Nothing to remove — To Do always stays." when To Do is the only column.
- On Postgres, removing a column locks its row first; a card put into it meanwhile waits, and a card that still arrives refuses the removal rather than losing its column.

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
