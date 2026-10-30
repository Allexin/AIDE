import { describe, expect, it } from 'vitest'
import { EMAIL_MASK, maskEmails } from './emailMask'

describe('maskEmails', () => {
  it('masks a bare address', () => {
    expect(maskEmails('me.work+tag@mail.example.com')).toBe(EMAIL_MASK)
  })

  it('masks every address inside a text and keeps the rest', () => {
    expect(maskEmails('Work (a@b.io) was saved as a@b.io, not c-d@e-f.org.'))
      .toBe(`Work (${EMAIL_MASK}) was saved as ${EMAIL_MASK}, not ${EMAIL_MASK}.`)
  })

  it('masks the email in an OpenCode description and keeps the key tail', () => {
    expect(maskEmails('deepseek: DeepSeek …a1b2, opencode: Personal (me@example.com)'))
      .toBe(`deepseek: DeepSeek …a1b2, opencode: Personal (${EMAIL_MASK})`)
  })

  it('leaves identifiers without an address alone', () => {
    for (const text of ['OpenAI API key', 'Qwen Account', 'account not saved', 'user@localhost']) {
      expect(maskEmails(text)).toBe(text)
    }
  })
})
