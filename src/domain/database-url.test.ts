import { describe, expect, it } from 'vitest'

import { maskDatabaseUrl, maskDatabaseUrls } from './database-url'

describe('a connection string said out loud', () => {
  it('never says a password', () => {
    expect(maskDatabaseUrl('postgres://user:secret@host:5432/db')).toBe('postgres://user:***@host:5432/db')
    expect(maskDatabaseUrl('postgresql://user:secret@host:6543/postgres'))
      .toBe('postgresql://user:***@host:6543/postgres')
  })

  it('takes the whole query with it, whatever is in there', () => {
    // A connection string carries its options in the query, and an option this
    // build has never heard of may still be a credential.
    expect(maskDatabaseUrl('postgres://user:secret@host:5432/db?sslmode=require'))
      .toBe('postgres://user:***@host:5432/db?***')
    expect(maskDatabaseUrl('postgres://user@host:5432/db?password=secret'))
      .toBe('postgres://user@host:5432/db?***')
  })

  it('leaves a connection string with nothing to hide exactly as it is', () => {
    expect(maskDatabaseUrl('postgres://user@host:5432/db')).toBe('postgres://user@host:5432/db')
    expect(maskDatabaseUrl('postgres://host:5432/db')).toBe('postgres://host:5432/db')
  })

  it('says nothing at all about a connection string it cannot read', () => {
    // Whatever is wrong with it, the secret is still somewhere inside.
    expect(maskDatabaseUrl('user:secret@host:5432/db')).toBe('postgres://***')
  })

  it('masks one that arrives in the middle of somebody else\'s sentence', () => {
    const line = 'connect ECONNREFUSED on postgres://user:secret@host:5432/db and postgresql://u:p@other:6543/db'

    expect(maskDatabaseUrls(line))
      .toBe('connect ECONNREFUSED on postgres://user:***@host:5432/db and postgresql://u:***@other:6543/db')
  })
})
