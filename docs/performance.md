# Performance

How fast kanbo answers on boards of 100, 1,000 and 10,000 cards, how many
database statements each read costs, and how much text each MCP tool hands an
agent. Numbers below were taken on 2026-09-28 with `scripts/bench.mjs`.

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

### SQLite (board file)

| surface | operation | 100 cards | 1,000 cards | 10,000 cards | statements |
| --- | --- | ---: | ---: | ---: | ---: |
| ops | create card | 0.54 / 1.07 | 0.65 / 1.06 | 1.92 / 3.16 | 10 |
| ops | move card | 0.83 / 1.12 | 0.78 / 1.01 | 0.77 / 0.89 | 15 |
| ops | list cards | 0.95 / 1.15 | 6.63 / 7.46 | 74.8 / 79.9 | 2 |
| ops | ready | 0.70 / 0.88 | 4.13 / 4.41 | 40.4 / 43.2 | 3 |
| ops | prime | 0.08 / 0.15 | 0.06 / 0.08 | 0.07 / 0.14 | 1 |
| ops | card get + comments | 0.41 / 0.47 | 0.37 / 0.42 | 0.46 / 0.57 | 5 |
| cli (in-process) | card list | 2.37 / 2.98 | 9.18 / 10.2 | 92.7 / 145.6 | 4 |
| cli (in-process) | ready | 1.79 / 2.19 | 6.36 / 6.99 | 53.6 / 55.4 | 6 |
| cli (in-process) | prime | 0.83 / 1.26 | 0.79 / 1.08 | 0.76 / 0.81 | 2 |
| cli (in-process) | card get | 1.18 / 1.61 | 1.02 / 1.52 | 1.26 / 1.85 | 5 |
| cli (in-process) | board | 2.04 / 2.70 | 9.02 / 9.79 | 86.6 / 91.8 | 4 |
| mcp | kanbo_prime | 0.13 / 0.22 | 0.09 / 0.10 | 0.14 / 0.34 | 1 |
| mcp | kanbo_ready | 0.99 / 1.37 | 5.26 / 5.75 | 52.3 / 54.3 | 5 |
| mcp | kanbo_columns | 0.09 / 0.12 | 0.09 / 0.11 | 0.10 / 0.23 | 1 |
| mcp | kanbo_card_list | 1.16 / 1.46 | 8.20 / 8.85 | 85.7 / 105.9 | 3 |
| mcp | kanbo_card_get | 0.82 / 1.13 | 3.55 / 4.16 | 32.7 / 34.7 | 5 |
| mcp | kanbo_card_pull_requests | 0.41 / 0.50 | 0.33 / 0.41 | 0.40 / 0.46 | 4 |
| mcp | kanbo_sprints | 0.55 / 0.63 | 2.91 / 3.11 | 26.3 / 28.9 | 3 |
| mcp | kanbo_card_create | 1.01 / 1.47 | 1.18 / 1.68 | 2.24 / 4.00 | 15 |
| mcp | kanbo_card_move | 1.19 / 1.65 | 1.21 / 1.40 | 1.35 / 1.58 | 19 |
| serve | GET /issues | 2.78 / 3.35 | 13.4 / 19.1 | 126.8 / 157.7 | 2 |
| cli (spawned) | card list | 106.5 / 119.8 | 114.3 / 118.2 | 234.4 / 241.2 | — |
| cli (spawned) | ready | 99.5 / 105.9 | 107.0 / 107.8 | 204.4 / 249.7 | — |
| cli (spawned) | card get 5 | 95.6 / 117.6 | 95.6 / 96.5 | 99.6 / 101.6 | — |
| cli (spawned) | board | 99.2 / 101.1 | 110.8 / 114.5 | 238.6 / 245.5 | — |

### Postgres (PGlite, in process)

| surface | operation | 100 cards | 1,000 cards | 10,000 cards | statements |
| --- | --- | ---: | ---: | ---: | ---: |
| ops | create card | 3.87 / 6.16 | 5.09 / 25.9 | 7.87 / 11.7 | 10 |
| ops | move card | 5.19 / 6.53 | 6.82 / 17.3 | 4.79 / 10.0 | 13 |
| ops | list cards | 4.15 / 5.06 | 113.4 / 312.4 | 428.8 / 556.2 | 2 |
| ops | ready | 3.52 / 4.30 | 38.0 / 130.0 | 274.9 / 335.0 | 3 |
| ops | prime | 0.31 / 0.65 | 0.30 / 25.1 | 0.30 / 0.34 | 1 |
| ops | card get + comments | 3.25 / 6.51 | 2.28 / 10.2 | 2.11 / 5.11 | 5 |
| cli (in-process) | card list | 9.40 / 11.0 | 97.2 / 205.5 | 410.6 / 507.4 | 6 |
| cli (in-process) | ready | 9.16 / 10.3 | 50.6 / 137.2 | 342.5 / 413.9 | 8 |
| cli (in-process) | prime | 4.82 / 5.66 | 6.90 / 24.5 | 4.78 / 26.1 | 4 |
| cli (in-process) | card get | 6.49 / 7.88 | 6.40 / 23.2 | 11.0 / 25.6 | 7 |
| cli (in-process) | board | 8.75 / 9.53 | 83.1 / 125.4 | 431.1 / 575.2 | 6 |
| mcp | kanbo_prime | 0.33 / 0.42 | 0.33 / 0.69 | 0.44 / 2.54 | 1 |
| mcp | kanbo_ready | 4.55 / 5.53 | 38.2 / 66.6 | 300.4 / 380.3 | 5 |
| mcp | kanbo_columns | 0.31 / 0.46 | 0.38 / 0.72 | 0.34 / 0.42 | 1 |
| mcp | kanbo_card_list | 4.80 / 6.19 | 59.1 / 83.0 | 375.0 / 460.3 | 3 |
| mcp | kanbo_card_get | 4.95 / 5.95 | 40.6 / 71.6 | 142.9 / 153.2 | 5 |
| mcp | kanbo_card_pull_requests | 1.62 / 2.27 | 2.10 / 36.5 | 1.43 / 1.69 | 4 |
| mcp | kanbo_sprints | 2.61 / 3.22 | 36.7 / 63.9 | 191.2 / 314.3 | 3 |
| mcp | kanbo_card_create | 8.56 / 9.71 | 29.2 / 65.0 | 12.7 / 28.3 | 15 |
| mcp | kanbo_card_move | 10.3 / 11.8 | 14.6 / 57.3 | 13.3 / 25.3 | 17 |
| serve | GET /issues | 6.27 / 11.4 | 64.1 / 110.5 | 347.1 / 412.2 | 2 |

