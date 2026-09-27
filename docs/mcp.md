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

| Tool | Does | Inputs | CLI equivalent |
| --- | --- | --- | --- |
| `kanbo_prime` | Read what this board is: its columns, what each one means, and the rules a card travels by. Run this first. | — | `kanbo prime` |
| `kanbo_ready` | List the cards that are spelled out, that nobody is working on and that are waiting for no one, in board order. | `limit` (integer, optional) | `kanbo ready` |
| `kanbo_columns` | List the columns in board order, each with its slug, what it means, and its `entryRules`. | — | `kanbo columns list` |
| `kanbo_sprints` | List milestones as sprints by start date — dates in unix seconds, open and done card counts — with `current: true` on the one running now. Read-only. | — | `kanbo sprint list` |
| `kanbo_card_get` | Read one card in full, including its parent (`parentIssueId`) and subtasks (`subCards`). | `card` (required) | `kanbo card get <id>` |
| `kanbo_card_list` | List the cards in board order. | `column` (optional), `limit` (integer, optional) | `kanbo card list` |
| `kanbo_card_create` | Put a new card on the board; pass `parent` to create a subtask. | `title`, `description`, `column`, `parent`, `executionMode` (`worktree` \| `main`) — all optional | `kanbo card create --description <text> [--title <title>] [--parent <id>]` |
| `kanbo_card_update` | Change a card's title, description, priority, labels or execution mode. | `card` (required); `title`, `description`, `priority` (`none` \| `low` \| `medium` \| `high` \| `urgent`), `labels` (array of strings, replaces), `executionMode` | `kanbo card update <id> [--title <title>] [--description <text>]` |
| `kanbo_card_move` | Move a card to another column. A column with `entryRules` refuses a card that does not meet them, listing what is missing. | `card`, `column` (both required) | `kanbo card move <id> <column>` |
| `kanbo_card_comment` | Write a finding, a decision or an open question on the card. | `card`, `content` (both required) | `kanbo card comment <id> --content <text>` |
| `kanbo_card_link_pr` | Link a pull request to the card. Linking the same one again changes nothing. | `card`, `url` (both required; `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`) | `kanbo card pr add <id> <url>` |
| `kanbo_card_pull_requests` | The pull requests linked to the card, in the order they were linked. | `card` (required) | `kanbo card pr list <id>` |
| `kanbo_status_line` | Say what the card is doing right now. | `card`, `text` (both required) | `kanbo card status-line <id> --text <text>` |
| `kanbo_wait_approval` | Mark the card as waiting for a person and end your turn. | `card` (required), `text` (optional status line) | `kanbo card wait-approval <id> [--text <text>]` |
| `kanbo_run_start` | Record that you have started working on a card. | `card`, `agent` (both required); `branch`, `executionMode`, `session` (`claude:<id>` or `codex:<id>`) | `kanbo run start <id> --agent <name> [--session <ref>]` |
| `kanbo_run_finish` | Record how a run you started ended. | `run` (required, the id `kanbo_run_start` gave back), `state` (required: `finished` \| `failed` \| `stopped`), `errorText` | `kanbo run finish <runId> --state <state>` |

The exact JSON Schema of each tool's input is in `kanbo capabilities --json` (`tools[].inputSchema`).

## What is deliberately missing

- **No tool approves or returns a card, or closes a sprint.** `kanbo_wait_approval` hands the card to a person; only a person takes it back, with `kanbo approve` / `kanbo return` in their own terminal or on the board page.
- **No tool deletes a card.** Cancelling one is a move to the Canceled column.
- **No tool sets who wrote something.** The author is decided by the transport, never by an argument.

## Using the tools from your own MCP server

The package also exports the tools for embedding in another MCP server:

- `kanbo/mcp` exports `buildKanboTools`, `createKanboMcpServer`, `registerKanboTools`, `createHttpTransport`, `KANBO_MCP_INSTRUCTIONS` and the `KanboToolTransport` interface. `createHttpTransport` runs the tools against a server of the `/issues` routes (see [HTTP API](http-api.md)).
- `registerKanboTools(server, transport, { includeRunTools })` adds the tools to an existing server; pass `includeRunTools: false` when your app records runs for the agents it launches itself.
