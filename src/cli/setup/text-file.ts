import { existsSync, readFileSync } from 'node:fs'

import type { FileChange } from './file-change'

/**
 * A person's text file, read and written back in the shape it came in.
 *
 * Editors on Windows save with CRLF line endings, and some with a UTF-8 byte
 * order mark. kanbo edits such files — an instruction block in `CLAUDE.md`, an
 * entry in `.mcp.json` or `config.toml` — so it reads them as plain `\n` text
 * without the mark, works on that, and writes the result back with the file's
 * own line endings and mark. A file of mixed endings is written back in the
 * one most of its lines use. New files are LF without a mark.
 */

export interface TextFileStyle {
  eol: '\n' | '\r\n'
  bom: boolean
}

export interface TextFileContents extends TextFileStyle {
  /** The text with `\n` line endings and no byte order mark. */
  text: string
}

const BOM = '﻿'

/** How kanbo writes a file that is not there yet. */
export const NEW_TEXT_FILE_STYLE: TextFileStyle = { eol: '\n', bom: false }

/** The file as text to work on, with the style to write it back in; `null` when there is no file. */
export function readTextFile(path: string): TextFileContents | null {
  return existsSync(path) ? parseText(readFileSync(path, 'utf8')) : null
}

export function parseText(raw: string): TextFileContents {
  const bom = raw.startsWith(BOM)
  const body = bom ? raw.slice(BOM.length) : raw
  const crlf = body.match(/\r\n/g)?.length ?? 0
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf
  return { text: body.replace(/\r\n/g, '\n'), eol: crlf > lf ? '\r\n' : '\n', bom }
}

/** `\n` text in the given style, ready to write. */
export function formatText(text: string, style: TextFileStyle): string {
  const body = style.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
  return style.bom ? BOM + body : body
}

/**
 * A change to a text file, worked out on its `\n` text: `edit` gets the text
 * (`null` when there is no file) and returns what it should say, or `null` to
 * leave it. Text that comes out the same is no change at all.
 */
export function planTextFile(path: string, edit: (existing: string | null) => string | null): FileChange {
  const file = readTextFile(path)
  const next = edit(file?.text ?? null)
  if (next === null || next === file?.text) {
    return { path, next: null }
  }
  return { path, next: formatText(next, file ?? NEW_TEXT_FILE_STYLE) }
}
