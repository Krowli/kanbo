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

### Breaking — for agents and scripts reading lists

- `kanbo_card_list` and `kanbo_ready` answer with one page of compact cards instead of every card in full: `{"total":…,"more":…,"nextOffset":…,"cards":[…]}`, one card per line. A compact card is `id`, `title` (display title), `column` (slug), `statusLine`, `waitingFor`, `parentId`, `attempt`, `activeRun` (`agentName`, `startedAt`) and `updatedAt`, empty fields left out. `kanbo_card_list` answers 50 cards and `kanbo_ready` 10 unless `limit` says otherwise; `offset` pages. `detail: "full"` prints every field as before (one page at a time); `fields: [...]` prints `id` and the fields named. Every argument these tools took before still works.
- `kanbo_card_get` brings the card's last 10 comments (`comments`, `commentCount`) with its `subCards` by default; `include: []` reads the card alone.
- `kanbo card list` prints 50 cards and `kanbo ready` 10 unless `--limit` or `--all` says otherwise; when there are more, one line on stderr says how many and where the next page starts (`--offset`). `--json` still prints an array of cards.
- `kanbo card get` shows the card's last 10 comments and its sub-cards; its `--json` gains `comments`, `commentCount` and `subCards` (and `runs`, `history`, `pullRequests` with `--include`).

### Breaking — for applications that implement `BoardStore` or `KanboToolTransport`

- `BoardStore.issues.listPage(query)` (one page of the cards a `BoardCardQuery` picks, with the total, in one statement) and `BoardStore.issues.countByMilestone(workspaceId)` are new; a store written by hand must add them. `KanboToolTransport` gains `cardPage` and `readyPage`; `cardGet` takes optional `include` and `commentLimit`, and `KanboCardDetailResult.subCards` is present only when read. Callers of `createHttpTransport` and `createBoardOps` change nothing.

### Added

