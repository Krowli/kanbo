# MCP reference

`kanbo mcp` is an MCP server over stdio. It opens the board the same way every `kanbo` command does (flags, environment, the project's `.kanbo/binding.json`) and treats its client as an agent: on a Postgres board it uses the binding's `agentDatabaseUrl` when there is one, and every write is filed under `KANBO_ACTOR_ID` or the operating-system user.

```bash
kanbo mcp                                   # the board this project is bound to
kanbo mcp --database-url "$URL" --workspace my-project
```

Registering it with Claude Code, Codex or Cursor is covered in [agents](agents.md).

## Server instructions

When a client connects, the server sends `instructions` in its MCP initialize result — text a client hands its model before any tool is called, so an agent with nothing but this server connected knows how to work the board:

- what kanbo is, and to call `kanbo_prime` at the start of a session (it returns the board's columns) and take work from `kanbo_ready`;
- move the card yourself, write a status line at every step, put results and questions in comments, split into subtasks only when asked or when parts stand alone;
- when a person is needed, `kanbo_wait_approval` and end the turn; never approve a card or take it out of waiting;
- the full manifest is the resource `kanbo://capabilities.md`.

The text is static (about 1.3k characters) and names no column, so it is valid before a board is resolved; the board's own columns come from `kanbo_prime`. Its rule sentences are the same ones `kanbo prime` uses. `kanbo/mcp` exports it as `KANBO_MCP_INSTRUCTIONS`; `createKanboMcpServer` sends it, `registerKanboTools` does not — a server of your own decides its own instructions.

`kanbo mcp` sends them in a folder with no board too: the server starts, and every tool answers "This folder has no kanbo board yet. Ask a person to run kanbo here." until a board is set up in that folder. `createDbTransport` itself is unchanged and still fails when no board resolves.

## Resources

| URI | Content |
| --- | --- |
| `kanbo://capabilities` | The capabilities manifest as JSON — the same as `kanbo capabilities --json`. |
| `kanbo://capabilities.md` | The same manifest as Markdown. |

## Tools

All tools take the card as `card`, spelled as the board prints it (`MAN-012`), and a column by slug (`in_progress`) or name (`"In Progress"`). A broken board rule comes back as a tool result with `isError` set and the rule's code, not as a protocol error. Every tool has a CLI equivalent that does the same thing.

**Other names an argument is accepted under.** Agents guess argument names before they read a tool's schema ([Real agents](performance.md#real-agents)), so a few are also taken under the name they reach for. The published schema lists only the canonical names; an alias is read only when the canonical name is absent, and both given with different values is refused.

| Argument | Also accepted as | Tools |
| --- | --- | --- |
| `card` | `id`, `cardId`, `key` | every tool that takes `card` |
| `content` | `text` | `kanbo_card_comment` |
| `text` | `content` | `kanbo_status_line`, `kanbo_wait_approval` |
| `run` | `runId`, `id` | `kanbo_run_finish` |
| `agent` | `agentName` | `kanbo_run_start` |
| `column` | `to` | `kanbo_card_move` |
| `state` `finished` | `completed`, `succeeded`, `success`, `done` | `kanbo_run_finish` (any case) |
| `state` `failed` | `error`, `errored` | `kanbo_run_finish` |
| `state` `stopped` | `cancelled`, `canceled`, `aborted` | `kanbo_run_finish` |

**An argument that is missing or wrong** comes back as one sentence that names it and ends with a call that works, not as the schema validator's dump:

```text
kanbo_card_comment needs `content` (the comment text). Example: {"card":"TST-5","content":"Added slugify(text) and a test; npm test passes."}
kanbo_run_finish `state` must be one of finished, failed, stopped. Example: {"run":"<the id kanbo_run_start gave back>","state":"finished"}
```

| Tool | Does | Inputs | CLI equivalent |
| --- | --- | --- | --- |
| `kanbo_prime` | Read what this board is: its columns, what each one means, and the rules a card travels by. Run this first. | — | `kanbo prime` |
| `kanbo_ready` | The cards to take next: in To Do, nobody working on them, waiting for no one, in board order — take the first. Compact cards, 10 by default, with `total`; on the first page, up to 5 cards a person sent back come first, under `returned`. | `limit` (integer, default 10), `offset`, `detail`, `fields` — all optional | `kanbo ready` |
| `kanbo_columns` | List the columns in board order, each with its slug, what it means, and its `entryRules`. | — | `kanbo columns list` |
| `kanbo_sprints` | List milestones as sprints by start date — dates in unix seconds, open and done card counts (counted by the database, not by reading the cards) — with `current: true` on the one running now. Read-only. | — | `kanbo sprint list` |
| `kanbo_card_get` | Read one card in full — including its parent (`parentIssueId`) — with its last 10 comments (`comments`, `commentCount`) and its subtasks (`subCards`), in one call. | `card` (required); `include` (array of `comments`, `subCards`, `runs`, `history`, `prs`; `["comments","subCards"]` when absent, `[]` for the card alone); `commentLimit` (integer, default 10) | `kanbo card get <id> [--include <parts>] [--comments <count>]` |
| `kanbo_card_list` | Find cards in one call, in board order; filters combine. Compact cards, 50 by default, with `total` and `nextOffset`. | all optional: `column`, `columns` (array), `waitingForPerson`, `parent`, `hasActiveRun`, `returned`, `text`, `updatedSince` (unix seconds, ISO date-time with `Z` or offset, or `YYYY-MM-DD` = UTC midnight; milliseconds refused), `labels` (array, all of them), `priority` (array), `limit` (default 50), `offset`, `detail` (`compact` \| `full`), `fields` (array) | `kanbo card list [--column <c>] [--waiting] [--parent <id>] [--active] [--returned] [--text <t>] [--updated-since <time>] [--label <l>] [--priority <p>] [--offset <n>]` |
| `kanbo_card_create` | Put a new card on the board; pass `parent` to create a subtask. | `title`, `description`, `column`, `parent`, `executionMode` (`worktree` \| `main`) — all optional | `kanbo card create --description <text> [--title <title>] [--parent <id>]` |
| `kanbo_card_update` | Change a card's title, description, priority, labels or execution mode. | `card` (required); `title`, `description`, `priority` (`none` \| `low` \| `medium` \| `high` \| `urgent`), `labels` (array of strings, replaces), `executionMode` | `kanbo card update <id> [--title <title>] [--description <text>]` |
| `kanbo_card_move` | Move a card to another column. A column with `entryRules` refuses a card that does not meet them, listing what is missing. | `card`, `column` (both required) | `kanbo card move <id> <column>` |
| `kanbo_card_comment` | Write a finding, a decision or an open question on the card. | `card`, `content` (both required; `content` also as `text`) | `kanbo card comment <id> --content <text>` |
| `kanbo_card_link_pr` | Link a pull request to the card. Linking the same one again changes nothing. | `card`, `url` (both required; `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`) | `kanbo card pr add <id> <url>` |
| `kanbo_card_pull_requests` | The pull requests linked to the card, in the order they were linked. | `card` (required) | `kanbo card pr list <id>` |
| `kanbo_status_line` | Say what the card is doing right now. | `card`, `text` (both required; `text` also as `content`) | `kanbo card status-line <id> --text <text>` |
| `kanbo_wait_approval` | Mark the card as waiting for a person and end your turn. | `card` (required), `text` (optional status line; also as `content`) | `kanbo card wait-approval <id> [--text <text>]` |
| `kanbo_run_start` | Record that you have started working on a card. Answers the run with `finishWith`, the exact `kanbo_run_finish` call that ends it. | `card`, `agent` (both required); `branch`, `executionMode`, `session` (`claude:<id>` or `codex:<id>`; when absent, the session Claude Code or Codex names in the server's environment — see below) | `kanbo run start <id> --agent <name> [--session <ref>]` |
| `kanbo_run_finish` | Record how a run you started ended. | `run` (required, the id `kanbo_run_start` gave back), `state` (required: `finished` \| `failed` \| `stopped`; `completed` and the others above are read as one of them), `errorText` | `kanbo run finish <runId> --state <state>` |

The exact JSON Schema of each tool's input is in `kanbo capabilities --json` (`tools[].inputSchema`).

**The session of a run.** `kanbo_run_start` without `session` records the session of the agent the server runs under: Claude Code sets `CLAUDE_CODE_SESSION_ID` in its Bash tool, hooks and stdio MCP servers ([its docs](https://code.claude.com/docs/en/env-vars)); Codex sets `CODEX_THREAD_ID` — its session id — in every shell command. `claude:<id>` or `codex:<id>` is recorded when exactly one of them is set; when both are (one agent started inside the other's shell), nothing says which one runs, and nothing is recorded. Agents are told to leave `session` out rather than invent one.

**Returned cards.** A card is *returned* when a person sent it back and nobody has picked it up again: its latest decision — the last `system.approved` or `system.returned` comment, the one `kanbo approve` / `kanbo return` write — is a return, it is not waiting for a person, and no run is going on on it. Starting a run on it, or handing it back with `kanbo_wait_approval`, takes it out; finishing that run without handing it back puts it back. `kanbo_card_list` with `returned: true` lists them, `kanbo_ready` and `kanbo_prime` name them first, and the status line a return writes reads `returned by a person: <comment>`.

### One question, one call

Every question below is one call. [Agent efficiency](agent-efficiency.md) lists how many each took before.

| Question | Call |
| --- | --- |
| What do I take next? | `kanbo_ready` |
| What is waiting for a person? | `kanbo_card_list` with `waitingForPerson: true` — each card with its last comment |
| Which card was sent back to me? | `kanbo_card_list` with `returned: true` (also first in `kanbo_ready` and `kanbo_prime`) |
| What is being worked on right now? | `kanbo_card_list` with `hasActiveRun: true` |
| What is in progress or in review? | `kanbo_card_list` with `columns: ["in_progress", "in_review"]` |
| What are the subtasks of MAN-012? | `kanbo_card_list` with `parent: "MAN-012"` (or `kanbo_card_get`: `subCards`) |
| Which cards mention "parser"? | `kanbo_card_list` with `text: "parser"` |
| What changed since I last looked? | `kanbo_card_list` with `updatedSince` (the time you last looked) |
| A card with its comments and subtasks | `kanbo_card_get` |
| …and its runs, history and pull requests | `kanbo_card_get` with `include: ["comments","subCards","runs","history","prs"]` |

### What a list answers with

`kanbo_card_list` and `kanbo_ready` answer with one JSON object — `total` (how many cards the question picks), `offset` when it is not 0, `more` and `nextOffset` when there is another page — and `cards`, one card per line:

```json
{"total":1000,"more":950,"nextOffset":50,"cards":[
{"id":"MAN-012","title":"Fix the parser","column":"in_progress","statusLine":"writing the test","attempt":1,"activeRun":{"agentName":"Claude","startedAt":1790000000},"updatedAt":1790000100},
{"id":"MAN-013","title":"Review the docs","column":"in_review","waitingFor":"human","updatedAt":1790000200,"lastComment":{"author":"system","text":"Rewrote the setup section; is the tone right?","createdAt":1790000190}}
]}
```

`kanbo_ready` puts the cards a person sent back ahead of the rest, on its first page:

```json
{"returned":[
{"id":"MAN-009","title":"Add slugify","column":"in_progress","statusLine":"returned by a person: slugify(\"!!!\") must be empty","attempt":1,"updatedAt":1790000300,"returned":true,"lastComment":{"author":"user","text":"slugify(\"!!!\") must be empty","createdAt":1790000300}}
],"total":4,"cards":[…]}
```

A compact card is `id`, `title` (the description's first line when the card has no title of its own), `column` (the slug `kanbo_card_move` takes), `statusLine`, `waitingFor`, `parentId`, `attempt` (runs so far), `activeRun` (`agentName`, `startedAt`) and `updatedAt`; a field that is empty is left out. A card waiting for a person, or returned (`returned: true`), also carries `lastComment`: who wrote it (`user` for a person's approval or return; a comment written through `kanbo` from a terminal or `kanbo mcp` reads `system`), its first 200 characters, and when — the run's own bookkeeping comments (`Run started …`) do not count. `detail: "full"` prints every field of each card, description, labels and the run's id included — the shape `kanbo_card_get` prints; `fields: ["description", "labels"]` prints `id` and only those.

## What is deliberately missing

- **No tool approves or returns a card, or closes a sprint.** `kanbo_wait_approval` hands the card to a person; only a person takes it back, with `kanbo approve` / `kanbo return` in their own terminal or on the board page.
- **No tool deletes a card.** Cancelling one is a move to the Canceled column.
- **No tool sets who wrote something.** The author is decided by the transport, never by an argument.

## Using the tools from your own MCP server

The package also exports the tools for embedding in another MCP server:

- `kanbo/mcp` exports `buildKanboTools`, `createKanboMcpServer`, `registerKanboTools`, `createHttpTransport`, `KANBO_MCP_INSTRUCTIONS` and the `KanboToolTransport` interface. `createHttpTransport` runs the tools against a server of the `/issues` routes (see [HTTP API](http-api.md)).
- `registerKanboTools(server, transport, { includeRunTools })` adds the tools to an existing server; pass `includeRunTools: false` when your app records runs for the agents it launches itself.
