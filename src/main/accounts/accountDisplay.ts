import { getAppConfig } from '../config/appConfig'
import { maskEmails } from '../../shared/emailMask'

/**
 * A text with account data on its way to any UI but the Account Manager: emails
 * masked when the user asked for it (Settings > General > Privacy).
 */
export function accountText(text: string): string {
  return getAppConfig().privacy.maskEmails ? maskEmails(text) : text
}
