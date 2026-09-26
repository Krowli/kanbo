import type { Command } from 'commander'

import { openInBrowser, presentServePage, resolveServeAccess } from '../../serve/access'
import type { ServeActors } from '../../serve/actors'
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  describePersonRights,
  startKanboServer,
} from '../../serve/server'
import { createCliActor, createPersonActor, isAgentShell } from '../actor'
import { openBoardSession } from '../command'
import { describeFailure } from '../failure'
import { CliError } from '../output'

/**
 * `kanbo serve` — the board over HTTP: the board page for a browser, and the
 * board's `/issues` routes for any other client.
 *
 * The routes serve the board and workspace this command resolves the way every
 * other command does, so a client written against them shows and edits this
 * board unchanged, whichever server answers them. Everything
 * about the door — the token, the origins, the body limit, who a request writes
 * as — is `../../serve/`.
 */

/** What `kanbo serve` is told. */
interface ServeCommandOptions {
  port: string
  host: string
  db?: string
  databaseUrl?: string
  workspace?: string
  token?: string
  corsOrigin: string[]
  /** `false` under `--no-open`. */
  open: boolean
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('serve this board over HTTP, with a board page for the browser')
    .option('--port <port>', 'port to listen on', String(DEFAULT_SERVE_PORT))
    .option('--host <host>', 'address to bind; anything but loopback needs a token', DEFAULT_SERVE_HOST)
    .option('--db <path>', 'board database file to open')
    .option('--database-url <url>', 'external Postgres board to serve instead of a board file')
    .option('--workspace <nameOrId>', 'workspace the server is about')
    .option('--token <token>', 'bearer token every request must carry (or set KANBO_SERVE_TOKEN); made up for the run on loopback when absent')
    .option('--cors-origin <origin>', 'let a browser call from this exact origin; repeat for more', collect, [])
    .option('--no-open', 'print the board page link without opening it in the browser')
    .action(async (options: ServeCommandOptions) => {
      const port = parsePort(options.port)
      // Refused before the board is opened: a server that would not be allowed
      // to start has no business connecting to anything first.
      const access = resolveServeAccess(options.host, options.token?.trim() || process.env.KANBO_SERVE_TOKEN?.trim() || null)

      const session = await openBoardSession(
        { db: options.db, databaseUrl: options.databaseUrl, workspace: options.workspace },
        'read',
      )
      const agentShell = isAgentShell()
      const actors: ServeActors = { writer: createCliActor(), person: agentShell ? null : createPersonActor() }

      let server: Awaited<ReturnType<typeof startKanboServer>>
      try {
        server = await startKanboServer({
          session,
          actors,
          host: options.host,
          port,
          token: access.token,
          corsOrigins: options.corsOrigin,
        })
      }
      catch (error) {
        await session.close()
        throw error
      }

      console.error(`kanbo serve: ${server.url} — workspace ${session.workspace.id}, bearer token required${access.generated ? ' (generated for this run)' : ''}`)
      console.error(`kanbo serve: ${describePersonRights(actors)}`)
      presentServePage(
        { url: server.url, access, agentShell, terminal: process.stdout.isTTY === true, open: options.open },
        { print: line => console.log(line), openInBrowser },
      )

      let stopping = false
      const stop = async (): Promise<void> => {
        if (stopping) {
          return
        }
        stopping = true
        try {
          await server.close()
          await session.close()
          process.exit(0)
        }
        catch (error) {
          console.error(describeFailure(error).message)
          process.exit(1)
        }
      }
      process.once('SIGINT', () => void stop())
      process.once('SIGTERM', () => void stop())
    })
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** A port a caller typed, refused rather than guessed at when it is not one. */
function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(1, `Expected a port between 0 and 65535, got "${value}".`)
  }
  return port
}
