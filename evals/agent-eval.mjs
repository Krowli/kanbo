#!/usr/bin/env node
// Does a real coding agent use kanbo the way its instructions say? Runs Claude Code
// (and Codex, when asked) headless against a throwaway project with a kanbo board,
// then scores what it did from the board and from its transcript.
//
//   node evals/agent-eval.mjs                                  # every scenario, variant x3, Claude Code
//   node evals/agent-eval.mjs --scenarios take-next --n 1      # one scenario, one run
//   node evals/agent-eval.mjs --agents claude,codex --variants full
//   node evals/agent-eval.mjs --summary evals/results/2026-09-28.json   # markdown from a results file
//
// Costs money: every run is a real agent session. See evals/README.md.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'TST'

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const o = {
    agents: ['claude'],
    variants: ['full', 'mcp', 'instructions'],
    scenarios: null,
    n: 3,
    model: 'sonnet',
    codexModel: null,
    timeout: 360,
    budget: 1.5,
    concurrency: 3,
    build: true,
    keep: false,
    out: null,
    summary: null,
    source: REPO,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--agents') o.agents = next().split(',')
    else if (a === '--variants') o.variants = next().split(',')
    else if (a === '--scenarios') o.scenarios = next().split(',')
    else if (a === '--n') o.n = Number(next())
    else if (a === '--model') o.model = next()
    else if (a === '--codex-model') o.codexModel = next()
    else if (a === '--timeout') o.timeout = Number(next())
    else if (a === '--budget') o.budget = Number(next())
    else if (a === '--concurrency') o.concurrency = Number(next())
    else if (a === '--no-build') o.build = false
    else if (a === '--keep') o.keep = true
    else if (a === '--out') o.out = next()
    else if (a === '--summary') o.summary = next()
    else if (a === '--reparse') o.reparse = next()
    else if (a === '--source') o.source = resolve(next())
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    }
    else throw new Error(`unknown option ${a}`)
  }
  return o
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFail)
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr}${r.stdout}`)
  return r
}

// A clean child: launched from inside an agent session, the parent's session markers
// must not leak into the run being measured, nor make kanbo think the seeding shell
// is an agent's.
function cleanEnv(binDir, extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT')
      continue
    if (k.startsWith('KANBO_') || k.startsWith('CODEX_THREAD') || k === 'CURSOR_AGENT' || k === 'GEMINI_CLI')
      continue
    env[k] = v
  }
  env.PATH = `${binDir}:${env.PATH}`
  return { ...env, ...extra }
}

function median(xs) {
  const v = xs.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!v.length)
    return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

function has(text, needle) {
  return typeof text === 'string' && text.toLowerCase().includes(needle.toLowerCase())
}

// Card keys as an agent may write them: TST-002, TST-2.
function mentionsCard(text, id) {
  const n = Number(id.split('-')[1])
  return new RegExp(`\\b${KEY}-0*${n}\\b`, 'i').test(text ?? '')
}

// ---------------------------------------------------------------- the sample project

const SAMPLE = {
  'README.md': `# tiny-strings

Small string helpers.

- \`capitalize(text)\` — first letter upper-case
- \`reverse(text)\` — charaters in reverse order

Run the tests with \`npm test\`.
`,
  'package.json': `${JSON.stringify({ name: 'tiny-strings', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'src/strings.js': `export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function reverse(text) {
  return [...text].reverse().join('')
}
`,
  'src/index.js': `export * from './strings.js'\n`,
  'test/strings.test.js': `import assert from 'node:assert/strict'
import { test } from 'node:test'

import { capitalize, reverse } from '../src/strings.js'

test('capitalize', () => {
  assert.equal(capitalize('hello'), 'Hello')
})

