import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { maskDatabaseUrls } from '../../domain/database-url'
import type { ColumnRefusalDetails } from '../../domain/entry-rules'
import { describeColumnRefusal } from '../../domain/entry-rules'
import { BoardError } from '../../domain/errors'
import type { KanboToolName } from '../tool-names'
import type { KanboToolTransport } from '../transport'

/**
 * What every board tool is, and the one way all of them answer.
 *
 * A tool is a name, a schema and exactly one call into the transport. It never
 * throws: a board rule the caller broke, a card that is not there, a server
 * that refused — all of it comes back as a tool error the model can read and
 * act on, because an exception out of a handler reaches the model as a
 * transport failure with nothing in it to correct.
 */

/** The zod raw shape `McpServer.registerTool` takes. */
export type KanboToolShape = Record<string, z.ZodType>

/**
 * What a tool call answers with: the result, or the reason it did not happen.
 *
 * It is the MCP result the protocol defines, narrowed to what the board's tools
 * actually produce — one block of text, and whether that text is a failure.
 */
export interface KanboToolResult extends CallToolResult {
  content: { type: 'text', text: string }[]
  isError?: true
}

/** One tool of the board, ready to register against any transport. */
export interface KanboTool {
  name: KanboToolName
  title: string
  description: string
  inputSchema: KanboToolShape
  run: (transport: KanboToolTransport, input: unknown) => Promise<KanboToolResult>
}

/**
 * Declare a tool: what it is called, what it takes, and the one thing it does.
 *
 * The arguments are parsed here as well as by the MCP server that dispatched
 * them, which is what lets the body be written against a typed input while the
 * list of tools stays one plain array a test can walk. What comes back is JSON,
 * unless the tool answers in prose and hands back a string — `kanbo_prime` is
 * the board talking to the agent, and quoting it would only make it harder to
 * read.
 */
export function defineKanboTool<Shape extends KanboToolShape>(definition: {
  name: KanboToolName
  title: string
  description: string
  inputSchema: Shape
  run: (transport: KanboToolTransport, input: z.output<z.ZodObject<Shape>>) => Promise<unknown>
}): KanboTool {
  const schema = z.object(definition.inputSchema)
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    run: async (transport, input) => {
      try {
        const answer = await definition.run(transport, schema.parse(input ?? {}))
        return toolText(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2))
      }
      catch (error) {
        return toolError(error)
      }
    },
  }
}

/**
 * The card a tool acts on. Every tool that takes one takes it under this name
 * and describes it the same way, so a model that learned the argument once
 * cannot be wrong about it on the next tool.
 */
export const cardArgument = z.string().min(1).describe('The card, by the id the board prints for it, for example MAN-012.')

/** Where a card's work happens. */
export const executionModeArgument = z.enum(['worktree', 'main'])
  .describe('Where the work happens: worktree is a separate copy of the project, main is the project folder itself.')

/** What a tool hands back when it did what it was asked. */
function toolText(text: string): KanboToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * Why the tool did not do what it was asked.
 *
 * A `BoardError` is a rule of the board the caller broke: its code names what
 * happened and its details say which value did it, so both are passed through
 * rather than translated into a sentence that could drift away from the rule.
 */
function toolError(error: unknown): KanboToolResult {
  // A card held at a column's door carries a list; the agent reads it as one
  // line per rule, the same lines the command line prints.
  if (error instanceof BoardError && error.code === 'board_column_rules_unmet') {
    const text = describeColumnRefusal(error.details as unknown as ColumnRefusalDetails)
    return { content: [{ type: 'text', text }], isError: true }
  }
  if (error instanceof BoardError) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : ''
    return { content: [{ type: 'text', text: `${error.code}${details}` }], isError: true }
  }
  // Anything else is a message this package did not write — on an external
  // board, a driver's — and such a message is free to carry the whole
  // connection string in the middle of it.
  return {
    content: [{ type: 'text', text: maskDatabaseUrls(error instanceof Error ? error.message : String(error)) }],
    isError: true,
  }
}
