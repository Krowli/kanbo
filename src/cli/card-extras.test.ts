import { describe, expect, it } from 'vitest'

import { projectKanboCardComment } from '../mcp/transport'
import { describeCardExtras } from './card-extras'

function row(authorKind: string, authorId: string | null, content: string, createdAt: number) {
  return { id: content, authorKind, authorId, sourceChatSessionId: null, content, createdAt }
}

describe('the comments of a card, as an agent reads them', () => {
  it('names who wrote each line and marks a person', () => {
    const comments = [
      row('system.run', null, 'Run started: claude · attempt 1 · main', 1_793_773_260),
      row('system', 'claude', 'Done in the project folder', 1_793_773_320),
      row('system.approved', 'krowli', 'Approved', 1_793_773_330),
      row('user', 'krowli', 'Third: from the person\'s page.', 1_793_800_000),
    ].map(projectKanboCardComment)

    expect(comments.map(comment => [comment.author, comment.by])).toEqual([
      ['system', 'kanbo'],
      ['system', 'claude'],
      ['user', 'krowli'],
      ['user', 'krowli'],
    ])
    expect(describeCardExtras({ comments, commentCount: 4 }).split('\n').slice(1)).toEqual([
      '2026-11-04 06:21  kanbo: Run started: claude · attempt 1 · main',
      '2026-11-04 06:22  claude: Done in the project folder',
      '2026-11-04 06:22  krowli (person): Approved',
      '2026-11-04 13:46  krowli (person): Third: from the person\'s page.',
    ])
  })

  it('falls back to the kind when a person\'s row has no id, and to kanbo for the board\'s own kinds', () => {
    expect(projectKanboCardComment(row('user', null, 'x', 1))).toMatchObject({ author: 'user', by: 'user' })
    expect(projectKanboCardComment(row('system.returned', null, 'x', 1))).toMatchObject({ author: 'user', by: 'user' })
    expect(projectKanboCardComment(row('system', null, 'x', 1))).toMatchObject({ author: 'system', by: 'kanbo' })
  })
})
