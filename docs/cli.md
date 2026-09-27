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
| `kanbo` | Where to start: the init wizard in a folder with no board, the home screen in one with a board, a short hint with nobody to ask. Always exits `0`. |
| `kanbo init` | Set up a board for this project and connect its agents — a wizard in a terminal, defaults with `--yes`. With `--global`, set up your own agent tools for every project instead. |
| `kanbo connect [agents...]` | Connect your agents (`claude`, `codex`, `cursor`, `gemini`, or `all`) to kanbo: the kanbo section in their instructions and the board's MCP server. `--check` shows what is connected, `--remove` takes it out. Alias `kanbo setup`. |
| `kanbo instructions [kind]` | Print the text to give an agent: `agent` (default, the full rules), `short`, `global`, `orchestrator`, `mcp` or `board`. `--copy` also puts it on the clipboard. No board needed except for `board`. |
| `kanbo doctor` | Check this install, this project's binding and board, instruction blocks and MCP registrations. |
| `kanbo uninstall` | Remove what `kanbo init` wrote: instruction blocks and `kanbo` MCP entries. Boards stay unless `--purge`. |
| `kanbo capabilities` | The board's tools, commands, rules and limits — machine-readable, no board needed. |
| `kanbo prime` | Print the columns of this board and the rules a card travels by. |
| `kanbo board` | The board in this terminal: each column with its count, the cards with their status lines, what waits for you and what an agent is working on. |
| `kanbo ready` | Cards that are spelled out, unclaimed and nobody else's turn. |
| `kanbo columns` | At a terminal, the columns and a small menu to change them (add, rename, move, remove, apply a template); with nobody to ask, the same list as `columns list`. |
| `kanbo columns list` | Every column in board order, with the slug a card is moved by. |
| `kanbo columns describe <column>` | Say in one line when a card belongs in a column. |
| `kanbo columns rules <column>` | Set what a card must satisfy before an agent may move it into a column. **Person only.** |
| `kanbo columns add <name>` | Add a column — before Done unless `--after`/`--before` says where. **Person only.** |
| `kanbo columns rename <column> <name>` | Give a column a new name; its slug follows the name. To Do keeps its slug. **Person only.** |
| `kanbo columns move <column>` | Move a column: `--first`, `--last`, `--before <column>` or `--after <column>`. **Person only.** |
| `kanbo columns remove <column>` | Remove a column, moving its cards to `--move-cards-to <column>`. To Do stays. **Person only.** |
| `kanbo columns template <template>` | Put `standard`, `simple` or `review-qa` on an empty board, or with `--add-missing` add the template's columns the board lacks. **Person only.** |
| `kanbo columns add-standard` | Add any of the standard columns this board is missing — `columns template standard --add-missing`. **Person only.** |
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

**Person only** commands refuse with exit `4` in an agent's shell: `KANBO_ACTOR_KIND=agent`, or a mark Claude Code, Gemini CLI or Cursor leaves ([configuration](configuration.md#agent-shells-kanbo-recognises)). `KANBO_ACTOR_KIND=person` overrides the mark — meant for your own terminal that an agent tool marked, but nothing stops an agent from setting it too: this check keeps an honest agent from approving its own work, it does not stop one that tries. Real enforcement needs a shared Postgres board with agents on the agent role ([storage](storage.md#roles)). See [agents](agents.md#agents-and-people).

## `kanbo`

`kanbo` with no words is where to start. What it does depends on the folder and on who is asking:

- **A person at a terminal, no board here:** the init wizard — exactly `kanbo init` (below).
- **A person at a terminal, a board here:** the home screen. A header (`kanbo · weather-station (WST) · .kanbo/board.db`), one line with the number of cards in each column (Canceled only when it has cards), `N cards waiting for you` when any are, and your agents — those found on this machine or already connected — with how each is connected (`Claude Code ✓ instructions + MCP · Codex ✓ MCP only · Cursor — not connected`, from the same check as `kanbo connect --check`). Then **What next?**, where every item shows the command it runs:
  - *Review the cards waiting for you* (only when there are any) — one card at a time: its key, title, column, status line and last comment, then *Approve*, *Send back with a comment* (asks for it; the agent reads it first), *Skip* or *Stop reviewing*. The same as `kanbo approve` and `kanbo return`.
  - *Show the board here* — `kanbo board` (below).
  - *Open the board in your browser* — `kanbo serve`.
  - *Add a card* — asks what it is about and puts it in To Do (`kanbo card create`).
  - *Connect an agent* — `kanbo connect`. *Get the agent instructions* — `kanbo instructions`.
  - *Change columns* — `kanbo columns`: its menu (below).
  - *Check the setup* — `kanbo doctor`. *Exit*.

  After each item the home screen comes back with fresh counts. Exit, or Ctrl-C at the menu, leaves with exit `0`; Ctrl-C inside an item goes back to the menu.
