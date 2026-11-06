# CLI reference

Everything here is taken from `kanbo <command> --help` of this version. These are the commands a person runs; an agent reaches the board through the MCP server (`kanbo mcp`, see [MCP reference](mcp.md)) and has no command line of its own. `kanbo --version` prints the version; `kanbo help <command>` prints the help of one command.

## Options every board command takes

Unless a command's own section says otherwise, it takes these:

| Option | Meaning |
| --- | --- |
| `--db <path>` | The board file to open. |
| `--database-url <url>` | A shared Postgres board to use instead of a board file. Only one of `--db` and `--database-url` may be given (exit `1` otherwise). |
| `--workspace <nameOrId>` | The project, when this folder is not bound to one. On a board file or Postgres board this is the project's (workspace) id. |
| `--json [fields]` | Print the result as JSON. With comma-separated fields, print only those (`--json id,title,column`); an unknown field prints a warning on stderr and is skipped. `doctor`, `uninstall`, `connect` and `init` take the same `--json [fields]`. |
| `--format <format>` | Print JSON: `json` (one line) or `pretty` (indented). |

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

`kanbo --help` lists them in four groups: *Get started* (`init`, `connect`, `doctor`, `uninstall`), *Your board* (`board`, `columns`, `approve`, `return`, `sprint`, `stats`, `serve`), *For agents* (`mcp`) and *Shared Postgres boards* (`migrate`, `roles`).

| Command | What it does |
| --- | --- |
| `kanbo` | Where to start: the init wizard in a folder with no board, the home screen in one with a board, a short hint with nobody to ask. Exits `0` after the hint, and when you leave the home screen (Exit, or Ctrl-C at the menu); in the wizard, Ctrl-C at any question or No at the last one ("Write these changes?") exits `1` with nothing written. A board file the project is bound to that has gone missing is said so (exit `2` with nobody to ask; in a terminal the wizard offers a new empty board in its place). |
| `kanbo init` | Set up a board for this project — a wizard in a terminal, defaults with `--yes`. `--connect <agents>` also registers the agents' MCP server. |
| `kanbo connect [agents...]` | Connect your agents (`claude`, `codex`, `cursor`, `gemini`, or `all`) to kanbo: register its MCP server in their own settings, for every project (`--project`: this project only). Takes out the kanbo section older versions wrote. `--check` shows what is connected, `--remove` takes it out. Alias `kanbo setup`. |
| `kanbo doctor [--fix [--yes]]` | Check that kanbo, this project's board and your agents' setup work: the install, the project settings (`.kanbo/binding.json`), the board, old instruction blocks and MCP registrations. `--fix` repairs what is kanbo's own after one confirmation, and never deletes anything. |
| `kanbo uninstall` | Remove what kanbo wrote into your agents' files: `kanbo` MCP entries and old instruction blocks. Boards stay unless `--purge`. |
| `kanbo board` | The board in this terminal: each column with its count, the cards with their status lines, what waits for you and what an agent is working on. |
| `kanbo columns` | At a terminal, the columns and a small menu to change them (add, rename, move, remove, apply a template); with nobody to ask, the same list as `columns list`. |
| `kanbo columns list` | Every column in board order, with the slug a card is moved by. |
| `kanbo columns describe <column>` | Say in one line when a card belongs in a column. |
| `kanbo columns rules <column>` | Set what a card must satisfy before an agent may move it into a column. **Person only.** |
| `kanbo columns flow <column>` | Set which columns a card may come from and how many cards the column holds. **Person only.** |
| `kanbo columns add <name>` | Add a column — before Done unless `--after`/`--before` says where. **Person only.** |
| `kanbo columns rename <column> <name>` | Give a column a new name; its slug follows the name. To Do keeps its slug. **Person only.** |
| `kanbo columns move <column>` | Move a column: `--first`, `--last`, `--before <column>` or `--after <column>`. **Person only.** |
| `kanbo columns remove <column>` | Remove a column, moving its cards to `--move-cards-to <column>`. To Do stays. **Person only.** |
| `kanbo columns template <template>` | Put `standard`, `simple` or `review-qa` on an empty board, or with `--add-missing` add the template's columns the board lacks. **Person only.** |
| `kanbo columns add-standard` | Add any of the standard columns this board is missing — `columns template standard --add-missing`. **Person only.** |
| `kanbo approve <card>` | Accept the work on a card that is waiting for you. **Person only.** |
| `kanbo return <card>` | Send a card back a column, with the reason on it. **Person only.** |
| `kanbo sprint list` | List sprints by start date; the current one is marked `*`. |
| `kanbo sprint create` | Start a sprint with a first and a last day. |
| `kanbo sprint close <id>` | Close a sprint and move its unfinished cards on to another open sprint. **Person only.** |
| `kanbo stats` | How work flows on this board over a range: cycle and lead time, cards finished per week, work in progress, aging cards, time in column, returns, attempts, and one line per agent and per person. `--json` adds the cumulative flow by day. |
| `kanbo migrate` | Create or update the board's tables after an upgrade — a board file or a shared Postgres board. |
| `kanbo roles print` | Print the SQL that creates the Postgres logins that keep agents from approving their own work, and their rights. |
| `kanbo roles apply` | Run that SQL on the shared board, as its owner. |
| `kanbo mcp` | Run the board's MCP server for an agent, over stdio (the agent starts it itself). |
| `kanbo serve` | Open the board in your browser: serves it over HTTP, with a board page. |

