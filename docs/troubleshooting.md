# Troubleshooting

**`No board found. Run "kanbo init --file" in the project, pass --db or --database-url, or set KANBO_DB_PATH or KANBO_DATABASE_URL.` (exit 2)**
No flag, environment variable or `.kanbo/binding.json` at or above the current directory names a board. Run `kanbo init --file` in the project root, or `cd` into the project. For an MCP client, check that it starts `kanbo mcp` in the project directory.

**`Install better-sqlite3 to use a board file`**
The native module is not installed where kanbo can find it. Install it next to kanbo: `npm install -g better-sqlite3` for a global kanbo, `npm install -D better-sqlite3` in a project.

**`better-sqlite3` fails to build**
There was no prebuilt binary for your platform and Node version, and the compiler toolchain is missing. Install Python and a C++ toolchain (Xcode Command Line Tools, `build-essential`, or Visual Studio's C++ workload) and reinstall. After switching Node versions, run `npm rebuild better-sqlite3`.

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
