#!/usr/bin/env node
// End-to-end check of what users install: pack kanbo, install the tarball
// globally into a temporary prefix, and drive the installed `kanbo` through a
// new project — board, card, agent connection, MCP handshake, `serve`,
// `doctor`, `uninstall`. Plain Node, the same on every OS.
//
//   node scripts/smoke.mjs                  # packs this checkout first (runs the build through prepack)
//   node scripts/smoke.mjs --tarball <tgz>  # installs a tarball packed already
//   node scripts/smoke.mjs --keep           # leaves the temporary folders for a look
//
// Nothing outside the temporary folders is touched: HOME, USERPROFILE,
// CODEX_HOME and CLAUDE_CONFIG_DIR point inside them for every kanbo run.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS = process.platform === 'win32'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const KEY = 'SMK'
const TOKEN = 't'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const tarballArg = args.includes('--tarball') ? args[args.indexOf('--tarball') + 1] : null

// ---------------------------------------------------------------- the log

let currentStep = 'setup'
const warnings = []

function step(name) {
  currentStep = name
  console.log(`\n▶ ${name}`)
}

function note(text) {
  console.log(`  ${text}`)
}

class SmokeFailure extends Error {}

function check(condition, message, detail) {
  if (!condition) {
    throw new SmokeFailure(detail === undefined ? message : `${message}\n${detail}`)
  }
}

// ---------------------------------------------------------------- folders and environment

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kanbo-smoke-')))
const prefix = join(root, 'prefix')
const home = join(root, 'home')
const project = join(root, 'project')
for (const dir of [prefix, home, project, join(home, '.codex'), join(home, '.claude')]) {
  mkdirSync(dir, { recursive: true })
}

// npm puts global bins in <prefix>/bin on POSIX and in <prefix> itself on Windows.
const binDir = WINDOWS ? prefix : join(prefix, 'bin')
const packageDir = WINDOWS ? join(prefix, 'node_modules', 'kanbo-cli') : join(prefix, 'lib', 'node_modules', 'kanbo-cli')

function pathKey(env) {
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** The environment every kanbo run gets: the installed bin first, a throwaway home, no agent shell. */
function kanboEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GEMINI_CLI', 'CURSOR_AGENT', 'CODEX_SANDBOX', 'KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'KANBO_SERVE_TOKEN', 'KANBO_DEBUG']) {
    delete env[name]
  }
  const key = pathKey(env)
  const path = env[key] ?? ''
  delete env[key]
  return {
    ...env,
    [key]: `${binDir}${WINDOWS ? ';' : ':'}${path}`,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GEMINI_CLI_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    KANBO_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    ...extra,
  }
}

