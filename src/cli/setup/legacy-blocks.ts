/**
 * The bodies of every instruction block kanbo 0.1.x–0.2.x wrote, word for word
 * and with `\n` line endings — rendered from the published tags (v0.1.0 …
 * v0.2.1), not rebuilt from today’s rules, which have changed since.
 *
 * Those versions marked a block with a bare `<!-- KANBO_START -->` and no hash,
 * so the only way to tell a block kanbo wrote from one a person changed is to
 * find its body here: a match is kanbo’s own (`legacy`) and is replaced
 * freely; anything else between bare markers is the person’s (`edited`).
 */
export const LEGACY_BLOCK_BODIES: readonly string[] = [
  // v0.1.0:project, v0.1.1:project
  [
    '## Kanbo board',
    '',
    'Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` — it prints the board\'s columns and what each one means.',
    '',
    '- Take a card from `kanbo ready`.',
    '- Move the card yourself (`kanbo card move <id> <column>`) — a card in the wrong column is a lie.',
    '- Write a status line at every step (`kanbo card status-line <id> --text "..."`).',
    '- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card\'s id), not separate top-level cards. (`kanbo card create --description "..." --parent <id>`).',
    '- Findings, decisions and questions go on the card (`kanbo card comment <id> --content "..."`).',
    '- When you need a person, run `kanbo card wait-approval <id>` and end your turn. Never approve your own work, and never take a card out of a column where it is waiting for a person.',
    '- Started the work yourself, not launched by an app that tracks the run? Pass your own session to `kanbo run start --session` — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints).',
    '- Run `kanbo capabilities` for the full list of tools, commands and rules.',
  ].join('\n'),
  // v0.1.2:project, v0.1.3:project, v0.2.0:project, v0.2.1:project
  [
    '## Kanbo board',
    '',
    'Work on this project is tracked on a kanbo board. Before starting a task run `kanbo prime` — it prints the board\'s columns and what each one means.',
    '',
    '- Take a card from `kanbo ready`.',
    '- You move the card between columns yourself, at the moment its real state changes. The board never moves a card for you. (`kanbo card move <id> <column>`)',
    '- Write a status line at every step, including before and after anything long-running. One sentence, present tense, about what is happening right now. (`kanbo card status-line <id> --text "..."`)',
    '- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card\'s id), not separate top-level cards. (`kanbo card create --description "..." --parent <id>`)',
    '- Findings, results, decisions and questions go on the card as comments. (`kanbo card comment <id> --content "..."`)',
    '- When you need a person, mark the card as waiting for approval and end your turn. You will be told when the answer comes. (`kanbo card wait-approval <id>`)',
    '- Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.',
    '- Started the work yourself, not launched by an app that tracks the run for you? Say so when you start the run — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints) — so your own log of it can be found later. (`kanbo run start <id> --agent <name> --session <ref>`)',
    '- Run `kanbo capabilities` for the full list of tools, commands and rules.',
  ].join('\n'),
  // v0.1.3:global, v0.2.0:global, v0.2.1:global
  [
    '## Kanbo boards',
    '',
    'A project with a `.kanbo/` directory tracks its work on a kanbo board. In such a project, before starting a task run `kanbo prime` (or call the `kanbo_prime` tool) — it prints the board\'s columns and what each one means. A project without `.kanbo/` has no board: ignore this section there, and do not create one — a person sets a board up with `kanbo init`.',
    '',
    '- Take a card from `kanbo ready`.',
    '- You move the card between columns yourself, at the moment its real state changes. The board never moves a card for you. (`kanbo card move <id> <column>`)',
    '- Write a status line at every step, including before and after anything long-running. One sentence, present tense, about what is happening right now. (`kanbo card status-line <id> --text "..."`)',
    '- Create subtasks only when the person asks for them, or when a task has parts that can be done and checked separately (different stages, owners or pull requests); do not split small work you will finish in one go. When you do split a card, make the parts subtasks of it (the parent card\'s id), not separate top-level cards. (`kanbo card create --description "..." --parent <id>`)',
    '- Findings, results, decisions and questions go on the card as comments. (`kanbo card comment <id> --content "..."`)',
    '- When you need a person, mark the card as waiting for approval and end your turn. You will be told when the answer comes. (`kanbo card wait-approval <id>`)',
    '- Only a person approves a card, and only a person takes one out of waiting. Never do either yourself.',
    '- Started the work yourself, not launched by an app that tracks the run for you? Say so when you start the run — `claude:<session id>` from Claude Code, `codex:<session id>` from Codex (the session id Codex prints) — so your own log of it can be found later. (`kanbo run start <id> --agent <name> --session <ref>`)',
    '- Run `kanbo capabilities` for the full list of tools, commands and rules.',
  ].join('\n'),
]
