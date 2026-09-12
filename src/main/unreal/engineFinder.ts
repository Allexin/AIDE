import { execSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { isWindows } from '../platform'

/**
 * Run `reg query <keyPath> /v <valueName>` and return the REG_SZ value, or null on any error.
 */
function queryRegSZ(keyPath: string, valueName: string): string | null {
  try {
    const output = execSync(`reg query "${keyPath}" /v "${valueName}"`, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // Output line looks like:
    //     InstalledDirectory    REG_SZ    C:\Program Files\Epic Games\UE_5.4
    const match = output.match(/REG_SZ\s+(.+)/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/**
 * Run `reg query <keyPath> /s` and return every REG_SZ value found under it.
 * Used to discover where engines are installed on this machine.
 */
function queryRegSZTree(keyPath: string): string[] {
  try {
    const output = execSync(`reg query "${keyPath}" /s`, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return [...output.matchAll(/REG_SZ\s+(.+)/g)].map((m) => m[1].trim())
  } catch {
    return []
  }
}

/** Registry values may use forward slashes ("T:/UE_5.7"); normalise them for Windows. */
function normalizePath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '')
}

/** An engine root must actually contain the editor binaries directory. */
function isEngineDir(path: string): boolean {
  return existsSync(join(path, 'Engine', 'Binaries', 'Win64'))
}

/** Return the path if it looks like a real engine root, otherwise null. */
function validate(path: string | null): string | null {
  if (!path) return null
  const normalized = normalizePath(path)
  return isEngineDir(normalized) ? normalized : null
}

/**
 * Parse the EngineAssociation field from the first .uproject file found in projectDir.
 * Returns null if no .uproject found or the field is missing.
 */
function getEngineAssociation(projectDir: string): string | null {
  try {
    const uprojectFile = readdirSync(projectDir).find((e) => e.endsWith('.uproject'))
    if (!uprojectFile) return null
    const raw = readFileSync(join(projectDir, uprojectFile), 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    return typeof data['EngineAssociation'] === 'string' ? (data['EngineAssociation'] as string) : null
  } catch {
    return null
  }
}

/**
 * Last-resort lookup for a launcher install the registry does not know about
 * (a fresh version installed to a custom drive often leaves no HKLM entry).
 *
 * Engines live side by side — "T:\UE_5.7", "T:\UE_5.8" — so look for "UE_<version>"
 * next to every engine the registry does know about, plus the default install root.
 */
function findEngineNextToKnownInstalls(version: string): string | null {
  if (!/^\d+\.\d+$/.test(version)) return null

  const known = [
    ...queryRegSZTree('HKLM\\SOFTWARE\\EpicGames\\Unreal Engine'),
    ...queryRegSZTree('HKCU\\SOFTWARE\\Epic Games\\Unreal Engine')
  ].map(normalizePath)

  const roots = [
    ...new Set([
      ...known.filter((p) => /[\\/]UE_\d+\.\d+$/i.test(p)).map((p) => dirname(p)),
      'C:\\Program Files\\Epic Games'
    ])
  ]

  for (const root of roots) {
    const candidate = join(root, `UE_${version}`)
    if (isEngineDir(candidate)) return candidate
  }
  return null
}

/**
 * Find the Unreal Engine installation directory for the given project.
 *
 * Steps:
 *   1. Read .uproject → EngineAssociation (e.g. "5.4" or "{GUID}")
 *   2. HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>  InstalledDirectory
 *      (Epic Games Launcher installs, machine-wide)
 *   3. HKCU\SOFTWARE\Epic Games\Unreal Engine  <version>
 *      (Epic Games Launcher installs registered per user)
 *   4. HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds  <association>
 *      (Custom / source builds registered by UnrealVersionSelector)
 *   5. "UE_<version>" next to an engine the registry already knows about
 *
 * Returns the engine root path (e.g. "C:\Program Files\Epic Games\UE_5.4"), or null.
 */
export function findUnrealEngineDir(projectDir: string): string | null {
  // Engine discovery relies on the Windows registry; unsupported elsewhere.
  if (!isWindows) return null

  const association = getEngineAssociation(projectDir)
  if (!association) return null

  // 1. HKLM — Epic Games Launcher installs (version string like "5.4")
  const hklm = validate(
    queryRegSZ(`HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}`, 'InstalledDirectory')
  )
  if (hklm) return hklm

  // 2. HKCU — Epic Games Launcher installs registered for the current user only
  const hkcuVersion = validate(
    queryRegSZ('HKCU\\SOFTWARE\\Epic Games\\Unreal Engine', association)
  )
  if (hkcuVersion) return hkcuVersion

  // 3. HKCU — Custom / source builds (GUID or custom name)
  const hkcuBuild = validate(
    queryRegSZ('HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds', association)
  )
  if (hkcuBuild) return hkcuBuild

  // 4. Unregistered install sitting next to a registered one
  return findEngineNextToKnownInstalls(association)
}

/**
 * Find the path to UnrealVersionSelector.exe from the Windows registry.
 *
 * Epic registers UVS as the handler for .uproject files:
 *   HKCR\Unreal.ProjectFile\shell\switchversion  Icon = "C:\...\UnrealVersionSelector.exe"
 *
 * This is used to open a project in the correct engine editor version.
 */
export function findUnrealVersionSelector(): string | null {
  // UnrealVersionSelector is registered in the Windows registry only.
  if (!isWindows) return null

  return queryRegSZ('HKCR\\Unreal.ProjectFile\\shell\\switchversion', 'Icon')
}
