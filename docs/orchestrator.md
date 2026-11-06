# Orchestrator examples

kanbo prescribes no roles and no pipeline. It gives your agents a board and a few hard rules; how they split and hand off work is up to your own instructions. This page shows one way to set up an **orchestrator**: an agent that pulls ready cards, decides whether a card needs subtasks, hands subtasks to sub-agents by card key, and waits for your approval.

Every example assumes the project has a board (`kanbo init`) and that the agents have the kanbo MCP server (`kanbo connect <agent>`, see [agents](agents.md)). Agent shells should have `KANBO_ACTOR_KIND=agent`.

## An orchestrator instruction file

Use it as the body of a Claude Code subagent, a Codex `AGENTS.md` section, a Cursor rule, or the prompt of your own script. It is plain Markdown to paste; kanbo does not write it anywhere for you.

```markdown
# Orchestrator

You coordinate work on this project's kanbo board. You do not approve work; a person does. Use the kanbo MCP tools.

## Start of every session
1. Call `kanbo_prime` and read the column descriptions. On this board the description is the contract, not the name.
2. Call `kanbo_ready`. If nothing is ready, say so and stop.
3. Take the first card with `kanbo_card_claim` (agent: orchestrator): it starts your run and moves the card out of To Do into the board's first work-in-progress column in one step, so no other agent takes it, and it answers with the run id you finish later. If another agent got there first, call `kanbo_ready` again.

## While working
- Write a status line (`kanbo_status_line`) at every step and before and after anything that takes more than a minute. One sentence, present tense.
- Put decisions, numbers and open questions on the card as comments (`kanbo_card_comment`). Your transcript is not the card.

## Splitting
Split a card into subtasks only when the person asked for it, or when it has parts that can be done and checked separately — different stages, owners or pull requests. Do not split work you would finish in one go.
- A subtask is `kanbo_card_create` with `parent` = the card, `column` = `to_do`, a title and a description.
- Give each subtask a description a sub-agent can act on without asking you: what to change, how to check it, a `- [ ]` checklist when there are several steps.

## Delegating
- Hand each subtask to a sub-agent by its key only: "Work APP-014 on the kanbo board." The sub-agent reads the card itself.
- Wait for the sub-agent to finish. Then read the subtask (`kanbo_card_get`): it should be in the board's review column or a finished one (by the descriptions in `kanbo_prime`) with a comment saying what changed. If it is not, write why on the parent card and decide: retry, fix it yourself, or ask the person.
- Link every pull request to the card it belongs to (`kanbo_card_link_pr`).

## Handing back
1. When the card's work is complete, move it to the column this board uses for review (see `kanbo_prime`) with `kanbo_card_move`.
2. Call `kanbo_wait_approval` with a text saying what the person should look at.
3. Finish your run: `kanbo_run_finish` with state `finished`.
4. End your turn. Do not approve, do not move the card out of review, do not start the same card again. The person approves with `kanbo approve` or returns it with a reason.

## When the card comes back
- Approved: move it to the board's finished column (see `kanbo_prime`).
- Returned: the reason is the newest comment. The card is back in an earlier column; start a new run and address the reason first.

## Never
- Never run `kanbo approve`, `kanbo return`, `kanbo sprint close`, or anything that changes the columns: `kanbo columns add`, `kanbo columns rename`, `kanbo columns move`, `kanbo columns remove`, `kanbo columns template`, `kanbo columns add-standard`, `kanbo columns rules`, `kanbo columns flow`. They are for a person and will fail in your shell anyway.
- Never delete or edit the board's database directly.
```

## Claude Code: orchestrator, implementer and reviewer subagents

Three files in `.claude/agents/`. The main session (you) asks the orchestrator to work the board; the orchestrator delegates to the other two. Claude Code allows subagents to start subagents (up to its nesting limit); if yours does not, run the orchestrator as the main session with the instruction file above in your own `CLAUDE.md`.

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
2. `kanbo_card_claim` it (agent: implementer): your run starts and the card moves to in_progress in one step.
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

Put the orchestrator instruction file in the project's `AGENTS.md`, mark shells as agents and register the MCP server (`kanbo connect codex` does it in `~/.codex/config.toml`; for the project only, `kanbo connect codex --project` writes `.codex/config.toml`):

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

## A worked session

An illustration of one session, not a recording: the run ids are made up. Lines starting with `# ──` say who acts: a person in a terminal, or an agent calling the kanbo MCP tools.

```text
# ── person ──
$ kanbo init --file --key API --yes
$ kanbo serve                                   # the board page: add the two cards below there

# ── orchestrator (MCP) ──
kanbo_ready {}
  → API-001 Add rate limiting to the public API · API-002 Fix typo in README
kanbo_card_claim {"card":"API-001","agent":"orchestrator"}
  → API-001 moved to in_progress; run 07341411-…; finish it with kanbo_run_finish
kanbo_status_line {"card":"API-001","text":"Splitting: middleware and load test are reviewed separately"}
kanbo_card_create {"parent":"API-001","column":"to_do","title":"Token-bucket middleware","description":"- [ ] middleware\n- [ ] unit tests"}
  → API-003
kanbo_card_create {"parent":"API-001","column":"to_do","title":"Load test at 100 rps","description":"k6 script in bench/, report p95 latency"}
  → API-004
kanbo_card_comment {"card":"API-001","content":"Decision: token bucket per client IP, in-memory store for now. Subtasks API-003 and API-004 go to sub-agents."}
kanbo_status_line {"card":"API-001","text":"Waiting for sub-agents on API-003 and API-004"}

# ── implementer sub-agent (MCP), handed API-003 ──
kanbo_card_claim {"card":"API-003","agent":"implementer"}
kanbo_status_line {"card":"API-003","text":"Writing the middleware and its unit tests"}
kanbo_card_update {"card":"API-003","description":"- [x] middleware\n- [x] unit tests"}
kanbo_card_comment {"card":"API-003","content":"Done: src/middleware/rate-limit.ts, 12 tests passing."}
kanbo_card_move {"card":"API-003","column":"done"}
kanbo_run_finish {"run":"11f4b723-…","state":"finished"}

# (API-004 goes the same way with a second sub-agent.)

# ── orchestrator again (MCP) ──
kanbo_card_move {"card":"API-001","column":"in_review"}
kanbo_wait_approval {"card":"API-001","text":"Both subtasks done; please review the middleware PR"}
kanbo_run_finish {"run":"07341411-…","state":"finished"}
  # No tool approves: the orchestrator ends its turn here.

# ── person ──
$ kanbo approve API-001 --comment 'Looks good. Ship it.'
Approved API-001

# ── orchestrator, next session (MCP) ──
kanbo_card_get {"card":"API-001","include":[]}
  → waitingFor: null, column In Review
kanbo_card_move {"card":"API-001","column":"done"}
```

An agent that runs `kanbo approve` in its own shell is refused with exit code `4`: the orchestrator cannot approve its own card, whatever it tries. The approval comes from the person's shell, and only then does the orchestrator move the card to Done.
