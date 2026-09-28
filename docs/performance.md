# Performance

How fast kanbo answers on boards of 100, 1,000 and 10,000 cards, how many
database statements each read costs, and how much text each MCP tool hands an
agent. Numbers below were taken on 2026-09-28 with `scripts/bench.mjs`, before and after
[agent efficiency](agent-efficiency.md). [Real agents](#real-agents) is what Claude Code
and Codex actually do with the board, from `evals/agent-eval.mjs`.

## Method

- **Machine:** Apple M1 Pro (10 cores), 32 GB, macOS 14.4 (Darwin 23.4.0), Node 24.13.0.
- **Boards:** a SQLite board file in a temporary folder, and a Postgres board in
  [PGlite](https://pglite.dev) — real Postgres compiled to WebAssembly, running in
  the bench process. PGlite has no network hop, so a real server adds one round
  trip per statement on top of these times (see [statements](#statements-per-read)).
- **Data:** seeded through kanbo's own operations, so every row is one a real
  board carries. Out of every 20 cards: 4 in Backlog, 6 in To Do, 3 in In Progress
  (each with a running agent run and a status line), 2 in In Review (waiting for a
  person), 5 in Done (each with a finished run). Every card has a ~250-character
  description and two comments; a third of the cards have a label.
- **Timing:** 20 samples per operation after one warm-up (5 for a spawned CLI);
  p50 / p95 in milliseconds. Writes (create, move) add cards or move them between
  To Do and In Progress while they are measured.
- **Surfaces:**
  - `ops` — the board operations a host app calls (`createBoardOps`).
  - `cli (in-process)` — the `kanbo` command, run in the bench process: what a
    command costs without Node starting up. Opens the board each time, as a
    command does.
  - `cli (spawned)` — `node dist/cli.cjs … --json` as a shell or an agent's Bash
    tool runs it, Node start-up included (SQLite only: a spawned process cannot
    reach an in-process PGlite).
  - `mcp` — the MCP tools through an MCP client on an in-memory pipe.
  - `serve` — `GET /issues` on `kanbo serve`, over HTTP on loopback.

## Results

p50 / p95 in ms. "statements" is what one call ran — the same at every size.
Numbers are after [agent efficiency](agent-efficiency.md) (list and ready answer
a page of compact cards and filter in the database); the numbers before it are
in [Before and after](#before-and-after-agent-efficiency).

### SQLite (board file)

| surface | operation | 100 cards | 1,000 cards | 10,000 cards | statements |
| --- | --- | ---: | ---: | ---: | ---: |
| ops | create card | 0.53 / 0.63 | 0.61 / 0.96 | 1.31 / 1.50 | 10 |
| ops | move card | 0.77 / 0.91 | 0.76 / 0.96 | 0.77 / 0.86 | 15 |
| ops | list cards | 0.91 / 0.94 | 6.42 / 7.02 | 69.6 / 73.5 | 2 |
| ops | ready | 0.41 / 0.48 | 1.78 / 1.96 | 16.7 / 18.5 | 2 |
| ops | prime | 0.06 / 0.08 | 0.06 / 0.09 | 0.06 / 0.08 | 1 |
| ops | card get + comments | 0.40 / 0.44 | 0.46 / 0.76 | 0.43 / 0.54 | 5 |
| cli (in-process) | card list | 1.89 / 2.47 | 2.81 / 3.32 | 13.6 / 15.2 | 4 |
| cli (in-process) | card list --column in_progress | 1.36 / 1.46 | 1.87 / 2.37 | 4.29 / 5.13 | 4 |
| cli (in-process) | ready | 1.15 / 1.21 | 1.67 / 2.06 | 6.43 / 7.05 | 4 |
| cli (in-process) | prime | 0.71 / 1.01 | 0.74 / 0.87 | 0.73 / 0.80 | 2 |
| cli (in-process) | card get | 1.47 / 1.79 | 1.36 / 1.52 | 1.37 / 1.80 | 7 |
| cli (in-process) | board | 1.94 / 2.70 | 8.71 / 9.59 | 84.5 / 89.9 | 4 |
| mcp | kanbo_prime | 0.12 / 0.19 | 0.08 / 0.09 | 0.13 / 0.23 | 1 |
| mcp | kanbo_ready | 0.47 / 0.62 | 0.78 / 0.92 | 4.57 / 4.99 | 3 |
| mcp | kanbo_columns | 0.10 / 0.21 | 0.08 / 0.10 | 0.09 / 0.11 | 1 |
| mcp | kanbo_card_list | 0.87 / 0.94 | 1.78 / 1.99 | 11.0 / 11.3 | 3 |
| mcp | kanbo_card_list `{ waitingForPerson }` | 0.40 / 0.44 | 0.79 / 0.82 | 2.49 / 2.90 | 3 |
| mcp | kanbo_card_list `{ column: in_progress }` | 0.57 / 0.61 | 0.98 / 1.51 | 2.56 / 2.70 | 3 |
| mcp | kanbo_card_list `{ detail: full }` | 0.83 / 0.89 | 1.81 / 1.91 | 10.8 / 11.4 | 3 |
| mcp | kanbo_card_get | 0.59 / 0.70 | 0.54 / 0.59 | 0.59 / 0.74 | 6 |
| mcp | kanbo_card_get `{ include: all }` | 0.78 / 1.11 | 0.73 / 0.77 | 0.83 / 1.07 | 9 |
| mcp | kanbo_card_pull_requests | 0.35 / 0.39 | 0.34 / 0.42 | 0.35 / 0.40 | 4 |
| mcp | kanbo_sprints | 0.18 / 0.20 | 0.23 / 0.25 | 0.74 / 1.36 | 3 |
| mcp | kanbo_card_create | 0.91 / 1.12 | 0.99 / 1.44 | 2.03 / 2.69 | 15 |
| mcp | kanbo_card_move | 1.14 / 1.22 | 1.12 / 1.26 | 1.21 / 1.38 | 19 |
| serve | GET /issues | 2.25 / 2.56 | 12.6 / 17.5 | 122.3 / 132.2 | 2 |
| cli (spawned) | card list | 92.8 / 99.4 | 94.3 / 96.5 | 106.5 / 107.4 | — |
| cli (spawned) | ready | 91.8 / 92.0 | 92.0 / 93.4 | 97.5 / 97.8 | — |
| cli (spawned) | card get 5 | 94.4 / 95.5 | 92.7 / 93.3 | 93.0 / 94.9 | — |
| cli (spawned) | board | 93.1 / 93.6 | 107.0 / 108.2 | 221.2 / 232.2 | — |

### Postgres (PGlite, in process)

| surface | operation | 100 cards | 1,000 cards | statements |
| --- | --- | ---: | ---: | ---: |
| ops | create card | 2.63 / 2.77 | 2.72 / 2.91 | 10 |
| ops | move card | 3.56 / 4.00 | 3.44 / 3.53 | 13 |
| ops | list cards | 3.40 / 3.77 | 21.7 / 23.8 | 2 |
| ops | ready | 1.25 / 1.40 | 5.36 / 5.73 | 2 |
| ops | prime | 0.27 / 0.30 | 0.26 / 0.28 | 1 |
| ops | card get + comments | 1.63 / 2.11 | 1.57 / 1.86 | 5 |
| cli (in-process) | card list | 6.52 / 7.61 | 6.58 / 7.14 | 6 |
| cli (in-process) | card list --column in_progress | 5.92 / 7.58 | 6.23 / 7.76 | 6 |
| cli (in-process) | ready | 5.57 / 6.58 | 5.73 / 6.26 | 6 |
| cli (in-process) | prime | 3.89 / 4.55 | 3.74 / 4.10 | 4 |
| cli (in-process) | card get | 6.22 / 6.72 | 5.72 / 6.59 | 9 |
| cli (in-process) | board | 7.65 / 8.52 | 27.3 / 28.6 | 6 |
| mcp | kanbo_prime | 0.43 / 0.69 | 0.30 / 0.34 | 1 |
| mcp | kanbo_ready | 1.57 / 1.79 | 1.75 / 1.82 | 3 |
| mcp | kanbo_columns | 0.35 / 0.47 | 0.29 / 0.34 | 1 |
| mcp | kanbo_card_list | 2.42 / 2.99 | 3.06 / 3.61 | 3 |
| mcp | kanbo_card_list `{ waitingForPerson }` | 1.34 / 1.59 | 2.54 / 2.87 | 3 |
| mcp | kanbo_card_list `{ column: in_progress }` | 1.73 / 1.83 | 2.68 / 2.81 | 3 |
| mcp | kanbo_card_list `{ detail: full }` | 2.35 / 2.73 | 3.08 / 3.24 | 3 |
| mcp | kanbo_card_get | 2.15 / 2.52 | 2.06 / 2.68 | 6 |
| mcp | kanbo_card_get `{ include: all }` | 2.92 / 3.46 | 2.87 / 3.27 | 9 |
| mcp | kanbo_card_pull_requests | 1.27 / 1.35 | 1.25 / 1.45 | 4 |
| mcp | kanbo_sprints | 0.77 / 0.93 | 0.84 / 0.91 | 3 |
| mcp | kanbo_card_create | 6.69 / 7.13 | 6.52 / 7.42 | 15 |
| mcp | kanbo_card_move | 7.50 / 7.92 | 7.32 / 8.10 | 17 |
| serve | GET /issues | 4.77 / 7.82 | 28.6 / 30.2 | 2 |

Seeding (through the operations, not part of any timing): SQLite 0.2 s / 1.5 s /
20 s, PGlite 0.7 s / 6.4 s for 100 / 1,000 / 10,000 cards. PGlite at 10,000
cards was not measured again after agent efficiency (it seeds for about two
minutes); its numbers before are in the section below.

### Before and after agent efficiency

The reads an agent makes most, p50 in ms. "Before" is 5e34eef; "after" is the
tables above.

| engine | read | 100 cards | 1,000 cards | 10,000 cards |
| --- | --- | ---: | ---: | ---: |
| SQLite | `kanbo_card_list` | 1.16 → 0.87 | 8.20 → 1.78 | 85.7 → 11.0 |
| SQLite | `kanbo_ready` | 0.99 → 0.47 | 5.26 → 0.78 | 52.3 → 4.57 |
| SQLite | `kanbo_card_get` | 0.82 → 0.59 | 3.55 → 0.54 | 32.7 → 0.59 |
| SQLite | `kanbo_sprints` | 0.55 → 0.18 | 2.91 → 0.23 | 26.3 → 0.74 |
| SQLite | `kanbo ready` (in-process) | 1.79 → 1.15 | 6.36 → 1.67 | 53.6 → 6.43 |
| SQLite | `kanbo card list` (in-process) | 2.37 → 1.89 | 9.18 → 2.81 | 92.7 → 13.6 |
| SQLite | `kanbo card list` (spawned) | 106.5 → 92.8 | 114.3 → 94.3 | 234.4 → 106.5 |
| SQLite | `kanbo ready` (spawned) | 99.5 → 91.8 | 107.0 → 92.0 | 204.4 → 97.5 |
| PGlite | `kanbo_card_list` | 4.80 → 2.42 | 59.1 → 3.06 | 375.0 → not measured |
| PGlite | `kanbo_ready` | 4.55 → 1.57 | 38.2 → 1.75 | 300.4 → not measured |
| PGlite | `kanbo_card_get` | 4.95 → 2.15 | 40.6 → 2.06 | 142.9 → not measured |
| PGlite | `kanbo_sprints` | 2.61 → 0.77 | 36.7 → 0.84 | 191.2 → not measured |
| PGlite | `kanbo ready` (in-process) | 9.16 → 5.57 | 50.6 → 5.73 | 342.5 → not measured |
| PGlite | `kanbo card list` (in-process) | 9.40 → 6.52 | 97.2 → 6.58 | 410.6 → not measured |

What changed:

- `kanbo_card_list`, `kanbo card list` and `kanbo board --column` ask the
  database for the cards a question picks — columns, waiting for a person,
  parent, running, text, changed since, labels, priority — and for one page of
  them with the total, in one statement (`BoardStore.issues.listPage`,
  `count(*) over ()`). They answer 50 cards unless told otherwise.
- `kanbo_ready` and `kanbo ready` are the same statement with the ready rule
  (To Do, waiting for no one, no running run); 10 cards unless told otherwise.
  The running cards are one `in (select …)` set, not a lookup per card: on
  PGlite a correlated `not exists` took `kanbo_ready` at 1,000 cards to 15 ms,
  the set 2 ms.
- `kanbo_card_get` reads the sub-cards by parent instead of reading the whole
  board, and brings the latest comments with it.
- `kanbo_sprints` counts cards per sprint and column in one grouped statement
  (`BoardStore.issues.countByMilestone`) instead of reading every card.
- Still whole-board: `kanbo board` without `--column`, `GET /issues` and the
  `ops` "list cards" row (a host's full read) — they show every card by design.

## Statements per read

Counted by an opt-in drizzle logger on the board handle
(`src/perf/query-counter.ts`), on for the tests and the bench only; a board in use
runs with drizzle's no-op logger. `src/perf/query-count.test.ts` runs every read
below on boards of 10 and 50 cards and fails when a count differs between them —
a read that asks once per card (an N+1) — or changes from the numbers here.

| read | SQLite | Postgres | before (SQLite / Postgres) |
| --- | ---: | ---: | --- |
| `kanbo card list` | 6 | 8 | 4 / 6 |
| `kanbo card list` with every filter | 7 | 9 | 5 / 7 |
| `kanbo ready` | 6 | 8 | 4 / 6 |
| `kanbo prime` | 3 | 5 | 2 / 4 |
| `kanbo card get` (now with comments and sub-cards) | 6 | 8 | 4 / 6 |
| `kanbo board` | 4 | 6 | same |
| a card with its comments (`ops`) | 5 | 5 | same |
| `kanbo_card_list` | 5 | 5 | 3 / 3 |
| `kanbo_card_list` with every filter | 6 | 6 | 4 / 4 |
| `kanbo_ready` | 5 | 5 | 3 / 3 |
| `kanbo_prime` | 2 | 2 | 1 / 1 |
| `kanbo_card_get` (now with comments and sub-cards) | 5 | 5 | 4 / 4 |
| `kanbo_card_get` with every part | 8 | 8 | new |
| `kanbo_sprints` | 3 | 3 | new in the guard; now counts in SQL |
| `GET /issues` | 2 | 2 | same |
| `GET /issues/:id/comments` | 3 | 3 | same |

"Before" is the 0.3.0 agent-efficiency build (3e69998). Since the
[real-agent](#real-agents) fixes, a list page costs two more — which of its cards
a person returned, and the last comment of the waiting and returned ones, two
statements for the whole page — `kanbo_ready` and `kanbo ready` two more for the
returned cards they name first, and `kanbo_prime` one. At 1,000 cards on SQLite
(p50): `kanbo_card_list` 1.78 → 2.49 ms, `kanbo_ready` 0.78 → 1.75 ms,
`kanbo_prime` 0.08 → 0.89 ms.

A command on Postgres runs two more than on SQLite: the check that the database
holds a board this build can write to. A filter adds no statement — it is part
of the one that reads the cards; naming a parent card adds the one that finds
it. `kanbo_card_get` costs one statement per part it brings (sub-cards,
comments, runs, history, pull requests) and saves the agent a call per part.
No read asks once per card. Writes are constant too: creating a card is 10
statements, moving one 13–15 (field history, the change counter, the column's
entry rules).

## MCP response size

Characters of each tool's text answer; tokens estimated as characters / 4. The
same on both engines.

| tool | 100 cards | 1,000 cards | 10,000 cards (SQLite) |
| --- | ---: | ---: | ---: |
| `kanbo_prime` | 1,992 ch ≈ 498 tok | 1,992 ch ≈ 498 tok | 1,992 ch ≈ 498 tok |
| `kanbo_columns` | 1,197 ch ≈ 299 tok | 1,197 ch ≈ 299 tok | 1,197 ch ≈ 299 tok |
| `kanbo_ready` | 1,198 ch ≈ 300 tok | 1,156 ch ≈ 289 tok | 1,158 ch ≈ 290 tok |
| `kanbo_card_list` | 7,117 ch ≈ 1,779 tok | 7,105 ch ≈ 1,776 tok | 7,101 ch ≈ 1,775 tok |
| `kanbo_card_list` `waitingForPerson: true` | 1,811 ch ≈ 453 tok | 9,036 ch ≈ 2,259 tok | 9,042 ch ≈ 2,261 tok |
| `kanbo_card_list` `column: "in_progress"` | 4,612 ch ≈ 1,153 tok | 11,933 ch ≈ 2,983 tok | 12,061 ch ≈ 3,015 tok |
| `kanbo_card_list` `detail: "full"` | 29,310 ch ≈ 7,328 tok | 29,284 ch ≈ 7,321 tok | 29,274 ch ≈ 7,319 tok |
| `kanbo_card_get` | 1,413 ch ≈ 353 tok | 1,415 ch ≈ 354 tok | 1,418 ch ≈ 355 tok |
| `kanbo_card_get` with every part | 2,116 ch ≈ 529 tok | 2,118 ch ≈ 530 tok | 2,122 ch ≈ 531 tok |
| `kanbo_card_pull_requests`, `kanbo_sprints` | 2 ch (`[]`) | 2 ch | 2 ch |

Before and after, default arguments:

| tool | 100 cards | 1,000 cards |
| --- | ---: | ---: |
| `kanbo_card_list` | 20,520 → 1,779 tok | 178,117 → 1,776 tok |
| `kanbo_ready` | 5,239 → 300 tok | 49,543 → 289 tok |
| `kanbo_card_get` | 161 → 353 tok | 161 → 354 tok |

Since the real-agent fixes (1,000 cards, SQLite): `kanbo_card_list` 7,799 ch ≈
1,950 tok (a waiting card now carries its last comment, up to 200 characters),
`waitingForPerson: true` 15,165 ch ≈ 3,791 tok (every row a waiting card with
its comment), `kanbo_ready` 1,219 ch ≈ 305 tok, `kanbo_prime` 1,960 ch ≈ 490 tok
(no returned card on the seeded board). The default list stays under 3,000
tokens.

A list answer no longer grows with the board: one page (50 cards, 10 for
`kanbo_ready`) of compact cards, about 140 characters each, and the total. A
page of cards being worked on is the largest (a status line and a run on each,
~240 characters). `kanbo_card_get` grew because it now carries the card's
latest comments (two on these boards) and its sub-cards — what an agent used to
read with more calls. `detail: "full"` prints what a list printed before, one
page at a time.

## Indexes

Query plans (`EXPLAIN QUERY PLAN` on SQLite, `EXPLAIN ANALYZE` on PGlite) at
10,000 cards:

- The card list (`where workspace_id = ? order by "order", created_at desc`) —
  the base of list, ready, board and `GET /issues` — finds the workspace's rows by
  an existing index and sorts them. An index on `(workspace_id, "order",
  created_at desc)` removes the sort: SQLite 15.6 → 9.6 ms, Postgres execution
  19.3 → 4.6 ms (its sort spilled 4.4 MB to disk). End to end the read barely
  moves — 136 → 125 ms on PGlite, where reading 10,000 wide rows back, not
  finding them, is the cost; through drizzle on SQLite the same read is 40 ms,
  of which the sort is the 6 ms saved.
- Run facts (`issue_runs` by `issue_id`), comments (`issue_comments` by
  `issue_id`), and card lookups by key or number already use indexes.

No index was added: the one candidate is not a clear win at 10,000 cards, and a
schema change is not worth under 10%. Worth revisiting on a real Postgres server
with a small `work_mem`, where the spilled sort costs more.

## Known limits

- **A page still counts every picked card.** `count(*) over ()` makes the
  database walk every card a question picks before it cuts the page, so an
  unfiltered `kanbo_card_list` is 11 ms at 10,000 cards on SQLite, not the
  0.8 ms of a filtered one.
- **Some reads are whole-board by design:** `kanbo board` without `--column`,
  `GET /issues` and a host's own full list — 70–120 ms at 10,000 cards on
  SQLite, 300–450 ms on PGlite (measured before agent efficiency).
- **Over HTTP, filters run in the MCP process.** A host's server answers
  `/issues` with at most one column and one parent; `kanbo_card_list` through
  `createHttpTransport` reads that and applies the rest itself, so the answer
  matches the board file's but the server still sends every card of the column.
- **Text search folds ASCII case only on SQLite** (`like`); Postgres folds every
  letter (`ilike`).
- A spawned `kanbo` costs ~90–100 ms before it does anything (Node start-up and
  loading the CLI); an agent calling the MCP server pays that once.
- PGlite is not a networked server. On Supabase each statement adds a round trip
  (often 1–30 ms), so the statement counts above matter more than these times.

## Running the bench

```sh
npm run build                                    # the spawned-CLI timings run dist/cli.cjs
npm run bench                                    # 100, 1,000, 10,000 cards on both engines
npm run bench -- --sizes 1000 --engines sqlite   # one size, one engine
npm run bench -- --iterations 5 --no-spawn       # fewer samples, no spawned CLI
npm run bench -- --out bench.md                  # also write the report to a file
```

Options: `--sizes`, `--engines` (`sqlite,postgres`), `--iterations` (20),
`--spawn-iterations` (5), `--payload-sizes` (sizes to report MCP payloads for:
`100,1000`), `--no-spawn`, `--out`. The full run takes several minutes, most of
it seeding 10,000 cards into PGlite; one size and one engine at a time keeps each
run short.

The [Bench workflow](../.github/workflows/bench.yml) runs it at 1,000 cards
weekly and on demand (Actions → Bench → Run workflow), and attaches the report
as the `bench` artifact and the job summary. It never runs on a push.

## Real agents

What real coding agents do with a board, measured with
[`evals/agent-eval.mjs`](../evals/README.md) on 2026-09-28: each run is a fresh
git project (a tiny JavaScript package and a seeded board), `kanbo connect` for the
variant, and one sentence of task given to the agent headless. The run is scored
from the board afterwards and from the agent's transcript. Run by hand before a
release; it costs money and is never in CI.

- **Agents:** Claude Code 2.1.283 with `--model sonnet`; Codex CLI 0.153.0 with its
  default model (`codex exec`).
- **Variants:** `full` — `kanbo connect <agent> --project` (the instruction block
  and the MCP server); `mcp` — MCP only; `instructions` — the instruction block
  only, the agent using `kanbo` in its shell. Codex was run on `full` only.
- **Builds:** 3e69998 (after [agent efficiency](agent-efficiency.md)) and, for the
  three scenarios where it matters, 4c3e532 (before it).
- **Runs:** 3 per scenario, variant, agent and build — 69 runs: 45 Claude Code on
  3e69998, 9 Claude Code on 4c3e532, 15 Codex. Claude Code reported $9.34 in all
  (31 agent-minutes); Codex 18 agent-minutes, no cost reported.
- **Kanbo calls** are MCP `kanbo_*` tool calls plus shell commands running `kanbo`,
  failed ones included (in brackets: how many failed, over the three runs).
  **Tokens** are everything the agent reported for the run — input, output and
  cache reads — so they are dominated by the agent's own system prompt and tools.
  Raw results: `evals/results/2026-09-28.json`.

| build | agent | variant | scenario | all rules kept | median kanbo calls (failed) | median tokens | median output tokens | median time (s) | median cost ($) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3e69998 | Claude Code | full | take-next | 3/3 | 9 (1) | 512,205 | 2,756 | 37 | 0.21 |
| 3e69998 | Claude Code | full | whats-waiting | 1/3 | 4 (1) | 166,935 | 648 | 10 | 0.09 |
| 3e69998 | Claude Code | full | plan-big | 3/3 | 8 (1) | 275,557 | 2,115 | 40 | 0.15 |
| 3e69998 | Claude Code | full | plan-small | 3/3 | 3 (0) | 171,213 | 1,198 | 19 | 0.11 |
| 3e69998 | Claude Code | full | returned | 3/3 | 8 (0) | 557,640 | 3,754 | 54 | 0.23 |
| 3e69998 | Claude Code | mcp | take-next | 3/3 | 10 (4) | 438,164 | 2,933 | 33 | 0.19 |
| 3e69998 | Claude Code | mcp | whats-waiting | 1/3 | 4 (2) | 167,837 | 812 | 11 | 0.10 |
| 3e69998 | Claude Code | mcp | plan-big | 3/3 | 6 (0) | 170,396 | 1,696 | 22 | 0.11 |
| 3e69998 | Claude Code | mcp | plan-small | 3/3 | 4 (0) | 166,834 | 1,385 | 24 | 0.10 |
| 3e69998 | Claude Code | mcp | returned | 3/3 | 8 (1) | 529,566 | 3,939 | 53 | 0.22 |
| 3e69998 | Claude Code | instructions | take-next | 3/3 | 10 (1) | 672,337 | 2,982 | 47 | 0.26 |
| 3e69998 | Claude Code | instructions | whats-waiting | 0/3 | 4 (0) | 211,248 | 841 | 21 | 0.12 |
| 3e69998 | Claude Code | instructions | plan-big | 3/3 | 10 (0) | 388,168 | 3,516 | 43 | 0.20 |
| 3e69998 | Claude Code | instructions | plan-small | 3/3 | 3 (0) | 212,827 | 1,595 | 25 | 0.13 |
| 3e69998 | Claude Code | instructions | returned | 3/3 | 9 (0) | 932,541 | 5,295 | 66 | 0.34 |
| 3e69998 | Codex | full | take-next | 3/3 | 16 (3) | 355,089 | 1,763 | 88 | — |
| 3e69998 | Codex | full | whats-waiting | 0/3 | 4 (0) | 108,778 | 360 | 22 | — |
| 3e69998 | Codex | full | plan-big | 3/3 | 17 (3) | 270,410 | 3,715 | 128 | — |
| 3e69998 | Codex | full | plan-small | 3/3 | 14 (3) | 187,612 | 1,477 | 69 | — |
| 3e69998 | Codex | full | returned | 3/3 | 16 (3) | 340,354 | 1,592 | 72 | — |
| 4c3e532 | Claude Code | full | take-next | 3/3 | 9 (0) | 386,252 | 2,421 | 28 | 0.17 |
| 4c3e532 | Claude Code | full | whats-waiting | 3/3 | 2 (0) | 128,947 | 483 | 14 | 0.08 |
| 4c3e532 | Claude Code | full | returned | 3/3 | 8 (2) | 645,468 | 5,180 | 54 | 0.27 |

**Rules.** On 3e69998 every rule check was kept in every run, on both agents and
every variant — 264 of 264 — except one: "at most two kanbo calls" in
`whats-waiting` (2 of 12 runs). Out of 12 runs per scenario: the agent took the
To Do card and not the Backlog one, moved it to In Progress, wrote at least two
status lines, commented the result, left the card in In Review or waiting for a
person, and never tried `kanbo approve` (12/12 on `take-next`); it split the
three-part card into sub-cards of it and created no top-level card (12/12), and
left the typo card whole (12/12); it read the person's comment on the returned
card, fixed what the comment asked, added the test and handed the card back
(12/12); it named both cards waiting for the person and changed nothing (12/12).

**Before and after agent efficiency.** On this nine-card board the calls did not
go down. Before, `kanbo_card_list` answered every card with everything, so
"what's waiting for me" was `kanbo_prime` + one list (2 calls, 3/3 runs). After,
the agent filters (`{ waitingForPerson: true }`) and gets compact rows — then
opens each waiting card with `kanbo_card_get` to see its comments (3–6 calls in
10 of 12 runs). The compact answer is what keeps a 1,000-card board readable (see
[MCP response size](#mcp-response-size)); on a small board the follow-up calls
cost more than the rows saved.

**Where kanbo confused the agents** on 3e69998 (transcript excerpts; what was
changed for each is in [after the fixes](#after-the-fixes)):

- `kanbo_card_comment` takes `content`, while `kanbo_status_line` and
  `kanbo_wait_approval` take `text`. Claude Code sent `text` in 6 runs (4 on
  3e69998, 2 on 4c3e532), got
  `Invalid arguments … expected string, received undefined at content`, and sent
  it again:
  `kanbo_card_comment {"card":"TST-002","text":"Added slugify(text) …"} [failed]`.
- A card is answered as `{"id":"TST-005", …}` but `kanbo_card_get` wants `card`:
  `kanbo_card_get {"id":"TST-005"} [failed]`, twice in one run, then
  `ToolSearch select:mcp__kanbo__kanbo_card_get` and the call again. Claude Code
  defers MCP tools behind its tool search; an agent that calls a tool before
  loading its schema guesses the argument names from the answers it has seen.
- `kanbo run finish --state` is `finished`, `failed` or `stopped`; agents write
  `completed` or `succeeded` first — 11 of the 12 Codex runs that started a run,
  and at least 2 of the 8 Claude Code runs that did:
  `kanbo run finish b116e026-… --state completed` → `Unknown run state "completed"`.
- "Continue the card that was returned to you" has no direct question. The
  returned card sits in In Progress, so `kanbo ready` does not show it, and agents
  search — one run: `kanbo_card_list {"column":"in_review"}`, `{"hasActiveRun":true}`,
  `{"column":"in_progress"}`, `{"waitingForPerson":false}` before `kanbo_card_get`
  (4 list calls); two of three Codex runs first opened the To Do card `ready`
  offered (`kanbo card get TST-003 …`). The status line it finds reads
  `returned by you: …` — said to the person, read by the agent.
- Claude Code does not know its own session id. The prime text asks for
  `claude:<session id>`, and agents invent one: `"session":"claude:sonnet-5-session"`,
  `claude:current`, `--session "claude:$(echo $CLAUDE_SESSION_ID)"` (a variable
  name the agent guessed), or put it in a status line (`Started via claude:session, …`).
- With the shell, agents read `kanbo capabilities` to learn the commands: 13 of
  15 Claude Code runs with `instructions` only and 12 of 15 Codex runs; none with
  MCP, whose tool list already says it.

Headless Codex needs `default_tools_approval_mode = "approve"` on the kanbo MCP
server: `codex exec` never asks, so without it every `kanbo_*` tool is refused
(`MCP tool call requires approval, but approval policy is never`). With it, Codex
still made 190 of its 199 kanbo calls through the shell — the instruction block
and `kanbo prime` name commands.

### After the fixes

What changed for each confusion above (CHANGELOG, "where real agents got
confused"): tool arguments are also accepted under the names agents reached for
(`text` for a comment, `id` for a card, `content` for a status line, `to` for a
column), and a missing or wrong one is answered with one sentence and a call
that works; `completed`, `succeeded` and the like are read as `finished`, and
starting a run prints the call that finishes it; a card a person sent back is
`returned`, listed first by `kanbo_ready` / `kanbo ready` / `kanbo prime` with the
person's comment, and its status line reads `returned by a person: …`; a waiting
card in a list carries its last comment (and, on the command line, its status
line); `kanbo run start` fills in the Claude Code or Codex session from the
environment; `kanbo prime` writes each command out with its arguments; `kanbo
connect codex` writes the approval line.

Re-run on 2026-09-28 with Claude Code 2.1.283 `--model sonnet`, variants `full`
and `instructions`, all five scenarios, 3 runs each: build 379f6b5 (the fixes),
and for `instructions` / `whats-waiting` 8dc8d12 (the command-line list also
prints a waiting card's status line — the first re-run showed agents still
opening each waiting card to read it). Raw results:
`evals/results/2026-09-28-t35.json` and `evals/results/2026-09-28-t35-waiting.json`.
Before is 3e69998, the same groups. **Capabilities** counts runs that read
`kanbo capabilities` (or the `kanbo://capabilities` resource).

| agent | variant | scenario | all rules kept | median kanbo calls | failed kanbo calls (3 runs) | median tokens | runs reading capabilities | median cost ($) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Code | full | take-next | 3/3 → 3/3 | 9 → 9 | 1 → 1 | 512,205 → 390,088 | 0 → 0 | 0.21 → 0.17 |
| Claude Code | full | whats-waiting | 1/3 → 3/3 | 4 → 2 | 1 → 0 | 166,935 → 130,955 | 0 → 0 | 0.09 → 0.08 |
| Claude Code | full | plan-big | 3/3 → 3/3 | 8 → 10 | 1 → 0 | 275,557 → 247,833 | 0 → 0 | 0.15 → 0.15 |
| Claude Code | full | plan-small | 3/3 → 3/3 | 3 → 5 | 0 → 0 | 171,213 → 197,870 | 0 → 0 | 0.11 → 0.11 |
| Claude Code | full | returned | 3/3 → 3/3 | 8 → 7 | 0 → 0 | 557,640 → 529,423 | 0 → 0 | 0.23 → 0.23 |
| Claude Code | instructions | take-next | 3/3 → 3/3 | 10 → 6 | 1 → 0 | 672,337 → 395,181 | 3 → 0 | 0.26 → 0.16 |
| Claude Code | instructions | whats-waiting | 0/3 → 2/3 | 4 → 2 | 0 → 0 | 211,248 → 124,463 | 2 → 0 | 0.12 → 0.07 |
| Claude Code | instructions | plan-big | 3/3 → 3/3 | 10 → 7 | 0 → 0 | 388,168 → 292,111 | 2 → 1 | 0.20 → 0.13 |
| Claude Code | instructions | plan-small | 3/3 → 3/3 | 3 → 2 | 0 → 0 | 212,827 → 157,162 | 3 → 0 | 0.13 → 0.09 |
| Claude Code | instructions | returned | 3/3 → 3/3 | 9 → 7 | 0 → 0 | 932,541 → 453,004 | 3 → 0 | 0.34 → 0.20 |

Over the 30 runs: all rules kept 25 → 29; kanbo calls 202 → 177; failed kanbo
calls 4 → 1; runs reading `kanbo capabilities` 13 → 1. Every rule check other
than "at most two kanbo calls" was kept in every run, before and after. Claude
Code reported $4.57 for the re-runs (33 runs, the 3 replaced `whats-waiting` runs
included).

- **Arguments.** No run sent `text` to `kanbo_card_comment` or `id` to a card
  tool and failed: the one failed call left is `kanbo_card_move {"id":"TST-002","to":"in_progress"}`,
  answered ``kanbo_card_move needs `column` (the column slug, e.g. in_progress). Example: …``
  and called right the next time; `to` is accepted since ba4e70f.
- **Finish states.** 5 `run finish` calls (was 6); none wrote `completed` or
  `succeeded` (was 2), and none failed.
- **Sessions.** No agent passed `--session` or `session` (was 3 of 6 runs that
  started one, with invented ids); the run started over MCP recorded
  `claude:32432f5a-…`, the session id of that very Claude Code transcript.
- **Returned card.** `returned` took 7 calls on the median in both variants (was
  8 and 9), with no list searching: the card is first in `kanbo_ready` / `kanbo
  prime`.
- **What is waiting.** With MCP, `kanbo_prime` + one `kanbo_card_list
  { waitingForPerson: true }` in all 3 runs. From the shell, `kanbo prime` +
  `kanbo card list --waiting` in 2 of 3; the third also asked `kanbo card list
  --returned` ("waiting for *me*"), a third call the scenario counts against it.

**Remaining.** `plan-big` and `plan-small` in the `full` variant took more calls
than before (10 and 5 median): in `plan-big` every run then moved the three new
sub-cards one by one (`kanbo_card_move` ×3, none before), and in `plan-small`
two runs wrote a closing status line and a comment. Both are the agent's own
choices, allowed by the rules; neither is a failed call. One `instructions` run
still read `kanbo capabilities` before splitting a card.

**Codex was not re-run:** its account hit its usage limit on the first call
("You've hit your usage limit"), so the 10 planned runs produced nothing and
were discarded. Its numbers above are 3e69998's.