test('reverse', () => {
  assert.equal(reverse('abc'), 'cba')
})
`,
}

const SLUGIFY_FIRST_TRY = `
export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
}
`

// ---------------------------------------------------------------- scenarios
//
// seed(k) runs as a person (KANBO_ACTOR_KIND=person) and returns the facts the
// scorer needs. score(ctx) returns { checks: {name: boolean}, notes }.

const SCENARIOS = {
  'take-next': {
    prompt: 'Take the next card from kanbo and do it.',
    seed(k, dir) {
      k('card', 'create', '--title', 'Dark mode', '--description', 'Idea: a dark theme for the docs site.', '--column', 'backlog')
      k('card', 'create', '--title', 'Add slugify(text)', '--execution-mode', 'main', '--column', 'to_do', '--description', 'Add `slugify(text)` to src/strings.js: lower-case, words joined by single dashes, no characters other than a-z, 0-9 and dashes (slugify("Hello World!") is "hello-world"). Export it and add a test in test/strings.test.js.')
      return { target: `${KEY}-002`, other: `${KEY}-001`, dir }
    },
    score(ctx) {
      const card = ctx.card(ctx.facts.target)
      const other = ctx.card(ctx.facts.other)
      const cols = ctx.columnPath(card)
      const code = ctx.nodeCheck(`const {slugify}=await import('./src/strings.js'); if (slugify('Hello World!')!=='hello-world') process.exit(1)`)
      return {
        checks: {
          tookToDoCard: cols[0] === 'to_do' && cols.length > 1,
          movedToInProgress: cols.includes('in_progress'),
          statusLines: ctx.agentStatusLines(card) >= 2,
          commentedResult: ctx.agentComments(card) >= 1,
          handedToPerson: card.columnSlug === 'in_review' || card.waitingFor === 'human',
          didNotApprove: card.columnSlug !== 'done' && !ctx.triedApprove(),
          leftOtherCardsAlone: other.columnSlug === 'backlog',
          codeWorks: code && ctx.testsPass(),
        },
      }
    },
  },

  'whats-waiting': {
    prompt: 'Look at the board and tell me what\'s waiting for me.',
    seed(k) {
      k('card', 'create', '--title', 'Rate limiting for the API', '--column', 'backlog')
      k('card', 'create', '--title', 'Add truncate(text, n)', '--column', 'to_do')
      k('card', 'create', '--title', 'Add padStart helper', '--column', 'to_do')
      k('card', 'create', '--title', 'Refactor reverse() for emoji', '--column', 'in_progress')
      k('card', 'status-line', `${KEY}-004`, '--text', 'Running the tests after the refactor')
      k('card', 'create', '--title', 'Add wordCount(text)', '--column', 'in_progress')
      k('card', 'move', `${KEY}-005`, 'in_review')
      k('card', 'wait-approval', `${KEY}-005`, '--text', 'wordCount added with tests — please review')
      k('card', 'create', '--title', 'Document capitalize()', '--column', 'in_progress')
      k('card', 'move', `${KEY}-006`, 'in_review')
      k('card', 'wait-approval', `${KEY}-006`, '--text', 'Should the docs cover Unicode? Need your decision')
      k('card', 'create', '--title', 'Set up CI', '--column', 'in_progress')
      k('card', 'move', `${KEY}-007`, 'in_review')
      k('card', 'status-line', `${KEY}-007`, '--text', 'Reviewer bot is checking the workflow')
      k('card', 'create', '--title', 'Initial commit', '--column', 'done')
      return { waiting: [`${KEY}-005`, `${KEY}-006`], notWaiting: [`${KEY}-002`, `${KEY}-003`, `${KEY}-004`, `${KEY}-007`] }
    },
    score(ctx) {
      const answer = ctx.answer
      const kanboCalls = ctx.kanboCalls
      return {
        checks: {
          namesBothWaitingCards: ctx.facts.waiting.every(id => mentionsCard(answer, id) || has(answer, ctx.card(id).title)),
          changedNothing: ctx.boardUnchanged(),
          atMostTwoKanboCalls: kanboCalls <= 2,
        },
      }
    },
  },

  'plan-big': {
    prompt: `Card ${KEY}-001 is big; plan it.`,
    seed(k) {
      k('card', 'create', '--title', 'String helpers for the 2.0 release', '--execution-mode', 'main', '--column', 'to_do', '--description', 'Three independent pieces, each its own change and test:\n1. slugify(text) — URL slugs.\n2. truncate(text, n) — cut to n characters with an ellipsis.\n3. wordCount(text) — number of words, Unicode-aware.\nThey can be reviewed and shipped separately.')
      k('card', 'create', '--title', 'Dark mode', '--column', 'backlog')
      return { target: `${KEY}-001`, before: 2 }
    },
    score(ctx) {
      const parent = ctx.card(ctx.facts.target)
      const created = ctx.cards.length - ctx.facts.before
      const subs = ctx.cards.filter(c => c.parentIssueId && ctx.idOf(c.parentIssueId) === parent.id)
      return {
        checks: {
          createdSubCards: subs.length >= 2,
          noTopLevelCards: created === subs.length,
          didNotApprove: !ctx.triedApprove(),
        },
        extra: { subCards: subs.length, created },
      }
    },
  },

  'plan-small': {
    prompt: `Plan card ${KEY}-001.`,
    seed(k) {
      k('card', 'create', '--title', 'Fix typo in README', '--execution-mode', 'main', '--column', 'to_do', '--description', 'README says "charaters" somewhere — should be "characters".')
      return { target: `${KEY}-001`, before: 1 }
    },
    score(ctx) {
      return {
        checks: {
          didNotSplit: ctx.cards.length === ctx.facts.before,
          didNotApprove: !ctx.triedApprove(),
        },
      }
    },
  },

  'returned': {
    prompt: 'Continue the card that was returned to you.',
    seed(k, dir) {
      writeFileSync(join(dir, 'src/strings.js'), SAMPLE['src/strings.js'] + SLUGIFY_FIRST_TRY)
      run('git', ['commit', '-qam', 'Add slugify'], { cwd: dir })
      k('card', 'create', '--title', 'Remove the typo in README', '--column', 'done')
      k('card', 'create', '--title', 'Add slugify(text)', '--execution-mode', 'main', '--column', 'to_do', '--description', 'Add `slugify(text)` to src/strings.js: lower-case, words joined by single dashes. Export it and test it.')
      k('card', 'move', `${KEY}-002`, 'in_progress')
      k('card', 'status-line', `${KEY}-002`, '--text', 'Writing slugify')
      k('card', 'comment', `${KEY}-002`, '--content', 'Added slugify to src/strings.js.')
      k('card', 'move', `${KEY}-002`, 'in_review')
      k('card', 'wait-approval', `${KEY}-002`, '--text', 'slugify is in — please review')
      k('return', `${KEY}-002`, '--comment', 'slugify("!!!") returns "-", and "  Hi  " gives "-hi-". Strip dashes at both ends, and add a test for both cases.')
      k('card', 'create', '--title', 'Add truncate(text, n)', '--column', 'to_do')
      return { target: `${KEY}-002`, other: `${KEY}-003` }
    },
    score(ctx) {
      const card = ctx.card(ctx.facts.target)
      const code = ctx.nodeCheck(`const {slugify}=await import('./src/strings.js'); if (slugify('!!!')!=='' || slugify('  Hi  ')!=='hi') process.exit(1)`)
      const testText = ctx.read('test/strings.test.js')
      return {
        checks: {
          readTheComment: ctx.sawInToolResult('Strip dashes at both ends'),
          fixedIt: code && ctx.testsPass(),
          addedTests: has(testText, '!!!'),
          commentedResult: ctx.agentComments(card) >= 1,
          handedToPerson: card.columnSlug === 'in_review' || card.waitingFor === 'human',
          didNotApprove: card.columnSlug !== 'done' && !ctx.triedApprove(),
          didNotTakeOtherCard: ctx.card(ctx.facts.other).columnSlug === 'to_do',
        },
      }
    },
  },
}

// ---------------------------------------------------------------- agents

const ALLOWED_CLAUDE_TOOLS = ['mcp__kanbo', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch']

function claudeCommand(o, project, variant) {
  const args = [
    '-p', null,
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    // Only the project's settings and CLAUDE.md: the user's own instructions,
    // hooks and plugins would make the run measure them, not kanbo.
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--max-budget-usd', String(o.budget),
    '--allowedTools', ALLOWED_CLAUDE_TOOLS.join(','),
  ]
  if (o.model)
    args.push('--model', o.model)
  if (variant !== 'instructions')
    args.push('--mcp-config', join(project, '.mcp.json'))
  return { cmd: 'claude', args }
}

function codexCommand(o, project, variant) {
  // No shell snapshot: it re-sources the user's shell profile, which rebuilds PATH
  // without the kanbo build under test.
  const args = ['exec', '--json', '-C', project, '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'workspace-write', '--disable', 'shell_snapshot']
  if (o.codexModel)
    args.push('-m', o.codexModel)
  // Codex reads a project's .codex/config.toml only in a trusted project, so the
  // server kanbo connect wrote there is handed over on the command line.
  // codex exec never asks for approval, so an MCP tool that needs one is refused
  // unless the server's tools are approved up front.
  if (variant !== 'instructions')
    args.push('-c', 'mcp_servers.kanbo.command="kanbo"', '-c', 'mcp_servers.kanbo.args=["mcp"]', '-c', 'mcp_servers.kanbo.default_tools_approval_mode="approve"')
  args.push(null)
  return { cmd: 'codex', args }
}

// Tool calls, tool results and usage out of a transcript, per agent.
function parseClaude(lines) {
  const calls = []
  const results = []
  let final = null
  for (const ev of lines) {
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_use')
          calls.push({ id: b.id, name: b.name, input: b.input, failed: false })
      }
    }
    else if (ev.type === 'user') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_result') {
          results.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content))
          const call = calls.find(c => c.id === b.tool_use_id)
          if (call && b.is_error)
            call.failed = true
        }
      }
    }
    else if (ev.type === 'result') {
      final = ev
    }
  }
  const u = final?.usage ?? {}
  const tokens = final
    ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    : null
  return {
    calls,
    results,
    answer: final?.result ?? '',
    tokens,
    outputTokens: u.output_tokens ?? null,
    costUsd: final?.total_cost_usd ?? null,
    turns: final?.num_turns ?? null,
    error: final ? (final.is_error ? final.subtype : null) : 'no result event',
    permissionDenials: final?.permission_denials?.length ?? 0,
  }
}

function parseCodex(lines) {
  const calls = []
  const results = []
  let answer = ''
  let usage = null
  let error = null
  for (const ev of lines) {
    const item = ev.item
    if (ev.type === 'item.completed' && item) {
      if (item.type === 'command_execution') {
        calls.push({ name: 'Bash', input: { command: item.command }, failed: item.exit_code !== 0 })
        results.push(item.aggregated_output ?? '')
      }
      else if (item.type === 'mcp_tool_call') {
        calls.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments, failed: item.status === 'failed' || Boolean(item.error) })
        results.push(JSON.stringify(item.result ?? item.error ?? ''))
      }
      else if (item.type === 'agent_message') {
        answer = item.text ?? answer
      }
    }
    else if (ev.type === 'turn.completed') {
      usage = ev.usage
    }
    else if (ev.type === 'turn.failed' || ev.type === 'error') {
      error = ev.error?.message ?? ev.message ?? 'error'
    }
  }
  const tokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null
  return { calls, results, answer, tokens, outputTokens: usage?.output_tokens ?? null, costUsd: null, turns: null, error, permissionDenials: 0 }
}

const KANBO_BASH = /(?:^|[\s;&|(`'"])kanbo\s/

