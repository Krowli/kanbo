# Project notes

<!-- KANBO_START -->
## Kanbo board

Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` — it prints the board's columns and what each one means.

- Take a card from `kanbo ready`.
- You move the card between columns yourself, at the moment its real state changes. The board never moves a card for you. (`kanbo card move <id> <column>`)
- Write a status line at every step, including before and after anything long-running. One sentence, present tense, about what is happening right now. (`kanbo card status-line <id> --text "..."`)
- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card's id), not separate top-level cards. (`kanbo card create --description "..." --parent <id>`)
- Findings, results, decisions and questions go on the card as comments. (`kanbo card comment <id> --content "..."`)
- When you need a person, mark the card as waiting for approval and end your turn. You will be told when the answer comes. (`kanbo card wait-approval <id>`)
- Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.
- Started the work yourself, not launched by an app that tracks the run for you? Say so when you start the run — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints) — so your own log of it can be found later. (`kanbo run start <id> --agent <name> --session <ref>`)
- Run `kanbo capabilities` for the full list of tools, commands and rules.
<!-- KANBO_END -->
