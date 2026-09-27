# Storage

A board lives in one of three places. Everything above storage — the CLI, the MCP tools, the HTTP server — behaves the same in all of them.

| | Board file | External Postgres | Host database |
| --- | --- | --- | --- |
| What it is | `.kanbo/board.db`, a SQLite file in the project | A Postgres database holding only the board (Supabase works) | The board's tables inside another app's own SQLite database |
| Created by | `kanbo init --file` | `kanbo migrate` | the app |
| Migrated by | `kanbo init --file`, `kanbo migrate` | `kanbo migrate` | the app (kanbo refuses to) |
| Who may write | whoever can open the file | the two database roles below | whoever can open the file |
| Good for | one person, one machine, one project | a team, several machines, several agents | an app that embeds kanbo |
| Driver | `better-sqlite3` | `postgres` (postgres-js) | `better-sqlite3` |

## Board file

```bash
kanbo init --file                    # .kanbo/board.db
kanbo init --file boards/team.db     # any path inside the project
```

The file is created atomically (built beside its path and renamed into place), migrated, and marked as kanbo's own in its `kanban_meta` table. A path that already holds some other database is refused. The file is opened in WAL mode, so `board.db-wal` and `board.db-shm` appear next to it; `.kanbo/.gitignore` covers all three when the file is inside `.kanbo/`.

A board file is protected only by file permissions: anyone who can open it can write anything to it. The person-only rules are enforced by kanbo's commands, not by the file. For a board several people and agents share, use Postgres.

## External Postgres / Supabase

```bash
# 1. As the owner: create the board, then the roles.
export OWNER_URL='postgres://owner:…@db.example.com:5432/board'
kanbo migrate --database-url "$OWNER_URL"
kanbo roles apply --database-url "$OWNER_URL"
# 2. Give each role a password, in psql or the Supabase SQL editor:
#    alter role kanban_person with password '…';
#    alter role kanban_agent  with password '…';
# 3. Bind the project: a person's login, and the agent role's login for agents.
kanbo init --database-url 'postgres://kanban_person:…@db.example.com:5432/board' \
           --agent-url    'postgres://kanban_agent:…@db.example.com:5432/board' \
           --workspace acme-api --identifier API --yes
```

`kanbo init --database-url` never opens the database; it only records the connection strings in `.kanbo/binding.json`, which is `0600` and never committed. Without `--agent-url` it warns that agents will reach the board as its owner — and an owner can approve its own work.

Connection strings are never printed in full: every message, `--json` result and MCP error masks the password and the query string (`postgres://user:***@host:5432/db`).

### Roles

`kanbo roles print` prints the SQL; `kanbo roles apply` runs it as the owner. It creates two login roles without passwords:

- **`kanban_person`** — `select, insert, update, delete` on every board table.
- **`kanban_agent`** — the same on every table except `issues`, where it has `select, insert, update` and no `delete`.

Triggers reading `current_user` enforce, for `kanban_agent`:

- it may not take a card out of `waiting_for = 'human'` — `kanbo: only a person may take a card out of waiting`;
- it may not write, update or delete a `system.approved` / `system.returned` comment — `kanbo: only a person may approve or return a card`.

Both are raised as SQLSTATE `42501` (`insufficient_privilege`). An agent may still *ask*: setting `waiting_for` to `human` is what `kanbo card wait-approval` does.

The session has to **be** the role. A login merely granted membership (`create role bot login; grant kanban_agent to bot;`) keeps `current_user = 'bot'`, and the triggers never fire. Hand out `kanban_agent`'s own connection string, or have the session run `set role kanban_agent`.

The roles do not enforce closing a sprint or column entry rules; kanbo's operations do.

### Supabase notes

Use the connection string from the project's database settings. The transaction pooler works for commands; kanbo disables prepared statements on its Postgres connections. Run `kanbo roles apply` with the `postgres` user's connection string.

## Host database

An app can keep the board's nine tables inside its own SQLite database, next to a `workspaces(id, name, identifier, locator_json)` table of its own. It re-exports the table definitions from `kanbo/sqlite/schema`, migrates them with its own migrations, and tells the `kanbo` command where the database is by setting `KANBO_DB_PATH` for the shells it starts. kanbo reads the `workspaces` table to find which workspace a folder is (a locator is `{"nodeId":"local","path":"/path/to/project"}`) and never writes to it. `kanbo migrate` and `kanbo roles apply` refuse such a file.

## Schema

Nine tables, the same logical schema on both engines (`src/sqlite/schema.ts`, `src/postgres/schema.ts`):

| Table | Holds |
| --- | --- |
| `issues` | The cards: key number, title, description, priority, labels, parent, column, board order, `status_line`, `waiting_for`, `execution_mode`, milestone, delegation. |
| `issue_statuses` | The columns of a workspace, in order, with a category, a `description` and `entry_rules`. |
| `issue_milestones` | Milestones; one with a `start_date` and a `due_date` is a sprint. |
| `issue_comments` | Comments, including the board's own `system.*` comments; `dedupe_key` makes a write idempotent. |
| `issue_runs` | One row per launch of a card: agent, host, execution mode, branch, worktree, `chat_session_id`, `external_session_ref`, state, times. |
| `issue_relations` | Edges between cards (`blocks`, `duplicates`, `relates_to`). |
| `issue_field_changes` | The append-only history of field edits. |
| `issue_pull_requests` | Pull requests a card names: owner, repo, number, url, who linked it. |
| `kanban_meta` | Counters: `board` (bumped once per write that changed something — poll it to see changes) and `schema_epoch`. |

References out of the board — `workspace_id`, delegated agents, `source_chat_session_id` — are plain text columns, not foreign keys. Postgres adds a `seq` column to runs, comments, field changes and pull request links to keep same-second rows in insertion order.

## Migrations

Two migration chains ship with the package: `drizzle-sqlite/` for board files and `drizzle-postgres/` for external databases, both applied by `kanbo migrate` and recorded in drizzle's `__drizzle_migrations` table, so a second run does nothing.

Before every write to a board file, and before any access to a Postgres board, kanbo checks that the tables, the columns and `schema_epoch` match this build. When they do not:

- a board file refuses writes (exit `3`, `This board file was made by an older kanbo. Run kanbo migrate.`) but stays readable;
- a Postgres board refuses everything (exit `3`, `This Postgres database has no kanbo board yet, or one an older kanbo made. Run kanbo migrate.`).

After `kanbo migrate` on Postgres, run `kanbo roles apply` again: a migration may add a sequence the roles need a grant on.