function isKanboCall(c) {
  if (c.name.startsWith('mcp__kanbo__'))
    return true
  return c.name === 'Bash' && KANBO_BASH.test(` ${c.input?.command ?? ''}`)
}

function describeCall(c) {
  const text = describeCallText(c)
  return c.failed ? `${text} [failed]` : text
}

function describeCallText(c) {
  if (c.name === 'Bash')
    return `Bash: ${String(c.input?.command ?? '').slice(0, 200)}`
  if (c.name.startsWith('mcp__kanbo__'))
    return `${c.name.slice('mcp__kanbo__'.length)} ${JSON.stringify(c.input ?? {}).slice(0, 200)}`
  if (['Read', 'Edit', 'Write'].includes(c.name))
    return `${c.name} ${c.input?.file_path ?? ''}`
  return c.name
}

function parseTranscript(agent, text) {
  const lines = text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)]
    }
    catch {
      return []
    }
  })
  return agent === 'claude' ? parseClaude(lines) : parseCodex(lines)
}

// What a results file keeps of a transcript; --reparse recomputes these.
function transcriptFields(parsed) {
  return {
    kanboCalls: parsed.calls.filter(isKanboCall).length,
    failedKanboCalls: parsed.calls.filter(c => isKanboCall(c) && c.failed).length,
    mcpCalls: parsed.calls.filter(c => c.name.startsWith('mcp__kanbo__')).length,
    toolSearchCalls: parsed.calls.filter(c => c.name === 'ToolSearch').length,
    toolCalls: parsed.calls.length,
    tokens: parsed.tokens,
    outputTokens: parsed.outputTokens,
    costUsd: parsed.costUsd,
    turns: parsed.turns,
    permissionDenials: parsed.permissionDenials,
    kanboTrace: parsed.calls.filter(isKanboCall).map(describeCall),
    trace: parsed.calls.map(describeCall),
    answer: parsed.answer.slice(0, 1500),
  }
}