/** `kanbo.cmd` on Windows needs a shell; its arguments are quoted for cmd.exe. */
function quoteForCmd(arg) {
  return /^[\w.:\\/=,@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

function spawnArgs(command, commandArgs) {
  if (!WINDOWS) {
    return { file: command, args: commandArgs, shell: false }
  }
  return { file: [command, ...commandArgs].map(quoteForCmd).join(' '), args: [], shell: true }
}

/** Run a command to the end; `stdin` is a pipe with nothing in it, never a terminal. */
function run(command, commandArgs, { env = kanboEnv(), cwd = project, expectCode = 0 } = {}) {
  const shown = [command, ...commandArgs].join(' ')
  note(`$ ${shown}`)
  const spec = spawnArgs(command, commandArgs)
  const result = spawnSync(spec.file, spec.args, { cwd, env, shell: spec.shell, input: '', encoding: 'utf8', timeout: 120_000, windowsHide: true })
  if (result.error) {
    throw new SmokeFailure(`${shown} did not run: ${result.error.message}`)
  }
  const stdout = result.stdout.replace(/\r\n/g, '\n')
  const stderr = result.stderr.replace(/\r\n/g, '\n')
  if (expectCode !== null && result.status !== expectCode) {
    throw new SmokeFailure(`${shown} exited ${result.status} (signal ${result.signal}), expected ${expectCode}`
      + `\n--- stdout\n${stdout}\n--- stderr\n${stderr}`)
  }
  return { code: result.status, stdout, stderr, all: `${stdout}\n${stderr}` }
}

const kanbo = (commandArgs, options) => run('kanbo', commandArgs, options)

// ---------------------------------------------------------------- helpers for the checks

function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

const BLOCK_PATTERN = /<!-- KANBO_START ([^>]*?)\s*-->\n([\s\S]*?)\n<!-- KANBO_END -->/

function readTomlServer(text) {
  const table = text.split(/^\[/m).find(part => part.startsWith('mcp_servers.kanbo]'))
  check(table !== undefined, 'config.toml has no [mcp_servers.kanbo] table', text)
  const strings = raw => [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[2] ?? JSON.parse(`"${m[1]}"`))
  const command = /^command\s*=\s*(.+)$/m.exec(table)
  const argsLine = /^args\s*=\s*\[(.*)\]\s*$/m.exec(table)
  check(command !== null, 'the kanbo table has no command', table)
  return { command: strings(command[1])[0], args: argsLine ? strings(argsLine[1]) : [] }
}

/** Start the server as a client would from its registration, shake hands, call kanbo_ready. */
async function mcpHandshake(label, launch) {
  note(`${label}: ${launch.command} ${launch.args.join(' ')}`)
  // The SDK the installed kanbo depends on — what a user's machine has.
  const require = createRequire(join(packageDir, 'package.json'))
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: kanboEnv(), cwd: project, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => { stderr += chunk })
  const client = new Client({ name: 'kanbo-smoke', version: VERSION })
  try {
    await withTimeout(client.connect(transport), 60_000, `${label}: no handshake within 60 s\n${stderr}`)
    const info = client.getServerVersion()
    check(info?.name === 'kanbo', `${label}: serverInfo.name is ${JSON.stringify(info?.name)}, expected "kanbo"`, stderr)
    const instructions = client.getInstructions()
    check(typeof instructions === 'string' && instructions.trim().length > 0, `${label}: the server sent no instructions`)
    const ready = await withTimeout(client.callTool({ name: 'kanbo_ready', arguments: {} }), 60_000, `${label}: kanbo_ready did not answer`)
    const text = (ready.content ?? []).map(part => part.text ?? '').join('\n')
    check(!ready.isError && text.includes(`${KEY}-001`), `${label}: kanbo_ready does not list ${KEY}-001`, text)
    note(`${label}: serverInfo ${info.name} ${info.version}, ${instructions.length} chars of instructions, kanbo_ready lists ${KEY}-001`)
  }
  finally {
    await client.close().catch(() => {})
  }
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new SmokeFailure(message)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** Stop a process and everything it started; on Windows `kanbo` runs under cmd.exe, so the tree goes. */
function stopTree(child) {
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  else {
    child.kill('SIGTERM')
  }
}

async function serveCheck() {
  const spec = spawnArgs('kanbo', ['serve', '--port', '0', '--no-open'])
  note('$ kanbo serve --port 0 --no-open  (KANBO_SERVE_TOKEN=t)')
  const child = spawn(spec.file, spec.args, { cwd: project, env: kanboEnv({ KANBO_SERVE_TOKEN: TOKEN }), shell: spec.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  const exited = new Promise(resolveExit => child.on('exit', (code, signal) => resolveExit({ code, signal })))
  try {
    const { url, workspace } = await withTimeout(new Promise((resolveUrl, reject) => {
      const onData = (chunk) => {
        output += chunk
        const found = /kanbo serve: (http:\/\/\S+) — workspace ([^,\s]+),/.exec(output)
        if (found) {
          resolveUrl({ url: found[1].replace(/\/$/, ''), workspace: found[2] })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      exited.then(({ code }) => reject(new SmokeFailure(`kanbo serve exited ${code} before printing its address\n${output}`)))
    }), 60_000, `kanbo serve printed no address within 60 s\n${output}`)
    note(`serving at ${url}, workspace ${workspace}`)
    const versionUrl = `${url}/issues/version?workspaceId=${encodeURIComponent(workspace)}`
    const unauthorized = await fetch(versionUrl)
    check(unauthorized.status === 401, `GET /issues/version without the token answered ${unauthorized.status}, expected 401`)
    const response = await fetch(versionUrl, { headers: { authorization: `Bearer ${TOKEN}` } })
    const body = await response.text()
    check(response.status === 200, `GET /issues/version answered ${response.status}`, body)
    check(typeof JSON.parse(body).seq === 'number', 'GET /issues/version has no seq', body)
    note(`GET /issues/version → 200 ${body}`)
  }
  finally {
    stopTree(child)
    const stopped = await withTimeout(exited, 15_000, `kanbo serve did not exit within 15 s of being stopped\n${output}`)
    note(`kanbo serve stopped (code ${stopped.code}, signal ${stopped.signal})`)
  }
}

// ---------------------------------------------------------------- the run

async function main() {
  console.log(`kanbo smoke ${VERSION} — Node ${process.version}, ${process.platform}/${process.arch}`)
  console.log(`temporary folder: ${root}`)

  step('pack')
  let tarball
  if (tarballArg) {
    tarball = resolve(tarballArg)
    check(existsSync(tarball), `no tarball at ${tarball}`)
  }
  else {
    const packDir = join(root, 'pack')
    mkdirSync(packDir)
    // prepack builds first, and the build prints to stdout: the tarball is found by its name, not in npm's output.
    const npm = spawnArgs('npm', ['pack', '--pack-destination', packDir])
    execFileSync(npm.file, npm.args, { cwd: REPO, shell: npm.shell, stdio: ['ignore', 'inherit', 'inherit'] })
    const packed = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
    check(packed.length === 1, `npm pack left ${packed.length} tarballs in ${packDir}`)
    tarball = join(packDir, packed[0])
  }
  note(tarball)

  step('install the tarball globally into a temporary prefix')
  // npm itself keeps the real environment (its cache, its registry settings); only kanbo runs get the throwaway home.
  run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { env: process.env, cwd: root })
  check(existsSync(join(packageDir, 'package.json')), `the package is not at ${packageDir}`)
  const sqlite = existsSync(join(packageDir, 'node_modules', 'better-sqlite3')) || existsSync(join(prefix, WINDOWS ? '' : 'lib', 'node_modules', 'better-sqlite3'))
  check(sqlite, 'better-sqlite3 was not installed with the package')

  step('a. kanbo --version')
  const version = kanbo(['--version']).stdout.trim()
  check(version === VERSION, `kanbo --version printed ${JSON.stringify(version)}, expected ${VERSION}`)
  note(version)

  run('git', ['init', '-q'], { env: kanboEnv() })

  step('b. bare kanbo without a terminal')
  const bare = kanbo([])
  check(bare.all.includes('kanbo init --yes'), 'bare kanbo does not mention kanbo init --yes', bare.all)

  step('c. kanbo init --yes --columns simple --key SMK')
  kanbo(['init', '--yes', '--columns', 'simple', '--key', KEY])
  const boardFile = join(project, '.kanbo', 'board.db')
  check(existsSync(boardFile), `no board file at ${boardFile}`)

  step('d. kanbo prime')
  const prime = kanbo(['prime'])
  check(prime.stdout.includes('To Do'), 'kanbo prime does not list To Do', prime.all)

  step('e. a card, and kanbo ready')
  kanbo(['card', 'create', '--description', 'smoke card'])
  const ready = kanbo(['ready', '--json', 'id'])
  check(ready.stdout.includes(`"${KEY}-001"`), `kanbo ready does not list ${KEY}-001`, ready.all)
  note(ready.stdout.trim().replace(/\s+/g, ' '))

  step('f. kanbo connect claude --project --yes')
  const connect = kanbo(['connect', 'claude', '--project', '--yes'])
  const claudeMd = readText(join(project, 'CLAUDE.md'))
  const block = BLOCK_PATTERN.exec(claudeMd)
  check(block !== null && /(^|\s)v2(\s|$)/.test(block[1]), 'CLAUDE.md has no v2 kanbo block', claudeMd)
  const mcpJson = JSON.parse(readText(join(project, '.mcp.json')))
  const projectEntry = mcpJson.mcpServers?.kanbo
  check(projectEntry !== undefined, '.mcp.json has no kanbo entry', JSON.stringify(mcpJson, null, 2))
  // A project file is shared across machines, so it is the portable form everywhere; on Windows kanbo says why it may not start there.
  check(projectEntry.command === 'kanbo' && projectEntry.args.join(' ') === 'mcp', `.mcp.json kanbo entry is not the portable form: ${JSON.stringify(projectEntry)}`)
  if (WINDOWS) {
    check(connect.all.includes('On Windows, `kanbo` in a project file'), 'connect on Windows did not warn about the project form', connect.all)
    note('portable form written, with the Windows warning')
  }
  note(`.mcp.json kanbo: ${JSON.stringify(projectEntry)}`)

  step('g. MCP handshake from the written registrations')
  if (WINDOWS) {
    // `kanbo` is npm's kanbo.cmd here, which a client that starts programs without a shell cannot run — the warning in f.
    // The registration such a client would use on Windows is the user-scope one below.
    note('.mcp.json (project form) is not started directly on Windows; see the warning in f')
  }
  else {
    await mcpHandshake('.mcp.json', projectEntry)
  }
  kanbo(['connect', 'codex', '--global', '--yes'])
  const codexLaunch = readTomlServer(readText(join(home, '.codex', 'config.toml')))
  if (WINDOWS) {
    check(codexLaunch.command.toLowerCase().endsWith('.exe') && codexLaunch.args.at(-1) === 'mcp', `the Codex user entry is not node + script: ${JSON.stringify(codexLaunch)}`)
  }
  await mcpHandshake('Codex config.toml (user scope)', codexLaunch)

  step('h. kanbo serve')
  await serveCheck()

  step('i. kanbo doctor --json')
  const doctor = kanbo(['doctor', '--json'], { expectCode: null })
  const findings = JSON.parse(doctor.stdout)
  const list = findings.findings
  check(Array.isArray(list), 'kanbo doctor --json printed no findings', doctor.stdout)
  const fails = list.filter(f => f.status === 'fail')
  check(fails.length === 0 && doctor.code === 0, `kanbo doctor found failures (exit ${doctor.code})`, JSON.stringify(fails, null, 2))
  for (const finding of list.filter(f => f.status === 'warn')) {
    warnings.push(`doctor warn ${finding.check}: ${finding.detail}`)
    note(warnings.at(-1))
  }
  note(`${list.length} findings, ${fails.length} fail`)

  step('j. kanbo instructions short matches the CLAUDE.md block')
  const short = kanbo(['instructions', 'short']).stdout.trim()
  check(short === block[2].trim(), 'kanbo instructions short differs from the block in CLAUDE.md', `--- instructions short\n${short}\n--- CLAUDE.md block\n${block[2]}`)

  step('k. kanbo uninstall --yes')
  kanbo(['uninstall', '--yes'])
  const claudeAfter = existsSync(join(project, 'CLAUDE.md')) ? readText(join(project, 'CLAUDE.md')) : ''
  check(!claudeAfter.includes('KANBO_START'), 'CLAUDE.md still has the kanbo block', claudeAfter)
  const mcpAfter = existsSync(join(project, '.mcp.json')) ? JSON.parse(readText(join(project, '.mcp.json'))) : {}
  check(mcpAfter.mcpServers?.kanbo === undefined, '.mcp.json still has the kanbo entry', JSON.stringify(mcpAfter, null, 2))
  const codexAfter = readText(join(home, '.codex', 'config.toml'))
  check(!codexAfter.includes('mcp_servers.kanbo'), 'the Codex user config still has the kanbo entry', codexAfter)
  check(existsSync(boardFile), 'uninstall --yes deleted the board file')

  console.log(`\n✔ kanbo smoke passed on ${process.platform}/${process.arch}, Node ${process.version}${warnings.length ? ` — ${warnings.length} warning(s):` : ''}`)
  for (const warning of warnings) {
    console.log(`  ${warning}`)
  }
}

let failed = false
try {
  await main()
}
catch (error) {
  failed = true
  console.error(`\n✖ kanbo smoke failed at step "${currentStep}":\n${error instanceof SmokeFailure ? error.message : error?.stack ?? error}`)
}
finally {
  if (keep) {
    console.log(`kept ${root}`)
  }
  else {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
    catch (error) {
      console.log(`could not remove ${root}: ${error.message}`)
    }
  }
}
process.exit(failed ? 1 : 0)
