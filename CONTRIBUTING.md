# Contributing to kanbo

Thanks for helping. Bug reports, documentation fixes and pull requests are all welcome.

## Before you start

- For a bug, open an issue with the [bug report form](https://github.com/Krowli/kanbo/issues/new?template=bug_report.yml): the command you ran, what it printed, and `kanbo --version`.
- For a feature, open a [feature request](https://github.com/Krowli/kanbo/issues/new?template=feature_request.yml) first so we can agree on the shape before you write code.
- For a security problem, do **not** open an issue — see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js `^22.19.0` or `>=24.11.0`, npm, and a C++ toolchain if `better-sqlite3` has no prebuilt binary for your platform.

```bash
git clone https://github.com/Krowli/kanbo.git
cd kanbo
npm install
npm run build        # dist/cli.cjs, dist/lib/, dist/page/
npm test             # the whole suite
npm run typecheck
npm link             # optional: `kanbo` on your PATH, pointing at this checkout
```

`npm run kanbo -- <args>` runs the CLI from source through `tsx`, without building.

Tests need no external services. Board-file tests use real SQLite files in a temporary directory; Postgres tests use [PGlite](https://pglite.dev), an in-process Postgres, so no database server is required. Some tests run the built output, so run `npm run build` before `npm test`.

## Layout

| Path | What |
| --- | --- |
| `src/domain/` | Pure rules: numbering, entry rules, activity projection, errors. |
| `src/ops/` | Board operations — every command, tool and route calls these. |
| `src/sqlite/`, `src/postgres/` | The two store implementations, schemas, migrations runners. |
| `src/cli/` | The `kanbo` command. |
| `src/mcp/` | MCP tools, transports and the server. |
| `src/serve/` | `kanbo serve`: HTTP routes, security checks, the board page (`src/serve/page/`). |
| `src/capabilities/` | The capabilities manifest. |
| `src/testing/` | Test helpers and the store contract both engines must pass. |
| `drizzle-sqlite/`, `drizzle-postgres/` | Migration chains. |
| `docs/` | User documentation. |

## Changing the board schema

The schema is declared twice, once per dialect (`src/sqlite/schema.ts`, `src/postgres/schema.ts`), and `src/postgres/schema.parity.test.ts` checks that they agree. A schema change is therefore:

1. Change both schema files.
2. Generate a migration for each chain: `npx drizzle-kit generate --config drizzle.sqlite.config.ts --name <what>` and `npx drizzle-kit generate --config drizzle.postgres.config.ts --name <what>`. (The `generate:sqlite` / `generate:postgres` scripts carry `--name board`, the name of the first migration.)
3. Add the new table or column to what `assertBoardSchema` expects if needed, and describe the migration in `drizzle-sqlite/README.md` / `drizzle-postgres/README.md`.
4. Add an entry to `CHANGELOG.md` saying that users must run `kanbo migrate` (and `kanbo roles apply` for Postgres).

## Pull requests

- Keep a pull request to one change, with tests for new behavior.
- `npm run build && npm test && npm run typecheck` must pass; CI runs the same on Linux and macOS, Node 22 and 24.
- Update `docs/` when a command, flag, tool or route changes: `src/mcp/docs.test.ts` fails when a command is missing from `docs/cli.md` or a tool from `docs/mcp.md`.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user would notice.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
