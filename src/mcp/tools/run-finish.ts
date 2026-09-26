import { z } from 'zod'

import { defineKanboTool } from './tool'

/** How a run ended. An app that launches agents ends the runs it started; this is for the ones nobody launched. */
export const runFinishTool = defineKanboTool({
  name: 'kanbo_run_finish',
  title: 'Finish a run',
  description: 'Record how a run you started ended, so the card stops saying someone is working on it.',
  inputSchema: {
    run: z.string().min(1).describe('The run, by the id kanbo_run_start gave back.'),
    state: z.enum(['finished', 'failed', 'stopped']).describe('How it ended.'),
    errorText: z.string().min(1).optional().describe('What went wrong, for a run that failed.'),
  },
  run: async (transport, input) => await transport.runFinish(input),
})
