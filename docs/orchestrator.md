# Orchestrator examples

kanbo prescribes no roles and no pipeline. It gives your agents a board and a few hard rules; how they split and hand off work is up to your own instructions. This page shows one way to set up an **orchestrator**: an agent that pulls ready cards, decides whether a card needs subtasks, hands subtasks to sub-agents by card key, and waits for your approval.

Every example assumes the project was set up with `kanbo init` (see [agents](agents.md)) and that agent shells have `KANBO_ACTOR_KIND=agent`.

## An orchestrator instruction file

Use it as the body of a Claude Code subagent, a Codex `AGENTS.md` section, a Cursor rule, or the prompt of your own script. `kanbo instructions orchestrator` prints it (`--copy` puts it on the clipboard).

```markdown
# Orchestrator

You coordinate work on this project's kanbo board. You do not approve work; a person does.

## Start of every session
1. Run `kanbo prime` (tool: `kanbo_prime`) and read the column descriptions. On this board the description is the contract, not the name.
2. Run `kanbo ready` (`kanbo_ready`). If nothing is ready, say so and stop.
3. Take the first card. Run `kanbo run start <card> --agent orchestrator` (`kanbo_run_start`) and move it to `in_progress` (`kanbo_card_move`) before doing anything else.

## While working
- Write a status line (`kanbo card status-line <card> --text "…"`, `kanbo_status_line`) at every step and before and after anything that takes more than a minute. One sentence, present tense.
- Put decisions, numbers and open questions on the card as comments (`kanbo_card_comment`). Your transcript is not the card.

## Splitting
Split a card into subtasks only when the person asked for it, or when it has parts that can be done and checked separately — different stages, owners or pull requests. Do not split work you would finish in one go.
- A subtask is `kanbo card create --parent <card> --column to_do --title "…" --description "…"` (`kanbo_card_create` with `parent`).
- Give each subtask a description a sub-agent can act on without asking you: what to change, how to check it, a `- [ ]` checklist when there are several steps.

## Delegating
- Hand each subtask to a sub-agent by its key only: "Work APP-014 on the kanbo board." The sub-agent reads the card itself.
- Wait for the sub-agent to finish. Then read the subtask (`kanbo_card_get`): it should be in `done` or `in_review` with a comment saying what changed. If it is not, write why on the parent card and decide: retry, fix it yourself, or ask the person.
- Link every pull request to the card it belongs to (`kanbo card pr add <card> <url>`, `kanbo_card_link_pr`).

## Handing back
1. When the card's work is complete, move it to `in_review`.
2. Run `kanbo card wait-approval <card> --text "<what the person should look at>"` (`kanbo_wait_approval`).
3. Finish your run: `kanbo run finish <runId> --state finished` (`kanbo_run_finish`).
4. End your turn. Do not approve, do not move the card out of review, do not start the same card again. The person approves with `kanbo approve` or returns it with a reason.

## When the card comes back
- Approved: move it to `done`.
- Returned: the reason is the newest comment. The card is back in an earlier column; start a new run and address the reason first.

## Never
- Never run `kanbo approve`, `kanbo return`, `kanbo sprint close` or `kanbo columns rules`. They will fail in your shell anyway.
- Never delete or edit the board's database directly.
```

## Claude Code: orchestrator, implementer and reviewer subagents

Three files in `.claude/agents/`. The main session (you) asks the orchestrator to work the board; the orchestrator delegates to the other two. Claude Code allows subagents to start subagents (up to its nesting limit); if yours does not, run the orchestrator as the main session with the instruction file above in `CLAUDE.md`.

`.claude/agents/kanbo-orchestrator.md`:

```markdown
---
name: kanbo-orchestrator
description: Pulls ready cards from the kanbo board, splits them when warranted, delegates subtasks to kanbo-implementer and kanbo-reviewer by card key, and hands finished cards to a person for approval.
tools: Read, Grep, Glob, Bash, Agent, mcp__kanbo
model: opus
---

<the "Orchestrator" instruction file above>

Delegate implementation subtasks to the `kanbo-implementer` subagent and review to the `kanbo-reviewer` subagent. Pass only the card key.
```

`.claude/agents/kanbo-implementer.md`:

```markdown
---
name: kanbo-implementer
description: Implements exactly one kanbo card, given its key. Moves the card, writes status lines, links the pull request, and moves it to in_review when done.
tools: Read, Grep, Glob, Edit, Write, Bash, mcp__kanbo
model: sonnet
---

You implement exactly one card; its key is in your task.
1. `kanbo_card_get` it. Stop if it waits for a person.
2. `kanbo_run_start` (agent: implementer), then `kanbo_card_move` to in_progress.
3. Do the work. Write a `kanbo_status_line` at every step. Tick the description's checklist with `kanbo_card_update` as items are done.
4. Comment what you changed and how you checked it (`kanbo_card_comment`). Link the pull request (`kanbo_card_link_pr`).
5. `kanbo_card_move` to in_review, `kanbo_run_finish` with state finished, and stop.
Never approve or return a card, and never touch other cards.
```

