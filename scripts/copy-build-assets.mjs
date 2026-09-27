// The files `npm run build` puts beside the bundles: both migration chains, and
// the `kanbo` binary — `src/cli/launcher.cjs`, which checks the Node version
// before it requires the command's bundle — with its executable bit. Node rather than `cp -R` and
// `chmod`, so the build runs the same in PowerShell and cmd.exe. Windows has no
// executable bit, so there is nothing to set there.
import { chmodSync, copyFileSync, cpSync } from 'node:fs'

const root = new URL('../', import.meta.url)

for (const directory of ['drizzle-postgres', 'drizzle-sqlite']) {
  cpSync(new URL(directory, root), new URL(`dist/${directory}`, root), { recursive: true })
}

copyFileSync(new URL('src/cli/launcher.cjs', root), new URL('dist/cli.cjs', root))

if (process.platform !== 'win32') {
  chmodSync(new URL('dist/cli.cjs', root), 0o755)
}
