import { execSync } from 'child_process'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
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
 * Find the Unreal Engine installation directory for the given project.
 *
 * Steps:
 *   1. Read .uproject → EngineAssociation (e.g. "5.4" or "{GUID}")
 *   2. HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>  InstalledDirectory
 *      (Epic Games Launcher installs)
 *   3. HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds  <association>
 *      (Custom / source builds registered by UnrealVersionSelector)
 *
 * Returns the engine root path (e.g. "C:\Program Files\Epic Games\UE_5.4"), or null.
 */
export function findUnrealEngineDir(projectDir: string): string | null {
  // Engine discovery relies on the Windows registry; unsupported elsewhere.
  if (!isWindows) return null

  const association = getEngineAssociation(projectDir)
  if (!association) return null

  // 1. HKLM — Epic Games Launcher installs (version string like "5.4")
  const hklm = queryRegSZ(
    `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}`,
    'InstalledDirectory'
  )
  if (hklm) return hklm

  // 2. HKCU — Custom / source builds (GUID or custom name)
  const hkcu = queryRegSZ(
    `HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds`,
    association
  )
  if (hkcu) return hkcu

  return null
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