**Person only** commands refuse with exit `4` in an agent's shell: `KANBO_ACTOR_KIND=agent`, or a mark Claude Code, Codex, Gemini CLI or Cursor leaves ([configuration](configuration.md#agent-shells-kanbo-recognises)). The refusal is two lines: `Only a person can …. This shell belongs to an agent (<mark>): ask a person to … on the board page (kanbo serve).`, then `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo <the command as typed>` (on Windows: `If you are a person in an editor terminal, run in PowerShell: $env:KANBO_ACTOR_KIND='person'; kanbo <the command as typed>`), each word quoted for that shell — a way through for a person whose own terminal carries an agent tool's mark, but nothing stops an agent from setting it too: this check keeps an honest agent from approving its own work, it does not stop one that tries. Real enforcement needs a shared Postgres board with agents on the agent role ([storage](storage.md#roles)). See [agents](agents.md#agents-and-people).

## `kanbo`

`kanbo` with no words is where to start. What it does depends on the folder and on who is asking:

- **A person at a terminal, no board here:** the init wizard — exactly `kanbo init` (below).
- **A person at a terminal, a board here:** the home screen. A header (`kanbo · weather-station (WST) · .kanbo/board.db`), one line with the number of cards in each column (Canceled only when it has cards), `N cards waiting for you` when any are, and your agents — those found on this machine or already connected — with whether each is connected (`Claude Code ✓ connected · Cursor — not connected`, from the same check as `kanbo connect --check`). Then **What next?**, where every item shows the command it runs:
  - *Review the cards waiting for you* (only when there are any) — one card at a time: its key, title, column, status line and last comment, then *Approve*, *Send back with a comment* (asks for it; the agent reads it first), *Skip* or *Stop reviewing*. The same as `kanbo approve` and `kanbo return`.
  - *Show the board here* — `kanbo board` (below).
  - *Open the board in your browser* — `kanbo serve`, in the foreground: it prints `Board open at <url> — press Ctrl-C to stop and return to the menu`, and Ctrl-C stops the server and brings the menu back.
  - *Add a card* — asks what it is about and puts it in To Do.
  - *Connect an agent* — `kanbo connect`.
  - *Change columns* — `kanbo columns`: its menu (below).
  - *Check the setup* — `kanbo doctor`. *Exit*.

  After each item the home screen comes back with fresh counts. Exit, or Ctrl-C at the menu, leaves with exit `0`; Ctrl-C inside an item goes back to the menu.
- **Nobody to ask** (no terminal, `CI` set, `TERM=dumb`, or an agent's shell): no question, exit `0`. With no board it prints

  ```
  This folder has no kanbo board yet.
  Set one up with the defaults (board file in .kanbo/, no agent files touched):  kanbo init --yes
  Also connect Claude Code:  kanbo init --yes --connect claude
  ```

  and in an agent's shell the first two lines are `This folder has no kanbo board yet. Ask a person to run kanbo here.` and `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo` (on Windows, the PowerShell form: `… run in PowerShell: $env:KANBO_ACTOR_KIND='person'; kanbo`). With a board it prints the header, the column counts, the waiting count and the agents as plain lines, ending `More: kanbo --help`.

Any other word is a command: `kanbo frobnicate` still fails with `unknown command` (exit `1`) and suggests the nearest one (`kanbo conect` → `Did you mean connect?`). `kanbo --help` prints the help.

## `kanbo init`

Set up a board for this project. Writes `.kanbo/binding.json` (mode `0600`) and `.kanbo/.gitignore`, creates the board, and — when you connect agents — registers kanbo's MCP server in their own settings, as `kanbo connect` does. It writes no instruction file. Running it again merges into the existing binding and changes nothing that is already current.

### In a terminal: the wizard

Without `--yes` (and without `--json`/`--format`), in a terminal, `init` asks one question at a time:

1. **Where should the board be set up?** — only when the folder is inside a git repository but not its root: the repository root (recommended) or only this folder.
2. **Where should the board live?** — *In this project* (the file `.kanbo/board.db`; nothing to run or host) or *In a shared Postgres database* (for a team; Supabase works). For Postgres it asks for the connection string (hidden; stored only in `.kanbo/binding.json`, which git never sees), the workspace id (default: the folder name), and whether to create the board's tables now (`kanbo migrate`), and warns that agents reach the board with that owner's connection string until you set up roles.
3. **Card numbers start with** — suggested from the folder name (`todo-list` → `TLI`); a letter and two letters or digits.
4. **Which columns should the board start with?** — *Standard* (Backlog → To Do → In Progress → In Review → Done · Canceled), *Simple* (To Do → In Progress → Done), *Review + QA* (… In Review → QA → Done), or *Custom*: pick from Backlog, To Do, In Progress, In Review, QA, Blocked, Done, Canceled, add columns of your own, and give each one line saying when a card belongs there — agents read it. To Do is always there: agents take work from it.
5. **Which coding agents do you use here?** — Claude Code, Codex, Cursor, Gemini CLI; the ones found on this machine or in the project that have no kanbo registration yet are ticked.
6. **Connect them now?** — *Yes* (register kanbo's MCP server for them, for every project) or *Not now* (the board only — later: `kanbo connect`). Questions 5 and 6 are asked only when an agent found here has no kanbo MCP registration; when every one has, the wizard says `Your agents already reach kanbo through its MCP server.` and asks nothing.
7. **Add a first card?** — optional; it goes in To Do.
8. The full list of changes, then **Write these changes?** — nothing, not even the binding, is written before this yes. At the end: what was done, and what to do next.

A question a flag already answers is not asked. In a project that already has a board, the board questions (1–4) are skipped and the wizard goes straight to the agents — a project bound to a shared Postgres board included: its workspace and key come from the binding. When `--database-url` or `KANBO_DATABASE_URL` names a shared board and the project has no binding yet, question 2 is settled but the workspace id, the tables question and the key are still asked.

What is already there is not asked about again. A shared board's workspace that already has cards keeps their key (`This board already numbers its cards WEA-001, … — new cards go on from there.`); one that already has columns keeps them (`This workspace already has its columns.`); when the board's tables are there, the tables question is skipped (the migration is run, which changes nothing on a current board). A `.kanbo/board.db` that is there without a binding keeps its cards' key and its columns. Without a terminal the same holds: `init --database-url … --workspace …` without `--key` takes the key from the workspace's cards, and is refused (exit `2`) only when the workspace has none. Ctrl-C at any question prints `Cancelled — nothing was written.` and exits `1`; the folder is left exactly as it was.

A warning is shown when agents could not start `kanbo mcp`: kanbo running from npx, or not on `PATH` (`npm install -g kanbo-cli`).

### Without a terminal, or with `--yes`

No questions. When nothing names a board — no `--db`/`--database-url`, no `KANBO_DATABASE_URL`, no binding at or above the folder — `init` creates a board file of the project's own, exactly like `--file`, with the standard columns and the card key suggested from the folder name (a project already bound keeps its key). `KANBO_DB_PATH` does not count: it names an app's own database for the commands the app starts, and a plain `kanbo init` makes the project's own board whatever it says; only `kanbo init --db <path>` binds a project to an app's database. No agent settings are touched unless `--connect` says so — and even then only with `--yes`: without it (an agent's shell, a script, `--json`) `init` sets up the board, leaves every agent as it is, and says `Not connecting agents without a yes: run kanbo connect <agents> --yes`. The output ends with how to connect them later (`kanbo connect <agent>`).

| Option | Meaning |
| --- | --- |
| `--file [path]` | Use a board file of this project's own instead of a host database or an external board (default `.kanbo/board.db`). Creates and migrates the file, and puts the columns into a new one. What a plain `kanbo init` does when nothing names a board. |
| `--database-url <url>` | External Postgres board to bind this project to. Needs a workspace id and a card key (`--workspace`, `--key`). |
| `--migrate` | With `--database-url`: create the board's tables now, as `kanbo migrate` does, and put the columns on the new board. |
| `--db <path>` | Host database file to read this project's workspace from (for a board that lives inside another app's SQLite database). The only way to bind a project to an app's database. |
| `--workspace <nameOrId>` | Workspace this project is. With `--file` and no binding yet, defaults to the folder name. |
| `--key <KEY>` | What card numbers start with (`APP` in `APP-001`): a letter and two letters or digits. The same as `--identifier`, checked. For a new board file it defaults to a key suggested from the folder name. |
| `--identifier <key>` | The same, unchecked (kept for 0.2 scripts). |
| `--columns <columns>` | The columns a new board starts with: `standard` (default), `simple`, `review-qa`, or a comma-separated list in board order that includes To Do — ready-made names (`QA`, `Blocked`, …) or your own. Ignored for a board that already exists. |
| `--connect <agents>` | Connect these agents as `kanbo connect <agents>` does: `claude`, `codex`, `cursor`, `gemini`, `all`, or `none`; comma-separated. |
| `--first-card <title>` | Put a first card in To Do. |
| `--agent-url <url>` | The connection string agents get, when it is not the one above (see [storage](storage.md#roles)). |
| `--board <id>` | The board inside the workspace, when it has more than one. |
| `--yes` | Take the defaults instead of asking. |
| `--json [fields]`, `--format <format>` | Output, as everywhere. No wizard. |

The wizard's answers and the equivalent flags plan exactly the same changes. `--connect` plans what `kanbo connect <agents>` plans; an MCP entry named `kanbo` that already exists is left alone, unless it is kanbo's own and no longer starts.

`--file` together with `--database-url` is refused (exit `1`).

## `kanbo connect`

`kanbo connect [agents...]`, alias `kanbo setup`. Agents: `claude`, `codex`, `cursor`, `gemini`, or `all`.

Registers kanbo's MCP server with the agents, in their own settings by default so one registration serves every project, and takes out the kanbo section older versions wrote into their instruction files. It writes no instruction file.

| Option | Meaning |
| --- | --- |
| `--project` | Write into this project's files only (`.mcp.json`, `.cursor/mcp.json`, …). |
| `--global` | Write into your own settings, for every project — the default, spelled out. |
| `--check` | Print a table — agent, MCP (`ok`/`missing`/`stale path`/`yours`/`yours, won't start`), scope — and a line `old kanbo section in <path> — kanbo connect removes it` for every file that still carries one; exit `1` when an agent you named is not connected. An entry of your own is reported as "your own kanbo entry — left as is". |
| `--remove` | Take the `kanbo` MCP entry and any kanbo section out again (both scopes unless `--project` or `--global` is given). |
| `--dry-run` | Print what would change, and change nothing. |
| `--yes` | Make the changes without asking. |
| `--json [fields]` | Print the result as JSON, or only these fields. |

Where the MCP server goes, per agent:

| Agent | Your own settings (default) · `--project` |
| --- | --- |
| `claude` | `claude mcp add --scope user` · `.mcp.json` |
| `codex` | `$CODEX_HOME/config.toml` (`~/.codex/config.toml`) · `.codex/config.toml` (Codex reads it only in a trusted project) |
| `cursor` | `~/.cursor/mcp.json` · `.cursor/mcp.json` |
| `gemini` | `~/.gemini/settings.json` (entries have no `type`) · `.gemini/settings.json` |

On Windows the entry in your own settings is written as this Node and kanbo's script (see [agents](agents.md)).

With no agents, in a terminal, `connect` asks which agents you use (the ones found on this machine or in this project are ticked), lists each change with what it is for — untick any — and asks once. Without a terminal it names the agents instead of asking (exit `1`). Named agents get the same preview and one question; `--yes` skips it, and a shell with no terminal and no `--yes` changes nothing (exit `1`).

#### What kanbo changes, and what it leaves alone

kanbo changes only what it wrote itself, in exactly the shape it wrote it. Anything else it shows you and asks about; it never rewrites or deletes it silently.

- **MCP entries.** kanbo's own `kanbo` entry is `{"command": "kanbo", "args": ["mcp"]}` (with `"type": "stdio"` or without, and with the empty `env` Claude Code adds itself), or a Node by full path running kanbo's own script — `{"command": "C:\\…\\node.exe", "args": ["C:\\…\\kanbo-cli\\dist\\cli.cjs", "mcp"]}` — with no other field: no `env` variable, no `cwd`, no `[mcp_servers.kanbo.env]` table. Only such an entry that no longer starts (a Node or script that is gone; on Windows, a bare `kanbo` in your own configuration) is rewritten, and only its `command` and `args` change. Any other `kanbo` entry — `cmd /c kanbo mcp`, `npx -y kanbo-cli mcp`, one with an `env` variable — is yours: `connect` leaves it as it is and says so, and `--remove`/`uninstall` take it out only on `--yes` or a yes in a terminal (default no).
- **Old instruction sections.** A section between kanbo's own start and end comment markers that kanbo 0.1–0.6 wrote — current, from an older version, or a 0.1–0.2 block whose text is word for word one those versions wrote — is removed from the agent's file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, in the project and in your own files), and the rest of the file is kept byte for byte. One you edited, a text you chose (`k=orchestrator` on the marker) or one a newer kanbo wrote is kept, with the note `an old kanbo section is still there; kanbo no longer uses it. Delete it yourself.`. (`kanbo connect --remove --yes` would remove it too, but it also unregisters the MCP server.)
- **Markers that do not pair up** — a start without an end, an end without a start, a start inside another block — make the file one kanbo does not write to or remove anything from: `connect`, `init` and `uninstall` skip it with "CLAUDE.md has a kanbo start marker without an end — fix it by hand, then run again", and `doctor` fails it with the same text.
- **From npx.** A kanbo run from npm's npx cache does not register itself by full path in your own settings — that path is gone once the command ends. It says "Install kanbo first so agents can start it: npm install -g kanbo-cli" instead.

`--remove` takes the section out of `AGENTS.md` only when every agent that reads it (Codex, Cursor) is removed in the same command — `kanbo connect codex cursor --remove`, or `kanbo connect --remove` with no agents, which removes kanbo from all of them. Otherwise it keeps it and says `AGENTS.md section kept — Cursor also reads it. Remove it with: kanbo connect cursor --remove`.

When a `kanbo` entry in Claude Code's user settings is rewritten, kanbo runs `claude mcp remove` and then `claude mcp add`. If the `add` fails after the `remove` ran, it says the old entry was removed and prints only the `add` command, on a line of its own — each command it hands you is on its own line, so it pastes into any shell, PowerShell included.

## `kanbo doctor`

| Option | Meaning |
| --- | --- |
| `--fix` | After the checks, fix every finding kanbo can fix (see below): show the plan, ask once (default Yes), apply, then run the checks again and print them. |
| `--yes` | With `--fix`: apply without asking. |
| `--json [fields]` | Print `{ version, findings: [{ check, status, detail, fix?, fixable }] }`; with fields, only those (`--json findings`). `fixable` is `true` when `--fix` would fix it. With `--fix`, the plan and what was done go to stderr and the JSON is the findings after the fixes. |

Checks, each `ok`, `info`, `warn` or `fail`, with a `fix` on everything that is not `ok`:

| Check | What it looks at |
| --- | --- |
| `version` | This kanbo's version and where it runs from. |
| `update` | `info` when npm has a newer kanbo (the run's own [update check](configuration.md#update-check), with its skips — none with `--json`; `--fix` reports the same answer twice rather than asking again); the fix is `npm install -g kanbo-cli@latest`. Only shown when there is one. |
| `install` | `warn` when this kanbo runs from npx's cache: agents cannot start it. Install it globally (`npm install -g kanbo-cli`). Only shown then. |
| `path` | The first `kanbo` on `PATH` is this one (`warn` when another one shadows it, or none is on `PATH`). |
| `settings` | The nearest `.kanbo/` at or above this folder has readable project settings (`binding.json`) (`fail` when it does not; `warn` outside any project). |
| `sqlite` | `better-sqlite3` loads (a board-file project only). |
| `board` | The board opens and its schema is current (`fail` with `kanbo migrate` as the fix). A Postgres board gets 5 seconds. |
| `columns` | `warn` when the board (a board file of the project's own, or a Postgres board) has no columns — boards from kanbo 0.1–0.2 got them only with the first card. Only shown then. |
| `instructions` | Files that still carry a kanbo section from an older version (the project's and your own `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`). Only files with one are reported: `warn` with `an old kanbo section — agents now learn the board from the MCP server`, fixed by `--fix` when kanbo wrote it and nobody changed it; a section you edited or chose, or a newer kanbo wrote, is yours to delete; `fail` when a file's markers do not pair up. |
| `mcp:<client>` | Every `kanbo` registration in the files `kanbo connect` writes (and `~/.claude.json`): its `command` is on `PATH`, or its full paths exist (`fail` otherwise, fixed by `kanbo connect <agent>`). On Windows a Codex registration that starts a `.cmd` is a `warn`. `warn` (`No coding agent reaches kanbo: its MCP server is registered nowhere.`, fix `kanbo connect claude --yes`) when there is none anywhere. |
| `mcp:handshake` | Starts `kanbo mcp` in the project (the command a registration names), sends `initialize`, and expects server name `kanbo` with instructions, within 10 seconds. |
| `actor` | `warn` when this shell is an agent's: `KANBO_ACTOR_KIND=agent`, or an agent tool's mark (named in the detail). |

Exits `1` when any check fails; warnings alone exit `0`. Without `--fix`, nothing is written.

**`--fix`** fixes only these, and only what is kanbo's own by the same rules `kanbo connect` follows:

| Finding | What `--fix` does |
| --- | --- |
| `instructions`: a section an older kanbo wrote (including the 0.1–0.2 one) | Removes it, as `kanbo connect <agent> --yes` would. A section you edited, a text you chose, one from a newer kanbo and a file whose markers do not pair up are left alone (the finding says why). |
| `mcp:<client>`: kanbo's own registration that no longer starts — its Node or script moved (the Windows form), or on Windows a bare `kanbo` in Codex's own settings | Rewrites the entry as `kanbo connect <agent>` would in that scope (for Claude Code's own settings: `claude mcp remove`, then `claude mcp add`). An entry of your own is never changed. |
| `columns`: a board with no columns | Adds the Standard columns (Backlog, To Do, In Progress, In Review, Done, Canceled). |
| `board`: a board file of the project's own that a newer kanbo's migration has not reached yet | Runs `kanbo migrate` on it; the plan names the file. A host app's database, a file of another epoch and a Postgres board are not migrated. |

The plan looks like this:

```text
kanbo doctor --fix will:
  remove CLAUDE.md (the old kanbo section: agents now learn the board from the MCP server)
  add    the Standard columns to the board: Backlog, To Do, In Progress, In Review, Done, Canceled
Nothing is deleted, and nothing else is changed.
```

Nothing is ever deleted. With nobody to ask (no terminal, CI, an agent's shell) and no `--yes`, it prints the plan and `Run kanbo doctor --fix --yes to apply.`, changes nothing, and exits `1` if a check failed. Every other finding keeps its `fix` text; where `--fix` covers it, that text names `kanbo doctor --fix` first.

## `kanbo uninstall`

| Option | Meaning |
| --- | --- |
| `--project` | Only this project's files. |
| `--global` | Only your own user-level files. Neither flag: both. |
| `--purge` | Also delete this project's `.kanbo/binding.json`, and its board file after a confirmation that names it. |
| `--yes` | Do it without asking. Never deletes a board file. |
| `--json [fields]` | Print `{ actions: [{ path, action, note? }], notes }`; with fields, only those. |

Removes the `kanbo` MCP entry from every file `kanbo connect` writes, and any old marked instruction block from the agents' files, for every agent: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` (project) and `~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md`, `~/.gemini/GEMINI.md` (global); `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json` (project) and `~/.cursor/mcp.json`, `$CODEX_HOME/config.toml`, `~/.gemini/settings.json` (global). To disconnect one agent, use `kanbo connect <agent> --remove`. Everything else in those files — your own text, other MCP servers, other TOML tables — stays. Files stay even when nothing is left in them: kanbo does not record which files it created. Claude Code's user-scope registration is removed with `claude mcp remove kanbo --scope user`, or the line is printed when `claude` is not on `PATH`. A block or `kanbo` entry that is not in the shape kanbo writes is asked about first (`--yes` answers it); a file whose markers do not pair up is left exactly as it is.

Boards are never touched without `--purge`. With it, only the binding and a board file of the project's own (`kanbo init --file`) are candidates, and the board file is deleted only when you answer yes in a terminal to a question naming it — not with `--yes`, and never from a shell with no terminal. A host app's database and a Postgres board are never deleted. Same preview and confirmation as `kanbo connect`.

## `kanbo board`

The board in the terminal, one column after another in board order (stacked, so it reads the same in a narrow terminal or a Windows console):

```
In Progress (1)
  WOR-002  Add a dark theme that follows the system setting…  [running: claude]
           writing the toggle; the colours are done, the Settings page is next…

In Review (1)
  WOR-003  Fix the login form  [waiting for you]
           login fixed, please check

Done (7)
  WOR-006  Finished task 3
  …
  … 2 more — kanbo board --all
```

Each card is its key and title (the first line of its description when it has no title of its own), its status line dimmed under it, `[waiting for you]` when it waits for a person and `[running: <agent>]` while a run is going on. Lines are cut to the terminal's width (80 when the output is not a terminal), measured as the terminal draws them: CJK and emoji take two columns. Escape sequences and control characters a card carries are never printed, here. An empty Canceled column is left out; Done and Canceled show the 5 cards changed last. Colour only in a terminal, never with `NO_COLOR`.

| Option | |
| --- | --- |
| `--column <column>` | Only this column, by slug, name or id. |
| `--all` | Every card of Done and Canceled. |
| `--json [fields]` | The same sections as JSON — `name`, `slug`, `category`, `count` (every card in the column) and `cards` (those shown, as `--json` prints a card); with a list, only those fields of each section. |

Plus `--db`, `--database-url`, `--workspace` and `--format`.

## `kanbo columns …`

- `columns list` — common options only.
- `columns describe <column> --text <text>` — `--text` (required): what the column means.
- `columns rules <column>` — `--require <rules>`: comma-separated `checklist_complete`, `pull_request_linked`, `ci_green`, `approved`; `--clear`: ask nothing of a card entering the column. Person only.
- `columns flow <column>` — `--from <columns>`: comma-separated columns a card may enter this one from, by slug, name or id, or `any` for every column; `--wip <count>`: the most cards it holds (1 or more), or `none`. An option left out keeps what the column has. An agent moving a card against them is refused with one line per rule; a person is warned. A new board's Done accepts cards from `in_review` only (a Review + QA board's from `in_review` and `qa`). Person only.
- `columns add <name>` — `--after <column>` or `--before <column>`: where it goes (neither: before the first completed column, Done, or before Canceled); `--description <text>`: when a card belongs in it, one line agents read; `--category <category>`: `backlog`, `unstarted`, `started` (default), `completed` or `canceled`. A ready-made name (`QA`, `Blocked`, …) brings its own line and category. A name whose slug another column has is refused.
- `columns rename <column> <name>` — the slug follows the new name, so a name another column's slug already answers to is refused. **To Do can't be renamed away from its slug `to_do`**: `kanbo_ready` takes work from the column with that slug, and agents would find no cards to take. Another spelling (`To-do`, `TO DO`) is fine. Agents read column names from `kanbo_prime`, so a rename reaches them there.
- `columns move <column>` — exactly one of `--first`, `--last`, `--before <column>`, `--after <column>`.
- `columns remove <column>` — `--move-cards-to <column>`: where the cards in it go. A column that holds cards is not removed without it — at a terminal kanbo asks which column, then *Remove column In Review and move 3 cards to To Do?* (default No); elsewhere it stops with the count and the command to type. The cards move in the same write as the removal, each card's history recording the move; a card waiting for a person keeps waiting, and a card entering a column without meeting its entry rules is warned about as when an agent moves a card there. **To Do can't be removed.**
- `columns template <template>` — `standard`, `simple` or `review-qa`. On a board with no columns, puts the template on as it is; on a board with columns, only with `--add-missing`, which adds the template's columns the board lacks, each after the template column before it. A template never takes a column away; running it twice changes nothing.
- `columns add-standard` — the same as `columns template standard --add-missing`: adds Backlog, To Do, In Progress, In Review, Done and Canceled where missing.
- `kanbo columns` alone — at a terminal: the columns, then *What would you like to change?* — *Add a column*, *Rename a column*, *Move a column*, *Remove a column*, *Apply a template* (its missing columns), *Done* — each naming the command it runs, back after each change. Ctrl-C at the menu leaves; inside an item it goes back to the menu. With nobody to ask it prints the list. Takes no options: the board comes from the folder, `KANBO_DB_PATH` or `KANBO_DATABASE_URL`.

All of these but `list` and `describe` are **person only**: in an agent's shell they stop with exit `4` and change nothing.

## `kanbo approve <card>` and `kanbo return <card>`

- `approve`: `--comment <text>` what to say alongside the decision.
- `return`: `--comment <text>` (required) why the card is coming back; `--to <column>` the column to send it to. The value printed is `{ card, stoppedRunIds }`.

Both are person only.

## `kanbo sprint …`

| Command | Options |
| --- | --- |
| `sprint list` | — |
| `sprint create` | `--title <title>` (required); `--start <date>` (required) first day, `YYYY-MM-DD` (UTC) or unix seconds; `--due <date>` (required) last day, `YYYY-MM-DD` (UTC, through its end) or unix seconds; `--description <text>`. |
| `sprint close <id>` | `--carry-to <id>` the open sprint unfinished cards move to; without it they leave the sprint. Person only. |

## `kanbo stats`

| Option | Meaning |
| --- | --- |
| `--from <date>` | First day, `YYYY-MM-DD` (UTC) or unix seconds. Left out: the Monday that makes the range the last 12 ISO weeks, this one included. |
| `--to <date>` | Last day, `YYYY-MM-DD` (UTC, through its end) or unix seconds. Left out, or later than now: now. |
| `--sprint <id>` | Only the cards of this sprint (`kanbo sprint list`), over its own dates unless `--from` or `--to` says otherwise; prints planned against done. |

Reading only, so an agent may run it. `--json` prints the whole `BoardMetrics` value (`--json cycleTime,throughput` picks fields). The cumulative flow, cards per column at the end of each UTC day, is in `--json` only.

What the numbers mean:

- **Started**: a card's first move into a `started` column, or its creation when it was created in one. **Finished**: its latest move into a `completed` column, for a card still in one. A card reopened since is not finished.
- **Cycle time** = finished − started, **lead time** = finished − created, over the cards finished in the range. They are shown as p50 and p85, by nearest rank: p85 of 20 cards is the 17th shortest.
- **Throughput**: cards finished per ISO week (Monday 00:00 UTC). **In progress**: cards in `started` columns now, against each column's limit (`kanbo columns flow`). **Aging**: those cards, oldest first, marked when older than the range's cycle-time p85.
- A card moved to no column is not seen leaving its last column (the column-change feed has no "to no column" entry), so the cumulative flow keeps it in that column until it is placed again; WIP reads the card's current column and leaves it out.
- **Time in column**: the time the finished cards spent in each column before they finished. A column deleted since is left out.
- **Returns** are moves back to an earlier column that is unstarted or started (To Do, In Progress, In Review on the standard board), by anyone: a person's `kanbo return`, an agent sending a card back, an outside script reopening one. They are split by people, agents and outside writers. A move back into Backlog is not a return. **First pass** = finished cards never returned ÷ finished cards. **Attempts** = runs per finished card.
- **Canceled** cards (in a `canceled` column now) are counted on their own line and left out of every other number.
- **Agents**: runs started in the range and how they ended, the median run, the finished cards each one ran, and how many of those came back. **People**: cards created, approvals, returns and moves in the range (creating a card is not a move).

## `kanbo migrate`

Options: `--db`, `--database-url`, `--json`, `--format` (no `--workspace`). Applies the board's migrations to an external Postgres database, or to a board file `kanbo init --file` created. A host app's own database is refused (exit `1`). Always uses the owner's connection string, never the agent's.

## `kanbo roles print` and `kanbo roles apply`

- `roles print` takes no options and prints the SQL.
- `roles apply` takes `--db`, `--database-url`, `--json`, `--format` and runs the SQL against an external board as its owner. A board file is refused.

Run `kanbo migrate` before `kanbo roles apply`. See [storage](storage.md#roles).

## `kanbo mcp`

| Option | Meaning |
| --- | --- |
| `--db <path>` | The board file to open. |
| `--database-url <url>` | External Postgres board to serve instead of a board file. |
| `--workspace <nameOrId>` | Workspace the board tools are about. |

Serves all seventeen tools and the `kanbo://capabilities` resources over stdio. The client is always treated as an agent. See [MCP](mcp.md). In a folder with no board it starts anyway: the client connects and gets the instructions, and every tool answers that this folder has no kanbo board, until one is set up there — the next call then finds it.

## `kanbo serve`

| Option | Meaning |
| --- | --- |
| `--port <port>` | Port to listen on (default `4318`). |
| `--host <host>` | Address to bind (default `127.0.0.1`); anything but loopback needs a token. |
| `--db <path>` | The board file to open. |
| `--database-url <url>` | External Postgres board to serve instead of a board file. |
| `--workspace <nameOrId>` | Workspace the server is about. |
| `--token <token>` | Bearer token every request must carry (or set `KANBO_SERVE_TOKEN`). On loopback without one, a token is generated for the run. |
| `--cors-origin <origin>` | Let a browser call from this exact origin; repeat for more. |
| `--no-open` | Print the board page link without opening it in the browser. |

See [HTTP API](http-api.md).
