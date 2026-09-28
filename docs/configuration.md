# Configuration

kanbo has no configuration file of its own beyond the per-project binding. Everything else is a flag or an environment variable.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `KANBO_DATABASE_URL` | every board command | Connection string of an external Postgres board. Beats the project's binding, in every shell — an agent's included. |
| `KANBO_DB_PATH` | every board command, `kanbo init` | Path of a SQLite board file to open when neither a flag nor the project's binding names one. An app that keeps the board inside its own database sets this for the shells it starts. |
| `KANBO_WORKSPACE_ID` | every board command | The workspace to work on, when `--workspace` is not given. Beats the binding. |
| `KANBO_ACTOR_ID` | every writing command, `kanbo mcp`, `kanbo serve` | The name writes are filed under. Defaults to the operating-system user name. |
| `KANBO_ACTOR_KIND` | every command | `agent` marks the shell as an agent's: person-only commands exit `4`, no question is asked, column entry rules refuse instead of warning, and a Postgres binding's `agentDatabaseUrl` is used. `person` marks it as a person's even when an agent tool's mark is there (see [Agent shells kanbo recognises](#agent-shells-kanbo-recognises)). Unset, the marks decide. |
| `KANBO_SERVE_TOKEN` | `kanbo serve` | Bearer token the HTTP server requires (same as `--token`, but not visible in `ps`). Unset on loopback, a token is generated for the run. |
| `KANBO_DEBUG` | every command | `1` adds the values that caused a board refusal (`Details: {…}`) under its message, and says why the update check got no answer. |
| `KANBO_NO_UPDATE_CHECK` | every command, `kanbo mcp` | `1` turns off the update check (see [Update check](#update-check)). |
| `NO_UPDATE_NOTIFIER` | every command, `kanbo mcp` | Set to anything: the same. The variable other command-line tools honour. |

## Update check

Every time kanbo starts, it asks npm (`https://registry.npmjs.org/kanbo-cli/latest`) which version is the latest, alongside the command — once per run, with no schedule and nothing cached. The request gets about 1.5 seconds and never holds the command up: its answer is used only if it arrives before the command finishes, plus at most 0.3 seconds. A command that fails ends at once, and the request is dropped. Pre-releases count only when you run one. If npm cannot be reached, nothing is said (`KANBO_DEBUG=1` says why).

When a newer kanbo is out:

- **A person at a terminal** is asked after the command's output: `kanbo X is available (you have Y). Update now?` (default No). Yes runs `npm install -g kanbo-cli@latest` in the same terminal and prints `Updated to X.`, or npm's failure and the command to run yourself. When npm could not write its global folder (`EACCES`/`EPERM`), the failure adds: `Your npm global folder needs permissions — see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`.
- **The home screen** (`kanbo` alone) shows a dim line under the summary and a menu item *Update kanbo to X* instead of the question. After a successful update it prints `Updated to X — start kanbo again to use it.` and ends (exit 0): the running process is still the old kanbo. Leaving the menu (Exit or Ctrl-C) without updating prints the one-line notice below — no question — if npm's answer has come by then (waiting 0.3 seconds at most).
- **On Windows** kanbo never installs itself: the running kanbo holds its SQLite module open, and Windows does not let npm replace a file in use. Instead of the question there is one line on stderr: `kanbo X is available (you have Y). Close kanbo and run: npm install -g kanbo-cli@latest`; the home screen's item reads *How to update kanbo to X* and prints the same line.
- **An agent's shell, or any shell with nobody to ask**, gets one line on stderr: `kanbo X is available (you have Y) — npm install -g kanbo-cli@latest` (on Windows, the line above).
- **`kanbo doctor`** shows it as an `update` finding (`info`) instead of asking; with `--fix`, the second round of checks reports the same answer. It waits for npm no longer than any other command does.
- **`kanbo mcp`** asks once, when the server starts, and ends the `kanbo_prime` tool's answer with `Note: kanbo X is available (running Y). Ask a person to update: npm install -g kanbo-cli@latest`. It never prints anything else on stdout.

No check is made when `CI` is set (to anything but empty, `0` or `false`), with `KANBO_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER` set, for machine output (`--json`, `--format json`), for `--version` and `--help`, and on the `kanbo mcp` command line itself (only its `kanbo_prime` note).

## Agent shells kanbo recognises

Some agent tools leave a documented mark in the environment of every command their agent runs. kanbo reads a shell carrying one as an agent's, exactly as if `KANBO_ACTOR_KIND=agent` were set: `kanbo approve`, `kanbo return`, `kanbo sprint close`, `kanbo columns rules`, `kanbo columns add|rename|move|remove|template|add-standard`, `kanbo run clear-session` and `kanbo run attach-session --replace` exit `4` with "Run it in your own terminal, or on the board page (kanbo serve).", and nothing asks a question (so `kanbo uninstall --purge` keeps the board file).

| Mark | Set by | Source |
| --- | --- | --- |
| `CLAUDECODE=1` | Claude Code, in its Bash and PowerShell tools, hooks and stdio MCP servers — **and in the integrated terminal of its IDE extensions** | [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars) |
| `GEMINI_CLI=1` | Gemini CLI, in `run_shell_command` | [geminicli.com/docs/tools/shell](https://geminicli.com/docs/tools/shell/) |
| `CURSOR_AGENT` (any value) | Cursor, in the Agent's terminal | [cursor.com/docs/agent/tools/terminal](https://cursor.com/docs/agent/tools/terminal) |

Not recognised: **Codex** documents no variable of its own in the commands it runs, so mark its shells with `KANBO_ACTOR_KIND=agent` ([agents](agents.md#mark-every-agent-shell-as-an-agents)).

**Your own terminal carries a mark** — typically an IDE terminal where the Claude Code extension sets `CLAUDECODE=1` — so person-only commands refuse there: set `KANBO_ACTOR_KIND=person` in that terminal (or its profile). `KANBO_ACTOR_KIND` always wins over the marks. `kanbo doctor` shows which mark it saw (`actor` warn).

## How a command finds its board

First match wins:

```
--db <path>  or  --database-url <url>        (both at once: exit 1)
  > KANBO_DATABASE_URL
  > databaseUrl in .kanbo/binding.json        (agentDatabaseUrl in an agent's shell, when present)
  > dbPath in .kanbo/binding.json             (written by kanbo init --file)
  > KANBO_DB_PATH
  > exit 2: This folder has no kanbo board yet. Run kanbo to set one up
            (or kanbo init --yes for the defaults).
```

The binding is the nearest `.kanbo/binding.json` at or above the current directory, so commands work from any subdirectory of the project. A relative `dbPath` is resolved against the project root (the directory holding `.kanbo/`).

`kanbo migrate` and `kanbo roles apply` never use `agentDatabaseUrl`: they are the owner's commands.

## How a command finds its workspace

Cards are numbered per workspace (`APP-001`), so every board command needs one:

```
--workspace <nameOrId>
  > KANBO_WORKSPACE_ID
  > workspaceId in .kanbo/binding.json
  > (host database only) the workspace whose folder contains the current directory
  > exit 2
```

On a board file or a Postgres board, the card-key prefix comes from `identifier` in the binding, so `kanbo init` always writes one. A board that lives inside another app's SQLite database (a *host database*) keeps its own `workspaces(id, name, identifier, locator_json)` table; there kanbo reads the workspace and its prefix from that table, and never writes to it.

## `.kanbo/binding.json`

Written by `kanbo init`, merged on every later run, mode `0600`, and listed in `.kanbo/.gitignore` so it is never committed.

```json
{
  "schemaVersion": 1,
  "workspaceId": "acme-api",
  "boardId": null,
  "dbPath": ".kanbo/board.db",
  "identifier": "API"
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1`. |
| `workspaceId` | The workspace this project is. |
| `boardId` | The board inside the workspace (`--board`), usually `null`. |
| `dbPath` | The board file `kanbo init --file` created, relative to the project root. `null` or absent otherwise. |
| `databaseUrl` | The external Postgres board (`--database-url`). A secret: this file is the only place it is written. |
| `agentDatabaseUrl` | The same board as the agent role logs in (`--agent-url`). Given to agents' shells and to `kanbo mcp`. |
| `identifier` | The card-key prefix (`--identifier`). |

## `.kanbo/`

| Path | Committed? | Written by |
| --- | --- | --- |
| `.kanbo/binding.json` | no | `kanbo init` |
| `.kanbo/.gitignore` | yes | `kanbo init` — lists `binding.json`, and the board file with its `-wal`/`-shm` when the board file is inside `.kanbo/` |
| `.kanbo/board.db` (+ `-wal`, `-shm`) | no | `kanbo init --file` |

kanbo never edits your own `.gitignore`.

## Files `kanbo init` may also write

| Flag | File | Content |
| --- | --- | --- |
| `--instructions claude` | `CLAUDE.md` | The instruction block between the `<!-- KANBO_START … -->` and `<!-- KANBO_END -->` markers. |
| `--instructions agents` | `AGENTS.md` | The same block. |
| `--mcp claude` | `.mcp.json` | `{"mcpServers":{"kanbo":{"type":"stdio","command":"kanbo","args":["mcp"]}}}`, merged. |
| `--mcp cursor` | `.cursor/mcp.json` | The same entry, merged. |
| `--mcp codex` | `.codex/config.toml` | `[mcp_servers.kanbo]` with `command = "kanbo"` and `args = ["mcp"]`, appended. |

These are committed project files, and none of them contains a secret: `kanbo mcp` reads the board from the binding like every other command.