`.claude/agents/kanbo-reviewer.md`:

```markdown
---
name: kanbo-reviewer
description: Reviews the work on one kanbo card in in_review, given its key, and records findings on the card.
tools: Read, Grep, Glob, Bash, mcp__kanbo
model: sonnet
---

You review exactly one card; its key is in your task. You do not edit code.
1. `kanbo_card_get` it and read its comments and linked pull requests.
2. `kanbo_run_start` (agent: reviewer). Write a `kanbo_status_line` while you review.
3. Check the change against the card's description and checklist. Run the tests.
4. Write your verdict as one `kanbo_card_comment`: "Review: OK" or "Review: changes needed" with a list.
5. If changes are needed, `kanbo_card_move` the card back to in_progress. Otherwise leave it in in_review.
6. `kanbo_run_finish` with state finished, and stop. Approving is the person's job.
```

Start it from the main session: *"Use the kanbo-orchestrator subagent to work the next ready card."*

## Codex

Put the orchestrator instruction file in the project's `AGENTS.md` (below the block `kanbo init --instructions agents` wrote), mark shells as agents and register the MCP server in `.codex/config.toml`:

```toml
[shell_environment_policy]
set = { KANBO_ACTOR_KIND = "agent", KANBO_ACTOR_ID = "codex-orchestrator" }

[mcp_servers.kanbo]
command = "kanbo"
args = ["mcp"]
```

Then run a session non-interactively:

```bash
codex exec "Work the next ready card on the kanbo board, following the Orchestrator section of AGENTS.md."
```

