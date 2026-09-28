import { z } from 'zod'

import { readRunFinishState, RUN_FINISH_STATES } from '../../ops/runs'
import { defineKanboTool } from './tool'

/** How a run ended. An app that launches agents ends the runs it started; this is for the ones nobody launched. */
export const runFinishTool = defineKanboTool({
  name: 'kanbo_run_finish',
  title: 'Finish a run',
  description: 'Record how a run you started ended, so the card stops saying someone is working on it: '
    + '`run` (the id kanbo_run_start gave back) and `state`: finished, failed or stopped.',
  inputSchema: {
    run: z.string().min(1).describe('The run, by the id kanbo_run_start gave back. Also accepted as `runId` or `id`.'),
    state: z.enum(RUN_FINISH_STATES).describe('How it ended. completed, succeeded, success and done are read as finished; error and errored as failed; cancelled, canceled and aborted as stopped.'),
    errorText: z.string().min(1).optional().describe('What went wrong, for a run that failed.'),
  },
  aliases: { run: ['runId', 'id'] },
  needs: { run: 'the run id kanbo_run_start gave back', state: 'finished, failed or stopped' },
  example: { run: '<the id kanbo_run_start gave back>', state: 'finished' },
  prepare: input => typeof input.state === 'string'
    ? { ...input, state: readRunFinishState(input.state) ?? input.state }
    : input,
  run: async (transport, input) => await transport.runFinish(input),
})
