#!/usr/bin/env node
// The `kanbo` binary (`dist/cli.cjs` once built): check the Node, then start
// the command. The command's own bundle uses syntax an old Node cannot even
// parse (`??=`, `?.`), so an old Node would die with a SyntaxError before any
// check inside it could run. This file is written for any Node at all — `var`,
// plain functions, no newer syntax — and says which Node kanbo needs instead.
// Keep it that way: `src/cli/launcher.test.ts` checks, and that the range below
// matches `engines` in package.json.
'use strict'

var SUPPORTED_NODE_RANGE = '^22.19.0 || >=24.11.0'

function isSupportedNode(version) {
  var parts = String(version).replace(/^v/, '').split('.')
  var major = Number(parts[0]) || 0
  var minor = Number(parts[1]) || 0
  if (major === 22) {
    return minor >= 19
  }
  if (major === 24) {
    return minor >= 11
  }
  return major > 24
}

var version = process.versions.node
if (!isSupportedNode(version)) {
  console.error('kanbo needs Node ' + SUPPORTED_NODE_RANGE + '; this is Node ' + version + '. '
    + 'Install a current Node (https://nodejs.org), then run kanbo again.')
  process.exit(1)
}
else {
  require('./cli-main.cjs')
}
