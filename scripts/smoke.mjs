#!/usr/bin/env node
// End-to-end check of what users install: pack kanbo, install the tarball
// globally into a temporary prefix, and drive the installed `kanbo` through a
// new project — board, card, agent connection, MCP handshake, `serve`,
// `doctor`, `uninstall`. Plain Node, the same on every OS.
//
// With --upgrade it checks an upgrade instead: the published kanbo-cli@0.2.1
// sets up a project and fills its board, then the tarball is installed over
// it and has to find everything where 0.2.1 left it (needs the npm registry).
//
//   node scripts/smoke.mjs                  # packs this checkout first (runs the build through prepack)
//   node scripts/smoke.mjs --upgrade        # from kanbo-cli@0.2.1 to this checkout
//   node scripts/smoke.mjs --tarball <tgz>  # installs a tarball packed already
//   node scripts/smoke.mjs --keep           # leaves the temporary folders for a look
//
// Nothing outside the temporary folders is touched: HOME, USERPROFILE,
// CODEX_HOME and CLAUDE_CONFIG_DIR point inside them for every kanbo run.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const upgrade = args.includes('--upgrade')
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
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'GEMINI_CLI', 'CURSOR_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'KANBO_DB_PATH', 'KANBO_DATABASE_URL', 'KANBO_ACTOR_KIND', 'KANBO_SERVE_TOKEN', 'KANBO_DEBUG']) {
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

/**
 * How long one `npm install --global` may take. On a Windows runner an install
 * of the package with its dependencies has taken just under two minutes, the
 * limit `run` gives a command, and once went over it.
 */
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * `npm install --global` of `packageSpec` into the prefix, with npm's own
 * environment. It prints a line every 30 s so a slow install does not read as a
 * hang, and past `NPM_INSTALL_TIMEOUT_MS` it stops npm's whole process tree and
 * waits for it to go before failing: a timeout that killed only the shell would
 * leave npm writing into the prefix and holding its files.
 */
async function npmInstall(packageSpec) {
  const commandArgs = ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', packageSpec]
  const shown = ['npm', ...commandArgs].join(' ')
  note(`$ ${shown}`)
  const spec = spawnArgs('npm', commandArgs)
  const started = Date.now()
  const child = spawn(spec.file, spec.args, { cwd: root, env: process.env, shell: spec.shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const closed = new Promise((resolveClose, reject) => {
    child.on('close', (code, signal) => resolveClose({ code, signal }))
    child.on('error', error => reject(new SmokeFailure(`${shown} did not run: ${error.message}`)))
  })
  const seconds = () => Math.round((Date.now() - started) / 1000)
  const heartbeat = setInterval(() => note(`… npm still running after ${seconds()} s`), 30_000)
  try {
    const { code, signal } = await withTimeout(closed, NPM_INSTALL_TIMEOUT_MS, `${shown} did not finish within ${NPM_INSTALL_TIMEOUT_MS / 60_000} min`)
    if (code !== 0) {
      throw new SmokeFailure(`${shown} exited ${code} (signal ${signal}) after ${seconds()} s\n${output.replace(/\r\n/g, '\n')}`)
    }
    note(`npm finished in ${seconds()} s`)
  }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      stopTree(child)
      await withTimeout(closed, 30_000, `${shown} was still running 30 s after being stopped`).catch(() => {})
    }
    throw error instanceof SmokeFailure ? new SmokeFailure(`${error.message}\n${output.replace(/\r\n/g, '\n')}`) : error
  }
  finally {
    clearInterval(heartbeat)
  }
}

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

