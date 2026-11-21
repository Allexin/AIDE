/** Images of Markdown in the file viewer (docs/file-viewer-spec.md, "Images and Mermaid in Markdown"). */

/** A relative or root-relative `src` of a Markdown image → the project file through aide-preview://. */
export function resolveAsset(src: string, assetBase: string, version: number): string {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) return src
  try {
    const url = new URL(src, assetBase)
    // A root-relative path ("/docs/a.png") means the project root, as on GitHub.
    if (src.startsWith('/')) url.pathname = src
    if (version > 0) url.searchParams.set('v', String(version))
    return url.href
  } catch {
    return src
  }
}
