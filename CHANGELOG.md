# Changelog

All notable changes to kanbo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `kanbo_card_update` takes `parent`, and `kanbo card update` takes `--parent <card>`: a card created at the wrong level is put under another card, or back on the top level with `"none"` (`--parent none`), and its history records the move like any other field's. A `null` for `parent` is read as not given — models send `null` for the fields they are not changing — so it never takes a card out from under its parent. The MCP server's instructions and the commands `kanbo prime` prints say so in one line each.
- For applications that use kanbo as a library: `KanboCardUpdateInput.parent` (`string | null`; `null` is the top level, absent leaves the parent as it is) — a hand-written `KanboToolTransport` passes it on, and `createHttpTransport` sends it as `parentIssueId`, the card's exact id, as for a new card. `BoardErrorCode` gains `issue_parent_cycle`, `400` in `BOARD_ERROR_RESPONSES`.

### Changed

- The MCP tools that write a card — `kanbo_card_create`, `kanbo_card_update`, `kanbo_card_move`, `kanbo_status_line`, `kanbo_wait_approval` — answer with the card compact, on one line, as `kanbo_card_list` prints it (`id`, `title`, `column` slug, `statusLine`, `waitingFor`, `parentId`, `attempt`, `activeRun`, `updatedAt`), instead of every field pretty-printed: an orchestrator writing its card 20–40 times a session got 5–19k characters back each time — 19k for a one-sentence status line — and read them again on every later turn. Each takes `detail: "full"` for the whole card, as before. The CLI prints what it printed. For applications that read these tools' answers: they are compact now; pass `detail: "full"` for the old answer.

### Fixed

- A card can no longer be put under one of its own sub-cards, at any depth: the board operation refuses it (`issue_parent_cycle` — "A card can't be put under one of its own sub-cards."), so `PATCH /issues/:id` does too, where it used to write the loop. A loop already in a board's data does not hang the check.

## [0.3.0] — 2026-09-28

kanbo 0.3 is about getting started without reading anything first — `kanbo` alone sets a project up or shows its board — about running the same everywhere (Windows included), and about agents spending fewer calls and tokens on the board. Boards need no migration: a board file or Postgres board 0.2.1 wrote opens as it is.

### Added

**Getting started**

