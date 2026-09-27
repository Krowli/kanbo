import { isSupportedNode, unsupportedNodeMessage } from './node-version'

/** Imported first by the CLI's entry point, so it runs before any other module is evaluated. */
if (!isSupportedNode(process.versions.node)) {
  console.error(unsupportedNodeMessage(process.versions.node))
  process.exit(1)
}
