import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The board page `kanbo serve` answers `/` with: a person opens the server's
 * address in a browser and works the board there.
 *
 * The page holds no data — everything it shows it asks the `/issues` routes
 * for, with the token the person typed — so it is served without the token.
 * Its script and stylesheet are built from `./page/` into `dist/page/` by
 * `tsdown.page.config.ts`; this module only finds them and answers with them,
 * under a policy that lets the page load nothing but itself and talk to
 * nothing but this server.
 */

/** What the page may load and talk to: itself, and nothing else. */
const BOARD_PAGE_CSP = [
  'default-src \'none\'',
  'script-src \'self\'',
  'style-src \'self\'',
  'connect-src \'self\'',
  'img-src \'self\' data:',
  'font-src \'self\'',
  'base-uri \'none\'',
  'form-action \'none\'',
  'frame-ancestors \'none\'',
].join('; ')

const SCRIPT_PATH = '/assets/board.js'
const STYLESHEET_PATH = '/assets/board.css'
const FONT_PATH = /^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/

/** The document itself. No data in it; the `data:` icon keeps the browser from asking for `/favicon.ico`. */
const BOARD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kanbo</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${STYLESHEET_PATH}">
<script src="${SCRIPT_PATH}" defer></script>
</head>
<body>
<div id="app"></div>
</body>
</html>
`

/** The built script, stylesheet and font files (by file name), read once when the server starts. */
export interface BoardPageAssets {
  script: string
  stylesheet: string
  fonts: ReadonlyMap<string, Buffer>
}

/**
 * Where the built page is, as seen from the running file: `dist/page/` beside
 * the bundled binary, or the package's `dist/page/` from `src/serve/` in a
 * checkout — which exists only once `npm run build` has run.
 */
export function resolveBoardPageDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, 'page'), join(here, '..', '..', 'dist', 'page')]
  return candidates.find(directory => existsSync(join(directory, 'board.js'))) ?? candidates[1]
}

/** The page's files from `directory`, or `null` when the page has not been built there. */
export function readBoardPageAssets(directory: string): BoardPageAssets | null {
  const script = join(directory, 'board.js')
  const stylesheet = join(directory, 'board.css')
  if (!existsSync(script) || !existsSync(stylesheet)) {
    return null
  }
  const fontDirectory = join(directory, 'fonts')
  const fonts = new Map<string, Buffer>()
  if (existsSync(fontDirectory)) {
    for (const name of readdirSync(fontDirectory).filter(file => FONT_PATH.test(`/assets/fonts/${file}`))) {
      fonts.set(name, readFileSync(join(fontDirectory, name)))
    }
  }
  return { script: readFileSync(script, 'utf8'), stylesheet: readFileSync(stylesheet, 'utf8'), fonts }
}

/** Whether a path is one of the page's own. */
export function isBoardPagePath(pathname: string): boolean {
  return pathname === '/' || pathname === SCRIPT_PATH || pathname === STYLESHEET_PATH || FONT_PATH.test(pathname)
}

/**
 * Answer a page path. With no built page, `/` says how to build it rather than
 * leaving a person at a blank screen or a `401`.
 */
export function sendBoardPage(response: ServerResponse, pathname: string, assets: BoardPageAssets | null): void {
  if (!assets) {
    const body = JSON.stringify({ code: 'not_found', message: 'The board page is not built. Run: npm run build' })
    response.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    response.end(body)
    return
  }
  const fontName = FONT_PATH.exec(pathname)?.[1]
  if (fontName !== undefined) {
    const font = assets.fonts.get(fontName)
    if (!font) {
      const body = JSON.stringify({ code: 'not_found', message: 'No such font' })
      response.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    response.writeHead(200, {
      'content-type': 'font/woff2',
      'content-length': font.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    response.end(font)
    return
  }
  const [contentType, body] = pathname === SCRIPT_PATH
    ? ['text/javascript; charset=utf-8', assets.script]
    : pathname === STYLESHEET_PATH
      ? ['text/css; charset=utf-8', assets.stylesheet]
      : ['text/html; charset=utf-8', BOARD_PAGE_HTML]
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    'content-security-policy': BOARD_PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}
