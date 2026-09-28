# Real-agent evaluation

`evals/agent-eval.mjs` checks what a real coding agent does with kanbo: it gives
Claude Code (and Codex, when asked) a board in a throwaway project and a one-line
task, lets it work headless, then scores the run from the board and from the
agent's transcript.

It is run by hand before a release, never in CI: every run is a real, paid agent
session.

## Running it

Needs Node 22+, this repository's dependencies (`npm ci`), and the agent CLI on
`PATH`, logged in (`claude --version`; `codex login status` for Codex). The script
builds kanbo, packs it with `npm pack`, installs the package into a temporary
prefix and puts that first on `PATH` — the agent runs the build under test, not a
`kanbo` you may have installed.

```bash
node evals/agent-eval.mjs                                   # every scenario, 3 variants, 3 runs each, Claude Code
node evals/agent-eval.mjs --scenarios take-next --n 1       # one scenario, one run per variant
node evals/agent-eval.mjs --agents claude,codex --variants full
node evals/agent-eval.mjs --summary evals/results/2026-09-28.json   # the markdown tables again
```

| Option | Meaning |
| --- | --- |
| `--agents` | `claude`, `codex`, or both, comma-separated (default `claude`). |
| `--variants` | How kanbo is connected: `full` (`kanbo connect <agent> --project`: instructions and MCP), `mcp` (MCP only, `--no-instructions`), `instructions` (instructions only, `--no-mcp`; the agent uses `kanbo` through its shell). Default all three. |
| `--scenarios` | Comma-separated names from the table below (default all). |
| `--n` | Runs per scenario per variant per agent (default 3). |
| `--model` | Claude Code model (default `sonnet`). `--codex-model` for Codex (default: Codex's own). |
| `--timeout` | Seconds per run before it is killed (default 360). |
| `--budget` | Claude Code `--max-budget-usd` per run (default 1.5). |
| `--concurrency` | Runs at once (default 3). |
| `--keep` | Keep each temporary project on disk (its path is in the results). |
| `--no-build` | Use the existing `dist/`. |
| `--out` | Results file (default `evals/results/<date>.json`). |
| `--source <dir>` | Build and test another kanbo checkout (an older commit, to compare before and after). This checkout's build still seeds and scores the board, so the two must share the board schema. |
| `--summary <file>` | Print the markdown tables of a results file; runs nothing. |
| `--reparse <file>` | Recompute the transcript-derived fields of a results file (calls, failed calls, tokens, traces) from the saved transcripts, while they are still on disk. |

**Cost.** The default is 5 scenarios × 3 variants × 3 runs = 45 Claude Code
sessions. With `sonnet` expect roughly $0.10–0.40 a run, $5–20 in all, and
20–40 minutes at concurrency 3. Start with `--n 1`. Each run is capped by
`--budget` and `--timeout`.

Each run's full transcript (`stream-json` for Claude Code, `--json` events for
Codex) is saved in a temporary folder named at the start and in the results file;
the results file keeps every tool call in one line each (`trace`) and the kanbo
calls on their own (`kanboTrace`); a call the tool refused or that exited non-zero
is marked `[failed]` and counted in `failedKanboCalls`.

## How the agent is run

- Claude Code: `claude -p "<task>" --output-format stream-json --verbose
  --no-session-persistence --setting-sources project --strict-mcp-config
  --mcp-config <project>/.mcp.json --permission-mode acceptEdits
  --permission-prompts none --allowedTools mcp__kanbo,Bash,Read,Edit,Write,…`.
  Only the project's settings and `CLAUDE.md` are loaded, so your own
  instructions, hooks and plugins are not what is measured. Claude Code's tool
  search is left as it ships; its calls are counted separately (`toolSearchCalls`).
- Codex: `codex exec --json -C <project> --ephemeral --ignore-user-config
  --ignore-rules -s workspace-write --disable shell_snapshot`, with the kanbo MCP
  server passed as `-c mcp_servers.kanbo.*` (Codex reads a project's
  `.codex/config.toml` only in a trusted project) and
  `default_tools_approval_mode="approve"` (`codex exec` never asks, so a tool
  that needs approval is refused). The shell snapshot is off because it re-reads
  your shell profile, which rebuilds `PATH` without the build under test. Codex
  still loads your own skills (`~/.agents/skills`), which `--ignore-user-config`
  does not turn off; they show up in its trace. Codex reports no cost.
- The environment is cleaned of the parent session's markers (`CLAUDECODE`,
  `CLAUDE_CODE_*`, `KANBO_*`), so the agent's shell is marked only by the agent itself.

## The project and the scenarios

Every run gets a fresh git project: a tiny JavaScript package (`README.md`,
`src/strings.js`, `src/index.js`, `test/strings.test.js`, `npm test` =
`node --test`), `kanbo init --yes --columns standard --key TST`, cards seeded as a
person, then `kanbo connect` for the variant.

| Scenario | Task given | Board | Scored (all must hold for a pass) |
| --- | --- | --- | --- |
| `take-next` | "Take the next card from kanbo and do it." | One To Do card (add `slugify` + test), one Backlog card | Took the To Do card; moved it to In Progress; ≥2 status lines; ≥1 comment; left it in In Review or waiting for a person; did not approve (not Done, no `kanbo approve`); Backlog card untouched; `slugify("Hello World!") === "hello-world"` and `npm test` passes |
| `whats-waiting` | "Look at the board and tell me what's waiting for me." | 9 cards; 2 in In Review waiting for a person, 1 In Review not waiting | The answer names both waiting cards; the board is unchanged; ≤2 kanbo calls |
| `plan-big` | "Card TST-001 is big; plan it." | A card with three independent parts | ≥2 sub-cards with TST-001 as parent; no new top-level card; no approval |
| `plan-small` | "Plan card TST-001." | A one-line typo card | No card created; no approval |
| `returned` | "Continue the card that was returned to you." | A card sent back by a person with a comment; a first `slugify` in the code | The comment's text reached the agent in a tool result; the fix works (`slugify("!!!") === ""`, `slugify("  Hi  ") === "hi"`) and `npm test` passes; a test for `!!!` added; ≥1 comment; handed back to a person; no approval; the other To Do card untouched |

Besides the checks, every run records: kanbo calls (MCP `mcp__kanbo__*` tools
plus shell commands running `kanbo`), all tool calls, Claude Code tool-search
calls, total tokens (input + output + cache, from the agent's usage report),
output tokens, cost, turns and wall time.

Results go to `evals/results/<date>.json`; the summary tables go into
[docs/performance.md](../docs/performance.md#real-agents).
