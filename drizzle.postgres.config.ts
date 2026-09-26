import { defineConfig } from 'drizzle-kit'

/**
 * The board's own migrations, for an external Postgres database.
 *
 * A host app's own migration runner migrates the board inside its own
 * database; `drizzle-sqlite/` migrates a board file of a project's own; this config
 * migrates an external Postgres board — three chains kept in step by hand,
 * generated together: a change to the board schema is three migrations, one
 * per chain, at the same epoch. There are no `dbCredentials` because nothing
 * here ever connects — the folder is generated from the schema and applied by
 * `kanbo migrate` against whichever database the caller names.
 */
export default defineConfig({
  schema: './src/postgres/schema.ts',
  out: './drizzle-postgres',
  dialect: 'postgresql',
})
