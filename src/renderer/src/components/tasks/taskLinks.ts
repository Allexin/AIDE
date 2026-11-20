/**
 * A doc or description link of a task as a file of the project, for the Tasks tab
 * (docs/task-tracker-implementation.md §8). A link is project-relative ("docs/x.md",
 * "./docs/x.md", "/docs/x.md"), an "#anchor" is dropped, "." and ".." are resolved; a link
 * that resolves outside the project root (above it, another drive, a network path) is
 * refused, so a task file cannot make the editor open a file elsewhere on the machine.
 */
export interface ProjectFile {
  /** The full path, with the project's separator. */
  absolute: string
  /** Relative to the project root, with "/". */
  relative: string
}

export function projectFileOfLink(projectPath: string, link: string): ProjectFile | null {
  const sep = projectPath.includes('\\') ? '\\' : '/'
  let path = link.split('#')[0].replace(/\\/g, '/').trim()
  if (!path) return null
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = /^[a-z]:\//i.test(path) || path.startsWith('//')
  if (absolute) {
    // A full path counts only when it is inside the project (Windows paths ignore case).
    const inside = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    if (!inside(path.slice(0, root.length), root) || (path.length > root.length && path[root.length] !== '/')) return null
    path = path.slice(root.length)
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    // "C:" further in, or an alternate data stream ("x.md:hidden"): not a plain project file.
    if (segment.includes(':')) return null
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (!segments.length) return null
  const base = projectPath.replace(/[\\/]+$/, '')
  return { absolute: `${base}${sep}${segments.join(sep)}`, relative: segments.join('/') }
}