- **Nobody to ask** (no terminal, `CI` set, `TERM=dumb`, or an agent's shell): no question, exit `0`. With no board it prints

  ```
  This folder has no kanbo board yet.
  Set one up with the defaults (board file in .kanbo/, no agent files touched):  kanbo init --yes
  Also connect Claude Code:  kanbo init --yes --connect claude
  ```

  and in an agent's shell the first line is `This folder has no kanbo board yet. Ask a person to run kanbo here.` With a board it prints the header, the column counts, the waiting count and the agents as plain lines, ending `More: kanbo --help`.

Any other word is a command: `kanbo frobnicate` still fails with `unknown command` (exit `1`) and suggests the nearest one (`kanbo conect` → `Did you mean connect?`). `kanbo --help` prints the help.

## `kanbo init`

Set up a board for this project, and tell its agents about it. Writes `.kanbo/binding.json` (mode `0600`) and `.kanbo/.gitignore`, creates the board, and — when you connect agents — the kanbo section in their instruction files and their MCP registrations. Running it again merges into the existing binding and changes nothing that is already current.

### In a terminal: the wizard

Without `--yes` (and without `--json`/`--format`), in a terminal, `init` asks one question at a time:

1. **Where should the board be set up?** — only when the folder is inside a git repository but not its root: the repository root (recommended) or only this folder.
2. **Where should the board live?** — *In this project* (the file `.kanbo/board.db`; nothing to run or host) or *In a shared Postgres database* (for a team; Supabase works). For Postgres it asks for the connection string (hidden; stored only in `.kanbo/binding.json`, which git never sees), the workspace id (default: the folder name), and whether to create the board's tables now (`kanbo migrate`), and warns that agents reach the board with that owner's connection string until you set up roles.
3. **Card numbers start with** — suggested from the folder name (`todo-list` → `TLI`); a letter and two letters or digits.
4. **Which columns should the board start with?** — *Standard* (Backlog → To Do → In Progress → In Review → Done · Canceled), *Simple* (To Do → In Progress → Done), *Review + QA* (… In Review → QA → Done), or *Custom*: pick from Backlog, To Do, In Progress, In Review, QA, Blocked, Done, Canceled, add columns of your own, and give each one line saying when a card belongs there — agents read it. To Do is always there: agents take work from it.
5. **Which coding agents do you use here?** — Claude Code, Codex, Cursor, Gemini CLI; the ones found on this machine or in the project are ticked.
6. **Connect them now?** — *Yes* (show exactly which files change, then ask), *Not now* (the board only; no other file is touched — later: `kanbo connect`), or *I'll paste the instructions myself* (prints them; nothing is written).
7. On *Yes*: the files that change, each with what it is for (untick any), and the kanbo section your agents get.
8. **Add a first card?** — optional; it goes in To Do.
9. The full list of changes, then **Write these changes?** — nothing, not even the binding, is written before this yes. At the end: what was done, and what to do next.

A question a flag already answers is not asked. In a project that already has a board, the board questions (1–4) are skipped and the wizard goes straight to the agents. Ctrl-C at any question prints `Cancelled — nothing was written.` and exits `1`; the folder is left exactly as it was.

A warning is shown when agents could not start `kanbo mcp`: kanbo running from npx, or not on `PATH` (`npm install -g kanbo-cli`).

### Without a terminal, or with `--yes`

No questions. When nothing names a board — no `--db`/`--database-url`, no `KANBO_DB_PATH`/`KANBO_DATABASE_URL`, no binding at or above the folder — `init` creates a board file of the project's own, exactly like `--file`, with the standard columns (so `kanbo prime` has them to show) and the card key suggested from the folder name (a project already bound keeps its key). No agent file is touched unless `--connect`, `--instructions` or `--mcp` says so — and even then only with `--yes`: without it (an agent's shell, a script, `--json`) `init` sets up the board, leaves every agent file as it is, and says `Not changing agent files without a yes: run kanbo connect <agent> --yes`. The output ends with how to connect them later (`kanbo connect <agent>`, or `kanbo instructions --copy` and paste it).

