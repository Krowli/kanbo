import type { ServeProjectView } from '../projects'
import { el } from './dom'

/**
 * The project switcher in the top bar, and the line that says where the
 * current board lives. Everything is text: a folder or project named like HTML
 * is shown as those characters.
 */

/** A labelled `<select>` with one option per project, the current one selected. */
export function renderProjectSwitcher(
  projects: readonly ServeProjectView[],
  currentId: string | null,
  onChoose: (projectId: string) => void,
): HTMLElement {
  const label = el('label', 'project-switcher', 'Project')
  const select = el('select', 'field project-select')
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

/** `WOR · ~/code/app · board file ~/code/app/.kanbo/board.db`, or `… · Postgres at db.example.com`. */
export function renderWhere(project: ServeProjectView, workspace: { identifier: string }): HTMLElement {
  const storage = project.storage.kind === 'file'
    ? `board file ${project.storage.path}`
    : `Postgres at ${project.storage.where}`
  return el('span', 'project-where', `${workspace.identifier} · ${project.folder} · ${storage}`)
}
