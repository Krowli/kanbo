import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { BoardSession } from '../cli/command'
import { describeFailure } from '../cli/failure'
import { CliError } from '../cli/output'
import type { ServeActors } from './actors'
import { ACTOR_HEADER, resolveRequestActors } from './actors'
import { isBoardPagePath, readBoardPageAssets, resolveBoardPageDirectory, sendBoardPage } from './board-page'
import type { ServeErrorBody } from './errors'
import { readErrorResponse, ServeError } from './errors'
import type { Route } from './router'
import { matchRoute } from './router'
import { createIssueRoutes } from './routes'

/**
 * `kanbo serve` — the board over HTTP, with nothing but `node:http` under it.
 *
 * What it answers is `./routes.ts`; what this module owns is the door: who may
 * come in, from which origin, with how much, and in what order. Requests are
 * handled one at a time. A SQLite board is one connection whose transactions
 * may await, and two requests interleaving on it would land in each other's
 * transaction — the reason a long-running host of the board lines its writes up
 * one at a time. One at a time is that line, and on a board this size it costs
 * nothing a person would notice.
 */

/** The most a request body may carry. A card is a few kilobytes; a megabyte is a mistake or an attack. */
export const SERVE_BODY_LIMIT_BYTES = 1024 * 1024

/** What `kanbo serve` listens on when nothing says otherwise. */
export const DEFAULT_SERVE_HOST = '127.0.0.1'
export const DEFAULT_SERVE_PORT = 4318

/** What a caller is told when a board is offered beyond this machine with nothing guarding it. */
export const SERVE_TOKEN_REQUIRED_MESSAGE
  = 'Serving the board beyond this machine needs a token. Pass --token or set KANBO_SERVE_TOKEN, '
    + 'or bind to 127.0.0.1.'

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'
const ALLOWED_HEADERS = `authorization, content-type, ${ACTOR_HEADER}`
/** How long a browser may keep a preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600

export interface KanboServeOptions {
  /** The open board and workspace every route is about. The caller closes it. */
  session: BoardSession
  actors: ServeActors
  host: string
  /** `0` asks the system for a free port. */
  port: number
  /** When set, every request must carry `Authorization: Bearer <token>`. Required off loopback. */
  token?: string | null
  /** The exact origins a browser may call from; none by default. */
  corsOrigins?: readonly string[]
  /** Where the built board page is; by default `dist/page/`, found from the running file. */
  pageDirectory?: string
  /** Where a request that failed for a reason nobody named is written down. Never a token or a connection string. */
  log?: (line: string) => void
}

export interface RunningKanboServer {
  /** The address to call, e.g. `http://127.0.0.1:4318`. */
  url: string
  port: number
  /** Stop listening and drop every open connection. The board stays open; its owner closes it. */
  close: () => Promise<void>
}

/**
 * Whether an address only this machine can reach. Anything else — `0.0.0.0`
 * included, which is every interface — is beyond it.
 */
function isLoopbackHost(host: string): boolean {
  const bare = stripBrackets(host).toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare)
}

/** Refuse to offer the board beyond this machine unguarded. Asked before the board is even opened. */
export function assertServeBinding(host: string, token: string | null | undefined): void {
  if (!isLoopbackHost(host) && !token) {
    throw new CliError(1, SERVE_TOKEN_REQUIRED_MESSAGE)
  }
}

export async function startKanboServer(options: KanboServeOptions): Promise<RunningKanboServer> {
  assertServeBinding(options.host, options.token)
  const routes = createIssueRoutes(options.session)
  // `[::1]` is how an address is written in a URL; `listen` takes it bare.
  const listenHost = stripBrackets(options.host)
  let boundPort = 0
  const handle = createRequestHandler(routes, options, () => boundPort)
  const server = createServer((request, response) => void handle(request, response))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })

  boundPort = (server.address() as AddressInfo).port
  return {
    url: `http://${urlHost(listenHost)}:${boundPort}`,
    port: boundPort,
    close: async () => await closeServer(server),
  }
}

/**
 * Who may act for a person on this server, said once when it starts: only a
 * request presenting the token does, and a server with no token, or started
 * from an agent's shell, has nobody who may.
 */
export function describePersonRights(actors: ServeActors, token: string | null | undefined): string {
  if (!actors.person) {
    return 'no request acts for a person (started from an agent\'s shell)'
  }
  if (!token) {
    return 'no request acts for a person (no token; set KANBO_SERVE_TOKEN to allow it)'
  }
  return `a request with the token acts for ${actors.person.id}`
}

function stripBrackets(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, '$1')
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
    // A client holding a keep-alive connection would otherwise hold the
    // shutdown open until it let go.
    server.closeAllConnections()
  })
}

