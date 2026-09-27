/**
 * The Node versions kanbo runs on — `engines` in package.json,
 * `^22.19.0 || >=24.11.0` — checked before anything else loads, so an older
 * Node hears which one it needs instead of a stack from deep inside a module.
 */

export const SUPPORTED_NODE_RANGE = '^22.19.0 || >=24.11.0'

export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  if (major === 22) {
    return minor >= 19
  }
  if (major === 24) {
    return minor >= 11
  }
  return major > 24
}

export function unsupportedNodeMessage(version: string): string {
  return `kanbo needs Node ${SUPPORTED_NODE_RANGE}; this is Node ${version.replace(/^v/, '')}. `
    + 'Install a current Node (https://nodejs.org), then run kanbo again.'
}
