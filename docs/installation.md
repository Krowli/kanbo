# Installation

## Requirements

- **Node.js** `^22.19.0` or `>=24.11.0` (the `engines` field of `package.json`).
- **`better-sqlite3`** for board files. It is an *optional dependency*: `npm install -g kanbo-cli` brings it along, with a prebuilt binary for macOS, Linux — glibc (Debian, Ubuntu, …) and musl (**Alpine**) — and Windows, each for x64 and arm64. kanbo loads it only when a board file is actually opened, so a Postgres-only setup, `kanbo capabilities` and `kanbo --help` work even where it could not be installed. Opening a board file without it fails with `Could not load better-sqlite3, which kanbo opens board files with, …`.
- For a shared board: a **Postgres** database you can create tables and roles in (Supabase works). See [storage](storage.md).

An older Node is refused before anything else runs: `kanbo needs Node ^22.19.0 || >=24.11.0; this is Node …`.

## npm, globally

```bash
npm install -g kanbo-cli
kanbo --version
```

> The npm package is named `kanbo-cli`; the command it installs is `kanbo`.

**Windows PowerShell.** npm's global installs put a `kanbo.ps1` shim on your `PATH` alongside `kanbo.cmd`. If PowerShell answers `kanbo : File …\kanbo.ps1 cannot be loaded because running scripts is disabled on this system`, that is its execution policy, not kanbo — it blocks every npm-installed CLI's `.ps1` shim the same way. Fix it once for your own account: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in PowerShell (no admin needed for `CurrentUser`). Command Prompt is unaffected: `kanbo.cmd` runs there either way.

## npx, without installing

```bash
npx -y -p kanbo-cli kanbo --help
```

`npx` installs `kanbo-cli` and its optional `better-sqlite3` the same way `npm install` does, into a throwaway cache. This works for one-off commands. For agents, a global install (or a project-local one) is better: MCP clients start `kanbo mcp` often, and each `npx` start resolves packages again — on a slow connection, or a registry outage, that start fails.

## In a project

```bash
npm install --save-dev kanbo-cli
npx kanbo init --file
```

`npx kanbo …` then runs the project's copy. MCP registrations written by `kanbo connect` (or `kanbo init --mcp`) call `kanbo`, so it must be on the `PATH` of the agent — either install globally or change the `command` in the registration to `npx` with `args: ["kanbo", "mcp"]`.

## From source

```bash
git clone https://github.com/Krowli/kanbo.git
cd kanbo
npm install
npm run build
npm link            # puts `kanbo` on your PATH, pointing at this checkout
kanbo --help
```

`npm run build` writes `dist/cli.cjs` (the command), `dist/lib/` (the library, ESM and CJS with types) and `dist/page/` (the board page `kanbo serve` answers with). To make a tarball you can install elsewhere: `npm pack`, then `npm install -g ./kanbo-cli-0.2.1.tgz`.

## Upgrading

```bash
npm install -g kanbo-cli@latest
```

A newer build may add columns or tables to the board. When it does:

- **A board file** (`kanbo init --file`) keeps working for reads; writes are refused with exit `3` and `This board file was made by an older kanbo. Run kanbo migrate.` Run `kanbo migrate` in the project.
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
npm uninstall -g kanbo-cli
```

Your boards are not touched: a board file stays in the project's `.kanbo/`, and a Postgres board stays in its database. To remove a project's binding too, run `kanbo uninstall --purge`; it deletes the board file only if you confirm a question naming it in a terminal (`--yes` does not answer that one).
