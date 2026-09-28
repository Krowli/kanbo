# Getting started

This walks through setting up kanbo in a project, step by step, as the wizard itself asks it. It assumes nothing: by the end you will have a board, at least one agent connected to it, and have approved your first card.

If you would rather skip the walkthrough, the [README](../README.md) quick start is three lines. This page is for seeing what each of those lines actually does.

## 1. Install it

```bash
npm install -g kanbo-cli
```

This installs the `kanbo` command globally, with `better-sqlite3` (the driver board files use) alongside it. See [installation](installation.md) for npx, per-project installs, and platform notes (Windows, Alpine, arm64).

## 2. Run it in a project

```bash
cd your-project
kanbo
```

A folder with no board starts the setup wizard — the same thing as running `kanbo init`. In a terminal, it asks one question at a time. Nothing is written until the last question.

**Where should the board live?**

```
◆  Where should the board live?
│  ● In this project (file .kanbo/board.db — nothing to run or host)
│  ○ In a shared Postgres database (for a team; Supabase works)
```

Pick the first one to start: a SQLite file at `.kanbo/board.db`, committed to nothing, shared with nobody. For a team, pick Postgres — it then asks for the connection string, a workspace id, and whether to create the board's tables now; see [storage](storage.md) for that path in full.

**Card numbers start with**

```
◆  Card numbers start with
│  WST
→ cards will be WST-001, WST-002, …
```

kanbo suggests a prefix from your folder's name (a project named `weather-station` suggests `WST`). Accept it or type your own.

**Which columns should the board start with?**

```
◆  Which columns should the board start with?
│  ● Standard: Backlog → To Do → In Progress → In Review → Done · Canceled
│  ○ Simple: To Do → In Progress → Done
│  ○ Review + QA: … In Review → QA → Done
│  ○ Custom: pick from a list and add your own
```

Standard is a reasonable default. To Do is always there, whatever you pick — agents take work from it.

**Which coding agents do you use here?**

```
◆  Which coding agents do you use here?
│  ◼ Claude Code (found ~/.claude)
│  ◻ Codex
│  ◻ Cursor
│  ◻ Gemini CLI
```

kanbo ticks the ones it found already installed on your machine or in the project. Toggle with Space.

**Connect them now?**

```
◆  Connect them now?
│  ● Yes — show exactly which files change, then ask
│  ○ Not now — set up the board only; no other file is touched (later: kanbo connect)
│  ○ I'll paste the instructions myself (prints them; nothing is written)
```

Say Yes and it shows exactly which files change, and why, before touching any of them:

```
◆  These files change so your agents know the board. Keep all of them?
│  ◼ CLAUDE.md (the kanbo section: Claude Code reads it in this project and runs kanbo prime before a task)
│  ◼ .mcp.json (lets Claude Code call the board's tools in this project)
```

The section it writes into `CLAUDE.md` (or `AGENTS.md` for Codex and Cursor) is short — a pointer, not the whole rulebook:

```markdown
<!-- KANBO_START v2 h=4842e336 -->
## Kanbo board

This project tracks its work on a kanbo board. Before starting a task, run `kanbo prime` (or call the `kanbo_prime` tool) and follow what it prints.
Take work with `kanbo ready`. Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.
<!-- KANBO_END -->
```

**Add a first card?**

```
◆  Add a first card? (optional — Enter to skip)
│  e.g. Add a README
```

Optional — type a title and press Enter, or skip it and add one later from the home screen.

**Write these changes?**

The wizard prints everything it is about to do, then asks once:

```
kanbo init will:
  create  .kanbo/board.db (a board file of this project's own, with the columns Backlog, To Do, In Progress, In Review, Done, Canceled)
  write   .kanbo/binding.json (binds this project to WST)
  write   CLAUDE.md (the kanbo section: Claude Code reads it in this project and runs kanbo prime before a task)
  write   .mcp.json (lets Claude Code call the board's tools in this project)
  add     a first card to To Do: Write the README
Nothing else is changed.

◆  Write these changes?
│  ● Yes / ○ No
```

Yes, and it is done:

```
✔ Board: .kanbo/board.db
✔ Columns: Backlog, To Do, In Progress, In Review, Done, Canceled
✔ Card numbers: WST-001, WST-002, …
✔ Claude Code: CLAUDE.md (written)
✔ Claude Code: .mcp.json (written)
✔ First card: WST-001 Write the README

Next: start Claude Code in this folder and say "take the next card from kanbo".
See the board: kanbo board · in your browser: kanbo serve
Run kanbo any time to come back here.
```

Ctrl-C at any question cancels with nothing written; No at the last question does the same.

## 3. The home screen

Run `kanbo` again (in the project, with a board already set up) and you get the home screen instead of the wizard: what is on the board, what needs you, and a menu — every item names the plain command behind it, so you can learn the CLI by watching what you pick:

```
kanbo · weather-station (WST) · .kanbo/board.db
Backlog 0 · To Do 0 · In Progress 0 · In Review 0 · Done 0
Agents: Claude Code — not connected

◆  What next?
│  ● Show the board here — kanbo board
│  ○ Open the board in your browser — kanbo serve
│  ○ Add a card — kanbo card create
│  ○ Connect an agent — kanbo connect
│  ○ Get the agent instructions — kanbo instructions
│  ○ Change columns — kanbo columns
│  ○ Check the setup — kanbo doctor
│  ○ Exit
```

