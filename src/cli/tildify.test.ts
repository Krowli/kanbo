import { describe, expect, it } from 'vitest'

import { tildify } from './tildify'

describe('tildify', () => {
  it.skipIf(process.platform === 'win32')('shortens a path under home, and only one under it', () => {
    expect(tildify('/Users/a/x.db', '/Users/a')).toBe('~/x.db')
    expect(tildify('/Users/a/p/.kanbo/board.db', '/Users/a')).toBe('~/p/.kanbo/board.db')
    expect(tildify('/Users/ab/x.db', '/Users/a')).toBe('/Users/ab/x.db')
    expect(tildify('/Users/a', '/Users/a')).toBe('/Users/a')
    expect(tildify('/srv/x.db', '/Users/a')).toBe('/srv/x.db')
  })

  it.runIf(process.platform === 'win32')('compares without case, and leaves another drive alone, on Windows', () => {
    expect(tildify('c:\\users\\a\\x.db', 'C:\\Users\\a')).toBe('~/x.db')
    expect(tildify('C:\\Users\\ab\\x.db', 'C:\\Users\\a')).toBe('C:/Users/ab/x.db')
    expect(tildify('D:\\x.db', 'C:\\Users\\a')).toBe('D:/x.db')
  })
})