- Agent efficiency ([docs/agent-efficiency.md](docs/agent-efficiency.md)): every question an agent asks of the board is one call. `kanbo_card_list` takes `columns`, `waitingForPerson`, `parent`, `hasActiveRun`, `text`, `updatedSince` (unix seconds or ISO date), `labels`, `priority`, `offset`, `detail` and `fields`; `kanbo_ready` takes `offset`, `detail` and `fields`; `kanbo_card_get` takes `include` (`comments`, `subCards`, `runs`, `history`, `prs`) and `commentLimit`. The CLI has the same: `kanbo card list --column a,b --waiting --parent <card> --active --text <t> --updated-since <time> --label <l> --priority <p> --offset <n> --all`, `kanbo ready --all`, `kanbo card get --include <parts> --comments <n>`. Tool descriptions say which argument answers which question.
- `createBoardOps(...).queryCards(input)` and `.queryReady(input)`: a page of cards, the total and the columns, filtered by the database. Exported types `BoardCardQuery`, `BoardCardPage`, `BoardMilestoneCardCount`, `CardQueryInput`, `CardQueryResult`.
- `addColumn(workspaceId, { name, description, color, category, position }, actor)` on `createBoardOps(...)`: a column at its place in one write, its name checked inside the write. `kanbo columns add` uses it.
- Update check: every run asks npm once for the latest `kanbo-cli` alongside the command (about 1.5 s, never holding the command more than 0.3 s after it finishes; no schedule, no cache). A person at a terminal is asked whether to update (default No) and a yes runs `npm install -g kanbo-cli@latest`; a permissions failure (`EACCES`/`EPERM`) points at npm's guide. The home screen shows it under the summary with a menu item — a successful update ends the menu with `Updated to X — start kanbo again to use it.` — and leaving the menu prints the one-line notice. On Windows nothing is installed from the running kanbo (its native module is locked): the question and the menu item become `Close kanbo and run: npm install -g kanbo-cli@latest`. An agent's shell gets one line on stderr; `kanbo doctor` reports the run's own check as a finding (also after `--fix`); `kanbo mcp` ends `kanbo_prime` with a note. Off in CI, with `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER`, for `--json`, `--version` and `--help`.
- `kanbo doctor --fix [--yes]`: fixes what is kanbo's own — an instruction block from an older kanbo, kanbo's own MCP entry whose Node or script moved (the Windows form), a board with no columns (Standard columns), a board file a migration behind (`kanbo migrate`) — after one plan and one question (default Yes), then checks again. Never deletes anything; a block you edited and an MCP entry of your own are left alone. Without a terminal and without `--yes` it prints the plan and `Run kanbo doctor --fix --yes to apply.`
- `kanbo doctor` checks: `columns` (a board with no columns), `install` (kanbo running from npx's cache), `update` (a newer kanbo, status `info`). `--json` findings carry `fixable`; `status` can be `info`. Fix texts that `--fix` covers name `kanbo doctor --fix` first.
- `removeColumn` returns `unmetRules` for moved cards that entered a column without meeting its entry rules; `kanbo columns remove` prints the same warning as `kanbo card move`. Moved cards keep `waitingFor`, as a moved card does.
- `scripts/smoke.mjs`: an end-to-end check of the packed tarball installed with `npm install -g` — board, card, agent connection, MCP handshake from the written registrations, `serve`, `doctor`, `uninstall`. CI runs it on Linux, macOS and Windows with Node 22 and 24 (and, not yet required, on arm64 Linux and Windows and on Alpine); the release workflow runs it before publishing.

### Changed

- Faster reads that no longer walk the whole board: `kanbo_ready` / `kanbo ready`, `kanbo_card_list` / `kanbo card list` (filters and pages), `kanbo board --column`, the sub-cards of `kanbo_card_get` and the card counts of `kanbo_sprints` are asked of the database. At 10,000 cards on SQLite `kanbo_ready` went from 52 to 4.6 ms, `kanbo_card_get` from 33 to 0.6 ms, `kanbo_sprints` from 26 to 0.7 ms ([docs/performance.md](docs/performance.md)).
- `normalizeCommentAuthorKind` accepts any string (an author kind as a server sends it); what it returns is unchanged.
- `kanbo serve`: every column change (`POST /issues/statuses`, `PATCH /issues/statuses/:id` with a new name, `DELETE`, `/reorder`, `/standard`) is a person's — a request without the token or with `x-kanbo-actor: agent` gets `403 issue_column_structure_requires_user`. `DELETE /issues/statuses/:id` removes through `removeColumn`: a column holding cards needs `moveCardsTo` (body or query), otherwise `409`; it answers `{ ok, movedCards, unmetRules? }`.
- `kanbo board`, `kanbo card list` and `kanbo card get` strip escape sequences and control characters from what cards and columns carry, and `kanbo board` measures and cuts text by the columns it takes (CJK and emoji two, combining marks none), column headings included.
- The orchestrator guide names no column but To Do by its slug; `kanbo prime` says which column is for what. `kanbo columns rename` says that agents pick the new name up from `kanbo prime`.
- `kanbo columns` menu: "Nothing to remove — To Do always stays." when To Do is the only column.
- On Postgres, removing a column locks its row first; a card put into it meanwhile waits, and a card that still arrives refuses the removal rather than losing its column.
- `kanbo --help` groups the commands — *Get started*, *Your board*, *For agents and integrations*, *Shared Postgres boards* — and every command and option is described in plain words. `kanbo init --instructions` shows its value as `<agent>`.
- `--json` takes an optional list everywhere it exists: `--json` alone prints the whole result as JSON, `--json a,b` only those fields (as before). `kanbo doctor`, `kanbo uninstall` and `kanbo capabilities` accept a field list too; `--json` alone prints what it printed before. The capabilities manifest carries the new command descriptions.
- Error messages are plain sentences. A board refusal prints what went wrong, the command to run next, and its code in brackets (`No column "foo" on this board.` / `  Next: kanbo columns list  [issue_status_not_found]`) instead of the code and its details as JSON; `KANBO_DEBUG=1` adds the details. Exit codes are unchanged. Messages that said "workspace", "binding", "host database" or "external board" now say "project", "this project's settings", "the app's database" and "shared Postgres board".

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
