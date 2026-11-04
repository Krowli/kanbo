import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCliActor, createPersonActor, createServeWriter, describeApprovalRefusal, describePersonOverride } from './actor'

/** An account the system's user database has no entry for, as in a container started with an arbitrary uid. */
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: () => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_os_get_passwd'), { code: 'ENOENT' })
    },
  }
})

describe('the actor when the account has no user entry', () => {
  beforeEach(() => {
    for (const name of ['KANBO_ACTOR_ID', 'USER', 'USERNAME', 'LOGNAME']) {
      vi.stubEnv(name, undefined)
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('takes the name from the environment', () => {
    vi.stubEnv('USERNAME', 'ana')

    expect(createCliActor().id).toBe('ana')
    expect(createPersonActor()).toEqual({ kind: 'user', id: 'ana' })
  })

  it('says unknown when nothing names the account', () => {
    expect(createCliActor().id).toBe('unknown')
  })
})

describe('the command a person in an agent-marked terminal is told to run', () => {
  it('sets the variable in front of the command in a POSIX shell, quoting a word that needs it', () => {
    expect(describePersonOverride(['return', 'WOR-1', '--comment', 'it\'s not', '--db', '/tmp/my board.db'], 'darwin'))
      .toBe('If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo return WOR-1 --comment \'it\'\\\'\'s not\' --db \'/tmp/my board.db\'')
    expect(describePersonOverride([], 'linux')).toBe('If you are a person in an editor terminal, run: KANBO_ACTOR_KIND=person kanbo')
  })

  it('sets the variable the PowerShell way on Windows, leaving a path bare and doubling a quote', () => {
    expect(describePersonOverride(['approve', 'WOR-1', '--db', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\board.db', '--workspace', 'workspace'], 'win32'))
      .toBe('If you are a person in an editor terminal, run in PowerShell: $env:KANBO_ACTOR_KIND=\'person\'; kanbo approve WOR-1 --db C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\board.db --workspace workspace')
    expect(describePersonOverride(['return', 'WOR-1', '--comment', 'it\'s $HOME', '--json', 'id,column'], 'win32'))
      .toBe('If you are a person in an editor terminal, run in PowerShell: $env:KANBO_ACTOR_KIND=\'person\'; kanbo return WOR-1 --comment \'it\'\'s $HOME\' --json \'id,column\'')
    expect(describePersonOverride([], 'win32')).toBe('If you are a person in an editor terminal, run in PowerShell: $env:KANBO_ACTOR_KIND=\'person\'; kanbo')
  })

  it('ends a refusal, on this platform, with the same line', () => {
    expect(describeApprovalRefusal('CLAUDECODE=1', ['approve', 'WOR-1']).split('\n')[1]).toBe(describePersonOverride(['approve', 'WOR-1']))
  })
})

describe('the actor an agent\'s shell writes as', () => {
  beforeEach(() => {
    for (const name of ['KANBO_ACTOR_ID', 'KANBO_ACTOR_KIND', 'CLAUDECODE', 'GEMINI_CLI', 'CURSOR_AGENT', 'CODEX_THREAD_ID', 'USER', 'LOGNAME']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('USERNAME', 'ana')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('files an agent tool\'s shell under the tool', () => {
    vi.stubEnv('CLAUDECODE', '1')

    expect(createCliActor().id).toBe('claude')
  })

  it('lets KANBO_ACTOR_ID name the writer anyway', () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('KANBO_ACTOR_ID', 'reviewer')

    expect(createCliActor().id).toBe('reviewer')
  })

  it('files a person in an agent-marked terminal under the OS user', () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('KANBO_ACTOR_KIND', 'person')

    expect(createCliActor().id).toBe('ana')
  })

  it('files a shell without a mark under the OS user', () => {
    expect(createCliActor().id).toBe('ana')
  })
})

describe('the actor the board page writes as', () => {
  beforeEach(() => {
    for (const name of ['KANBO_ACTOR_ID', 'CLAUDECODE', 'USERNAME', 'LOGNAME']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('USER', 'ana')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is the OS user when the server was started from an agent\'s shell', () => {
    vi.stubEnv('CLAUDECODE', '1')

    expect(createServeWriter().id).toBe('ana')
  })

  it('ignores the agent\'s KANBO_ACTOR_ID in an agent\'s shell', () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('KANBO_ACTOR_ID', 'reviewer')

    expect(createServeWriter().id).toBe('ana')
  })

  it('is KANBO_ACTOR_ID in a person\'s shell', () => {
    vi.stubEnv('KANBO_ACTOR_ID', 'alice')

    expect(createServeWriter().id).toBe('alice')
  })

  it('is the OS user in a shell without a mark', () => {
    expect(createServeWriter().id).toBe('ana')
  })
})
