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
  // The label names the select for a screen reader; the select shows the project itself. The wrapper draws its chevron.
  const label = el('label', 'project-switcher select-wrap')
  label.append(el('span', 'visually-hidden', 'Project'))
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
  // The key stands out, like a callsign; the rest is where it lives.
  const where = el('span', 'project-where')
  where.append(el('span', 'where-key', workspace.identifier))
  if (!project) {
    if (workspace.name) {
      where.append(` · ${workspace.name}`)
    }
    return where
  }
  const storage = project.storage.kind === 'file'
    ? `board file ${project.storage.path}`
    : `Postgres at ${project.storage.where}`
  where.append(` · ${project.folder} · ${storage}`)
  return where
}
