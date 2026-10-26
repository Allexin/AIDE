/** A value as a JavaScript literal for a page's inline <script>. */
export function safeJsJson(obj: unknown): string {
  const del = String.fromCharCode(0x7f)
  return JSON.stringify(obj)
    .split(del).join('\\u007f')
    .replace(/<\/script>/gi, '<\\/script>')
}
