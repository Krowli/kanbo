<!-- Once this directory changes, update this README.md -->

# Board migrations for an external Postgres

The board schema for an external Postgres database. `drizzle-sqlite/` is the
other half: the same logical board, at the same `BOARD_SCHEMA_EPOCH`, for a
SQLite file. **A change to the board is a migration in each chain, written
together**, or a board that moves between the two engines stops being the same
board.

Generated with `npm run generate:postgres` from `src/postgres/schema.ts`, and
applied by `kanbo migrate` (`migrateBoardDatabase`) and by nothing else.

## Files

- **0000_board.sql**: the whole board at epoch 1 — eight tables, their indexes
  and the foreign keys that point inside the board. The two `INSERT … ON CONFLICT
  DO NOTHING` statements at the end seed `kanban_meta` with `board` revision `0`
  and `schema_epoch` `1` (the generation `assertBoardSchema` demands). They are
  hand-written, because `drizzle-kit` generates structure, not rows: regenerating
  this file drops them, and they have to be put back.
- **0001_history_order.sql**: `seq` on `issue_comments` and `issue_field_changes`
  — the `bigserial` this dialect orders same-second rows by, because Postgres
  has no `rowid` and its heap order is not insertion order. It changes nothing
  above the store, so `BOARD_SCHEMA_EPOCH` stays 1 and there is no SQLite half
  to write: a file already orders those two by `rowid`. A database still at
  0000 therefore carries the right stamp and the wrong columns, which is why
  `assertBoardSchema` asks `information_schema.columns` for every column by
  name — that board reads as `board_schema_outdated` until `kanbo migrate`
  has been run again.
- **0002_issue_pull_requests.sql**: `issue_pull_requests`, the pull requests a
  card names (ruling 4-1), with the same `seq` `bigserial` the history tables
  carry, so a card's links list in the order they were made. The epoch stays 1;
  a database still at 0001 reads as `board_schema_outdated`
  (`missingAddedTables`) until `kanbo migrate` has run, and `kanbo roles apply`
  has to run after it for the agent's grant on the new table and its sequence.
- **0003_milestone_start_date.sql**: `issue_milestones.start_date` (`bigint`
  unix seconds, nullable), the day a milestone read as a sprint begins (ruling
  5x-3) — a plain `ADD COLUMN`, no new sequence, so no new grant. The epoch
  stays 1; a database still at 0002 reads as `board_schema_outdated`
  (`missingColumns`) until `kanbo migrate` has run.
- **0004_status_entry_rules.sql**: `issue_statuses.entry_rules` (text, a JSON
  array of `ENTRY_RULES`, nullable), what a card must satisfy before an agent
  may put it in the column (ruling 6-1) — a plain `ADD COLUMN`, no new
  sequence, so no new grant. The epoch stays 1; a database still at 0003 reads
  as `board_schema_outdated` (`missingColumns`) until `kanbo migrate` has run.
- **0005_run_external_session_ref.sql**: `issue_runs.external_session_ref`
  (text, nullable), where an external agent's own log of a run lives, once it
  has said (ruling 7-1): `claude:<id>` (a Claude Code session id) or
  `codex:<id>` (a Codex session id — the one in the rollout's `session_meta`); `null` while it never has — a plain
  `ADD COLUMN`, no new sequence, so no new grant. The epoch stays 1; a
  database still at 0004 reads as `board_schema_outdated` (`missingColumns`)
  until `kanbo migrate` has run.
- **meta/**: the drizzle journal and schema snapshots. JSON only, or
  `drizzle-kit generate` fails to parse the directory.

Generating a second migration takes a name of its own — the package script
carries `--name board` for the first one — so it is
`npx drizzle-kit generate --config drizzle.postgres.config.ts --name <what it does>`.
`kanbo roles apply` grants `usage` on the sequences these columns draw from,
so it is run *after* `kanbo migrate` and again whenever a migration adds one.
