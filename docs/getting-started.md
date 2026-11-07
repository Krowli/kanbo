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

A folder with no board starts the setup wizard — the same thing as running `kanbo init`. In a terminal, it asks one question at a time: where the board lives, the card key, the columns, and which agents to connect. Nothing is written until the last question is answered; Ctrl-C at any question writes nothing.

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
│  ● Yes — register kanbo's MCP server for them, for every project
│  ○ Not now — set up the board only (later: kanbo connect)
```

These two questions are asked only when an agent kanbo found has no kanbo registration yet; if every agent it found already has one, it says "Your agents already reach kanbo through its MCP server." and asks nothing.

Say Yes and kanbo registers the MCP server in your own agent settings, so one registration serves every project; it writes nothing into the project's `CLAUDE.md` or `AGENTS.md`, because the server tells the agent the rules itself. There is no further question: the wizard writes, then prints what it did.

Done:

```
✔ Board: .kanbo/board.db
✔ Columns: Backlog, To Do, In Progress, In Review, Done, Canceled
✔ Card numbers: WST-001, WST-002, …
✔ Claude Code: ~/.claude.json (ran claude mcp add --scope user kanbo -- kanbo mcp)

Next: start Claude Code in this folder and say "take the next card from kanbo".
See the board: kanbo board · in your browser: kanbo serve
Run kanbo any time to come back here.
```

Ctrl-C at any question cancels with nothing written. To start the board with a card, run `kanbo init --first-card "Write the README"`, or add one later from the home screen.

## 3. The home screen

Run `kanbo` again (in the project, with a board already set up) and you get the home screen instead of the wizard: what is on the board, what needs you, and a menu — every item names the plain command behind it, so you can learn the CLI by watching what you pick:

```
kanbo · weather-station (WST) · .kanbo/board.db
Backlog 0 · To Do 0 · In Progress 0 · In Review 0 · Done 0
Agents: Claude Code — not connected

◆  What next?
│  ● Show the board here — kanbo board
│  ○ Open the board in your browser — kanbo serve
│  ○ Add a card
│  ○ Connect an agent — kanbo connect
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
Added WST-001 Write the README to To Do
```

The card lands in To Do. (An agent's own `kanbo_card_create` defaults to the board's first column instead — Backlog on a Standard board — so its own follow-up cards are not handed straight to the next `kanbo_ready`.)

## 5. Connecting an agent

If you skipped this in the wizard (or picked Not now), run it once from anywhere:

```bash
kanbo connect claude --yes
```

This registers kanbo's MCP server in Claude Code's own settings (`claude mcp add --scope user kanbo -- kanbo mcp`), so Claude Code can call the board as typed tools in every project. `kanbo connect codex cursor` (any of `claude`, `codex`, `cursor`, `gemini`) does the same for the others, and several at once; it registers them for every project; `--project` registers them for this project only, in the project's files instead of your own settings — see [agents](agents.md) for what each client's connection looks like. If an older kanbo wrote a section into your `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, `kanbo connect` takes it out.

`kanbo connect` shows every change before it is written. Run `kanbo connect --check` any time to see what is connected.

## 6. What the agent does

Tell your agent: **"take the next card from kanbo."** `kanbo mcp` hands the rules to the client as its server instructions the moment it connects, before any tool is called. Then the agent does roughly this:

1. Calls `kanbo_prime` — the board's columns, what each one means, and the rules a card travels by.
2. Takes the next card with `kanbo_card_claim` — the first card in To Do that nobody is working on and nobody is waiting on. One step starts its run and moves it to the column this board uses for work in progress. `kanbo_ready` only lists what is ready.
3. Works the card: writes a status line at every step, puts findings and decisions in comments, splits into subtasks only when the card calls for it, links any pull request it opens.
4. When it needs you, moves the card to review and calls `kanbo_wait_approval` — then finishes its run (`kanbo_run_finish`) and stops. It cannot approve or return the card itself: kanbo has no tool for that, and refuses it in an agent's shell with exit code `4`, whatever it tries.

See [orchestrator examples](orchestrator.md) for a worked session, and multi-agent setups (a Claude Code orchestrator with sub-agents, a Codex profile).

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

Opens the board in your browser at `http://127.0.0.1:4318` — columns, cards (a parent card holds its sub-tasks as rows), status lines, a **Waiting for you** pill, a List view, filters, keys (`j`/`k`, Enter, `/`, `x`) and a bar for changing several cards at once, and **Approve** / **Return** buttons on any card that needs you. It is loopback-only and token-guarded by default; see [HTTP API](http-api.md) for the security model and routes if you want to build on it.

## Two shortcuts

### Just install, touch nothing

Want a board without wiring up any agent yet? Answer **Not now** at the "Connect them now?" question and kanbo writes the board and nothing else:

```
kanbo init will:
  create  .kanbo/board.db (a board file of this project's own, with the columns To Do, In Progress, Done)
  write   .kanbo/binding.json (binds this project to MET)
Nothing else is changed.
```

Outside a terminal — a script, CI, or if you just run `kanbo init --yes` — kanbo takes this same path automatically: a board file with the Standard columns, and no agent settings touched unless `--connect` says so (with `--yes`). Either way: no `CLAUDE.md`, no `AGENTS.md`, no MCP registration, until you ask for one. Connect an agent later with `kanbo connect <agent>`.

### Connect once for all projects

The registration `kanbo connect` makes is already for every project, so do it once per agent, wherever you are:

```bash
kanbo connect all --yes
```

It binds no project and creates no board. A project gets its own board with a plain `kanbo init` in it; in a folder without one, the server still starts and every tool says there is no board here. See [agents](agents.md#connecting-agents-kanbo-connect).

## Where to next

- [Using kanbo with agents](agents.md) — every client's exact settings, Windows notes, the agent-vs-person rules
- [Orchestrator examples](orchestrator.md) — a full worked session, subagents
- [CLI reference](cli.md) · [MCP reference](mcp.md) — every command and tool
- [Troubleshooting](troubleshooting.md) · [FAQ](faq.md)
