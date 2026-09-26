import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { buildCapabilitiesManifest } from '../capabilities/manifest'
import { renderCapabilitiesMarkdown } from '../capabilities/markdown'
import { KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI, KANBO_CAPABILITIES_RESOURCE_URI } from './resources'
import { createKanboMcpServer } from './server'
import type { KanboToolTransport } from './transport'

/**
 * No board is opened here on purpose: the capabilities resources are
 * board-independent, the same way `kanbo capabilities` needs no `--db`, so
 * the transport `createKanboMcpServer` otherwise hands its tools is never
 * called and stands in as an empty stub.
 */
const NO_TRANSPORT = {} as unknown as KanboToolTransport

/** A client and the board's MCP server, talking to each other in this process — the same pairing `tools.test.ts` uses. */
async function connectClient(): Promise<Client> {
  const server = createKanboMcpServer(NO_TRANSPORT, { includeRunTools: true })
  const [clientChannel, serverChannel] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'capabilities-resources-test', version: '0.0.0' })
  await Promise.all([client.connect(clientChannel), server.connect(serverChannel)])
  return client
}

function textOf(content: { text: string } | { blob: string }): string {
  expect('text' in content).toBe(true)
  return (content as { text: string }).text
}

describe('the board\'s capabilities resources', () => {
  it('lists both resources', async () => {
    const client = await connectClient()

    const { resources } = await client.listResources()

    expect(resources.map(resource => resource.uri).sort()).toEqual(
      [KANBO_CAPABILITIES_RESOURCE_URI, KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI].sort(),
    )
    await client.close()
  })

  it('reads kanbo://capabilities as the JSON manifest', async () => {
    const client = await connectClient()

    const { contents } = await client.readResource({ uri: KANBO_CAPABILITIES_RESOURCE_URI })

    expect(contents).toHaveLength(1)
    expect(contents[0]!.mimeType).toBe('application/json')
    expect(JSON.parse(textOf(contents[0]!))).toEqual(buildCapabilitiesManifest())
    await client.close()
  })

  it('reads kanbo://capabilities.md as the same manifest, rendered', async () => {
    const client = await connectClient()

    const { contents } = await client.readResource({ uri: KANBO_CAPABILITIES_MARKDOWN_RESOURCE_URI })

    expect(contents).toHaveLength(1)
    expect(contents[0]!.mimeType).toBe('text/markdown')
    expect(textOf(contents[0]!)).toBe(renderCapabilitiesMarkdown(buildCapabilitiesManifest()))
    await client.close()
  })
})