Seeding (through the operations, not part of any timing): SQLite 0.2 s / 1.6 s /
34 s, PGlite 1.0 s / 11 s / 123 s for 100 / 1,000 / 10,000 cards.

### What changed while measuring

Two reads were slower than their statements explain, both in JavaScript rather
than in the database (SQLite, 10,000 cards, p50):

| read | before | after | cause |
| --- | ---: | ---: | --- |
| `kanbo board` (in-process) | 1,260 ms | 87 ms | each title's width measured grapheme by grapheme; plain ASCII is now measured by length |
| `kanbo_card_list` | 518 ms | 86 ms | each card's run facts searched for in the whole list — quadratic; now read by position |
| `kanbo_ready` | 137 ms | 52 ms | the same search |

## Statements per read

Counted by an opt-in drizzle logger on the board handle
(`src/perf/query-counter.ts`), on for the tests and the bench only; a board in use
runs with drizzle's no-op logger. `src/perf/query-count.test.ts` runs every read
below on boards of 10 and 50 cards and fails when a count differs between them —
a read that asks once per card (an N+1) — or changes from the numbers here.

| read | SQLite | Postgres |
| --- | ---: | ---: |
| `kanbo card list` | 4 | 6 |
| `kanbo ready` | 6 | 8 |
| `kanbo prime` | 2 | 4 |
| `kanbo card get` | 4 | 6 |
| `kanbo board` | 4 | 6 |
| a card with its comments (`ops`) | 5 | 5 |
| `kanbo_card_list` | 3 | 3 |
| `kanbo_ready` | 5 | 5 |
| `kanbo_prime` | 1 | 1 |
| `kanbo_card_get` | 4 | 4 |
| `GET /issues` | 2 | 2 |
| `GET /issues/:id/comments` | 3 | 3 |

A command on Postgres runs two more than on SQLite: the check that the database
holds a board this build can write to. No read was found asking once per card —
every card list reads its cards in one statement and their run facts in one
more. Writes are constant too: creating a card is 10 statements, moving one 13–15
(field history, the change counter, the column's entry rules).

## MCP response size

Characters of each tool's text answer; tokens estimated as characters / 4. The
same on both engines.

| tool | 100 cards | 1,000 cards |
| --- | ---: | ---: |
| `kanbo_prime` | 1,992 ch ≈ 498 tok | 1,992 ch ≈ 498 tok |
| `kanbo_columns` | 1,197 ch ≈ 299 tok | 1,197 ch ≈ 299 tok |
| `kanbo_card_get` | 642 ch ≈ 161 tok | 644 ch ≈ 161 tok |
| `kanbo_ready` | 20,957 ch ≈ 5,239 tok | 198,171 ch ≈ 49,543 tok |
| `kanbo_card_list` | 82,079 ch ≈ 20,520 tok | 712,469 ch ≈ 178,117 tok |
| `kanbo_card_pull_requests`, `kanbo_sprints` | 2 ch (`[]`) | 2 ch |

`kanbo_card_list` and `kanbo_ready` grow with the board: about 710 characters
per card listed, descriptions included (`kanbo_ready` lists the To Do cards, 30%
of these boards). Past a few hundred
cards an unfiltered list no longer fits an agent's context — pass `column` and
`limit`.

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

- **Whole-board reads are linear in the board.** `card list`, `ready`, `board`,
  `GET /issues` and their MCP tools read every card of the workspace and filter
  in JavaScript: ~50–130 ms at 10,000 cards on SQLite, 300–450 ms on PGlite.
  `ready` and `card list --column` read the whole board even when they print a
  few cards.
- **`kanbo_card_get` reads the whole board** to find a card's sub-cards (33 ms on
  SQLite, 143 ms on PGlite at 10,000 cards), and `kanbo_sprints` does the same to
  count cards per sprint.
- **Payloads**, above: the unfiltered list tools are not usable by an agent on a
  big board.
- A spawned `kanbo` costs ~95–100 ms before it does anything (Node start-up and
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
