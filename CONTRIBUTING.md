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
npm run coverage     # the same suite, with a coverage summary and coverage/lcov.info
npm run typecheck
npm link             # optional: `kanbo` on your PATH, pointing at this checkout
```

`npm run kanbo -- <args>` runs the CLI from source through `tsx`, without building.

Tests need no external services. Board-file tests use real SQLite files in a temporary directory; Postgres tests use [PGlite](https://pglite.dev), an in-process Postgres, so no database server is required. Some tests run the built output, so run `npm run build` before `npm test`.

### The capability matrix

`src/e2e/capability-matrix.test.ts` drives every command and every MCP tool the capabilities manifest lists against a board file and a Postgres (PGlite) board, and checks each result through another door: a card created over MCP in `kanbo card list` and on `serve`'s `/issues`, a move typed in the terminal in the agent's `kanbo_card_get` and the card's history, a person's approval in both. Its last test fails when the manifest lists a command or tool with no case; add a case when you add one (or, if it cannot run in-process, an entry in `NOT_DRIVEN_HERE` saying why).

### Coverage

`npm run coverage` runs the suite with V8 coverage and fails below the thresholds in `vitest.config.ts` (statements, branches, functions, lines — what the suite measured when they were set, rounded down). CI runs it on Linux, Node 24, prints the summary in the log and keeps `coverage/lcov.info` as the `coverage-lcov` artifact. When coverage rises, raise the thresholds with it; code run only in a child process (the built CLI some tests start) is not counted.

### The smoke test

`node scripts/smoke.mjs` checks what users install. It packs this checkout (`npm pack`, which builds first), installs the tarball globally into a temporary prefix, and drives the installed `kanbo` through a new git project: `--version`, bare `kanbo` without a terminal, `init --yes --columns simple --key SMK`, `prime`, a card and `ready`, `connect claude --project --yes`, an MCP handshake started from the written registrations (the project's `.mcp.json` everywhere but Windows, and Codex's user-scope entry everywhere), `serve` answering over HTTP, `doctor --json` with no failure, `instructions short` against the `CLAUDE.md` block, and `uninstall --yes`. `HOME`, `USERPROFILE`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` point into the temporary folder, so your own settings are never touched. It prints a step log and exits non-zero naming the step that failed.

```bash
node scripts/smoke.mjs                          # pack and check this checkout
node scripts/smoke.mjs --tarball kanbo-cli-x.y.z.tgz   # check a tarball packed already
node scripts/smoke.mjs --keep                   # keep the temporary folder to look at
node scripts/smoke.mjs --upgrade                # the upgrade from kanbo-cli@0.2.1 instead (needs the npm registry)
```

`--upgrade` checks an upgrade instead: it installs the published `kanbo-cli@0.2.1` (and `better-sqlite3` beside it, as 0.2.1 needed) into the prefix, runs `init --file --instructions claude --mcp claude --yes` in a new project with text of a person's own around the `CLAUDE.md` block, and fills the board — cards, a comment, a started and a finished run, a status line, a wait for approval, a column description. Then it installs the tarball over the same prefix and checks that every table of the board file holds the same rows, `card list` and `columns list` read the same, `prime`, `ready` and the MCP server started from 0.2.1's `.mcp.json` entry work, `doctor --json` warns (fixably) about the old block and `doctor --fix --yes` makes it current without touching the text around it, `connect --check` answers, and bare `kanbo` prints the board. `src/upgrade-from-0.2.1.test.ts` checks the same without the network, on boards built with the migrations as v0.2.1 shipped them (`src/testing/fixtures/v0.2.1/`).

CI runs both on every job after the tests, and the release workflow runs it on the tarball before publishing.

Every prompt goes through `src/cli/ui/ui.ts`; a test answers one with `src/testing/prompt-driver.ts` (fake terminal streams and key presses, no pty). A test that needs a program on `PATH` writes it with `src/testing/fake-bin.ts`, which works on Windows too.

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

## Releasing

Releases are published by `.github/workflows/release.yml` through npm trusted publishing (OIDC): there is no npm token in the repository or its secrets.

1. Move the `Unreleased` entries of `CHANGELOG.md` under a new `## [x.y.z] — YYYY-MM-DD` heading.
2. Set `"version"` in `package.json` to the same `x.y.z` and run `npm install --package-lock-only`.
3. `npm run build && npm run typecheck && npm test`, commit, push `main`, and wait for CI to pass.
4. Optional rehearsal: run the `release` workflow by hand (Actions → release → Run workflow). A manual run is always a dry run: it checks the version against the changelog, builds, tests, packs and runs `npm publish --dry-run`.
5. Tag and push: `git tag vx.y.z && git push origin vx.y.z`.

On the tag the workflow checks that the tag, `package.json` and a `CHANGELOG.md` section all name the same version, builds, typechecks, tests, checks the tarball, runs the smoke test on it, runs `npm publish --provenance --access public`, and creates (or updates) the GitHub release with that changelog section as its notes and the tarball attached. A version already on the registry is skipped, so a failed run can be re-run.

The trusted publisher is configured once on npmjs.com (package `kanbo-cli` → Settings → Trusted Publisher): GitHub Actions, organization or user `Krowli`, repository `kanbo`, workflow filename `release.yml`, no environment.

## Pull requests

- Keep a pull request to one change, with tests for new behavior.
- `npm run build && npm test && npm run typecheck` must pass; CI runs the same, and the smoke test, on Linux, macOS and Windows, Node 22 and 24; arm64 Linux and Windows and Alpine run too, not yet required to pass.
- Update `docs/` when a command, flag, tool or route changes: `src/mcp/docs.test.ts` fails when a command is missing from `docs/cli.md` or a tool from `docs/mcp.md`.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user would notice.

By contributing you agree that your contributions are licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
