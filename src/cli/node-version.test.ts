import { describe, expect, it } from 'vitest'

import { isSupportedNode, unsupportedNodeMessage } from './node-version'

describe('the Node versions kanbo runs on', () => {
  it('follows engines: ^22.19.0 || >=24.11.0', () => {
    for (const version of ['22.19.0', 'v22.23.2', '24.11.0', '24.21.0', '25.0.0', '26.3.1']) {
      expect(isSupportedNode(version), version).toBe(true)
    }
    for (const version of ['18.20.0', '20.19.0', '22.18.9', 'v22.0.0', '23.11.0', '24.10.0']) {
      expect(isSupportedNode(version), version).toBe(false)
    }
  })

  it('says which Node it needs and which one it got', () => {
    expect(unsupportedNodeMessage('v20.11.1'))
      .toBe('kanbo needs Node ^22.19.0 || >=24.11.0; this is Node 20.11.1. Install a current Node (https://nodejs.org), then run kanbo again.')
  })
})
