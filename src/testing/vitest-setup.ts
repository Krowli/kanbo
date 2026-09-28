import { AGENT_SHELL_MARKERS } from '../cli/agent-shell'

/**
 * The tests run as a person's shell, whatever shell started them. An agent
 * tool that runs `npm test` leaves its mark in the environment (`CLAUDECODE=1`
 * and the like), and every test of a person-only command would then be
 * refused. A test about an agent's shell sets the mark itself.
 */
for (const marker of AGENT_SHELL_MARKERS) {
  delete process.env[marker.variable]
}

/**
 * No test asks npm about a newer kanbo: a command run in-process, or a built
 * `kanbo` a test starts (which inherits this), would otherwise reach the
 * network. The update check's own tests hand it a fake `fetch` and environment.
 */
process.env.KANBO_NO_UPDATE_CHECK = '1'

/**
 * Nor as an agent's session: `kanbo run start` without `--session` records the
 * session these name, and a test that expects none would find the session of
 * whatever agent ran `npm test`.
 */
delete process.env.CLAUDE_CODE_SESSION_ID
delete process.env.CODEX_THREAD_ID
