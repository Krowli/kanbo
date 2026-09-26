<!-- Once this directory changes, update this README.md -->

# Board migrations for a board file of this package's own

The board schema for a SQLite file nobody but this package owns — the one a
project keeps beside its code. It is one of the chains that build the same
board (ruling 5-2):

| Where the board lives | Who migrates it | With what |
| --- | --- | --- |
| a board file of a project's own | this package, through `migrateBoardFile` | **this folder** |
| an external Postgres | `kanbo migrate` (`migrateBoardDatabase`) | `drizzle-postgres/` |
| a host app's own database | the app, with its own migrations | the app's own chain |

**A change to the board is a migration in every chain, written together** — at
the same `BOARD_SCHEMA_EPOCH` — or a board stops being the same board when it
moves. An app that keeps the board in its own database re-exports
`kanbo/sqlite/schema` and generates its own migration from it. `src/postgres/schema.parity.test.ts` compares the two schemas the chains
are generated from, so a column added on one side alone fails there rather than
in somebody's database.

Generated with `npm run generate:sqlite` from
`src/sqlite/schema.ts`.

## Files

- **0000_board.sql**: the whole board at epoch 1 — eight tables, their indexes
  and the foreign keys that point inside the board. There are no foreign keys
  out of it: this file has no `workspaces`, `agents` or `provider_targets` to
  point at (ruling 5-1). The two `INSERT OR IGNORE` statements at the end seed
  `kanban_meta` with `board` revision `0` and `schema_epoch` `1` (the generation
  `assertBoardSchema` demands). They are hand-written, because `drizzle-kit`
  generates structure, not rows: regenerating this file drops them, and they
  have to be put back.
- **0001_issue_pull_requests.sql**: `issue_pull_requests`, the pull requests a
  card names (ruling 4-1) — a plain `CREATE TABLE` with its foreign key onto
  `issues` (cascade), the unique `(issue_id, owner, repo, number)` and the
  `(owner, repo, number)` index. The epoch stays 1: a file still at 0000 carries
  the right stamp and lacks the table, which `assertBoardSchema` reports as
  `missingAddedTables` until `kanbo migrate` has been run on it.
- **0002_milestone_start_date.sql**: `issue_milestones.start_date` (unix
  seconds, nullable), the day a milestone read as a sprint begins (ruling
  5x-3) — a plain `ADD COLUMN`. The epoch stays 1; a file still at 0001 reads as
  `board_schema_outdated` (`missingColumns`) until `kanbo migrate` has run.
- **0003_status_entry_rules.sql**: `issue_statuses.entry_rules` (text, a JSON
  array of `ENTRY_RULES`, nullable), what a card must satisfy before an agent
  may put it in the column (ruling 6-1) — a plain `ADD COLUMN`; `null` asks for
  nothing. The epoch stays 1; a file still at 0002 reads as
  `board_schema_outdated` (`missingColumns`) until `kanbo migrate` has run.
- **0004_run_external_session_ref.sql**: `issue_runs.external_session_ref`
  (text, nullable), where an external agent's own log of a run lives, once it
  has said (ruling 7-1): `claude:<id>` (a Claude Code session id) or
  `codex:<id>` (a Codex session id — the one in the rollout's `session_meta`); `null` while it never has — a plain
  `ADD COLUMN`. The epoch stays 1; a file still at 0003 reads as
  `board_schema_outdated` (`missingColumns`) until `kanbo migrate` has run.
- **meta/**: the drizzle journal and schema snapshots. JSON only, or
  `drizzle-kit generate` fails to parse the directory.

Nothing here rebuilds a table, and nothing here ever should: `migrateBoardFile`
is drizzle's own migrator, in one pass with foreign keys left as the caller set
them. A rebuild would need a runner that turns foreign keys off around it, and
the only reason to have one is other tables that point at the board — of which
this file has none.

A second migration takes a name of its own — the package script carries
`--name board` for the first one — so it is
`npx drizzle-kit generate --config drizzle.sqlite.config.ts --name <what it does>`.
