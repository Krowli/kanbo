import { describe, expect, it } from 'vitest'

import { COLUMN_CATALOGUE, COLUMN_TEMPLATE_IDS, COLUMN_TEMPLATES, hasReadyColumn, insertOwnColumns, ownColumn } from './column-templates'
import { DEFAULT_STATUSES } from './status-name'

describe('column templates', () => {
  it.each(COLUMN_TEMPLATE_IDS)('%s has To Do, the column agents take work from', (id) => {
    expect(hasReadyColumn(COLUMN_TEMPLATES[id])).toBe(true)
  })

  it('has To Do in the catalogue a person builds their own set from', () => {
    expect(hasReadyColumn(COLUMN_CATALOGUE)).toBe(true)
  })

  it('is the standard six for the standard template, and QA after In Review for review-qa', () => {
    expect(COLUMN_TEMPLATES.standard.map(column => column.name)).toEqual(DEFAULT_STATUSES.map(status => status.name))
    expect(COLUMN_TEMPLATES.simple.map(column => column.name)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(COLUMN_TEMPLATES['review-qa'].map(column => column.name))
      .toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'QA', 'Done', 'Canceled'])
    expect(COLUMN_TEMPLATES['review-qa'][3]!.description).toBe('Pull request open; waiting for code review')
    expect(COLUMN_TEMPLATES['review-qa'][4]).toMatchObject({ category: 'started', description: 'Being tested before it counts as done' })
  })

  it('places a person\'s own columns before Done', () => {
    const columns = insertOwnColumns(COLUMN_TEMPLATES.simple, [ownColumn('Design', 'Being sketched')])
    expect(columns.map(column => column.name)).toEqual(['To Do', 'In Progress', 'Design', 'Done'])
  })
})