| Option | Meaning |
| --- | --- |
| `--file [path]` | Use a board file of this project's own instead of a host database or an external board (default `.kanbo/board.db`). Creates and migrates the file, and puts the columns into a new one. What a plain `kanbo init` does when nothing names a board. |
| `--database-url <url>` | External Postgres board to bind this project to. Needs a workspace id and a card key (`--workspace`, `--key`). |
| `--migrate` | With `--database-url`: create the board's tables now, as `kanbo migrate` does, and put the columns on the new board. |
| `--db <path>` | Host database file to read this project's workspace from (for a board that lives inside another app's SQLite database). |
| `--workspace <nameOrId>` | Workspace this project is. With `--file` and no binding yet, defaults to the folder name. |
| `--key <KEY>` | What card numbers start with (`APP` in `APP-001`): a letter and two letters or digits. The same as `--identifier`, checked. For a new board file it defaults to a key suggested from the folder name. |
| `--identifier <key>` | The same, unchecked (kept for 0.2 scripts). |
| `--columns <columns>` | The columns a new board starts with: `standard` (default), `simple`, `review-qa`, or a comma-separated list in board order that includes To Do — ready-made names (`QA`, `Blocked`, …) or your own. Ignored for a board that already exists. |
| `--connect <agents>` | Connect these agents as `kanbo connect <agents>` does: `claude`, `codex`, `cursor`, `gemini`, `all`, or `none`; comma-separated. Not together with `--instructions`/`--mcp`. |
| `--first-card <title>` | Put a first card in To Do. |
| `--agent-url <url>` | The connection string agents get, when it is not the one above (see [storage](storage.md#roles)). |
| `--board <id>` | The board inside the workspace, when it has more than one. |
| `--instructions <file>` | Where to write the instruction block: `claude` (`CLAUDE.md`), `agents` (`AGENTS.md`) or `none`. With `--global`: a comma-separated list of `claude`, `codex`, `gemini`, or `none`. |
| `--mcp <clients>` | Register the board's MCP server with `claude` (`.mcp.json`), `codex` (`.codex/config.toml`), `cursor` (`.cursor/mcp.json`); comma-separated. |
| `--global` | Set up your own agent tools for every project instead of binding this one (see below). Binds no board. |
| `--yes` | Take the defaults instead of asking. |
| `--json <fields>`, `--format <format>` | Output, as everywhere. No wizard. |

The wizard's answers and the equivalent flags plan exactly the same changes. The instruction block sits between `<!-- KANBO_START v2 h=… -->` and `<!-- KANBO_END -->` and is replaced in place on a later run when kanbo wrote it — see [which blocks and entries kanbo changes](#what-kanbo-changes-and-what-it-leaves-alone). An MCP entry named `kanbo` that already exists is left alone, unless it is kanbo's own and no longer starts. `--instructions` and `--mcp` plan the same changes as `kanbo connect <agent> --project` (`agents` is the `AGENTS.md` Codex and Cursor read).

`--file` together with `--database-url` is refused (exit `1`).

A block written by an older kanbo (including the bare `<!-- KANBO_START -->` block of 0.1–0.2, word for word as it wrote it) is refreshed whenever `init` or `kanbo connect` writes that file: `kanbo init --connect <agent> --yes`, the wizard, or `kanbo connect <agent> --yes` (`--global` for your own files). `kanbo doctor` warns about one until then.

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
| `--check` | Print a table — agent, instructions (`current`/`outdated`/`legacy`/`edited`/`chosen`/`newer`/`damaged`/`missing`), MCP (`ok`/`missing`/`stale path`/`yours`/`yours, won't start`), scope — and exit `1` when an agent you named is not connected. An entry of your own is reported as "your own kanbo entry — left as is". |
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

#### What kanbo changes, and what it leaves alone

kanbo changes only what it wrote itself, in exactly the shape it wrote it. Anything else it shows you and asks about; it never rewrites or deletes it silently.

- **MCP entries.** kanbo's own `kanbo` entry is `{"command": "kanbo", "args": ["mcp"]}` (with `"type": "stdio"` or without), or a Node by full path running kanbo's own script — `{"command": "C:\\…\\node.exe", "args": ["C:\\…\\kanbo-cli\\dist\\cli.cjs", "mcp"]}` — with no other field: no `env`, no `cwd`, no `[mcp_servers.kanbo.env]` table. Only such an entry that no longer starts (a Node or script that is gone; on Windows, a bare `kanbo` in your own configuration) is rewritten, and only its `command` and `args` change. Any other `kanbo` entry — `cmd /c kanbo mcp`, `npx -y kanbo-cli mcp`, one with an `env` — is yours: `connect` leaves it as it is and says so, and `--remove`/`uninstall` take it out only on `--yes` or a yes in a terminal (default no).
- **Instruction blocks.** A block kanbo wrote — current, from an older version, or a 0.1–0.2 block whose text is word for word one those versions wrote — is replaced in place. A block you edited is replaced only when you answer yes to "You changed the kanbo section in … Replace it with the current one?" (default no); with `--yes` or without a terminal it is kept, with a note. Taking it out asks "You changed the kanbo section in …. Remove it anyway?" (default no); `--yes` removes it.
- **A text you chose.** A block from `kanbo instructions <kind> --markers` for a text other than `short`/`global` carries its kind on the marker (`k=orchestrator`); `connect` keeps it ("you chose the orchestrator text — kept") and `doctor` is fine with it.
- **A block from a newer kanbo** (`v3` or later on the marker) is never rewritten, and `doctor` says to update kanbo (`npm install -g kanbo-cli@latest`).
- **Markers that do not pair up** — a start without an end, an end without a start, a start inside another block — make the file one kanbo does not write to or remove anything from: `connect`, `init` and `uninstall` skip it with "CLAUDE.md has a kanbo start marker without an end — fix it by hand, then run again", and `doctor` fails it with the same text.
- **From npx.** A kanbo run from npm's npx cache does not register itself by full path in your own settings — that path is gone once the command ends. It says "Install kanbo first so agents can start it: npm install -g kanbo-cli" instead.

`--remove` takes the block out of `AGENTS.md` only when every agent that reads it (Codex, Cursor) is removed in the same command — `kanbo connect codex cursor --remove`, or `kanbo connect --remove` with no agents, which removes kanbo from all of them. Otherwise it keeps it and says `AGENTS.md section kept — Cursor also reads it. Remove it with: kanbo connect cursor --remove`.

When a `kanbo` entry in Claude Code's user settings is rewritten, kanbo runs `claude mcp remove` and then `claude mcp add`. If the `add` fails after the `remove` ran, it says the old entry was removed and prints only the `add` command, on a line of its own — each command it hands you is on its own line, so it pastes into any shell, PowerShell included.

## `kanbo instructions`

`kanbo instructions [kind] [--copy] [--markers]`. The text goes to stdout and nothing else does, so `kanbo instructions >> AGENTS.md` writes exactly the text; in a terminal, a line before and after it on stderr says what to do with it.

| Kind | Text |
| --- | --- |
| `agent` (default) | The full rules for an agent working the board from a shell. |
| `short` | The short kanbo section `kanbo connect` writes into a project's `CLAUDE.md` or `AGENTS.md`. |
| `global` | The section for your own instruction file, for every project. |
| `orchestrator` | The orchestrator instruction file from [Orchestrator examples](orchestrator.md). |
| `mcp` | What `kanbo mcp` tells a client when it connects. |
| `board` | This board's columns and rules, and the commands — what `kanbo prime` prints. Needs a board (exit `2` otherwise). |

| Option | Meaning |
| --- | --- |
| `--copy` | Also put the text on the clipboard: `pbcopy` on macOS, `clip.exe` on Windows and WSL, `wl-copy` on Wayland, `xclip` or `xsel` on X11, and over SSH without any of them the OSC 52 escape to your terminal. Without a clipboard it says so; the text is on the screen to select. |
| `--markers` | Wrap the text in the `<!-- KANBO_START … -->` / `<!-- KANBO_END -->` markers, as kanbo writes it into a file. |

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
| `instructions` | Every kanbo block in the project's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` and your own files is the block this version writes. `warn` when a block was written by an older kanbo, when you edited one, or when there is no block anywhere; `ok` for a text you chose (`--markers`) or a block a newer kanbo wrote (with a note to update); `fail` when a file's markers do not pair up. |
| `mcp:<client>` | Every `kanbo` registration in the files `kanbo connect` writes (and `~/.claude.json`): its `command` is on `PATH`, or its full paths exist (`fail` otherwise, fixed by `kanbo connect <agent>`). On Windows a Codex registration that starts a `.cmd` is a `warn`. `warn` when there is none. |
| `mcp:handshake` | Starts `kanbo mcp` in the project (the command a registration names), sends `initialize`, and expects server name `kanbo` with instructions, within 10 seconds. |
| `actor` | `warn` when this shell is an agent's: `KANBO_ACTOR_KIND=agent`, or an agent tool's mark (named in the detail). |

Exits `1` when any check fails; warnings alone exit `0`. Nothing is written.

## `kanbo uninstall`

| Option | Meaning |
| --- | --- |
| `--project` | Only this project's files. |
| `--global` | Only your own user-level files. Neither flag: both. |
| `--purge` | Also delete this project's `.kanbo/binding.json`, and its board file after a confirmation that names it. |
| `--yes` | Do it without asking. Never deletes a board file. |
| `--json` | Print `{ actions: [{ path, action, note? }] }`. |

Removes the marked instruction block and the `kanbo` MCP entry from every file `kanbo connect` writes, for every agent: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` (project) and `~/.claude/CLAUDE.md`, `$CODEX_HOME/AGENTS.md`, `~/.gemini/GEMINI.md` (global); `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json` (project) and `~/.cursor/mcp.json`, `$CODEX_HOME/config.toml`, `~/.gemini/settings.json` (global). To disconnect one agent, use `kanbo connect <agent> --remove`. Everything else in those files — your own text, other MCP servers, other TOML tables — stays. Files stay even when nothing is left in them: kanbo does not record which files it created. Claude Code's user-scope registration is removed with `claude mcp remove kanbo --scope user`, or the line is printed when `claude` is not on `PATH`. A block or `kanbo` entry that is not in the shape kanbo writes is asked about first (`--yes` answers it); a file whose markers do not pair up is left exactly as it is.

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

Each card is its key and title (the first line of its description when it has no title of its own), its status line dimmed under it, `[waiting for you]` when it waits for a person and `[running: <agent>]` while a run is going on. Lines are cut to the terminal's width (80 when the output is not a terminal). An empty Canceled column is left out; Done and Canceled show the 5 cards changed last. Colour only in a terminal, never with `NO_COLOR`.

| Option | |
| --- | --- |
| `--column <column>` | Only this column, by slug, name or id. |
| `--all` | Every card of Done and Canceled. |
| `--json [fields]` | The same sections as JSON — `name`, `slug`, `category`, `count` (every card in the column) and `cards` (those shown, as `card list --json` prints them); with a list, only those fields of each section. |

Plus `--db`, `--database-url`, `--workspace` and `--format`.

## `kanbo columns …`

- `columns list` — common options only.
- `columns describe <column> --text <text>` — `--text` (required): what the column means.
- `columns rules <column>` — `--require <rules>`: comma-separated `checklist_complete`, `pull_request_linked`, `ci_green`, `approved`; `--clear`: ask nothing of a card entering the column. Person only.
- `columns add <name>` — `--after <column>` or `--before <column>`: where it goes (neither: before the first completed column, Done, or before Canceled); `--description <text>`: when a card belongs in it, one line agents read; `--category <category>`: `backlog`, `unstarted`, `started` (default), `completed` or `canceled`. A ready-made name (`QA`, `Blocked`, …) brings its own line and category. A name whose slug another column has is refused.
- `columns rename <column> <name>` — the slug follows the new name, so a name another column's slug already answers to is refused. **To Do can't be renamed away from its slug `to_do`**: `kanbo ready` takes work from the column with that slug, and agents would find no cards to take. Another spelling (`To-do`, `TO DO`) is fine.
- `columns move <column>` — exactly one of `--first`, `--last`, `--before <column>`, `--after <column>`.
- `columns remove <column>` — `--move-cards-to <column>`: where the cards in it go. A column that holds cards is not removed without it — at a terminal kanbo asks which column, then *Remove column In Review and move 3 cards to To Do?* (default No); elsewhere it stops with the count and the command to type. The cards move in the same write as the removal, each card's history recording the move. **To Do can't be removed.**
- `columns template <template>` — `standard`, `simple` or `review-qa`. On a board with no columns, puts the template on as it is; on a board with columns, only with `--add-missing`, which adds the template's columns the board lacks, each after the template column before it. A template never takes a column away; running it twice changes nothing.
- `columns add-standard` — the same as `columns template standard --add-missing`: adds Backlog, To Do, In Progress, In Review, Done and Canceled where missing.
- `kanbo columns` alone — at a terminal: the columns, then *What would you like to change?* — *Add a column*, *Rename a column*, *Move a column*, *Remove a column*, *Apply a template* (its missing columns), *Done* — each naming the command it runs, back after each change. Ctrl-C at the menu leaves; inside an item it goes back to the menu. With nobody to ask it prints the list. Takes no options: the board comes from the folder, `KANBO_DB_PATH` or `KANBO_DATABASE_URL`.

All of these but `list` and `describe` are **person only**: in an agent's shell they stop with exit `4` and change nothing.

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

Serves all sixteen tools and the `kanbo://capabilities` resources over stdio. The client is always treated as an agent. See [MCP](mcp.md). In a folder with no board it starts anyway: the client connects and gets the instructions, and every tool answers that this folder has no kanbo board, until one is set up there — the next call then finds it.

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
