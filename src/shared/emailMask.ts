export const EMAIL_MASK = '***@****.***'

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu

/** Replace every email address in a text; identifiers and names may contain one anywhere. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, EMAIL_MASK)
}