/** Start the server as a client would from its registration, shake hands, call kanbo_ready and find `card` in it. */
async function mcpHandshake(label, launch, card = `${KEY}-001`) {
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
    check(!ready.isError && text.includes(card), `${label}: kanbo_ready does not list ${card}`, text)
    note(`${label}: serverInfo ${info.name} ${info.version}, ${instructions.length} chars of instructions, kanbo_ready lists ${card}`)
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

/** The tarball to install: the one given, or this checkout packed now. */
function packTarball() {
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
  return tarball
}

async function main() {
  console.log(`kanbo smoke ${VERSION} — Node ${process.version}, ${process.platform}/${process.arch}`)
  console.log(`temporary folder: ${root}`)

  const tarball = packTarball()

  step('install the tarball globally into a temporary prefix')
  // npm itself keeps the real environment (its cache, its registry settings); only kanbo runs get the throwaway home.
  await npmInstall(tarball)
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

// ---------------------------------------------------------------- --upgrade: from kanbo-cli@0.2.1

const OLD_VERSION = '0.2.1'
const UPGRADE_KEY = 'UPG'
const TEXT_BEFORE = '# My project\n\nNotes a person wrote before kanbo was installed.\n'
const TEXT_AFTER = '\n## Build\n\nNotes a person wrote after the kanbo section.\n'

/** Every table of the board file and every row in it, read with the better-sqlite3 installed beside kanbo. */
function readBoardTables(file) {
  const globalModules = WINDOWS ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
  const Database = createRequire(join(globalModules, 'noop.js'))('better-sqlite3')
  const database = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const tables = database.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all()
    return Object.fromEntries(tables.map(({ name }) => {
      const columns = database.prepare(`select name from pragma_table_info(?)`).all(name).map(column => column.name)
      const rows = database.prepare(`select * from "${name}" order by rowid`).all()
      return [name, { columns, rows }]
    }))
  }
  finally {
    database.close()
  }
}

/** What differs between the board before and after: a table or a row gone or changed. New columns and new migrations are allowed. */
function compareBoardTables(before, after) {
  const differences = []
  for (const [name, table] of Object.entries(before)) {
    const now = after[name]
    if (!now) {
      differences.push(`table ${name} is gone`)
      continue
    }
    const project = row => JSON.stringify(table.columns.map(column => row[column]))
    const kept = now.rows.map(project)
    const was = table.rows.map(project)
    // A later build may add migrations; every other table must hold exactly the rows it held.
    const same = name === '__drizzle_migrations'
      ? was.every((row, index) => kept[index] === row)
      : was.length === kept.length && was.every((row, index) => kept[index] === row)
    if (!same) {
      differences.push(`table ${name}: ${was.length} rows before, ${kept.length} after\n  before ${JSON.stringify(table.rows)}\n  after  ${JSON.stringify(now.rows)}`)
    }
  }
  return differences
}

async function upgradeMain() {
  console.log(`kanbo upgrade smoke ${OLD_VERSION} → ${VERSION} — Node ${process.version}, ${process.platform}/${process.arch}`)
  console.log(`temporary folder: ${root}`)

  const tarball = packTarball()

  step(`u1. install the published kanbo-cli@${OLD_VERSION}, and better-sqlite3 beside it as ${OLD_VERSION} asked`)
  await npmInstall(`kanbo-cli@${OLD_VERSION}`)
  await npmInstall('better-sqlite3@13')
  const oldVersion = kanbo(['--version']).stdout.trim()
  check(oldVersion === OLD_VERSION, `kanbo --version printed ${JSON.stringify(oldVersion)}, expected ${OLD_VERSION}`)
  note(oldVersion)

  step(`u2. ${OLD_VERSION}: kanbo init --file --instructions claude --mcp claude --yes`)
  run('git', ['init', '-q'], { env: kanboEnv() })
  const claudeMdPath = join(project, 'CLAUDE.md')
  writeFileSync(claudeMdPath, TEXT_BEFORE)
  kanbo(['init', '--file', '--workspace', 'upgrade', '--identifier', UPGRADE_KEY, '--instructions', 'claude', '--mcp', 'claude', '--yes'])
  const oldBlock = BLOCK_PATTERN.exec(readText(claudeMdPath))
  check(oldBlock !== null && !/v2/.test(oldBlock[1]), `${OLD_VERSION} wrote no unversioned kanbo block`, readText(claudeMdPath))
  appendFileSync(claudeMdPath, TEXT_AFTER)
  const oldMcpEntry = JSON.parse(readText(join(project, '.mcp.json'))).mcpServers?.kanbo
  check(oldMcpEntry !== undefined, `${OLD_VERSION} wrote no kanbo entry in .mcp.json`)
  note(`.mcp.json kanbo: ${JSON.stringify(oldMcpEntry)}`)

  step(`u3. ${OLD_VERSION}: cards, a comment, runs, a status line, a wait for approval, a column description`)
  kanbo(['card', 'create', '--title', 'First card', '--description', 'What the first card is about'])
  kanbo(['card', 'create', '--description', 'A card with only a description'])
  kanbo(['card', 'create', '--title', 'Third card'])
  kanbo(['card', 'comment', `${UPGRADE_KEY}-001`, '--content', 'A finding from before the upgrade'])
  kanbo(['run', 'start', `${UPGRADE_KEY}-001`, '--agent', 'Claude', '--session', 'claude:before-upgrade'])
  const finished = JSON.parse(kanbo(['run', 'start', `${UPGRADE_KEY}-003`, '--agent', 'Codex', '--format', 'json']).stdout)
  kanbo(['run', 'finish', finished.id, '--state', 'finished'])
  kanbo(['card', 'status-line', `${UPGRADE_KEY}-001`, '--text', 'halfway through'])
  kanbo(['card', 'wait-approval', `${UPGRADE_KEY}-001`, '--text', 'please look'], { env: kanboEnv({ KANBO_ACTOR_KIND: 'agent' }) })
  kanbo(['columns', 'describe', 'in_review', '--text', 'A person checks it here'])
  kanbo(['card', 'move', `${UPGRADE_KEY}-002`, 'to_do'])

  const cardFields = 'id,title,description,column,statusLine,waitingFor,attemptCount,parentIssueId,labels,priority'
  const boardFile = join(project, '.kanbo', 'board.db')
  const cardsBefore = JSON.parse(kanbo(['card', 'list', '--json', cardFields]).stdout)
  const columnsBefore = JSON.parse(kanbo(['columns', 'list', '--json', 'name,slug,description']).stdout)
  const tablesBefore = readBoardTables(boardFile)
  note(`${cardsBefore.length} cards; ${Object.entries(tablesBefore).map(([name, table]) => `${name} ${table.rows.length}`).join(', ')}`)

  step(`u4. install this build (${VERSION}) over the same prefix`)
  await npmInstall(tarball)
  const newVersion = kanbo(['--version']).stdout.trim()
  check(newVersion === VERSION, `kanbo --version printed ${JSON.stringify(newVersion)}, expected ${VERSION}`)
  // The version may not have moved yet (it is bumped at release); a command 0.2.1 did not have tells the builds apart.
  kanbo(['connect', '--help'])
  note(`${newVersion}, and kanbo connect exists`)

  step('u5. every card, comment, run and change is where it was')
  const cardsAfter = JSON.parse(kanbo(['card', 'list', '--json', cardFields]).stdout)
  check(JSON.stringify(cardsAfter) === JSON.stringify(cardsBefore), 'kanbo card list differs after the upgrade', `before ${JSON.stringify(cardsBefore)}\nafter  ${JSON.stringify(cardsAfter)}`)
  const columnsAfter = JSON.parse(kanbo(['columns', 'list', '--json', 'name,slug,description']).stdout)
  check(JSON.stringify(columnsAfter) === JSON.stringify(columnsBefore), 'kanbo columns list differs after the upgrade', `before ${JSON.stringify(columnsBefore)}\nafter  ${JSON.stringify(columnsAfter)}`)
  const differences = compareBoardTables(tablesBefore, readBoardTables(boardFile))
  check(differences.length === 0, 'the board file changed in the upgrade', differences.join('\n'))
  note(`${cardsAfter.length} cards and ${Object.keys(tablesBefore).length} tables the same, row for row`)

  step('u6. prime, ready and card list on the old board')
  const prime = kanbo(['prime'])
  check(prime.stdout.includes('A person checks it here'), 'kanbo prime does not show the column description written by the old kanbo', prime.all)
  const ready = JSON.parse(kanbo(['ready', '--json', 'id']).stdout)
  check(ready.some(card => card.id === `${UPGRADE_KEY}-002`), `kanbo ready does not list ${UPGRADE_KEY}-002`, JSON.stringify(ready))
  const waiting = JSON.parse(kanbo(['card', 'get', `${UPGRADE_KEY}-001`, '--json', 'waitingFor,statusLine']).stdout)
  check(waiting.waitingFor === 'human' && waiting.statusLine === 'please look', `${UPGRADE_KEY}-001 is no longer waiting`, JSON.stringify(waiting))

  step(`u7. MCP handshake from the .mcp.json entry ${OLD_VERSION} wrote`)
  if (WINDOWS) {
    // `kanbo` is npm's kanbo.cmd here, which a client that starts programs without a shell cannot run (see the plain smoke).
    note('.mcp.json (project form) is not started directly on Windows')
  }
  else {
    await mcpHandshake('.mcp.json from 0.2.1', oldMcpEntry, `${UPGRADE_KEY}-002`)
  }

  step(`u8. kanbo doctor sees the ${OLD_VERSION} block as older, and --fix brings it up to date`)
  const doctorBefore = kanbo(['doctor', '--json'], { expectCode: null })
  const findingsBefore = JSON.parse(doctorBefore.stdout).findings
  const failsBefore = findingsBefore.filter(f => f.status === 'fail')
  check(failsBefore.length === 0, `kanbo doctor failed on the upgraded project (exit ${doctorBefore.code})`, JSON.stringify(failsBefore, null, 2))
  const instructionsBefore = findingsBefore.find(f => f.check === 'instructions')
  check(instructionsBefore?.status === 'warn' && instructionsBefore.fixable === true, 'kanbo doctor does not warn about the old block, fixably', JSON.stringify(instructionsBefore))
  note(`instructions: ${instructionsBefore.status} — ${instructionsBefore.detail}`)
  kanbo(['doctor', '--fix', '--yes'])
  const claudeMd = readText(claudeMdPath)
  const newBlock = BLOCK_PATTERN.exec(claudeMd)
  check(newBlock !== null && /(^|\s)v2(\s|$)/.test(newBlock[1]), 'CLAUDE.md has no v2 kanbo block after doctor --fix', claudeMd)
  check(claudeMd.startsWith(TEXT_BEFORE) && claudeMd.endsWith(TEXT_AFTER), 'doctor --fix changed the text outside the kanbo block', claudeMd)
  check(claudeMd.split('KANBO_START').length === 2, 'CLAUDE.md has more than one kanbo block', claudeMd)
  const doctorAfter = kanbo(['doctor', '--json'], { expectCode: null })
  const findingsAfter = JSON.parse(doctorAfter.stdout).findings
  const instructionsAfter = findingsAfter.find(f => f.check === 'instructions')
  check(instructionsAfter?.status === 'ok' && doctorAfter.code === 0, 'kanbo doctor still reports the block or a failure after --fix', JSON.stringify(findingsAfter, null, 2))
  for (const finding of findingsAfter.filter(f => f.status === 'warn')) {
    warnings.push(`doctor warn ${finding.check}: ${finding.detail}`)
    note(warnings.at(-1))
  }

  step('u9. kanbo connect --check')
  const connectCheck = kanbo(['connect', '--check'])
  check(/claude/i.test(connectCheck.all), 'kanbo connect --check does not mention Claude Code', connectCheck.all)
  note(connectCheck.stdout.trim().split('\n').join(' | '))

  step('u10. bare kanbo without a terminal prints the board')
  const bare = kanbo([])
  check(bare.stdout.includes(UPGRADE_KEY) && bare.stdout.includes('More: kanbo --help'), 'bare kanbo does not print the board summary', bare.all)

  console.log(`\n✔ kanbo upgrade smoke passed on ${process.platform}/${process.arch}, Node ${process.version}${warnings.length ? ` — ${warnings.length} warning(s):` : ''}`)
  for (const warning of warnings) {
    console.log(`  ${warning}`)
  }
}

let failed = false
try {
  await (upgrade ? upgradeMain() : main())
}
catch (error) {
  failed = true
  console.error(`\n✖ kanbo ${upgrade ? 'upgrade ' : ''}smoke failed at step "${currentStep}":\n${error instanceof SmokeFailure ? error.message : error?.stack ?? error}`)
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
