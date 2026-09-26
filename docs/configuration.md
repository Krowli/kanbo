# Configuration

kanbo has no configuration file of its own beyond the per-project binding. Everything else is a flag or an environment variable.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `KANBO_DATABASE_URL` | every board command | Connection string of an external Postgres board. Beats the project's binding, in every shell — an agent's included. |
| `KANBO_DB_PATH` | every board command, `kanbo init` | Path of a SQLite board file to open when neither a flag nor the project's binding names one. An app that keeps the board inside its own database sets this for the shells it starts. |
| `KANBO_WORKSPACE_ID` | every board command | The workspace to work on, when `--workspace` is not given. Beats the binding. |
| `KANBO_ACTOR_ID` | every writing command, `kanbo mcp`, `kanbo serve` | The name writes are filed under. Defaults to the operating-system user name. |
| `KANBO_ACTOR_KIND` | every command | Set to `agent` to mark the shell as an agent's: person-only commands exit `4`, column entry rules refuse instead of warning, and a Postgres binding's `agentDatabaseUrl` is used. Any other value, or none, is a person's shell. |
| `KANBO_SERVE_TOKEN` | `kanbo serve` | Bearer token the HTTP server requires (same as `--token`, but not visible in `ps`). |

## How a command finds its board

First match wins:

```
--db <path>  or  --database-url <url>        (both at once: exit 1)
  > KANBO_DATABASE_URL
  > databaseUrl in .kanbo/binding.json        (agentDatabaseUrl in an agent's shell, when present)
  > dbPath in .kanbo/binding.json             (written by kanbo init --file)
  > KANBO_DB_PATH
  > exit 2: No board found. Run "kanbo init --file" in the project, pass --db or --database-url,
            or set KANBO_DB_PATH or KANBO_DATABASE_URL.
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
| `--instructions claude` | `CLAUDE.md` | The instruction block between `<!-- KANBO_START -->` and `<!-- KANBO_END -->`. |
| `--instructions agents` | `AGENTS.md` | The same block. |
| `--mcp claude` | `.mcp.json` | `{"mcpServers":{"kanbo":{"type":"stdio","command":"kanbo","args":["mcp"]}}}`, merged. |
| `--mcp cursor` | `.cursor/mcp.json` | The same entry, merged. |
| `--mcp codex` | `.codex/config.toml` | `[mcp_servers.kanbo]` with `command = "kanbo"` and `args = ["mcp"]`, appended. |

These are committed project files, and none of them contains a secret: `kanbo mcp` reads the board from the binding like every other command.
