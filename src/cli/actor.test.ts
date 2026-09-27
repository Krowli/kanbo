import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCliActor, createPersonActor } from './actor'

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
