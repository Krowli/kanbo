# Agent efficiency

What an agent working a kanbo board asks, and how many calls — and how much
text — each question costs. The goal: one call per question, and an answer
small enough that it does not crowd the agent's context on a board of
thousands of cards. Sizes and times are in [Performance](performance.md).

"Before" is kanbo at 5e34eef (the MCP tools and commands as 0.2 shipped them,
plus phase 1–6 of 0.3.0); "after" is this version.

## Questions

Calls to answer each question, through MCP and through the CLI. "—" means the
question could not be answered through that door at all.

| Question | MCP before | MCP after | CLI before | CLI after |
| --- | --- | --- | --- | --- |
| What do I take next? | 1 `kanbo_ready` — every ready card, ≈49,500 tokens at 1,000 cards | 1 `kanbo_ready` — 10 compact cards and the total, ≈290 tokens | 1 `kanbo ready` — every ready card | 1 `kanbo ready` — 10 and a count on stderr |
| What is waiting for a person? | 1 `kanbo_card_list` of the whole board (≈178,000 tokens) and a scan of `waitingFor` | 1 `kanbo_card_list` `waitingForPerson: true` | 1 `card list --json` and a scan | 1 `card list --waiting` |
| What is being worked on right now? | 1 whole-board list and a scan of `activeRun` | 1 `kanbo_card_list` `hasActiveRun: true` | 1 `card list --json` and a scan | 1 `card list --active` |
| What is in progress or in review? | 2 `kanbo_card_list`, one per column | 1 `kanbo_card_list` `columns: [...]` | 2 `card list --column` | 1 `card list --column in_progress,in_review` |
| A card with its comments and sub-cards | `kanbo_card_get` for the sub-cards; comments — | 1 `kanbo_card_get` (last 10 comments, `commentCount`, `subCards`) | 1 `card get`, then `card list --json parentIssueId` and a scan; comments — | 1 `card get` |
| …with its runs, history and pull requests | +1 `kanbo_card_pull_requests`; runs and history — | 1 `kanbo_card_get` `include: [...]` | +1 `card pr list`; runs and history — | 1 `card get --include ...` |
| The sub-cards of MAN-012 | 1 `kanbo_card_get` (read the whole board to find them) | 1 `kanbo_card_list` `parent` or `kanbo_card_get` (read by parent) | 1 `card list --json` and a scan | 1 `card list --parent MAN-012` |
| Which cards mention "parser"? | 1 whole-board list, descriptions included, and a scan | 1 `kanbo_card_list` `text: "parser"` | 1 `card list --json title,description` and a scan | 1 `card list --text parser` |
| What changed since I last looked? | 1 whole-board list and a comparison of `updatedAt` | 1 `kanbo_card_list` `updatedSince` | 1 `card list --json` and a comparison | 1 `card list --updated-since <time>` |
| Cards labelled `ui`, high priority | 1 whole-board list and a scan | 1 `kanbo_card_list` `labels`, `priority` | 1 `card list --json` and a scan | 1 `card list --label ui --priority high` |
| How is the sprint going? | 1 `kanbo_sprints` (read every card to count) | 1 `kanbo_sprints` (counted by the database) | 1 `sprint list` | 1 `sprint list` |
| What are the columns and rules? | 1 `kanbo_prime` | 1 `kanbo_prime` | 1 `kanbo prime` | 1 `kanbo prime` |
| How many cards are in each column? | whole-board list and a count | one `kanbo_card_list` per column with `limit: 1` (read `total`) | 1 `kanbo board` | 1 `kanbo board` |

