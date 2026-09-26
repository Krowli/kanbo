import type { z } from 'zod'

import type { RequestActors } from './actors'
import { validationError } from './errors'

/**
 * A route table as small as the server needs: a method, a path with `:name`
 * segments, the zod shapes of its query and body, and a handler.
 *
 * Routes match in the order they are listed, so a path with a fixed segment —
 * `/issues/statuses` — is listed before the `/issues/:id` it would otherwise
 * fall into — the precedence most HTTP routers give static segments.
 */

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** What a handler is handed: the path parameters, the parsed query and body, and who the request writes as. */
interface RouteInput<TQuery, TBody> {
  params: Record<string, string>
  query: TQuery
  body: TBody
  actors: RequestActors
}

/** One route as it is declared. */
export interface RouteSpec<TQuery, TBody> {
  method: HttpMethod
  path: string
  query?: z.ZodType<TQuery>
  body?: z.ZodType<TBody>
  /**
   * Whether the route writes the board. A write asks the schema guard first, so
   * a board older than this build is never written to — the same guard every
   * `kanbo` command asks.
   */
  write?: boolean
  handle: (input: RouteInput<TQuery, TBody>) => Promise<unknown>
}

/** A route with its types erased, as the table holds it. */
export interface Route {
  method: HttpMethod
  segments: string[]
  write: boolean
  run: (input: { params: Record<string, string>, query: Record<string, string | string[]>, body: unknown, actors: RequestActors }) => Promise<unknown>
}

/** Declare a route; the query and body reach the handler parsed, or the request is a 400. */
export function route<TQuery = Record<string, never>, TBody = undefined>(spec: RouteSpec<TQuery, TBody>): Route {
  return {
    method: spec.method,
    segments: splitPath(spec.path),
    write: spec.write ?? false,
    run: async ({ params, query, body, actors }) => {
      const parsedQuery = spec.query ? spec.query.safeParse(query) : { success: true as const, data: query as TQuery }
      if (!parsedQuery.success) {
        throw validationError('query', parsedQuery.error)
      }
      // A body-less request to a route that takes one is read as `{}`: every
      // body with nothing required — approve, wait-approval — may be left out.
      const parsedBody = spec.body ? spec.body.safeParse(body ?? {}) : { success: true as const, data: undefined as TBody }
      if (!parsedBody.success) {
        throw validationError('body', parsedBody.error)
      }
      return await spec.handle({ params, query: parsedQuery.data, body: parsedBody.data, actors })
    },
  }
}

/** The route a request names and its path parameters, or `null` when no route does. */
export function matchRoute(routes: readonly Route[], method: string, path: string): { route: Route, params: Record<string, string> } | null {
  const segments = splitPath(path)
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== segments.length) {
      continue
    }
    const params: Record<string, string> = {}
    const matches = candidate.segments.every((segment, index) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = segments[index]
        return segments[index].length > 0
      }
      return segment === segments[index]
    })
    if (matches) {
      return { route: candidate, params }
    }
  }
  return null
}

/**
 * A path as its segments, decoded, with a trailing slash ignored: `/issues`
 * and `/issues/` are the same list route. A segment that is not valid
 * percent-encoding is kept as it came, and names nothing on the board.
 */
function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment)
    }
    catch {
      return segment
    }
  })
}
