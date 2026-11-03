import type { ServeProjectView } from '../projects'
import { el } from './dom'

/**
 * The project switcher in the top bar, and the line that says where the
 * current board lives. Everything is text: a folder or project named like HTML
 * is shown as those characters.
 */

/**
 * A labelled `<select>` with one option per project, the current one selected.
 * `startedOn` adds a first option, value `''`, for a server with no project of
 * its own: it serves a board that no folder in the list describes.
 */
export function renderProjectSwitcher(
  projects: readonly ServeProjectView[],
  currentId: string | null,
  onChoose: (projectId: string) => void,
  startedOn: { name: string | null } | null = null,
): HTMLElement {
  const label = el('label', 'project-switcher', 'Project')
  const select = el('select', 'field project-select')
  if (startedOn) {
    const own = el('option', undefined, `${startedOn.name ? `${startedOn.name} · ` : ''}the board this server was started on`)
    own.value = ''
    own.selected = currentId === null
    select.append(own)
  }
  for (const project of projects) {
    const option = el('option', undefined, `${project.name} · ${project.folder}`)
    option.value = project.id
    option.selected = project.id === currentId
    select.append(option)
  }
  select.addEventListener('change', () => onChoose(select.value))
  label.append(select)
  return label
}

/**
 * `WOR · ~/code/app · board file ~/code/app/.kanbo/board.db`, or `… · Postgres at db.example.com`.
 * With no project (the board the server was started on), only what the board says of itself.
 */
export function renderWhere(project: ServeProjectView | null, workspace: { identifier: string, name?: string }): HTMLElement {
  if (!project) {
    return el('span', 'project-where', [workspace.identifier, workspace.name].filter(Boolean).join(' · '))
  }
  const storage = project.storage.kind === 'file'
    ? `board file ${project.storage.path}`
    : `Postgres at ${project.storage.where}`
  return el('span', 'project-where', `${workspace.identifier} · ${project.folder} · ${storage}`)
}
