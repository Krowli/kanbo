# Installation

## Requirements

- **Node.js** `^22.19.0` or `>=24.11.0` (the `engines` field of `package.json`).
- **`better-sqlite3`** for board files. It is an *optional peer dependency*: kanbo loads it only when a SQLite board file is actually opened. A Postgres-only setup, `kanbo capabilities` and `kanbo --help` work without it. Opening a board file without it fails with `Install better-sqlite3 to use a board file`.
- For a shared board: a **Postgres** database you can create tables and roles in (Supabase works). See [storage](storage.md).

`better-sqlite3` is a native module. npm downloads a prebuilt binary for common platforms and Node versions; otherwise it compiles from source, which needs Python and a C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on Debian/Ubuntu, the "Desktop development with C++" workload on Windows).

## npm, globally

```bash
npm install -g kanbo-cli better-sqlite3
kanbo --version
```

Install `better-sqlite3` next to kanbo so the binary can find it. Leave it out if you only use Postgres boards.

> The npm package is named `kanbo-cli`; the command it installs is `kanbo`.

## npx, without installing

```bash
npx -y -p kanbo-cli -p better-sqlite3 kanbo --help
```

This works for one-off commands. For agents, a global install (or a project-local one) is better: MCP clients start `kanbo mcp` often, and each `npx` start resolves packages again.

## In a project

```bash
npm install --save-dev kanbo-cli better-sqlite3
npx kanbo init --file
```

`npx kanbo …` then runs the project's copy. MCP registrations written by `kanbo init --mcp` call `kanbo`, so it must be on the `PATH` of the agent — either install globally or change the `command` in the registration to `npx` with `args: ["kanbo", "mcp"]`.

## From source

```bash
git clone https://github.com/Krowli/kanbo.git
cd kanbo
npm install
npm run build
npm link            # puts `kanbo` on your PATH, pointing at this checkout
kanbo --help
```

`npm run build` writes `dist/cli.cjs` (the command), `dist/lib/` (the library, ESM and CJS with types) and `dist/page/` (the board page `kanbo serve` answers with). To make a tarball you can install elsewhere: `npm pack`, then `npm install -g ./kanbo-cli-0.2.1.tgz better-sqlite3`.

## Upgrading

```bash
npm install -g kanbo-cli@latest
```

A newer build may add columns or tables to the board. When it does:

- **A board file** (`kanbo init --file`) keeps working for reads; writes are refused with exit `3` and `Board file is older than this build. Run kanbo migrate.` Run `kanbo migrate` in the project.
- **An external Postgres board** is refused entirely (exit `3`) until you run `kanbo migrate`, and then `kanbo roles apply`, with the owner's connection string. See [storage](storage.md#migrations).

`kanbo migrate` applies only what is pending and is safe to run again. The [changelog](../CHANGELOG.md) says when an upgrade needs it.

## Uninstalling

First take out what `kanbo init` wrote — the instruction blocks and the `kanbo` MCP entries, in the project and in your own files — while `kanbo` is still installed:

```bash
cd your-project
kanbo uninstall            # shows what it will remove, then asks; --yes to skip the question
```

`--project` or `--global` limits it to one scope. Nothing else in those files is touched. Then remove the package:

```bash
npm uninstall -g kanbo-cli better-sqlite3
```

Your boards are not touched: a board file stays in the project's `.kanbo/`, and a Postgres board stays in its database. To remove a project's binding too, run `kanbo uninstall --purge`; it deletes the board file only if you confirm a question naming it in a terminal (`--yes` does not answer that one).
