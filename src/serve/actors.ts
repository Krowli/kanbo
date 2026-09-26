import type { BoardActor } from '../ops/types'

/**
 * Who a request writes as.
 *
 * An app with sign-in knows its caller from the session a request carries.
 * This server has none to ask, so it says what `kanbo` says in a terminal: every
 * write is filed `external`, under the user who started the server. What a
 * request cannot do is name its own kind — a header that could say `user`
 * would make approval worth nothing — so the only thing a request may say
 * about itself is that it is *less*: `x-kanbo-actor: agent`.
 *
 * Acting for a person takes two things: the server was not started from a
 * shell started for an agent (the detection `kanbo approve` refuses
 * on), and the request presented the server's token. Without a token anyone
 * who can reach the port could be anything, so nobody acts for a person.
 */

/** The header a request downgrades itself with. */
export const ACTOR_HEADER = 'x-kanbo-actor'

/** Who the server may write as, fixed when it starts. */
export interface ServeActors {
  /** Every write is filed under this — `external`, as the command line files it. */
  writer: BoardActor
  /** The person who started the server, or `null` when it was started from an agent's shell. */
  person: BoardActor | null
}

/** Who one request writes as, by what it is doing. */
export interface RequestActors {
  /** Status lines, comments, runs, links, context refs — the writes anyone may make. */
  writer: BoardActor
  /**
   * Putting a card in a column — create, update, move, reorder, bulk. For a
   * person the column's entry rules warn (`unmetRules`) instead of refusing, as
   * they do for a person on the board page and in their own terminal.
   */
  placement: BoardActor
  /**
   * What only a person may do — approve, return, close a sprint, set a
   * column's entry rules, delete a comment the board wrote, drop a link somebody
   * else made. When the request may not act for one this is the writer, and the
   * board refuses it with its own 403.
   */
  person: BoardActor
}

/** What a request says about itself that decides its actors. */
export interface RequestIdentity {
  /** The `x-kanbo-actor` header, as many times as it was sent. */
  actorHeader: string | string[] | undefined
  /** Whether the request presented the server's token — only then may it act for a person. */
  authenticated: boolean
}

/**
 * The actors one request gets: the person's rights only for a request that
 * presented the token, on a server whose starter may act as one, and that did
 * not give them up with `agent` among the values of `x-kanbo-actor`.
 */
export function resolveRequestActors(actors: ServeActors, identity: RequestIdentity): RequestActors {
  const person = identity.authenticated && !saysAgent(identity.actorHeader) ? actors.person : null
  if (!person) {
    return { writer: actors.writer, placement: actors.writer, person: actors.writer }
  }
  return { writer: actors.writer, placement: { ...actors.writer, placesForPerson: true }, person }
}

/** Whether any comma-separated value of the header, however it is spelled or repeated, is `agent`. */
function saysAgent(header: string | string[] | undefined): boolean {
  return [header ?? []].flat().flatMap(value => value.split(',')).some(value => value.trim().toLowerCase() === 'agent')
}
