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
