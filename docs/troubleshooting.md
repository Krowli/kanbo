# Troubleshooting

Start with `kanbo doctor` in the project: it checks the install, the binding, the board, the instruction blocks and the MCP registrations, and prints a fix for each problem. Then `kanbo doctor --fix` fixes what it can — an old instruction block, kanbo's own MCP entry whose Node moved, a board with no columns, a board file a migration behind — after showing the plan and asking once (`--yes` to skip the question). It never deletes anything, and never changes a block you edited or an MCP entry of your own.

## `kanbo doctor` findings

**`path` warn: `… comes first on PATH and is not this kanbo`**
Two installs; agents and MCP clients start the first one. Remove the other (`npm uninstall -g …`, or delete the old binary), or put this one first on `PATH`.

**`binding` fail: `.kanbo has no binding.json` / `… is not a binding this build can read`**
The project's binding is gone or damaged. Run `kanbo init --file` (or `kanbo init --database-url …` with the same flags as before) in the project root.

**`sqlite` fail: `better-sqlite3 cannot be loaded`**
See `Could not load better-sqlite3 …` below.

**`board` fail: `This board file was made by an older kanbo. Run kanbo migrate.`**
Run `kanbo doctor --fix` (or `kanbo migrate`) in the project.

**`columns` warn: `This board has no columns`**
Boards from kanbo 0.1–0.2 got their columns only with the first card, so `kanbo prime` shows agents none. Run `kanbo doctor --fix` to add the Standard columns, or pick a set yourself: `kanbo columns template simple`.

**`install` warn: `kanbo runs from npx's cache`**
A kanbo run with `npx` is gone once that command ends, so agents cannot start `kanbo mcp`. Install it: `npm install -g kanbo-cli`.