- Bare `kanbo`: with nobody to ask (no terminal, or an agent's shell) it prints a short hint — how to set a board up, or a few lines about the board — and exits `0`. At a terminal in a folder with no board it starts the init wizard; with a board it opens the home screen: the column counts, the cards waiting for you, which agents are connected, and a menu (review waiting cards — approve or send back with a comment —, show the board, open the board page, add a card, connect an agent, get the instructions, change columns, check the setup, update kanbo).
- The `kanbo init` wizard: where the board lives (a file in the project, or a shared Postgres database), the card key (suggested from the folder name), the columns (Standard, Simple, Review + QA, or your own), which agents to connect, and a first card — then the full list of changes and one "Write these changes?". Ctrl-C at any question leaves the folder exactly as it was. Every answer is also a flag: `--key`, `--columns <template or list>`, `--connect <agents>`, `--first-card <title>`, `--migrate` (create the Postgres tables now).
- Plain `kanbo init` (no flags, nothing naming a board) creates a board file of the project's own, `.kanbo/board.db`, with the standard columns and a card key from the folder name.
- `kanbo connect <agents>` (alias `kanbo setup`) for `claude`, `codex`, `cursor`, `gemini` or `all`: the kanbo section in each agent's instruction file and kanbo's MCP server in its settings, `--project` or `--global`; `--no-instructions`, `--no-mcp`, `--check` (what is connected; exit `1` when a named agent is not), `--remove`, `--dry-run`, `--yes`. It changes only what kanbo wrote, in the shape it wrote it: an MCP entry or an instruction block you edited is left alone, and removing an entry of your own asks first (default No). A shared `AGENTS.md` section stays while Codex or Cursor still reads it.
- `kanbo instructions [agent|short|global|orchestrator|mcp|board]` prints the text an agent needs, with `--copy` (clipboard on macOS, Windows, WSL, Wayland, X11, or OSC 52 over SSH) and `--markers`.
- `kanbo board`: the board in the terminal, one section per column, cut to the terminal's width; Done and Canceled show their last five cards unless `--all`; `--column`, `--json [fields]`.
- `kanbo columns add|rename|move|remove|template|add-standard`, and a menu with `kanbo columns` alone at a terminal. `remove` moves the column's cards to `--move-cards-to` (or asks). To Do can't be removed or renamed to another slug — `kanbo ready` takes work from it. All of these are a person's (exit `4` in an agent's shell).
- Column templates: `standard` (Backlog, To Do, In Progress, In Review, Done, Canceled), `simple`, `review-qa`, and ready-made columns (QA, Blocked, …) by name in `--columns`.
- `kanbo doctor --fix [--yes]`: fixes what is kanbo's own — an instruction block from an older kanbo, kanbo's own MCP entry whose Node or script moved, a board with no columns, a board file a migration behind — after one plan and one question (default Yes), then checks again. It never deletes anything. Without a terminal and without `--yes` it prints the plan and `Run kanbo doctor --fix --yes to apply.`
- `kanbo doctor` checks `columns` (a board with no columns), `install` (kanbo running from npx's cache) and `update` (a newer kanbo, status `info`); `--json` findings carry `fixable`.
- Update check: every run asks npm once for the latest `kanbo-cli`, alongside the command (never holding it more than 0.3 s after it finishes; no schedule, no cache). A person at a terminal running a global install is asked whether to update (default No), and a yes runs `npm install -g kanbo-cli@latest`; a permissions failure points at npm's guide. The home screen shows it with a menu item. Nothing is installed on Windows from the running kanbo (`Close kanbo and run: …`), in a project's own install (`This project installs kanbo; update it here: npm install kanbo-cli@latest`) or from npx (`npx runs the newest kanbo when you pass @latest: npx kanbo-cli@latest`). An agent's shell is told `kanbo X is available (running Y). Ask a person to update: npm install -g kanbo-cli@latest`; `kanbo mcp` ends `kanbo_prime` with the same note; `kanbo doctor` shows it as a finding. Off in CI, with `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER`, and for `--json`, `--version`, `--help` and `kanbo mcp`'s own output.

**For agents**

- `kanbo mcp` starts in a folder with no board: every tool answers `This folder has no kanbo board yet. Ask a person to run kanbo here.`, and a board created there meanwhile is picked up on the next call.
- Agent shells are recognised by the marks their tools document or set: `CLAUDECODE=1` (Claude Code), `GEMINI_CLI=1` (Gemini CLI), `CURSOR_AGENT` (Cursor's agent terminal) and `CODEX_THREAD_ID` (Codex, every shell command it runs), as well as `KANBO_ACTOR_KIND=agent`. In such a shell the person-only commands exit `4`, nothing asks a question, column entry rules refuse instead of warning, and a Postgres board's agent connection string is used. `KANBO_ACTOR_KIND=person` overrides the marks for a person's own terminal.
- Every question an agent asks of the board is one call ([docs/agent-efficiency.md](docs/agent-efficiency.md)). `kanbo_card_list` takes `columns`, `waitingForPerson`, `returned`, `parent`, `hasActiveRun`, `text`, `updatedSince` (unix seconds, an ISO date-time with `Z` or an offset, or `YYYY-MM-DD` for UTC midnight), `labels`, `priority`, `offset`, `detail` and `fields`; `kanbo_ready` takes `offset`, `detail` and `fields`; `kanbo_card_get` takes `include` (`comments`, `subCards`, `runs`, `history`, `prs`) and `commentLimit`. The CLI has the same: `kanbo card list --column a,b --waiting --returned --parent <card> --active --text <t> --updated-since <time> --label <l> --priority <p> --offset <n> --all`, `kanbo ready --all`, `kanbo card get --include <parts> --comments <n>`. `text` ignores case in any script (`über` finds `Über`) on SQLite, Postgres and over HTTP alike.
- Returned cards — sent back by a person and not picked up again (latest decision a return, not waiting, no run) — come first in `kanbo_ready` (under `returned`), `kanbo ready` and `kanbo prime`, each with the person's comment. A list's card that is waiting or returned carries `lastComment` (who, the first 200 characters, when); `kanbo card list` prints it, and a waiting card's status line, under the card.
- The MCP tools take the argument names agents reached for as well as their own: `card` also as `id`, `cardId` or `key`; `kanbo_card_comment`'s `content` also as `text`; `kanbo_status_line`'s and `kanbo_wait_approval`'s `text` also as `content`; `kanbo_run_finish`'s `run` also as `runId` or `id`; `kanbo_run_start`'s `agent` also as `agentName`; `kanbo_card_move`'s `column` also as `to`. The CLI likewise: `kanbo card comment --text`, `kanbo card status-line --content`, `kanbo card wait-approval --content`. The JSON Schema a client lists is unchanged; both names with different values are refused.
- A run's finish state also reads `completed`, `succeeded`, `success`, `done` as `finished`; `error`, `errored` as `failed`; `cancelled`, `canceled`, `aborted` as `stopped`. `kanbo run start` prints the command that finishes the run; `kanbo_run_start` answers with `finishWith`.
- `kanbo run start` without `--session` and `kanbo_run_start` without `session` record the session of the agent they run under — `CLAUDE_CODE_SESSION_ID` (Claude Code) or `CODEX_THREAD_ID` (Codex), when exactly one is set.

**For applications that use kanbo as a library**

- `createBoardOps(...)`: `queryCards(input)` and `queryReady(input)` (a page of cards, the total and the columns, filtered by the database), `renameColumn`, `moveColumn`, `removeColumn(workspaceId, column, { moveCardsTo }, actor)` (moves the cards in the same write; returns `movedCards` and `unmetRules`), `addColumn(workspaceId, { name, description, color, category, position }, actor)`, `applyColumnTemplate(workspaceId, columns, { mode: 'seed' | 'add-missing', actor })`, `readCardAttention(cards, running)`.
- Exports from `kanbo-cli`: `suggestCardKey`, `isValidCardKey`, `CARD_KEY_PATTERN`, `COLUMN_TEMPLATES`, `COLUMN_TEMPLATE_IDS`, `COLUMN_CATALOGUE`, and the types `ColumnSpec`, `ColumnTemplateId`, `AddColumnInput`, `ApplyColumnTemplateOptions`, `ColumnPosition`, `RemoveColumnOptions`, `RemoveColumnResult`, `BoardCardQuery`, `BoardCardPage`, `BoardMilestoneCardCount`, `CardQueryInput`, `CardQueryResult`, `CardAttention`, `CardLastComment`.
- Exports from `kanbo-cli/mcp` — what a hand-written `KanboToolTransport` is written against: the types `KanboCardQuery`, `KanboCardPage`, `KanboReadyPage`, `KanboCardInclude`, `KanboCardDetailResult`, `KanboCardFacts`, `KanboCardCommentResult`, `KanboFieldChangeResult`, `KanboSprintResult`, `KanboCardCreateInput`, `KanboCardUpdateInput`, `KanboRunStartInput`, `KanboRunFinishInput`; the constants `KANBO_CARD_INCLUDES`, `DEFAULT_KANBO_CARD_INCLUDES`, `DEFAULT_KANBO_COMMENT_LIMIT`; and the helpers `matchesKanboCardQuery` and `pageOf`.
- `BoardErrorCode` gains `board_column_name_taken`, `board_column_not_empty` (`details.cardCount`), `board_column_ready_protected`, `board_column_remove_target_invalid` and `board_column_structure_requires_user`, each with a row in `BOARD_ERROR_RESPONSES`.

### Changed

- Windows is supported and tested like macOS and Linux (CI on Windows, macOS and Linux, Node 22 and 24): programs are found and started the Windows way, files kanbo edits keep their CRLF line endings and byte order mark, a file Windows holds open is retried, and MCP registrations in your own settings start kanbo as this Node and this script, which works on every system.
- `better-sqlite3` comes with kanbo (an optional dependency, installed from prebuilt binaries) instead of being a peer you install yourself. When it can't load, kanbo says so, and Postgres boards still work. An old Node is told which Node kanbo needs instead of failing with a syntax error.
- `CLAUDE_CONFIG_DIR` and `GEMINI_CLI_HOME` are honoured for Claude Code's and Gemini CLI's own files.
- The instruction block kanbo writes is short: it says to run `kanbo prime` first and what every agent must do, and carries a version and a hash so kanbo can tell its own block, an older one, and one you edited. `kanbo prime` ends with the commands an agent uses, each written out as a call that works.
- `kanbo card create` by a person with no `--column` puts the card in To Do, as the home screen and the wizard do; an agent's still goes to the board's first column (Backlog on the standard board), as in 0.2.
- Help and errors in plain words. `kanbo --help` groups the commands (*Get started*, *Your board*, *For agents and integrations*, *Shared Postgres boards*). A board refusal prints what went wrong, the command to run next and its code in brackets (`No column "foo" on this board.` / `  Next: kanbo columns list  [issue_status_not_found]`) instead of the code and its details as JSON; `KANBO_DEBUG=1` adds the details. Exit codes are unchanged. "Workspace", "binding", "host database" and "external board" are now "project", "project settings", "the app's database" and "shared Postgres board" — `kanbo init` prints `This project uses board X — …`, and `kanbo doctor`'s `binding` check is called `settings`.
- A refusal in an agent's shell names the mark it saw and ends with the command a person in an editor terminal runs instead: `Only a person can approve a card. This shell belongs to an agent (CLAUDECODE=1): ask a person to approve it on the board page (kanbo serve).` / `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo approve WOR-1`. The no-board text in an agent's shell ends the same way (`… KANBO_ACTOR_KIND=person kanbo`). On Windows the line is PowerShell's: `If you are a person in an editor terminal, run in PowerShell: $env:KANBO_ACTOR_KIND='person'; kanbo approve WOR-1`, each word quoted for PowerShell.
- `--json` takes an optional field list everywhere it exists: `--json` alone prints the whole result, `--json a,b` only those fields.
- `kanbo init` on a board that is already there says what it kept instead of ignoring `--columns` and `--key`: `Kept the existing columns (…); to change columns use kanbo columns`, `Kept the existing key (ABC); --key names the key of a new board only` (and `kept` in `--json`). It reuses what the project settings and the board already say about the workspace and its key.
- A board file the project settings name that has gone missing is said so (`This project's board file is missing: …`), and `kanbo init --file` (or the wizard) puts a new empty board in its place.
- `kanbo connect codex` writes `default_tools_approval_mode = "approve"` into kanbo's MCP table (without it `codex exec` refuses every `kanbo_*` call).
- `kanbo_card_list` and `kanbo_ready` answer with one page of compact cards (see *Breaking*); `kanbo_card_get` brings the card's last 10 comments and its sub-cards by default.
- Faster reads: lists, ready, sub-cards and sprint counts are asked of the database. At 10,000 cards on SQLite `kanbo_ready` went from 52 to 4.6 ms, `kanbo_card_get` from 33 to 0.6 ms, `kanbo_sprints` from 26 to 0.7 ms; a default `kanbo_card_list` at 1,000 cards is about 1,950 tokens (was 178,117 for every card in full) ([docs/performance.md](docs/performance.md)).
- `kanbo board`, `kanbo card list` and `kanbo card get` strip escape sequences and control characters from what cards and columns carry, and measure text by the columns it takes (CJK and emoji two).
- `kanbo serve`: every column change over HTTP is a person's — without the token or with `x-kanbo-actor: agent` it is `403`; `DELETE /issues/statuses/:id` needs `moveCardsTo` for a column holding cards (else `409`) and answers `{ ok, movedCards, unmetRules? }`. The board page opens the right way on macOS, Windows, WSL and Linux (X11 and Wayland).
- The status line a return writes reads `returned by a person: <comment>` (was `returned by you: …`). The orchestrator guide names no column but To Do by its slug and lists every person-only command.
- The npm tarball is 1.0 MB (was 2.6 MB): no source maps, each migration chain once (in `dist/`), and `CHANGELOG.md` included.
- The release workflow publishes exactly the tarball it smoke-tested, and only after the whole CI workflow has passed on the tagged commit.

### Breaking — CLI behaviour

- Bare `kanbo` no longer prints the help and exits `1`: it prints a hint or the board summary and exits `0` (or, at a terminal, starts the wizard or the home screen). `kanbo --help` prints the help.
- `kanbo init` without `--yes` never writes agent files — instruction blocks, MCP settings, `claude mcp add`. It sets up the board and says `Not changing agent files without a yes: run kanbo connect <agent> --yes`. At a terminal it runs the wizard instead of per-file questions.
- `kanbo card list` prints 50 cards and `kanbo ready` 10 unless `--limit` or `--all` says otherwise; when there are more, one line on stderr says how many and where the next page starts (`--offset`). `kanbo card get` shows the last 10 comments and the sub-cards; its `--json` gains `comments`, `commentCount` and `subCards`.
- `kanbo_card_list` and `kanbo_ready` answer `{"total":…,"more":…,"nextOffset":…,"cards":[…]}` with compact cards (`id`, `title`, `column` slug, `statusLine`, `waitingFor`, `parentId`, `attempt`, `activeRun`, `updatedAt`, plus `returned` and `lastComment` when they apply) — 50 and 10 by default. `detail: "full"` prints every field as before; `fields: [...]` picks them.
- A shell an agent tool marked — including the integrated terminal of Claude Code's IDE extensions (`CLAUDECODE=1`) and any shell Codex started (`CODEX_THREAD_ID`) — is an agent's: `approve`, `return`, `sprint close`, `columns rules`, the column changes and `run clear-session` exit `4` there. A person there runs the command with `KANBO_ACTOR_KIND=person` in front, as the refusal shows.
- `kanbo columns add-standard` is a person's command (it is `kanbo columns template standard --add-missing`).
- Error messages on stderr are sentences, not `code {json}` (see *Changed*); a script that parsed them should match the code in brackets, or use `--json`.
- Every run asks npm for the latest version (see *Added*); set `KANBO_NO_UPDATE_CHECK=1` where that is unwelcome.
- `kanbo doctor --json`: the `binding` finding is now `settings`, `status` can be `info`, and findings carry `fixable`.

### Breaking — for applications that use kanbo as a library

- Column operations of `createBoardOps(...)`: `deleteColumn(statusId)` refuses a column that still holds cards (`board_column_not_empty`, `details.cardCount`) — use `removeColumn(workspaceId, column, { moveCardsTo }, actor)` — and refuses To Do (`board_column_ready_protected`); it renumbers the columns left 0..n-1. `updateColumn(statusId, { name }, actor)` follows `renameColumn`'s rules (`board_column_name_taken`, `board_column_ready_protected`, `issue_status_name_empty`; trimmed) and a changed name needs a person (`board_column_structure_requires_user`). `createColumn(input, actor)` needs a person and a free slug, and goes one past the highest order. `deleteColumn`, `reorderColumns` and `addStandardColumns` take an optional trailing `actor`; given and not a person, they are refused. `ApplyColumnTemplateOptions` is a union (`{ mode: 'seed' }` or `{ mode: 'add-missing', actor }`).
- `BOARD_ERROR_RESPONSES.board_column_not_empty` is `409` (was `400`).
- `BoardStore` gains methods a store written by hand must add: `statuses.lockById(statusId)`, `issues.listPage(query)`, `issues.countByMilestone(workspaceId)`, `comments.listLatestByIssues(issueIds, authorKinds?)`. `BoardCardQuery.returned` is new. The factories `createSqliteBoardStore` and `createPostgresBoardStore` have them.
- `KanboToolTransport` gains `cardPage(query)` and `readyPage({ limit, offset, returnedLimit })` (answering `KanboReadyPage`, with `returned` when asked); `cardGet` takes optional `include` and `commentLimit`; `KanboCardDetailResult.subCards` is present only when read; `KanboCardResult` may carry `returned` and `lastComment`. `createHttpTransport` has them.
- MCP tools: `KanboTool.registrationSchema` is new. A server that registers the tools itself passes `tool.registrationSchema` as the MCP `inputSchema` (not `tool.inputSchema`): it accepts the argument aliases and lets a wrong argument reach the tool, which answers with one sentence and an example call. `registerKanboTools`, `createKanboMcpServer` and each `KanboToolRegistration.register` already do.
- Texts an application may show or compare: `RETURNED_STATUS_LINE_PREFIX` is `returned by a person: ` (was `returned by you: `), and the capabilities manifest's canonical string with it; `OWN_SESSION_RULE` says kanbo fills in the session and never to invent one; `buildPrimeText` (and `kanbo_prime`) start with a `Returned to you — …` list when cards were sent back, and end with the command sheet written out with arguments; the descriptions in `DEFAULT_STATUSES` are rewritten (e.g. To Do is `Ready to start — agents take work from here`). `KANBO_MCP_INSTRUCTIONS` is unchanged.
- `normalizeCommentAuthorKind` accepts any string; what it returns is unchanged.
- `better-sqlite3` moved from an optional peer dependency to `optionalDependencies`: an application installing `kanbo-cli` gets it too (npm skips it where it can't install; Postgres boards still work).

### Fixed

- Board order is total: cards with the same position and creation time are ordered by id on both engines, so paging never skips or repeats a card.
- Card keys suggested from a folder name spell out ß, æ, ø, œ and friends and split ligatures (`Ærø` → `AER`); a ready-made column typed by name in `--columns` lands in its own place.
- The home screen names a board outside your home folder by its whole path (`/Users/ab` is not under `/Users/a`).
- On Postgres, removing a column locks it first, so a card put into it meanwhile refuses the removal rather than losing its column.
- A project settings file saved by an editor with a byte order mark is read.
- `kanbo connect` says a note (such as Cursor's rules living in its settings) once, with the plan, not again after it.

### Upgrading from 0.2

1. `npm install -g kanbo-cli@latest`. `better-sqlite3` now comes with it; nothing to build.
2. In each project, `kanbo doctor --fix` — it replaces the instruction block 0.2 wrote with the new short one (a block you edited is left alone and reported), fixes kanbo's own MCP entries, and changes nothing else. Or `kanbo connect <agents> --yes`. Your board, cards and project settings stay as they are; no migration runs.
3. Scripts: bare `kanbo` exits `0` and prints a hint; `kanbo init` without `--yes` no longer writes agent files (add `--yes`, or run `kanbo connect <agent> --yes`); `kanbo card list` prints 50 cards and `kanbo ready` 10 — add `--all` for every card; errors on stderr are sentences with the code in brackets; `kanbo doctor --json` calls the `binding` check `settings`; set `KANBO_NO_UPDATE_CHECK=1` to keep a script off the network.
4. A person working in an agent tool's terminal (Claude Code's IDE extension, a shell Codex started) runs person-only commands as `KANBO_ACTOR_KIND=person kanbo approve …`.
5. Applications using kanbo as a library: see *Breaking — for applications* above — hand-written stores and transports need the new methods, and tools are registered with `registrationSchema`.

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

[0.3.0]: https://github.com/Krowli/kanbo/releases/tag/v0.3.0
[0.2.1]: https://github.com/Krowli/kanbo/releases/tag/v0.2.1
[0.2.0]: https://github.com/Krowli/kanbo/releases/tag/v0.2.0
[0.1.3]: https://github.com/Krowli/kanbo/releases/tag/v0.1.3
[0.1.2]: https://github.com/Krowli/kanbo/releases/tag/v0.1.2
[0.1.1]: https://github.com/Krowli/kanbo/releases/tag/v0.1.1
[0.1.0]: https://github.com/Krowli/kanbo/releases/tag/v0.1.0