function runAgent(cmd, args, prompt, cwd, env, timeoutSec) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn(cmd, args.map(a => (a === null ? prompt : a)), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutSec * 1000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, out, err, timedOut, seconds: (Date.now() - started) / 1000 })
    })
  })
}

// ---------------------------------------------------------------- one run

// bins.test is the build under test (the agent's PATH and `kanbo connect`, which
// writes that version's instructions); bins.tool seeds and reads the board.
function makeProject(bins, scenario, variant, agent) {
  const dir = mkdtempSync(join(tmpdir(), `kanbo-eval-${scenario}-`))
  for (const [path, text] of Object.entries(SAMPLE)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const personEnv = cleanEnv(bins.tool, { KANBO_ACTOR_KIND: 'person' })
  run('git', ['init', '-q'], { cwd: dir })
  run('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'add', '-A'], { cwd: dir })
  run('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '-qm', 'Initial'], { cwd: dir })
  run('git', ['config', 'user.name', 'eval'], { cwd: dir })
  run('git', ['config', 'user.email', 'eval@example.com'], { cwd: dir })
  const k = (...args) => run('kanbo', args, { cwd: dir, env: personEnv })
  k('init', '--yes', '--columns', 'standard', '--key', KEY)
  const facts = SCENARIOS[scenario].seed(k, dir)
  const connect = ['connect', agent, '--project', '--yes']
  if (variant === 'mcp')
    connect.push('--no-instructions')
  if (variant === 'instructions')
    connect.push('--no-mcp')
  run('kanbo', connect, { cwd: dir, env: cleanEnv(bins.test, { KANBO_ACTOR_KIND: 'person' }) })
  run('git', ['add', '-A'], { cwd: dir })
  run('git', ['commit', '-qm', 'kanbo board'], { cwd: dir, allowFail: true })
  return { dir, facts }
}

function boardState(dir, binDir) {
  const env = cleanEnv(binDir, { KANBO_ACTOR_KIND: 'person' })
  const k = (...args) => JSON.parse(run('kanbo', [...args, '--json'], { cwd: dir, env }).stdout)
  const columns = k('columns', 'list')
  const cards = k('card', 'list', '--all')
  const details = Object.fromEntries(cards.map(c => [c.id, k('card', 'get', c.id, '--include', 'comments,subCards,history', '--comments', '50')]))
  return { columns, cards, details }
}

function scoreRun(scenario, dir, binDir, facts, parsed, before, after) {
  const slugById = Object.fromEntries(after.columns.map(c => [c.id, c.slug]))
  const card = id => after.details[id]
  const agentHistory = (c, field) => (c.history ?? []).filter(h => h.field === field && !(before.details[c.id]?.history ?? []).some(b => b.createdAt === h.createdAt && b.to === h.to && b.field === h.field))
  const env = cleanEnv(binDir)
  const ctx = {
    facts,
    cards: after.cards,
    answer: parsed.answer,
    kanboCalls: parsed.calls.filter(isKanboCall).length,
    card,
    idOf: (parentId) => {
      const hit = after.cards.find(c => c.id === parentId || c.uuid === parentId)
      return hit ? hit.id : Object.values(after.details).find(d => d.uuid === parentId)?.id ?? parentId
    },
    // Columns the card passed through, starting where it was before the run.
    columnPath: (c) => {
      const start = before.details[c.id]?.columnSlug
      return [start, ...agentHistory(c, 'statusId').map(h => slugById[h.to])]
    },
    agentStatusLines: c => agentHistory(c, 'statusLine').length,
    agentComments: c => (c.comments ?? []).length - (before.details[c.id]?.comments ?? []).length,
    triedApprove: () => parsed.calls.some(x => x.name === 'Bash' && /\bkanbo\s+approve\b/.test(x.input?.command ?? '')),
    sawInToolResult: needle => parsed.results.some(r => has(r, needle)),
    boardUnchanged: () => JSON.stringify(before.cards) === JSON.stringify(after.cards),
    nodeCheck: script => run('node', ['--input-type=module', '-e', script], { cwd: dir, env, allowFail: true }).status === 0,
    testsPass: () => run('npm', ['test', '--silent'], { cwd: dir, env, allowFail: true }).status === 0,
    read: path => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : ''),
  }
  return SCENARIOS[scenario].score(ctx)
}

async function oneRun(o, bins, agent, variant, scenario, index) {
  const { dir, facts } = makeProject(bins, scenario, variant, agent)
  const before = boardState(dir, bins.tool)
  const { cmd, args } = agent === 'claude' ? claudeCommand(o, dir, variant) : codexCommand(o, dir, variant)
  const res = await runAgent(cmd, args, SCENARIOS[scenario].prompt, dir, cleanEnv(bins.test), o.timeout)
  const parsed = parseTranscript(agent, res.out)
  let scored
  try {
    const after = boardState(dir, bins.tool)
    scored = scoreRun(scenario, dir, bins.tool, facts, parsed, before, after)
  }
  catch (e) {
    scored = { checks: {}, scoreError: String(e.message ?? e).slice(0, 500) }
  }
  const transcript = join(o.transcriptDir, `${agent}-${variant}-${scenario}-${index}.jsonl`)
  writeFileSync(transcript, res.out)
  if (!o.keep)
    rmSync(dir, { recursive: true, force: true })
  const checks = scored.checks
  const values = Object.values(checks)
  return {
    agent,
    variant,
    scenario,
    index,
    exitCode: res.code,
    timedOut: res.timedOut,
    error: parsed.error ?? (res.code !== 0 ? res.err.slice(-500) : null),
    seconds: Math.round(res.seconds),
    ...transcriptFields(parsed),
    checks,
    passed: values.length > 0 && values.every(Boolean),
    extra: scored.extra,
    scoreError: scored.scoreError,
    transcript,
    project: o.keep ? dir : null,
  }
}

// ---------------------------------------------------------------- summary

function summarize(results) {
  const rows = []
  const groups = new Map()
  for (const r of results.runs) {
    const key = `${r.build ?? results.commit}|${r.agent}|${r.variant}|${r.scenario}`
    if (!groups.has(key))
      groups.set(key, [])
    groups.get(key).push(r)
  }
  rows.push('| build | agent | variant | scenario | runs | all rules kept | rule checks kept | median kanbo calls (failed, all runs) | median tokens | median output tokens | median time (s) | median cost ($) |')
  rows.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [key, runs] of groups) {
    const [build, agent, variant, scenario] = key.split('|')
    const checks = runs.flatMap(r => Object.values(r.checks))
    const kept = checks.filter(Boolean).length
    const cost = median(runs.map(r => r.costUsd))
    rows.push(`| ${build} | ${agent} | ${variant} | ${scenario} | ${runs.length} | ${runs.filter(r => r.passed).length}/${runs.length} | ${checks.length ? Math.round((100 * kept) / checks.length) : 0}% | ${median(runs.map(r => r.kanboCalls))} (${runs.reduce((s, r) => s + (r.failedKanboCalls ?? 0), 0)}) | ${median(runs.map(r => r.tokens))?.toLocaleString('en-US') ?? '—'} | ${median(runs.map(r => r.outputTokens))?.toLocaleString('en-US') ?? '—'} | ${median(runs.map(r => r.seconds))} | ${cost == null ? '—' : cost.toFixed(2)} |`)
  }
  const perCheck = new Map()
  for (const r of results.runs) {
    for (const [name, ok] of Object.entries(r.checks)) {
      const k = `${r.build ?? results.commit}|${r.agent}|${r.scenario}|${name}`
      const v = perCheck.get(k) ?? [0, 0]
      perCheck.set(k, [v[0] + (ok ? 1 : 0), v[1] + 1])
    }
  }
  rows.push('', '| build | agent | scenario | check | kept (all variants) |', '| --- | --- | --- | --- | ---: |')
  for (const [k, [ok, n]] of perCheck) {
    const [build, agent, scenario, name] = k.split('|')
    rows.push(`| ${build} | ${agent} | ${scenario} | ${name} | ${ok}/${n} |`)
  }
  const total = results.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0)
  rows.push('', `${results.runs.length} runs, ${Math.round(results.runs.reduce((s, r) => s + r.seconds, 0) / 60)} agent-minutes, $${total.toFixed(2)} reported by the agents.`)
  return rows.join('\n')
}

