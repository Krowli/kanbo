import { defineKanboTool } from './tool'

/** The columns of the board, with the slug a card is moved by. */
export const columnsTool = defineKanboTool({
  name: 'kanbo_columns',
  title: 'Columns of the board',
  description: 'List this board\'s columns in board order, each with the slug kanbo_card_move takes, what the column means here, '
    + 'and the entryRules a card must meet before you move it in.',
  inputSchema: {},
  run: async transport => await transport.columns(),
})
