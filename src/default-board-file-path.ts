import { join } from 'node:path'

/**
 * Where a board file of a project's own goes when nobody names a path —
 * `kanbo init --file` writes it here, and an app that attaches a project's
 * board file can import the same constant rather than spelling it again.
 */
export const DEFAULT_BOARD_FILE_PATH = join('.kanbo', 'board.db')
