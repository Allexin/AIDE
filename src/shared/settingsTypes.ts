export interface SettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'number' | 'password' | 'select'
  options?: Array<{ value: string; label: string }>
  default?: unknown
  /** Only render this field when the named sibling key equals the given value. */
  visibleWhen?: { key: string; value: unknown }
}
