/**
 * How a shell says it belongs to an agent — kept apart from `actor.ts`, which
 * reads the operating system's user, so the test setup can clear these marks
 * without loading it.
 */

/** How `KANBO_ACTOR_KIND` says a shell is an agent's, as the refusals spell it. */
export const AGENT_KIND_MARKER = 'KANBO_ACTOR_KIND=agent'

/**
 * What agent tools put in the environment of the commands their agent runs,
 * and only those that the tool's own documentation promises — a variable seen
 * in one version and never documented can vanish in the next, or turn up in a
 * person's shell. Checked 2026-09-27:
 *
 * - Claude Code: `CLAUDECODE=1` in the subprocesses it spawns (Bash and
 *   PowerShell tools, hooks, stdio MCP servers). Its IDE extensions set it in
 *   their integrated terminals too — a person there says
 *   `KANBO_ACTOR_KIND=person`. https://code.claude.com/docs/en/env-vars
 * - Gemini CLI: `GEMINI_CLI=1` in the environment of `run_shell_command`.
 *   https://geminicli.com/docs/tools/shell/
 * - Cursor: `CURSOR_AGENT`, set (value not documented) in the Agent's
 *   terminal. https://cursor.com/docs/agent/tools/terminal
 *
 * Not handled: Codex documents no variable of its own in the commands it runs
 * (https://learn.chatgpt.com/docs/config-file/environment-variables, config-advanced);
 * set `KANBO_ACTOR_KIND=agent` for it.
 */
export const AGENT_SHELL_MARKERS: readonly { variable: string, matches: (value: string) => boolean, label: string }[] = [
  { variable: 'CLAUDECODE', matches: value => value === '1', label: 'CLAUDECODE=1' },
  { variable: 'GEMINI_CLI', matches: value => value === '1', label: 'GEMINI_CLI=1' },
  { variable: 'CURSOR_AGENT', matches: value => value !== '', label: 'CURSOR_AGENT' },
]

/**
 * Why this shell is an agent's — `KANBO_ACTOR_KIND=agent` or the mark an
 * agent tool left — or `null` for a person's.
 *
 * `KANBO_ACTOR_KIND` decides first, either way: `agent` from an app that
 * starts agents or a person who runs one, `person` from a person whose own
 * terminal carries an agent tool's mark (an IDE's integrated terminal).
 */
export function readAgentShellMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  const kind = env.KANBO_ACTOR_KIND?.trim()
  if (kind === 'agent') {
    return AGENT_KIND_MARKER
  }
  if (kind === 'person') {
    return null
  }
  const marker = AGENT_SHELL_MARKERS.find(candidate => candidate.matches(env[candidate.variable]?.trim() ?? ''))
  return marker?.label ?? null
}