/** Methods that change nothing, and so need no JSON content type to prove a script sent them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function createRequestHandler(routes: readonly Route[], options: KanboServeOptions, boundPort: () => number) {
  const token = options.token || null
  const corsOrigins = new Set(options.corsOrigins ?? [])
  const log = options.log ?? ((line: string) => console.error(line))
  const loopback = isLoopbackHost(options.host)
  const page = readBoardPageAssets(options.pageDirectory ?? resolveBoardPageDirectory())
  /** The tail of the line requests wait in. It never rejects, so one failure cannot stop the rest. */
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * The `Host` a loopback server answers to: its own loopback names with the
   * port it is on. A page on another site that rebinds its own name to
   * 127.0.0.1 still sends that name, and is turned away.
   */
  function allowedHosts(): Set<string> {
    const port = boundPort()
    return new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `${urlHost(stripBrackets(options.host)).toLowerCase()}:${port}`,
    ])
  }

  /**
   * The origins of this server's own page: `http://` and each name it answers
   * to. A browser names it on every write the page sends, and it is let in the
   * way a `--cors-origin` is — but with no CORS header needed, being the same
   * origin. Bound to `0.0.0.0` the server has no one name to be called by, so
   * a page opened by some address of it is named with `--cors-origin`.
   */
  function isOwnOrigin(origin: string): boolean {
    return [...allowedHosts()].some(host => origin.toLowerCase() === `http://${host}`)
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const origin = request.headers.origin
    try {
      if (loopback && !allowedHosts().has((request.headers.host ?? '').toLowerCase())) {
        throw new ServeError(403, 'host_not_allowed', 'This server answers only to its own loopback address')
      }
      // A browser names the page a request comes from. A page that is not on
      // the list is refused whatever it asks, before anything is routed — a
      // "simple" request needs no preflight, and would otherwise be carried out
      // with only its answer hidden from the page.
      if (origin !== undefined && !corsOrigins.has(origin) && !isOwnOrigin(origin)) {
        throw new ServeError(403, 'origin_not_allowed', 'Requests from this origin are not allowed')
      }
      if (origin !== undefined && corsOrigins.has(origin)) {
        response.setHeader('access-control-allow-origin', origin)
        response.setHeader('vary', 'Origin')
      }

      // A preflight carries no credentials — the browser asks before it sends
      // them — so it is answered before the token is asked for, and says
      // nothing about the board.
      if (request.method === 'OPTIONS') {
        if (origin !== undefined && corsOrigins.has(origin)) {
          response.setHeader('access-control-allow-methods', ALLOWED_METHODS)
          response.setHeader('access-control-allow-headers', ALLOWED_HEADERS)
          response.setHeader('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS))
        }
        response.writeHead(204).end()
        return
      }

      // The page holds no data — it asks the routes below for everything, with
      // the token the person gives it — so it is served without the token.
      const url = new URL(request.url ?? '/', 'http://kanbo.invalid')
      if ((request.method === 'GET' || request.method === 'HEAD') && isBoardPagePath(url.pathname)) {
        sendBoardPage(response, url.pathname, page)
        return
      }

      if (token && !carriesToken(request, token)) {
        response.setHeader('www-authenticate', 'Bearer')
        throw new ServeError(401, 'unauthorized', 'A valid bearer token is required')
      }
      // A form or a `text/plain` fetch reaches a server without a preflight;
      // a JSON content type does not. Every write therefore has to say it.
      if (!SAFE_METHODS.has(request.method ?? 'GET') && !isJsonContentType(request.headers['content-type'])) {
        throw new ServeError(415, 'unsupported_media_type', 'Send the request as content-type: application/json')
      }
      const matched = matchRoute(routes, request.method ?? 'GET', url.pathname)
      if (!matched) {
        throw new ServeError(404, 'not_found', 'Not Found')
      }
      const body = await readJsonBody(request)
      // Acting for a person takes the token: without one configured, nobody
      // who can reach the port is known to be the person who started it.
      const actors = resolveRequestActors(options.actors, {
        actorHeader: request.headers[ACTOR_HEADER],
        authenticated: token !== null,
      })
      const result = queue.then(async () => {
        if (matched.route.write) {
          await options.session.assertWritable()
        }
        return await matched.route.run({ params: matched.params, query: readQuery(url.searchParams), body, actors })
      })
      queue = result.catch(() => undefined)
      sendJson(response, 200, await result)
    }
    catch (error) {
      const failure = readErrorResponse(error)
      if (failure) {
        if (failure.status === 413) {
          // The rest of the body is not read: the connection goes with the answer.
          response.setHeader('connection', 'close')
          response.once('finish', () => request.destroy())
        }
        else if (!request.complete) {
          // A body nobody read is not worth keeping the connection for.
          response.setHeader('connection', 'close')
        }
        sendJson(response, failure.status, failure.body)
        return
      }
      log(`kanbo serve: ${request.method} ${request.url?.split('?')[0]} failed: ${describeFailure(error).message}`)
      sendJson(response, 500, { code: 'internal_server_error', message: 'Internal Server Error' } satisfies ServeErrorBody)
    }
  }
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * Whether the request carries the token, compared in constant time. Both sides
 * are hashed first, so the comparison is between two values of one length and
 * says nothing about how long the token is.
 */
function carriesToken(request: IncomingMessage, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  if (!match) {
    return false
  }
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(match[1].trim()), digest(token))
}

function payloadTooLarge(): ServeError {
  return new ServeError(413, 'payload_too_large', `Request body is larger than ${SERVE_BODY_LIMIT_BYTES} bytes`, {
    limit: SERVE_BODY_LIMIT_BYTES,
  })
}

/**
 * The request body as JSON, `undefined` when there is none.
 *
 * A body that says it is over the limit is refused before a byte of it is
 * read, and one that turns out to be is refused the moment it passes the
 * limit; either way the rest is never read (the caller closes the connection).
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > SERVE_BODY_LIMIT_BYTES) {
    throw payloadTooLarge()
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > SERVE_BODY_LIMIT_BYTES) {
      throw payloadTooLarge()
    }
    chunks.push(chunk)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') {
    return undefined
  }
  try {
    return JSON.parse(text)
  }
  catch {
    throw new ServeError(400, 'validation_error', 'request validation failed', {
      source: 'body',
      issues: [{ path: 'root', message: 'Body is not valid JSON' }],
    })
  }
}

/** The query string as the schemas read it: a repeated parameter is a list, a single one a string. */
function readQuery(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    query[key] = values.length === 1 ? values[0] : values
  }
  return query
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
