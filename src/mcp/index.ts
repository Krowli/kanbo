/**
 * The board as MCP tools.
 *
 * What a host takes from here is the tools and one of the two transports. The
 * transport that opens the board file is deliberately not re-exported: it pulls
 * in SQLite and the whole command-line runtime, which a host talking to a
 * running server has no use for and should not be made to carry. It is
 * imported directly from `./db-transport` by `kanbo mcp`, the one caller that
 * needs it.
 */
export { createHttpTransport, type KanboHttpRequest, type KanboHttpTransportInput } from './http-transport'
export { KANBO_MCP_INSTRUCTIONS } from './instructions'
export {
  KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI,
  KANBO_CAPABILITIES_RESOURCE_URI,
  registerKanboCapabilitiesResources,
} from './resources'
export { createKanboMcpServer, KANBO_MCP_SERVER_NAME, registerKanboTools } from './server'
export {
  KANBO_TOOL_CLI_EQUIVALENTS,
  KANBO_TOOL_NAMES,
  type KanboToolCliEquivalent,
  type KanboToolName,
} from './tool-names'
export {
  buildKanboTools,
  KANBO_TOOLS,
  type KanboToolOptions,
  type KanboToolRegistration,
} from './tools'
export type { KanboTool, KanboToolResult } from './tools/tool'
export {
  DEFAULT_KANBO_CARD_INCLUDES,
  DEFAULT_KANBO_COMMENT_LIMIT,
  KANBO_CARD_INCLUDES,
  matchesKanboCardQuery,
  pageOf,
} from './transport'
export type {
  KanboActiveRunResult,
  KanboCardCommentResult,
  KanboCardCreateInput,
  KanboCardDetailResult,
  KanboCardFacts,
  KanboCardInclude,
  KanboCardPage,
  KanboCardQuery,
  KanboCardResult,
  KanboCardUpdateInput,
  KanboColumnResult,
  KanboCommentResult,
  KanboFieldChangeResult,
  KanboPullRequestResult,
  KanboReadyPage,
  KanboRunFinishInput,
  KanboRunResult,
  KanboRunStartInput,
  KanboSprintResult,
  KanboToolTransport,
} from './transport'
