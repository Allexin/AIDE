import { describe, expect, it } from 'vitest'
import { projectFileOfLink } from './taskLinks'

const WIN = 'E:\\Projects\\app'
const POSIX = '/home/u/app'

describe('task links as project files', () => {
  it('opens project-relative links, with the anchor dropped', () => {
    expect(projectFileOfLink(WIN, 'docs/spec.md#csp')).toEqual({ absolute: 'E:\\Projects\\app\\docs\\spec.md', relative: 'docs/spec.md' })
    expect(projectFileOfLink(WIN, './docs/spec.md')).toEqual({ absolute: 'E:\\Projects\\app\\docs\\spec.md', relative: 'docs/spec.md' })
    expect(projectFileOfLink(WIN, '/docs\\spec.md')).toEqual({ absolute: 'E:\\Projects\\app\\docs\\spec.md', relative: 'docs/spec.md' })
    expect(projectFileOfLink(POSIX, 'docs/a/../spec.md')).toEqual({ absolute: '/home/u/app/docs/spec.md', relative: 'docs/spec.md' })
  })

  it('refuses a link that resolves outside the project root', () => {
    expect(projectFileOfLink(WIN, '../secret.txt')).toBeNull()
    expect(projectFileOfLink(WIN, 'docs/../../secret.txt')).toBeNull()
    expect(projectFileOfLink(WIN, '..\\..\\Windows\\win.ini')).toBeNull()
    expect(projectFileOfLink(WIN, 'C:/Windows/win.ini')).toBeNull()
    expect(projectFileOfLink(WIN, 'E:/Projects/app-other/x.md')).toBeNull()
    expect(projectFileOfLink(WIN, '\\\\server\\share\\x.md')).toBeNull()
    expect(projectFileOfLink(POSIX, '//etc/passwd')).toBeNull()
    expect(projectFileOfLink(WIN, 'docs/x.md:hidden')).toBeNull()
  })

  it('takes a full path inside the project, in any case', () => {
    expect(projectFileOfLink(WIN, 'e:/projects/APP/docs/x.md')).toEqual({ absolute: 'E:\\Projects\\app\\docs\\x.md', relative: 'docs/x.md' })
  })

  it('refuses an empty link or the root itself', () => {
    expect(projectFileOfLink(WIN, '#anchor')).toBeNull()
    expect(projectFileOfLink(WIN, './')).toBeNull()
    expect(projectFileOfLink(WIN, 'docs/..')).toBeNull()
  })
})
