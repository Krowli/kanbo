import { defineKanboTool } from './tool'

/** The board's sprints, the current one marked. Read-only: closing a sprint is a person's (ruling 5x-4). */
export const sprintsTool = defineKanboTool({
  name: 'kanbo_sprints',
  title: 'Sprints of the board',
  description: 'List this board\'s milestones as sprints by start date — dates in unix seconds, open and done card counts — '
    + 'with current: true on the open one running now. Read-only: closing a sprint is a person\'s decision.',
  inputSchema: {},
  run: async transport => await transport.sprints(),
})
