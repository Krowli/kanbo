# CLI reference

Everything here is taken from `kanbo <command> --help` and `kanbo capabilities --json` of this version. `kanbo --version` prints the version; `kanbo help <command>` prints the help of one command.

## Options every board command takes

Unless a command's own section says otherwise, it takes these:

| Option | Meaning |
| --- | --- |
| `--db <path>` | Board database file to open. |
| `--database-url <url>` | External Postgres board to work on instead of a board file. Only one of `--db` and `--database-url` may be given (exit `1` otherwise). |
| `--workspace <nameOrId>` | Workspace the command is about. On a board file or Postgres board this is the workspace id. |
| `--json <fields>` | Print only these comma-separated fields, as JSON (`--json id,title,column`). An unknown field prints a warning on stderr and is skipped. |
| `--format <format>` | Output format: `json` or `pretty`. |

Without `--json` or `--format`, commands print text meant for a person. How the board and the workspace are chosen when no flag names them is described in [configuration](configuration.md#how-a-command-finds-its-board).

A card is named as the board prints it — `MAN-012`, `MAN-12` or just `12`. A column is named by slug (`in_progress`), name (`"In Progress"`) or id.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The command did not do what it was asked. See the message. |
| `2` | Nothing to work on, or nothing told the command what to work on. |
| `3` | The database is older than the board schema this build speaks. |
| `4` | The command is a person's to run, and this shell is not a person. |

## Commands

| Command | What it does |
| --- | --- |
| `kanbo init` | Bind this project to a board, and tell its agents about it. With `--global`, set up your own agent tools for every project instead. |
| `kanbo connect [agents...]` | Connect your agents (`claude`, `codex`, `cursor`, `gemini`, or `all`) to kanbo: the kanbo section in their instructions and the board's MCP server. `--check` shows what is connected, `--remove` takes it out. Alias `kanbo setup`. |
| `kanbo doctor` | Check this install, this project's binding and board, instruction blocks and MCP registrations. |
| `kanbo uninstall` | Remove what `kanbo init` wrote: instruction blocks and `kanbo` MCP entries. Boards stay unless `--purge`. |
| `kanbo capabilities` | The board's tools, commands, rules and limits — machine-readable, no board needed. |
| `kanbo prime` | Print the columns of this board and the rules a card travels by. |
| `kanbo ready` | Cards that are spelled out, unclaimed and nobody else's turn. |
| `kanbo columns list` | Every column in board order, with the slug a card is moved by. |
| `kanbo columns describe <column>` | Say in one line when a card belongs in a column. |
| `kanbo columns rules <column>` | Set what a card must satisfy before an agent may move it into a column. **Person only.** |
| `kanbo columns add-standard` | Add any of the standard columns this board is missing. |
| `kanbo card list` | Cards in board order. |
| `kanbo card get <card>` | One card, by key or number. |
| `kanbo card create` | Put a new card on the board. |
| `kanbo card update <card>` | Change a card's fields. |
| `kanbo card move <card> <column>` | Move a card to another column. |
| `kanbo card status-line <card>` | Say what the card is doing right now. |
| `kanbo card comment <card>` | Write a finding, a decision or a question on the card. |
| `kanbo card wait-approval <card>` | Hand the card to a person and end your turn. |
| `kanbo card pr add <card> <url>` | Link a pull request to the card; linking it again changes nothing. |
| `kanbo card pr list <card>` | The pull requests linked to the card, in the order they were linked. |
| `kanbo card pr remove <card> <linkId>` | Unlink a pull request from the card. |
| `kanbo approve <card>` | Accept the work on a card that is waiting for you. **Person only.** |
| `kanbo return <card>` | Send a card back a column, with the reason on it. **Person only.** |
| `kanbo run start <card>` | Say that you are working on a card. |
| `kanbo run attach-session <runId> <ref>` | Say which of your own logs a run is; a run keeps the first one named. |
| `kanbo run clear-session <runId>` | Say that the log a run names is not its log. **Person only.** |
| `kanbo run finish <runId>` | Say how a run ended. |
| `kanbo sprint list` | Every milestone of this board by start date, the current sprint marked `*`. |
| `kanbo sprint create` | Create a sprint: a milestone with a start and a due date. |
| `kanbo sprint close <id>` | Close a sprint, carrying its unfinished cards to another open milestone. **Person only.** |
| `kanbo migrate` | Create or update the board schema in an external Postgres database, or a board file of its own. |
| `kanbo roles print` | Print the SQL that creates the roles and the rules they live under. |
| `kanbo roles apply` | Run that SQL against the external board, as its owner. |
| `kanbo mcp` | Serve this board to an MCP client over stdio. |
| `kanbo serve` | Serve this board over HTTP, with a board page for the browser. |

**Person only** commands refuse with exit `4` in a shell where `KANBO_ACTOR_KIND=agent` is set. There is no flag to get past this. See [agents](agents.md#agents-and-people).

## `kanbo init`

Bind this project to a board, and tell its agents about it. Writes `.kanbo/binding.json` (mode `0600`) and `.kanbo/.gitignore`; with the options below it also writes an instruction block and MCP registrations. Running it again merges into the existing binding and changes nothing that is already current.

When nothing names a board — no `--db`/`--database-url`, no `KANBO_DB_PATH`/`KANBO_DATABASE_URL`, no binding at or above the folder — a plain `kanbo init` creates a board file of the project's own, exactly like `--file`. A new board file gets the standard columns straight away, so `kanbo prime` has them to show.

`init` works out everything first: it asks its questions, then (in a terminal, without `--yes`) shows the list of files it will create or write and asks `Make these changes?`. Nothing — not even the binding — is written before that yes; Ctrl-C at any question leaves the folder as it was.

| Option | Meaning |
| --- | --- |
| `--file [path]` | Use a board file of this project's own instead of a host database or an external board (default `.kanbo/board.db`). Creates and migrates the file, and seeds the standard columns into a new one. What a plain `kanbo init` does when nothing names a board. |
| `--database-url <url>` | External Postgres board to bind this project to. Needs a workspace id and a card-key prefix (`--workspace`, `--identifier`). |
| `--db <path>` | Host database file to read this project's workspace from (for a board that lives inside another app's SQLite database). |
| `--workspace <nameOrId>` | Workspace this project is. With `--file` and no binding yet, defaults to the folder name. |
| `--identifier <key>` | What this workspace's card keys start with (`APP` in `APP-001`). With `--file`, defaults to the folder name. |
| `--agent-url <url>` | The connection string agents get, when it is not the one above (see [storage](storage.md#roles)). |
| `--board <id>` | The board inside the workspace, when it has more than one. |
| `--instructions <file>` | Where to write the instruction block: `claude` (`CLAUDE.md`), `agents` (`AGENTS.md`) or `none`. With `--global`: a comma-separated list of `claude`, `codex`, `gemini`, or `none`. |
| `--mcp <clients>` | Register the board's MCP server with `claude` (`.mcp.json`), `codex` (`.codex/config.toml`), `cursor` (`.cursor/mcp.json`); comma-separated. |
| `--global` | Set up your own agent tools for every project instead of binding this one (see below). Binds no board. |
| `--yes` | Take the defaults instead of asking. |
| `--json <fields>`, `--format <format>` | Output, as everywhere. |

Without `--instructions` or `--mcp`, `init` asks in an interactive terminal and does neither otherwise. The instruction block sits between `<!-- KANBO_START v2 h=… -->` and `<!-- KANBO_END -->` and is replaced in place on a later run — unless you edited it, in which case `init` asks first (default no) and leaves it alone under `--yes`. An MCP entry named `kanbo` that already exists is left alone, unless it is kanbo's own and no longer starts (see `kanbo connect`). `--instructions` and `--mcp` plan the same changes as `kanbo connect <agent> --project` (`agents` is the `AGENTS.md` Codex and Cursor read).

`--file` together with `--database-url` is refused (exit `1`).

A block written by an older kanbo (including the bare `<!-- KANBO_START -->` block of 0.1–0.2) is not refreshed on its own: `kanbo doctor` warns about it, and running `kanbo connect <agent> --yes` (or `kanbo connect <agent> --global --yes` for your own files) rewrites it. No other command touches it.

### `kanbo init --global`

The same changes as `kanbo connect <agents> --global`, for the agents its flags name. Writes, for every project on this machine:

| What | Where |
| --- | --- |
| Instruction block (`--instructions`, default `claude,codex`) | `claude`: `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude/CLAUDE.md`) · `codex`: `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) · `gemini`: `$GEMINI_CLI_HOME/.gemini/GEMINI.md` (default `~/.gemini/GEMINI.md`, only when asked for) |
| MCP registration (`--mcp`, default `claude,codex,cursor`) | `claude`: runs `claude mcp add --scope user kanbo -- kanbo mcp` (prints the line instead when `claude` is not on `PATH`) · `codex`: `[mcp_servers.kanbo]` in `$CODEX_HOME/config.toml` · `cursor`: `~/.cursor/mcp.json`. On Windows each starts `node.exe <kanbo's cli.cjs> mcp` (see [agents](agents.md)) |

The global block binds no board and no board is created. It tells an agent to use kanbo in a project that has a `.kanbo/` directory, and to leave a project without one alone; a project gets a board with a plain `kanbo init`. It uses the same markers, so a second run reports every file `unchanged`.

Every change is shown first and nothing is written until you confirm, or pass `--yes`. In a shell with no terminal and without `--yes` it writes nothing and exits `1`. With `--json`/`--format`, the preview goes to stderr. `--file`, `--db`, `--database-url`, `--workspace`, `--board`, `--identifier` and `--agent-url` are refused with `--global` (exit `1`).

Paths and formats follow each tool's docs: [Claude Code memory](https://code.claude.com/docs/en/memory), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Cursor MCP](https://cursor.com/docs/context/mcp), [Gemini CLI GEMINI.md](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html).

## `kanbo connect`

`kanbo connect [agents...]`, alias `kanbo setup`. Agents: `claude`, `codex`, `cursor`, `gemini`, or `all`.

| Option | Meaning |
| --- | --- |
| `--project` | Write into this project's files only. |
| `--global` | Write into your own files, for every project. |
| `--no-instructions` | Leave the agents' instruction files alone. |
| `--no-mcp` | Leave the agents' MCP configuration alone. |
| `--check` | Print a table — agent, instructions (`current`/`outdated`/`legacy`/`edited`/`missing`), MCP (`ok`/`missing`/`stale path`), scope — and exit `1` when an agent you named is not connected. |
| `--remove` | Take the kanbo section and the `kanbo` MCP entry out again (both scopes unless `--project` or `--global` is given). |
| `--dry-run` | Print what would change, and change nothing. |
| `--yes` | Make the changes without asking. |
| `--json [fields]` | Print the result as JSON, or only these fields. |

What goes where, per agent:

| Agent | Instructions: project · `--global` | MCP: project · `--global` | MCP default |
| --- | --- | --- | --- |
| `claude` | `CLAUDE.md` · `$CLAUDE_CONFIG_DIR/CLAUDE.md` (`~/.claude/CLAUDE.md`) | `.mcp.json` · `claude mcp add --scope user` | project |
| `codex` | `AGENTS.md` · `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md`) | `.codex/config.toml` · `$CODEX_HOME/config.toml` | user: Codex reads a project's file only in a trusted project |
| `cursor` | `AGENTS.md` · none: paste the section into Cursor Settings → Rules | `.cursor/mcp.json` · `~/.cursor/mcp.json` | project |
| `gemini` | `GEMINI.md` · `$GEMINI_CLI_HOME/.gemini/GEMINI.md` (`~/.gemini/GEMINI.md`) | `.gemini/settings.json` · `~/.gemini/settings.json` (entries have no `type`) | project |

Instructions go into the project unless `--global` is given; the MCP server goes where the table's last column says unless `--project` or `--global` is given. **On Windows every MCP default is your own configuration**, written as this Node and kanbo's script (see [agents](agents.md)).

With no agents, in a terminal, `connect` asks which agents you use (the ones found on this machine or in this project are ticked), shows the kanbo section, lists each file it would change with what it is for — untick any — and asks once. Without a terminal it names the agents instead of asking (exit `1`). Named agents get the same preview and one question; `--yes` skips it, and a shell with no terminal and no `--yes` changes nothing (exit `1`).

A `kanbo` MCP entry of kanbo's own that no longer starts — a full path to a Node or script that is gone, or on Windows a bare `kanbo` in your own configuration — is rewritten. Any other `kanbo` entry is yours and left alone. A block you edited is replaced only when you answer yes in a terminal.

`--remove` takes the block out of `AGENTS.md` only when no other agent that reads it (Codex, Cursor) is still connected, that is, still has a `kanbo` MCP entry.

## `kanbo doctor`

| Option | Meaning |
| --- | --- |
| `--json` | Print `{ version, findings: [{ check, status, detail, fix? }] }`. |

Checks, each `ok`, `warn` or `fail`, with a `fix` on everything that is not `ok`:

| Check | What it looks at |
| --- | --- |
| `version` | This kanbo's version and where it runs from. |
| `path` | The first `kanbo` on `PATH` is this one (`warn` when another one shadows it, or none is on `PATH`). |
| `binding` | The nearest `.kanbo/` at or above this folder has a readable `binding.json` (`fail` when it does not; `warn` outside any project). |
| `sqlite` | `better-sqlite3` loads (a board-file project only). |
| `board` | The board opens and its schema is current (`fail` with `kanbo migrate` as the fix). A Postgres board gets 5 seconds. |
| `instructions` | Every kanbo block in the project's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` and your own files is the block this version writes. `warn` when a block was written by an older kanbo, when you edited one, or when there is no block anywhere. |
| `mcp:<client>` | Every `kanbo` registration in the files `kanbo connect` writes (and `~/.claude.json`): its `command` is on `PATH`, or its full paths exist (`fail` otherwise, fixed by `kanbo connect <agent>`). On Windows a Codex registration that starts a `.cmd` is a `warn`. `warn` when there is none. |
| `mcp:handshake` | Starts `kanbo mcp` in the project (the command a registration names), sends `initialize`, and expects server name `kanbo` with instructions, within 10 seconds. |
| `actor` | `warn` when `KANBO_ACTOR_KIND=agent` is set in this shell. |

Exits `1` when any check fails; warnings alone exit `0`. Nothing is written.

## `kanbo uninstall`

| Option | Meaning |
| --- | --- |
| `--project` | Only this project's files. |
| `--global` | Only your own user-level files. Neither flag: both. |
| `--purge` | Also delete this project's `.kanbo/binding.json`, and its board file after a confirmation that names it. |
| `--yes` | Do it without asking. Never deletes a board file. |
| `--json` | Print `{ actions: [{ path, action, note? }] }`. |

Removes the marked instruction block and the `kanbo` MCP entry from every file `kanbo connect` writes, for every agent: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` (project) and `~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md`, `~/.gemini/GEMINI.md` (global); `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json` (project) and `~/.cursor/mcp.json`, `$CODEX_HOME/config.toml`, `~/.gemini/settings.json` (global). To disconnect one agent, use `kanbo connect <agent> --remove`. Everything else in those files — your own text, other MCP servers, other TOML tables — stays. Files stay even when nothing is left in them: kanbo does not record which files it created. Claude Code's user-scope registration is removed with `claude mcp remove kanbo --scope user`, or the line is printed when `claude` is not on `PATH`.

Boards are never touched without `--purge`. With it, only the binding and a board file of the project's own (`kanbo init --file`) are candidates, and the board file is deleted only when you answer yes in a terminal to a question naming it — not with `--yes`, and never from a shell with no terminal. A host app's database and a Postgres board are never deleted. Same preview and confirmation as `kanbo init --global`.

## `kanbo capabilities`

| Option | Meaning |
| --- | --- |
| `--json` | Print the manifest as JSON. |
| `--markdown` | Print the manifest as Markdown (the default). |

Opens no board.

## `kanbo prime`

Print the columns of this board and the rules a card travels by, then the commands an agent uses (the `kanbo_prime` MCP tool leaves the commands out). Common options only.

## `kanbo ready`

| Option | Meaning |
| --- | --- |
| `--limit <count>` | How many cards to print. |

Lists To Do cards with no run and nobody's turn but the agent's, in board order.

## `kanbo columns …`

- `columns list` — common options only.
- `columns describe <column> --text <text>` — `--text` (required): what the column means.
- `columns rules <column>` — `--require <rules>`: comma-separated `checklist_complete`, `pull_request_linked`, `ci_green`, `approved`; `--clear`: ask nothing of a card entering the column. Person only.
- `columns add-standard` — adds Backlog, To Do, In Progress, In Review, Done and Canceled where missing.

## `kanbo card …`

| Command | Options |
| --- | --- |
| `card list` | `--column <column>` only cards in this column; `--limit <count>` how many. |
| `card get <card>` | — |
| `card create` | `--title <title>` (the card's own key when absent); `--description <text>`; `--column <column>` (the first column when absent); `--parent <card>` the card this one belongs under; `--execution-mode <mode>` `worktree` or `main`. |
| `card update <card>` | `--title <title>`; `--description <text>`; `--priority <priority>` one of `none`, `low`, `medium`, `high`, `urgent`; `--labels <labels>` comma-separated, replacing the current ones; `--execution-mode <mode>`. |
| `card move <card> <column>` | — |
| `card status-line <card>` | `--text <text>` (required): one sentence, present tense. |
| `card comment <card>` | `--content <text>` (required). |
| `card wait-approval <card>` | `--text <text>`: the status line to leave, saying what you need. |
| `card pr add <card> <url>` | `url` as `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`. |
| `card pr list <card>` | — |
| `card pr remove <card> <linkId>` | `linkId` as `card pr list` prints it. Anyone but a person may only remove a link it created. |

Fields `--json` can name on a card: `id`, `number`, `title`, `description`, `column`, `columnSlug`, `statusLine`, `waitingFor`, `priority`, `labels`, `executionMode`, `parentIssueId`, `attemptCount`, `activeRun` (`{ id, agentName, state, startedAt }` or `null`), `updatedAt`.

In a person's shell, `card create`, `card update` and `card move` into a column whose entry rules the card does not meet go through and print one `kanbo: warning: …` line per unmet rule; in an agent's shell they are refused with exit `1`.

## `kanbo approve <card>` and `kanbo return <card>`

- `approve`: `--comment <text>` what to say alongside the decision.
- `return`: `--comment <text>` (required) why the card is coming back; `--to <column>` the column to send it to. The value printed is `{ card, stoppedRunIds }`.

Both are person only.

## `kanbo run …`

| Command | Options |
| --- | --- |
| `run start <card>` | `--agent <name>` (required) what to call whoever is working; `--branch <branch>`; `--execution-mode <mode>` (defaults to the card's); `--session <ref>` your own log of this run, `claude:<session id>` or `codex:<session id>`. |
| `run attach-session <runId> <ref>` | `--replace` put this log in place of the one the run names — a person's own terminal only. |
| `run clear-session <runId>` | Person only. |
| `run finish <runId>` | `--state <state>` (required) one of `finished`, `failed`, `stopped`; `--error-text <text>` what went wrong, for a failed run. |

Fields `--json` can name on a run: `id`, `issueId`, `agentName`, `state`, `executionMode`, `branch`, `worktreePath`, `startedAt`, `endedAt`, `attempt`.

## `kanbo sprint …`

| Command | Options |
| --- | --- |
| `sprint list` | — |
| `sprint create` | `--title <title>` (required); `--start <date>` (required) first day, `YYYY-MM-DD` (UTC) or unix seconds; `--due <date>` (required) last day, `YYYY-MM-DD` (UTC, through its end) or unix seconds; `--description <text>`. |
| `sprint close <id>` | `--carry-to <id>` the open milestone unfinished cards move to; without it they leave the milestone. Person only. |

## `kanbo migrate`

Options: `--db`, `--database-url`, `--json`, `--format` (no `--workspace`). Applies the board's migrations to an external Postgres database, or to a board file `kanbo init --file` created. A host app's own database is refused (exit `1`). Always uses the owner's connection string, never the agent's.

## `kanbo roles print` and `kanbo roles apply`

- `roles print` takes no options and prints the SQL.
- `roles apply` takes `--db`, `--database-url`, `--json`, `--format` and runs the SQL against an external board as its owner. A board file is refused.

Run `kanbo migrate` before `kanbo roles apply`. See [storage](storage.md#roles).

## `kanbo mcp`

| Option | Meaning |
| --- | --- |
| `--db <path>` | Board database file to open. |
| `--database-url <url>` | External Postgres board to serve instead of a board file. |
| `--workspace <nameOrId>` | Workspace the board tools are about. |

Serves all sixteen tools and the `kanbo://capabilities` resources over stdio. The client is always treated as an agent. See [MCP](mcp.md).

## `kanbo serve`

| Option | Meaning |
| --- | --- |
| `--port <port>` | Port to listen on (default `4318`). |
| `--host <host>` | Address to bind (default `127.0.0.1`); anything but loopback needs a token. |
| `--db <path>` | Board database file to open. |
| `--database-url <url>` | External Postgres board to serve instead of a board file. |
| `--workspace <nameOrId>` | Workspace the server is about. |
| `--token <token>` | Bearer token every request must carry (or set `KANBO_SERVE_TOKEN`). On loopback without one, a token is generated for the run. |
| `--cors-origin <origin>` | Let a browser call from this exact origin; repeat for more. |
| `--no-open` | Print the board page link without opening it in the browser. |

See [HTTP API](http-api.md).
