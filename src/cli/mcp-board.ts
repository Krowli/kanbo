import type { KanboDbTransport, KanboDbTransportInput } from '../mcp/db-transport'
import { createDbTransport } from '../mcp/db-transport'
import type { KanboToolTransport } from '../mcp/transport'
import { BoardNotFoundError } from './db-target'
import { CliError, EXIT_NOT_RESOLVED } from './output'

/**
 * The board `kanbo mcp` serves — or, in a folder with none yet, a stand-in
 * that finds it later.
 *
 * A person who registers kanbo in their own agent settings has it started in
 * every folder they open, and most of those have no board. A server that
 * refused to start there would show up in the agent as a broken connection. So
 * it starts anyway: the client connects and reads the instructions, and every
 * tool answers that there is no board here. Each call looks again, so a board
 * a person creates in this folder while the agent is running is picked up on
 * the next call, and held from then on.
 *
 * Any other failure to open the board — a file that is not a board, a database
 * that does not answer — is not "no board" and still stops the server at once.
 */

/** What every tool answers in a folder with no board. */
export const NO_BOARD_FOR_AGENT_MESSAGE
  = 'This folder has no kanbo board. Ask a person to run `kanbo` here to set one up.'

/** Every method of the tool transport, listed so the stand-in forwards each — a new one is a type error here. */
const TRANSPORT_METHODS: Record<keyof KanboToolTransport, true> = {
  prime: true,
  ready: true,
  columns: true,
  sprints: true,
  cardGet: true,
  cardList: true,
  cardCreate: true,
  cardUpdate: true,
  cardMove: true,
  cardComment: true,
  cardLinkPullRequest: true,
  cardPullRequests: true,
  statusLine: true,
  waitApproval: true,
  runStart: true,
  runFinish: true,
}

export async function openMcpBoard(input: KanboDbTransportInput): Promise<KanboDbTransport> {
  try {
    return await createDbTransport(input)
  }
  catch (error) {
    if (!isNoBoard(error)) {
      throw error
    }
  }
  return createDeferredBoard(input)
}

function createDeferredBoard(input: KanboDbTransportInput): KanboDbTransport {
  let board: KanboDbTransport | null = null
  let opening: Promise<KanboDbTransport> | null = null

  const open = async (): Promise<KanboDbTransport> => {
    if (board) {
      return board
    }
    opening ??= createDbTransport(input).then(
      (opened) => {
        board = opened
        return opened
      },
      (error: unknown) => {
        opening = null
        throw isNoBoard(error) ? new CliError(EXIT_NOT_RESOLVED, NO_BOARD_FOR_AGENT_MESSAGE) : error
      },
    )
    return await opening
  }

  const methods = Object.fromEntries(Object.keys(TRANSPORT_METHODS).map(name => [
    name,
    async (argument: unknown) => {
      const opened = await open()
      const method = opened[name as keyof KanboToolTransport] as (argument: unknown) => Promise<unknown>
      return await method(argument)
    },
  ])) as unknown as KanboToolTransport

  return {
    ...methods,
    close: async () => {
      await board?.close()
    },
  }
}

/** The failure that means nothing names a board here — not a board that failed to open. */
function isNoBoard(error: unknown): boolean {
  return error instanceof BoardNotFoundError
}
