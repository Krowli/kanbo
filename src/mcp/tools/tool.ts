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
  /** The arguments under their canonical names — what the tool publishes and the manifest lists. */
  inputSchema: KanboToolShape
  /**
   * What the MCP server registers: the same JSON Schema as `inputSchema`, but
   * accepting anything, so a call with a wrong or aliased argument reaches
   * `run` — which answers it in a sentence — instead of the server's own
   * validation dump.
   */
  registrationSchema: z.ZodType
  /** Other names each argument is accepted under, canonical name first. */
  aliases: Readonly<Record<string, readonly string[]>>
  run: (transport: KanboToolTransport, input: unknown) => Promise<KanboToolResult>
}

/** What every tool that takes `card` also takes it as. */
export const CARD_ALIASES = ['id', 'cardId', 'key'] as const

/** The definition of a tool, as each tool module writes it. */
export interface KanboToolDefinition<Shape extends KanboToolShape> {
  name: KanboToolName
  title: string
  description: string
  inputSchema: Shape
  /**
   * A call that works, printed in every argument error so the model's next try
   * is a copy of it. Absent for a tool that takes no argument it could get wrong.
   */
  example?: Record<string, unknown>
  /** Other names an argument is accepted under. `card` always takes `id`, `cardId` and `key`. */
  aliases?: Partial<Record<keyof Shape & string, readonly string[]>>
  /** What a required argument is, in a few words, for the error that says it is missing. */
  needs?: Partial<Record<keyof Shape & string, string>>
  /** A last reading of the arguments after the aliases, before they are checked: synonyms of an enum, say. */
  prepare?: (input: Record<string, unknown>) => Record<string, unknown>
  run: (transport: KanboToolTransport, input: z.output<z.ZodObject<Shape>>) => Promise<unknown>
}

/**
 * Declare a tool: what it is called, what it takes, and the one thing it does.
 *
 * The arguments are parsed here, not by the MCP server that dispatched them
 * (its `registrationSchema` accepts anything): an alias is read as the
 * argument it stands for, and an argument that is missing or wrong is answered
 * with one sentence that names it and shows a call that works — agents that
 * guessed an argument name, measured in docs/performance.md, got zod's dump
 * and guessed again. What comes back is JSON, unless the tool answers in prose
 * and hands back a string — `kanbo_prime` is the board talking to the agent,
 * and quoting it would only make it harder to read.
 */
export function defineKanboTool<Shape extends KanboToolShape>(definition: KanboToolDefinition<Shape>): KanboTool {
  const schema = z.object(definition.inputSchema)
  const aliases: Record<string, readonly string[]> = {
    ...('card' in definition.inputSchema ? { card: CARD_ALIASES } : {}),
    ...definition.aliases as Record<string, readonly string[]>,
  }
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    registrationSchema: registrationSchemaOf(definition.inputSchema),
    aliases,
    run: async (transport, input) => {
      try {
        const read = readAliases(definition, aliases, isPlainObject(input) ? input : {})
        const prepared = definition.prepare ? definition.prepare(read) : read
        const parsed = schema.safeParse(prepared)
        if (!parsed.success) {
          throw new KanboArgumentError(describeArgumentIssues(definition, parsed.error.issues, prepared))
        }
        const answer = await definition.run(transport, parsed.data)
        return toolText(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2))
      }
      catch (error) {
        return toolError(error)
      }
    },
  }
}

/** An argument the caller got wrong, said in one sentence — never a board rule. */
class KanboArgumentError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The arguments under their canonical names. An alias is used only when the
 * canonical name is absent; both given with different values is refused rather
 * than one of them quietly winning.
 */
function readAliases<Shape extends KanboToolShape>(
  definition: KanboToolDefinition<Shape>,
  aliases: Record<string, readonly string[]>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const read = { ...input }
  for (const [canonical, names] of Object.entries(aliases)) {
    for (const alias of names) {
      if (!(alias in read) || alias in definition.inputSchema) {
        continue
      }
      const value = read[alias]
      delete read[alias]
      if (read[canonical] === undefined) {
        read[canonical] = value
      }
      else if (JSON.stringify(read[canonical]) !== JSON.stringify(value)) {
        throw new KanboArgumentError(
          `${definition.name} got \`${canonical}\` and \`${alias}\` with different values; send only \`${canonical}\`.${exampleSentence(definition)}`,
        )
      }
    }
  }
  return read
}

/** The sentence an argument error ends with: a call that works. */
function exampleSentence(definition: { example?: Record<string, unknown> }): string {
  return definition.example ? ` Example: ${JSON.stringify(definition.example)}` : ''
}

/** What `needs` says when a tool does not: every `card` is the same card. */
const DEFAULT_NEEDS: Record<string, string> = { card: 'the card id, e.g. TST-5' }

/** Every problem with the arguments, one short clause each, and a call that works. */
function describeArgumentIssues<Shape extends KanboToolShape>(
  definition: KanboToolDefinition<Shape>,
  issues: readonly z.core.$ZodIssue[],
  input: Record<string, unknown>,
): string {
  const needs: Record<string, string | undefined> = { ...DEFAULT_NEEDS, ...definition.needs }
  const isMissing = (issue: z.core.$ZodIssue): boolean => issue.path.length === 1 && input[String(issue.path[0])] === undefined
  const missing = issues.filter(isMissing).map(issue => String(issue.path[0]))
  const wrong = issues
    .filter(issue => !isMissing(issue))
    .map(issue => `\`${issue.path.map(String).join('.') || 'arguments'}\` ${describeIssue(issue)}`)
  const parts = [
    ...(missing.length > 0
      ? [`needs ${missing.map(name => `\`${name}\`${needs[name] ? ` (${needs[name]})` : ''}`).join(' and ')}`]
      : []),
    ...wrong,
  ]
  return `${definition.name} ${parts.join('; ')}.${exampleSentence(definition)}`
}

/** One problem with one argument, as the end of a sentence that starts with the argument. */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_value':
      return `must be one of ${issue.values.map(value => String(value)).join(', ')}`
    case 'invalid_type':
      return `must be ${issue.expected === 'array' ? 'a list' : `a ${issue.expected}`}`
    case 'too_small':
      return issue.origin === 'string' ? 'must not be empty' : `must be at least ${String(issue.minimum)}`
    default:
      return issue.message.toLowerCase().startsWith('invalid') ? 'is not valid here' : issue.message
  }
}

/**
 * The schema the MCP server registers: every argument accepts any value and
 * any other name is let through, while the JSON Schema it publishes is the
 * canonical one, field for field — each field carries its own JSON Schema as
 * metadata, and the object carries the list of required ones.
 */
function registrationSchemaOf(shape: KanboToolShape): z.ZodType {
  const required = Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([name]) => name)
  const fields = Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    const { $schema: _schema, ...json } = z.toJSONSchema(field, { io: 'input', target: 'draft-7' })
    return [name, z.unknown().optional().meta(json)]
  }))
  return z.looseObject(fields).meta(required.length > 0 ? { required, additionalProperties: undefined } : { additionalProperties: undefined })
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
  if (error instanceof KanboArgumentError) {
    return { content: [{ type: 'text', text: error.message }], isError: true }
  }
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