**`update` info: `kanbo X is available`**
Update with `npm install -g kanbo-cli@latest`. See [Update check](configuration.md#update-check) to turn the check off.

**`instructions` warn: `block was written by an older kanbo`**
Run `kanbo doctor --fix`, or the command in the fix (`kanbo connect claude --project --no-mcp --yes` in the project, or `kanbo connect <agent> --global --no-mcp --yes`). `kanbo init` and `kanbo connect` also refresh it whenever they write that file.

**`instructions` warn: `you edited the kanbo block`**
The text between the markers no longer matches what kanbo wrote. kanbo leaves it alone; to replace it, run `kanbo connect claude --project --no-mcp` in a terminal and answer yes.

**`instructions` fail: `… has a kanbo start marker without an end`**
The file's kanbo markers do not pair up (a start without an end, an end without a start, or a start inside another block), so kanbo does not write to it or remove anything from it. Fix the markers by hand — or delete the stray one — then run the command again.

**`instructions` ok: `written by a newer kanbo (vN)`**
A newer kanbo wrote this block; this one leaves it alone. Update kanbo: `npm install -g kanbo-cli@latest`.

**`mcp:<client>`: `your own kanbo entry (…) — left as is`**
The `kanbo` entry is not in a shape kanbo writes (it starts kanbo another way, or has an `env`), so kanbo never changes it. It is a warning only when it cannot start here.

**`mcp:<client>` fail: `starts …, but … does not exist`**
kanbo's own registration names a Node and a kanbo script by full path (the Windows form), and one of them has moved — a Node upgrade, or kanbo reinstalled elsewhere. Run `kanbo doctor --fix` (or `kanbo connect <agent>` in the same scope) to point it at this kanbo.

**`mcp:<client>` fail: `starts …, which is not on PATH`**
The client cannot start the server. Install kanbo globally, or change `command` in the named file to an absolute path.

**`mcp:handshake` fail: `… mcp did not answer initialize`**
The `kanbo` a client would start fails before answering. The detail is its first line on stderr; run `kanbo mcp` in the project yourself to see all of it.

**`actor` warn: `This shell says it belongs to an agent`**
`KANBO_ACTOR_KIND=agent` is set, or an agent tool's mark (`CLAUDECODE=1`, `CODEX_THREAD_ID`, `GEMINI_CLI=1`, `CURSOR_AGENT`) — the finding names which. If this is your own terminal, remove `KANBO_ACTOR_KIND=agent` from your shell profile, or for a mark set `KANBO_ACTOR_KIND=person` (an IDE terminal with the Claude Code extension sets `CLAUDECODE=1`; a shell Codex started inherits `CODEX_THREAD_ID`).

## Messages

A refusal from the board reads as a sentence, the command to run next, and the error's code in brackets — the code is what to search for:

```text
No column "foo" on this board.
  Next: kanbo columns list  [issue_status_not_found]
```

Set `KANBO_DEBUG=1` to also print the values that caused it (`Details: {…}`).

**`This folder has no kanbo board yet. Run kanbo to set one up (or kanbo init --yes for the defaults).` (exit 2)**
No flag (`--db`, `--database-url`), environment variable (`KANBO_DB_PATH`, `KANBO_DATABASE_URL`) or `.kanbo/binding.json` at or above the current directory names a board. Run `kanbo` in the project root, or `cd` into the project. In an agent's shell the message reads `Ask a person to run kanbo here.` instead, with a second line, `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo`. For an MCP client, check that it starts `kanbo mcp` in the project directory.

**`This project's board file is missing: <path>. Create a new empty board here: kanbo init --file (the old cards are gone), or restore the file.` (exit 2)**
The project is bound to a board file (`.kanbo/binding.json`), or `KANBO_DB_PATH` names one, and the file is not there — deleted, moved, or on a checkout that never had it (the board file is not in git). Put the file back where the message says, or start again with an empty board: `kanbo init --file` creates it at the same path and keeps the project's card key. In a terminal, `kanbo` and `kanbo init` offer the same: *Create a new empty board at <path>* or *Cancel*.

**`kanbo` prints `This folder has no kanbo board yet.` and `kanbo init --yes` instead of starting the setup**
`kanbo` asks questions only when it runs in a terminal it can draw in: not when its input or output is piped or redirected, `CI` is set, `TERM=dumb`, or the shell belongs to an agent (`KANBO_ACTOR_KIND=agent`, or a mark such as `CLAUDECODE=1` — see the `actor` finding above). Run it in your own terminal, or run the printed `kanbo init --yes` (add `--connect claude` to connect Claude Code as well).

**`Could not load better-sqlite3, which kanbo opens board files with, on Node … (<platform>-<arch>): …`**
The native module kanbo reads board files with is missing or does not load on this Node, system and processor. Reinstall kanbo, which brings it along: `npm install -g kanbo-cli`. A program that uses kanbo as a library installs `better-sqlite3` itself (`npm install better-sqlite3`).

**`kanbo needs Node ^22.19.0 || >=24.11.0; this is Node …`**
Install a current Node from https://nodejs.org (or with your version manager) and run kanbo again.

**`… is not a board file kanbo can open.` (exit 2)**
`--db` or the binding points at a file that is not a SQLite database.

**`Could not tell which project this is …` / `Could not tell what this project's card numbers start with …` (exit 2)**
The binding has no workspace or no `identifier`. Rerun `kanbo init --file --workspace <id> --identifier <KEY>` (or `--database-url …`), or pass `--workspace`.

**`This board file was made by an older kanbo. Run kanbo migrate.` (exit 3)**
You upgraded kanbo. Run `kanbo migrate` in the project. Reads keep working until then.

**`This Postgres database has no kanbo board yet, or one an older kanbo made …` (exit 3)**
The Postgres database has no board yet, or an older one. Run `kanbo migrate --database-url <owner url>`, then `kanbo roles apply` with the same URL.

**`Only a person can approve a card. This shell belongs to an agent (KANBO_ACTOR_KIND=agent): ask a person to approve it on the board page (kanbo serve).` (exit 4)**
`KANBO_ACTOR_KIND=agent` is set in this shell. Approve from your own terminal, where it is not set — check your shell profile if it is set there. The same message with `(CLAUDECODE=1)`, `(CODEX_THREAD_ID)`, `(GEMINI_CLI=1)` or `(CURSOR_AGENT)` means an agent tool marked the shell; in your own terminal, set `KANBO_ACTOR_KIND=person`, or run the command the refusal's second line prints — `If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo <the command as typed>`. Every person-only command (`approve`, `return`, `sprint close`, the column changes, `run clear-session`) refuses the same way.

**`One board at a time: pass --db for a board file or --database-url for a shared Postgres board, not both.` (exit 1)**
Give only one of the two flags.

**`… can't go into "…" yet:` … `[board_column_rules_unmet]` (exit 1)**
The column has entry rules the card does not meet; the lines below say which. Fix the card (tick the checklist, link the pull request) or ask a person to move it.

**`kanbo: agents in this project will reach the board with the connection string you gave, which owns it.`**
A warning from `kanbo init --database-url` without `--agent-url`. Apply the roles and record the agent's login: see [storage](storage.md#external-postgres--supabase).

**The Postgres roles do not refuse anything**
The session is not the role itself. A login that was only granted membership in `kanban_agent` keeps its own name as `current_user`. Use `kanban_agent`'s own connection string, or `set role kanban_agent`.

**`kanbo serve` refuses to start on `0.0.0.0`**
Any non-loopback address needs a token: set `KANBO_SERVE_TOKEN`.

**The board page says it is not built (`404`)**
You are running from a checkout without a build. Run `npm run build`.

**Browser requests get `403 origin_not_allowed` or `403 host_not_allowed`**
Open the page by the address the server printed (`127.0.0.1` or `localhost` with its port). A page on another origin must be listed with `--cors-origin <origin>`.

**Approve / Return on the board page are refused**
The page must send the server's token: open it by the link `kanbo serve` printed, or paste the token (`KANBO_SERVE_TOKEN`, if you set one) into the Token field. A server started from an agent's shell never acts for a person.

**The MCP tools do not show up**
Check that `kanbo` is on the `PATH` the client uses (GUI apps often do not see your shell's `PATH`; use an absolute path as the `command`), and run `kanbo mcp` yourself in the project: it should wait silently for input. Then restart the client.
