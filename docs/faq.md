# FAQ

**Is kanbo a project-management tool for teams?**
It is a board for work that agents do and people approve. It has cards, columns, subtasks, comments, sprints and pull request links, but no users, permissions screens or notifications. People are whoever runs `kanbo` in their own shell; agents are shells with `KANBO_ACTOR_KIND=agent`.

**Do I need a server?**
No. Every command opens the board directly: a SQLite file in the project, or a Postgres database. `kanbo serve` is optional, for the board page and the HTTP API.

**Where is my data?**
In `.kanbo/board.db` in the project (after `kanbo init --file`), or in the Postgres database you bound the project to. kanbo sends nothing anywhere else.

**Should I commit `.kanbo/board.db`?**
kanbo keeps it out of git by default (`.kanbo/.gitignore`). A SQLite file does not merge; for a board several people share, use Postgres.

**Can an agent approve its own work?**
Not through kanbo: there is no MCP tool for it, and the CLI refuses in a shell with `KANBO_ACTOR_KIND=agent` (exit `4`). On Postgres with the `kanban_agent` role, the database refuses too. On a board file, an agent that writes to the SQLite file with other tools is not stopped — that is what the Postgres roles are for.

**Which agents work with kanbo?**
Anything that can run a shell command or talk MCP over stdio: Claude Code, Codex, Cursor, and your own scripts. See [agents](agents.md).

**MCP or CLI?**
Either; they call the same operations. MCP gives the agent typed tools and is always treated as an agent. The CLI works for agents without MCP and for you.

**Does kanbo launch agents?**
No. You or your orchestrator start agents; kanbo records their runs (`kanbo run start` / `finish`) so the board shows who is working on what.

**Does kanbo talk to GitHub?**
No. `kanbo card pr add` records a link. The rule `ci_green` and the pull request standing on the board read facts written onto the card (as comments with dedupe keys) by whatever watches your pull requests; kanbo itself does not poll GitHub.

**How do sprints work?**
A milestone with a start and a due date is a sprint (`kanbo sprint create`). `kanbo sprint list` marks the current one. Closing it (`kanbo sprint close`, person only) moves unfinished cards to another milestone or out of the sprint.

**Can I rename or add columns?**
Yes: `kanbo columns` (a small menu at a terminal), or `kanbo columns add|rename|move|remove|template`; or through the HTTP API (`POST /issues/statuses`, `PATCH /issues/statuses/:id`); `kanbo columns describe` sets what a column means and `kanbo columns rules` what a card needs to enter it. Agents read the descriptions via `kanbo prime`, so describe your columns.

**Can one database hold several projects?**
Yes. Cards, columns and milestones belong to a workspace id; each project's binding names its own.

**Is there a hosted version?**
No.