Picking a card in a column moves it; Exit or Ctrl-C at the menu leaves.

## 4. Add a card

From the home screen, **Add a card**:

```
◆  What is the card about? (Enter on an empty line to go back)
│  Write the README
WST-001  To Do  worktree
Write the README

Write the README
```

The same as `kanbo card create --title "Write the README"`. It lands in the first column — To Do on a Standard board.

## 5. Connecting an agent

If you skipped this in the wizard, run it from the project root:

```bash
kanbo connect claude --yes
```

This is the same two things the wizard's Yes did: the short section in `CLAUDE.md`, and the MCP server registered in `.mcp.json` (so Claude Code can call the board as typed tools, with no shell command needed for the basics). `kanbo connect codex cursor gemini` does the same for the others, and `kanbo connect all --global` sets every agent up for every project on your machine instead of just this one — see [step 8](#8-set-it-up-for-all-projects-instead) below, and [agents](agents.md) for what each client's connection looks like.

Every change is shown before it is written, same as the wizard. Run `kanbo connect --check` any time to see what is connected.

## 6. What the agent does

Tell your agent: **"take the next card from kanbo."** With the MCP server connected, it already knows the rules — `kanbo mcp` hands them to the client as its server instructions the moment it connects, before any tool is called. Either way (MCP tools, or the `kanbo` command in its shell) it does roughly this:

1. Runs `kanbo prime` (or calls `kanbo_prime`) — the board's columns, what each one means, and the rules a card travels by.
2. Runs `kanbo ready` (`kanbo_ready`) — the cards in To Do that nobody is working on and nobody is waiting on. Takes the first one.
3. Records that it started (`kanbo run start <card> --agent <name>`), then moves the card to the column this board uses for work in progress.
4. Works the card: writes a status line at every step, puts findings and decisions in comments, splits into subtasks only when the card calls for it, links any pull request it opens.
5. When it needs you, moves the card to review and runs `kanbo card wait-approval <card> --text "…"` — then stops. It cannot approve or return the card itself: kanbo refuses that in an agent's shell, exit code `4`, whatever it tries.

See [orchestrator examples](orchestrator.md) for a worked, command-by-command session, and multi-agent setups (a Claude Code orchestrator with sub-agents, a Codex profile, a plain shell loop).

## 7. Approving

Cards waiting for you show up at the top of the home screen:

```
kanbo · weather-station (WST) · .kanbo/board.db
Backlog 0 · To Do 0 · In Progress 0 · In Review 2 · Done 0
2 cards waiting for you

◆  What next?
│  ● Review the cards waiting for you (2) — kanbo approve · kanbo return
```

Picking it walks you through them one at a time — key, title, column, status line, last comment — with **Approve**, **Send back with a comment**, **Skip** or **Stop reviewing**:

```
WST-001  In Review
Fix the login form
Status: login fixed, please check

◆  What about WST-001?
│  ● Approve
│  ○ Send back with a comment
│  ○ Skip
│  ○ Stop reviewing
```

The same as running `kanbo approve WST-001` yourself, or `kanbo return WST-001 --comment "…"` to send it back with a reason the agent reads first. Only a person can do either — an agent's shell gets refused, and on a shared Postgres board the database itself enforces it (see [agents](agents.md#agents-and-people)).

## 8. The board page

```bash
kanbo serve
```

Opens the board in your browser at `http://127.0.0.1:4318` — columns, cards, status lines, a **Waiting for you** badge, and **Approve** / **Return** buttons on any card that needs you. It is loopback-only and token-guarded by default; see [HTTP API](http-api.md) for the security model and routes if you want to build on it.

## Two shortcuts

### Just install, touch nothing

Want a board without wiring up any agent yet? Answer **Not now** at the "Connect them now?" question and kanbo writes the board and nothing else:

```
kanbo init will:
  create  .kanbo/board.db (a board file of this project's own, with the columns To Do, In Progress, Done)
  write   .kanbo/binding.json (binds this project to MET)
Nothing else is changed.
```

Outside a terminal — a script, CI, or if you just run `kanbo init --yes` — kanbo takes this same path automatically: a board file with the Standard columns, and no agent file touched unless `--connect`, `--instructions` or `--mcp` says so. Either way: no `CLAUDE.md`, no `AGENTS.md`, no MCP registration, until you ask for one. Connect an agent later with `kanbo connect <agent>`, or hand it the text yourself with `kanbo instructions --copy`.

### Set it up for all projects

Rather than repeating step 5 in every project, do it once for every agent you run, everywhere:

```bash
kanbo connect all --global
```

This writes to your own files — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.cursor/mcp.json`, and so on — and binds no project and creates no board. The block it writes tells an agent to use kanbo in a project that has a `.kanbo/` folder, and to leave one without alone. A project still gets its own board with a plain `kanbo init` in it; the global setup just means you never register the MCP server or paste instructions again. See [agents](agents.md#1-globally-for-all-your-agents).

## Where to next

- [Using kanbo with agents](agents.md) — every client's exact files, Windows notes, the agent-vs-person rules
- [Orchestrator examples](orchestrator.md) — a full worked session, subagents, a shell loop
- [CLI reference](cli.md) · [MCP reference](mcp.md) — every command and tool
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
