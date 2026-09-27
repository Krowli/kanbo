# Troubleshooting

Start with `kanbo doctor` in the project: it checks the install, the binding, the board, the instruction blocks and the MCP registrations, and prints a fix for each problem.

## `kanbo doctor` findings

**`path` warn: `… comes first on PATH and is not this kanbo`**
Two installs; agents and MCP clients start the first one. Remove the other (`npm uninstall -g …`, or delete the old binary), or put this one first on `PATH`.

**`binding` fail: `.kanbo has no binding.json` / `… is not a binding this build can read`**
The project's binding is gone or damaged. Run `kanbo init --file` (or `kanbo init --database-url …` with the same flags as before) in the project root.

**`sqlite` fail: `better-sqlite3 cannot be loaded`**
See `Could not load better-sqlite3 …` below.

**`board` fail: `Board file is older than this build. Run kanbo migrate.`**
Run `kanbo migrate` in the project.

**`instructions` warn: `block was written by an older kanbo`**
Run the command in the fix (`kanbo init --instructions claude --yes` in the project, or `kanbo init --global --instructions <client> --yes`). Blocks are not refreshed automatically.

**`instructions` warn: `you edited the kanbo block`**
The text between the markers no longer matches what kanbo wrote. kanbo leaves it alone; to replace it, run `kanbo init --instructions claude` in a terminal and answer yes.

**`mcp:<client>` fail: `starts …, which is not on PATH`**
The client cannot start the server. Install kanbo globally, or change `command` in the named file to an absolute path.

**`mcp:handshake` fail: `… mcp did not answer initialize`**
The `kanbo` a client would start fails before answering. The detail is its first line on stderr; run `kanbo mcp` in the project yourself to see all of it.

**`actor` warn: `This shell says it belongs to an agent`**
`KANBO_ACTOR_KIND=agent` is set. If this is your own terminal, remove it from your shell profile — otherwise you cannot approve.

## Messages

**`No board found. Run "kanbo init --file" in the project, pass --db or --database-url, or set KANBO_DB_PATH or KANBO_DATABASE_URL.` (exit 2)**
No flag, environment variable or `.kanbo/binding.json` at or above the current directory names a board. Run `kanbo init --file` in the project root, or `cd` into the project. For an MCP client, check that it starts `kanbo mcp` in the project directory.

**`Could not load better-sqlite3, which kanbo opens board files with, on Node … (<platform>-<arch>): …`**
The native module kanbo reads board files with is missing or does not load on this Node, system and processor. Reinstall kanbo, which brings it along: `npm install -g kanbo-cli`. A program that uses kanbo as a library installs `better-sqlite3` itself (`npm install better-sqlite3`).

**`kanbo needs Node ^22.19.0 || >=24.11.0; this is Node …`**
Install a current Node from https://nodejs.org (or with your version manager) and run kanbo again.

**`… is not a board database this tool can open.` (exit 2)**
`--db` or the binding points at a file that is not a SQLite database.

**`Could not tell which workspace this is …` / `Could not tell what this workspace's card keys start with …` (exit 2)**
The binding has no workspace or no `identifier`. Rerun `kanbo init --file --workspace <id> --identifier <KEY>` (or `--database-url …`), or pass `--workspace`.

**`Board file is older than this build. Run kanbo migrate.` (exit 3)**
You upgraded kanbo. Run `kanbo migrate` in the project. Reads keep working until then.

**`This database holds no board this build can speak for …` (exit 3)**
The Postgres database has no board yet, or an older one. Run `kanbo migrate --database-url <owner url>`, then `kanbo roles apply` with the same URL.

**`Approval is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent).` (exit 4)**
`KANBO_ACTOR_KIND=agent` is set in this shell. Approve from your own terminal, where it is not set — check your shell profile if it is set there.

**`One board at a time: pass --db for a board file or --database-url for an external board, not both.` (exit 1)**
Give only one of the two flags.

**`board_column_rules_unmet: … cannot enter "…" yet:` (exit 1)**
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