// ---------------------------------------------------------------- main

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.reparse) {
    const results = JSON.parse(readFileSync(o.reparse, 'utf8'))
    for (const r of results.runs) {
      if (r.transcript && existsSync(r.transcript))
        Object.assign(r, transcriptFields(parseTranscript(r.agent, readFileSync(r.transcript, 'utf8'))))
    }
    writeFileSync(o.reparse, `${JSON.stringify(results, null, 2)}\n`)
    return
  }
  if (o.summary) {
    console.log(summarize(JSON.parse(readFileSync(o.summary, 'utf8'))))
    return
  }
  const scenarios = o.scenarios ?? Object.keys(SCENARIOS)
  for (const s of scenarios) {
    if (!SCENARIOS[s])
      throw new Error(`unknown scenario ${s}; known: ${Object.keys(SCENARIOS).join(', ')}`)
  }
  for (const agent of o.agents) {
    const v = run(agent, ['--version'], { allowFail: true })
    if (v.status !== 0)
      throw new Error(`${agent} is not usable: install it and log in first`)
  }

  // The build under test, installed the way a user installs it, first on PATH.
  // With --source, this checkout's build still seeds and scores the board (its
  // JSON output is what the scorer reads); the board schema must be the same.
  const work = mkdtempSync(join(tmpdir(), 'kanbo-eval-'))
  const install = (source, name) => {
    if (o.build)
      run('npm', ['run', 'build'], { cwd: source, stdio: 'ignore' })
    const packDir = join(work, `${name}-pack`)
    mkdirSync(packDir)
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: source })
    const tgz = readdirSync(packDir).find(f => f.endsWith('.tgz'))
    run('npm', ['i', '-g', '--prefix', join(work, name), join(packDir, tgz)], { cwd: work })
    return join(work, name, 'bin')
  }
  const testBin = install(o.source, 'prefix')
  const bins = { test: testBin, tool: o.source === REPO ? testBin : install(REPO, 'tool') }
  const kanboVersion = run(join(bins.test, 'kanbo'), ['--version']).stdout.trim()

  const date = new Date().toISOString().slice(0, 10)
  const out = o.out ?? join(REPO, 'evals', 'results', `${date}.json`)
  mkdirSync(dirname(out), { recursive: true })
  o.transcriptDir = join(work, 'transcripts')
  mkdirSync(o.transcriptDir)

  const jobs = []
  for (const agent of o.agents) {
    for (const variant of o.variants) {
      for (const scenario of scenarios) {
        for (let i = 1; i <= o.n; i++)
          jobs.push({ agent, variant, scenario, i })
      }
    }
  }
  const results = {
    date,
    kanboVersion,
    commit: run('git', ['rev-parse', '--short', 'HEAD'], { cwd: o.source }).stdout.trim(),
    agents: Object.fromEntries(o.agents.map(a => [a, run(a, ['--version']).stdout.trim()])),
    model: { claude: o.model, codex: o.codexModel ?? 'default' },
    n: o.n,
    timeoutSeconds: o.timeout,
    transcripts: o.transcriptDir,
    runs: [],
  }
  console.error(`kanbo ${kanboVersion}; ${jobs.length} runs; transcripts in ${o.transcriptDir}`)
  let nextJob = 0
  const worker = async () => {
    while (nextJob < jobs.length) {
      const j = jobs[nextJob++]
      let r
      try {
        r = await oneRun(o, bins, j.agent, j.variant, j.scenario, j.i)
      }
      catch (e) {
        r = { agent: j.agent, variant: j.variant, scenario: j.scenario, index: j.i, error: String(e.message ?? e).slice(0, 1000), checks: {}, passed: false, seconds: 0, kanboCalls: null, tokens: null }
      }
      results.runs.push(r)
      writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
      const failed = Object.entries(r.checks).filter(([, ok]) => !ok).map(([n]) => n)
      console.error(`${results.runs.length}/${jobs.length} ${j.agent} ${j.variant} ${j.scenario}#${j.i}: ${r.passed ? 'PASS' : 'FAIL'}${failed.length ? ` (${failed.join(', ')})` : ''} kanbo=${r.kanboCalls} tokens=${r.tokens} ${r.seconds}s${r.error ? ` error=${String(r.error).slice(0, 120)}` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency, jobs.length) }, worker))
  results.runs.sort((a, b) => `${a.agent}${a.variant}${a.scenario}${a.index}`.localeCompare(`${b.agent}${b.variant}${b.scenario}${b.index}`))
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
  console.log(summarize(results))
  console.error(`results: ${out}`)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
