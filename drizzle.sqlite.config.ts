import { defineConfig } from 'drizzle-kit'

/**
 * The board's migrations for a board file of this package's own.
 *
 * Three homes, three migration chains, one schema (ruling 5-2):
 * a host app's own chain puts the board inside its database,
 * `drizzle-postgres/` puts it in an external database, and this one builds the
 * file a project keeps beside its own code. There are no `dbCredentials`
 * because nothing here ever connects — the folder is generated from
 * `src/sqlite/schema.ts` and applied by `migrateBoardFile` to whichever file
 * the caller names.
 */
export default defineConfig({
  schema: './src/sqlite/schema.ts',
  out: './drizzle-sqlite',
  dialect: 'sqlite',
})