For sub-agents, start one Codex session per subtask with its own actor id, for example `codex --profile board-worker exec "Work API-003 on the kanbo board."` with the profile from [agents](agents.md#a-codex-profile).

## A plain shell loop

For any CLI agent. It picks the next ready card, gives the key to an agent, and stops when the board has nothing ready or a card waits for you.

```bash
#!/usr/bin/env bash
set -euo pipefail
export KANBO_ACTOR_KIND=agent KANBO_ACTOR_ID=loop

while true; do
  card=$(kanbo ready --limit 1 --json id | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a[0]?a[0].id:"")})')
  if [ -z "$card" ]; then
    echo "Nothing ready."
    break
  fi
  echo "Working $card"
  # Replace with your agent: claude -p, codex exec, aider, a script…
  claude -p "Work $card on the kanbo board. Follow the kanbo block in CLAUDE.md. End with kanbo card wait-approval."
  waiting=$(kanbo card get "$card" --json waitingFor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waitingFor??""))')
  if [ "$waiting" = "human" ]; then
    echo "$card is waiting for you: kanbo approve $card  or  kanbo return $card --comment \"…\""
    break
  fi
done
```

`kanbo ready` never offers a card that has a run going or is waiting for a person, so a card the agent left unfinished is not picked up twice.

## A worked session

Generated by running these commands against a fresh board file with kanbo 0.1.0. Run ids and paths differ on your machine. Lines starting with `# ──` say whose shell the following commands run in: a person's (no `KANBO_ACTOR_KIND`), or an agent's (`KANBO_ACTOR_KIND=agent`, `KANBO_ACTOR_ID` set to the agent's name).

```text
# ── person ──
$ kanbo init --file --identifier API --instructions none --yes
Bound this project to API — ~/acme-api/.kanbo/binding.json
Board file: ~/acme-api/.kanbo/board.db

$ kanbo card create --column to_do --title 'Add rate limiting to the public API' --description 'Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.'
API-001  To Do  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

$ kanbo card create --column to_do --title 'Fix typo in README' --description 'The install section says npm isntall.'
API-002  To Do  worktree
Fix typo in README

The install section says npm isntall.

# ── orchestrator (agent shell) ──
$ kanbo ready
API-001  To Do  Add rate limiting to the public API
API-002  To Do  Fix typo in README

$ kanbo run start API-001 --agent orchestrator
Run b2147c3f-4a70-436b-a6e6-d9f32f32b4d2 started on API-001

$ kanbo card move API-001 in_progress
API-001  In Progress  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: launched orchestrator

$ kanbo card status-line API-001 --text 'Splitting: middleware and load test are reviewed separately'
API-001  In Progress  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Splitting: middleware and load test are reviewed separately

$ kanbo card create --parent API-001 --column to_do --title 'Token-bucket middleware' --description $'- [ ] middleware\n- [ ] unit tests'
API-003  To Do  worktree
Token-bucket middleware

- [ ] middleware
- [ ] unit tests

parent: API-001

$ kanbo card create --parent API-001 --column to_do --title 'Load test at 100 rps' --description 'k6 script in bench/, report p95 latency'
API-004  To Do  worktree
Load test at 100 rps

k6 script in bench/, report p95 latency

parent: API-001

$ kanbo card comment API-001 --content 'Decision: token bucket per client IP, in-memory store for now. Subtasks API-003 and API-004 go to sub-agents.'
Commented on API-001

$ kanbo card status-line API-001 --text 'Waiting for sub-agents on API-003 and API-004'
API-001  In Progress  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Waiting for sub-agents on API-003 and API-004

# ── implementer sub-agent (agent shell), handed API-003 ──
$ kanbo run start API-003 --agent implementer
Run 7147f430-b079-4650-8233-8834bd4dfc29 started on API-003

$ kanbo card move API-003 in_progress
API-003  In Progress  worktree
Token-bucket middleware

- [ ] middleware
- [ ] unit tests

status line: launched implementer
parent: API-001

$ kanbo card status-line API-003 --text 'Writing the middleware and its unit tests'
API-003  In Progress  worktree
Token-bucket middleware

- [ ] middleware
- [ ] unit tests

status line: Writing the middleware and its unit tests
parent: API-001

$ kanbo card update API-003 --description $'- [x] middleware\n- [x] unit tests'
API-003  In Progress  worktree
Token-bucket middleware

- [x] middleware
- [x] unit tests

status line: Writing the middleware and its unit tests
parent: API-001

$ kanbo card comment API-003 --content 'Done: src/middleware/rate-limit.ts, 12 tests passing.'
Commented on API-003

$ kanbo card move API-003 done
API-003  Done  worktree
Token-bucket middleware

- [x] middleware
- [x] unit tests

status line: Writing the middleware and its unit tests
parent: API-001

$ kanbo run finish 7147f430-b079-4650-8233-8834bd4dfc29 --state finished
Run 7147f430-b079-4650-8233-8834bd4dfc29 finished

# (API-004 goes the same way with a second sub-agent.)

# ── orchestrator again ──
$ kanbo card move API-001 in_review
API-001  In Review  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Waiting for sub-agents on API-003 and API-004

$ kanbo card wait-approval API-001 --text 'Both subtasks done; please review the middleware PR'
API-001  In Review  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Both subtasks done; please review the middleware PR
waiting for a person

$ kanbo approve API-001
Approval is for a person. This shell belongs to an agent (KANBO_ACTOR_KIND=agent). Ask a person to approve it on the board or run "kanbo approve" in their own terminal.
(exit 4)

$ kanbo card get API-001 --json id,column,statusLine,waitingFor,attemptCount
{
  "id": "API-001",
  "column": "In Review",
  "statusLine": "Both subtasks done; please review the middleware PR",
  "waitingFor": "human",
  "attemptCount": 1
}

# ── person ──
$ kanbo approve API-001 --comment 'Looks good. Ship it.'
Approved API-001

API-001  In Review  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Both subtasks done; please review the middleware PR

# ── orchestrator (agent shell) ──
$ kanbo card get API-001 --json id,column,waitingFor
{
  "id": "API-001",
  "column": "In Review",
  "waitingFor": null
}

$ kanbo card move API-001 done
API-001  Done  worktree
Add rate limiting to the public API

Limit anonymous clients to 60 requests per minute. Return 429 with Retry-After.

status line: Both subtasks done; please review the middleware PR

$ kanbo run finish b2147c3f-4a70-436b-a6e6-d9f32f32b4d2 --state finished
Run b2147c3f-4a70-436b-a6e6-d9f32f32b4d2 finished

$ kanbo card list --json id,title,column,parentIssueId
[
  {
    "id": "API-001",
    "title": "Add rate limiting to the public API",
    "column": "Done",
    "parentIssueId": null
  },
  {
    "id": "API-002",
    "title": "Fix typo in README",
    "column": "To Do",
    "parentIssueId": null
  },
  {
    "id": "API-003",
    "title": "Token-bucket middleware",
    "column": "Done",
    "parentIssueId": "API-001"
  },
  {
    "id": "API-004",
    "title": "Load test at 100 rps",
    "column": "To Do",
    "parentIssueId": "API-001"
  }
]
```

Note the `exit 4`: the orchestrator cannot approve its own card, whatever it tries. The approval came from the person's shell, and only then did the orchestrator move the card to Done and finish its run.