Every question but the last is one call after. The last stays one call in the
terminal (`kanbo board`) and one per column over MCP; no tool was added for it
(see [Not done](#not-done)).

A list answer is one page — 50 cards (`kanbo_card_list`), 10 (`kanbo_ready`) —
of compact cards and the `total`, with `nextOffset` when there are more: the
agent sees how much there is without reading all of it, and reads the next
page only if it needs it.

## Tools

The 16 MCP tools, what an agent calls each one for, and what changed.

| Tool | Typical question | Calls | Changed |
| --- | --- | --- | --- |
| `kanbo_prime` | What is this board, and how do cards travel? | 1 | — |
| `kanbo_ready` | What do I take next? | 1 | Compact, 10 by default, `total`, `offset`, `detail`, `fields`; read in one statement |
| `kanbo_columns` | Which columns, and what do they require? | 1 | — |
| `kanbo_sprints` | Which sprint is running, how far along? | 1 | Counts by one grouped statement instead of reading every card |
| `kanbo_card_get` | Everything about this card | 1 | `include` (`comments`, `subCards`, `runs`, `history`, `prs`), `commentLimit`; comments and sub-cards by default; sub-cards read by parent |
| `kanbo_card_list` | Which cards are waiting / running / in these columns / under this card / mention this / changed since? | 1 | `columns`, `waitingForPerson`, `parent`, `hasActiveRun`, `text`, `updatedSince`, `labels`, `priority`, `offset`, `detail`, `fields`; compact, 50 by default; filtered in the database |
| `kanbo_card_create` | Put a card (or a subtask) on the board | 1 | Answers the card compact; `detail: "full"` for every field |
| `kanbo_card_update` | Change title, description, priority, labels | 1 | Answers the card compact; `detail: "full"` for every field |
| `kanbo_card_move` | Move a card | 1 | Answers the card compact; `detail: "full"` for every field |
| `kanbo_card_comment` | Write a finding or a question | 1 | — |
| `kanbo_card_link_pr` | Link a pull request | 1 | — |
| `kanbo_card_pull_requests` | Which pull requests does this card name? | 1 | Also in `kanbo_card_get` `include: ["prs"]` |
| `kanbo_status_line` | Say what I am doing | 1 | Answers the card compact; `detail: "full"` for every field |
| `kanbo_wait_approval` | Hand the card to a person | 1 | Answers the card compact; `detail: "full"` for every field |
| `kanbo_run_start` | Record that I started | 1 | — |
| `kanbo_run_finish` | Record how it ended | 1 | — |

The descriptions of `kanbo_card_list`, `kanbo_ready` and `kanbo_card_get` now
say how to get each of these in one call (for example "Waiting for a person:
`waitingForPerson: true`"), in one or two sentences each: every description is
sent to the model with every request.

## Commands

| Command | Typical question | Changed |
| --- | --- | --- |
| `kanbo prime` | Columns, rules, commands | — |
| `kanbo ready` | What do I take next? | 10 by default (`--limit`, `--all`), a count of the rest on stderr; read in one statement |
| `kanbo card list` | The same questions as `kanbo_card_list` | `--column` takes several, `--waiting`, `--parent`, `--active`, `--text`, `--updated-since`, `--label`, `--priority`, `--offset`, `--all`; 50 by default, the rest counted on stderr; filtered in the database |
| `kanbo card get` | Everything about this card | Last 10 comments and sub-cards by default; `--include`, `--comments` |
| `kanbo board` | The board at a glance | `--column` reads only that column |

The JSON a command prints keeps its shape (an array of cards for `card list`
and `ready`); the page and the count of the rest go to stderr, so a script
reading stdout reads what it read before — one page of it.

## Compact cards

A list prints per card: `id`, `title` (the first line of the description when
the card has no title of its own), `column` (the slug a move takes),
`statusLine`, `waitingFor`, `parentId`, `attempt`, `activeRun` (`agentName`,
`startedAt`) and `updatedAt`, leaving out every field that is empty. The
description, labels, priority, execution mode and the run's id are what an
agent reads once it has chosen a card — `kanbo_card_get`, or `detail: "full"`
or `fields: [...]` on the list.

The tools that write a card — `kanbo_card_create`, `kanbo_card_update`,
`kanbo_card_move`, `kanbo_status_line`, `kanbo_wait_approval` — answer with it
the same way, one compact card on one line. They used to answer with the whole
card, description included, pretty-printed: an orchestrator writing its card 20
to 40 times a session got 5,000 to 19,000 characters back each time (19,000 for
a one-sentence status line), and read all of it again on every later turn.
`detail: "full"` still answers every field.

## Not done

- **Counts per column over MCP.** `kanbo board` answers it in the terminal;
  over MCP it is one `kanbo_card_list` per column with `limit: 1`. A count per
  column in `kanbo_prime` would make it free, and grow the answer every
  session starts with.
- **A cursor.** Pages are by `offset`: a card moved between two pages can be
  skipped or seen twice. Board order changes rarely while an agent pages, and
  `total` says when the board moved under it.
- **Filters on a server's `/issues`.** A host that serves the board over HTTP
  filters on one column and one parent; `createHttpTransport` applies the rest
  in the MCP process. `kanbo serve`'s routes are unchanged.
