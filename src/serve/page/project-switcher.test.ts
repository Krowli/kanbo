// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { ServeProjectView } from '../projects'
import { renderProjectSwitcher, renderWhere } from './project-switcher'

function project(extra: Partial<ServeProjectView> = {}): ServeProjectView {
  return {
    id: 'aaaaaaaaaaaa',
    name: 'app',
    folder: '~/code/app',
    storage: { kind: 'file', path: '~/code/app/.kanbo/board.db' },
    isDefault: true,
    ...extra,
  }
}

describe('renderProjectSwitcher', () => {
  it('shows a project named as HTML as its characters, and runs nothing', () => {
    const name = '<img src=x onerror=alert(1)>'
    const element = renderProjectSwitcher([project({ name })], 'aaaaaaaaaaaa', () => {})
    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('option')?.textContent).toContain(name)
  })

  it('selects the current project and reports the one chosen', () => {
    const chosen: string[] = []
    const element = renderProjectSwitcher(
      [project(), project({ id: 'bbbbbbbbbbbb', name: 'other', isDefault: false })],
      'bbbbbbbbbbbb',
      id => chosen.push(id),
    )
    const select = element.querySelector('select')!
    expect(select.value).toBe('bbbbbbbbbbbb')
    expect(element.textContent).toContain('Project')
    select.value = 'aaaaaaaaaaaa'
    select.dispatchEvent(new Event('change'))
    expect(chosen).toEqual(['aaaaaaaaaaaa'])
  })
})

describe('renderWhere', () => {
  it('names the board file of a file board', () => {
    expect(renderWhere(project(), { identifier: 'WOR' }).textContent)
      .toBe('WOR · ~/code/app · board file ~/code/app/.kanbo/board.db')
  })

  it('names the host of a Postgres board, with no connection string', () => {
    const text = renderWhere(project({ storage: { kind: 'postgres', where: 'db.example.com' } }), { identifier: 'WOR' }).textContent
    expect(text).toBe('WOR · ~/code/app · Postgres at db.example.com')
    expect(text).not.toContain('postgres://')
  })
})
