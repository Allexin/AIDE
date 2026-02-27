import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

export interface ToolbarChannel {
  name: string
  attention?: boolean
}

export interface ToolbarButton {
  id: string
  icon: string
  tooltip: string
  command: string
  cwd?: string
  channels?: {
    stdout?: ToolbarChannel
    stderr?: ToolbarChannel
  }
}

export interface ToolbarConfig {
  projectType?: string
  buttons: ToolbarButton[]
}

export interface ToolbarPresetGroup {
  type: string
  label: string
  buttons: ToolbarButton[]
}

// Default toolbar: only the Explorer button; projectType empty so auto-detect runs on first open.
const DEFAULT_TOOLBAR: ToolbarConfig = {
  projectType: '',
  buttons: [
    {
      id: 'open-explorer',
      icon: '📂',
      tooltip: 'Open project in Explorer',
      command: 'explorer.exe .',
      cwd: '${projectRoot}'
    }
  ]
}

export const PRESET_GROUPS: ToolbarPresetGroup[] = [
  {
    type: 'general',
    label: 'General',
    buttons: [
      {
        id: 'open-explorer',
        icon: '📂',
        tooltip: 'Open project in Explorer',
        command: 'explorer.exe .',
        cwd: '${projectRoot}'
      }
    ]
  },
  {
    type: 'npm',
    label: 'npm',
    buttons: [
      {
        id: 'npm-build',
        icon: '🔨',
        tooltip: 'Build project',
        command: 'npm run build',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Build Output' },
          stderr: { name: 'Build Errors', attention: true }
        }
      },
      {
        id: 'npm-dev',
        icon: '▶',
        tooltip: 'Run dev server',
        command: 'npm run dev',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Dev Server' },
          stderr: { name: 'Dev Errors', attention: true }
        }
      },
      {
        id: 'npm-test',
        icon: '🧪',
        tooltip: 'Run tests',
        command: 'npm test',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Test Output' },
          stderr: { name: 'Test Errors', attention: true }
        }
      },
      {
        id: 'npm-install',
        icon: '📦',
        tooltip: 'Install dependencies',
        command: 'npm install',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'npm install' },
          stderr: { name: 'npm install errors', attention: true }
        }
      }
    ]
  },
  {
    type: 'unreal',
    label: 'Unreal Engine',
    buttons: [
      {
        id: 'unreal-open',
        icon: '🎮',
        tooltip: 'Open in UE Editor',
        // UnrealVersionSelector opens the correct engine version for this project
        command: 'cmd /c for %f in ("*.uproject") do "${unrealVersionSelector}" /editor "%~ff"',
        cwd: '${projectRoot}'
      },
      {
        id: 'unreal-build',
        icon: '🔨',
        tooltip: 'Build',
        // UnrealBuildTool: <ProjectName>Editor Win64 Development <project.uproject> -rocket
        command:
          'cmd /c for %f in ("*.uproject") do "${unrealEngine}\\Engine\\Binaries\\DotNET\\UnrealBuildTool\\UnrealBuildTool.exe" "%~nfEditor" Win64 Development "%~ff" -rocket',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'UE Build' },
          stderr: { name: 'UE Build Errors', attention: true }
        }
      },
      {
        id: 'unreal-open-vs',
        icon: '💻',
        tooltip: 'Open in Visual Studio',
        command: 'cmd /c for %f in ("*.sln") do start "" "%f"',
        cwd: '${projectRoot}'
      },
      {
        id: 'unreal-clear-intermediate',
        icon: '🗑',
        tooltip: 'Clear Intermediate',
        // Removes build artifacts: Intermediate, DerivedDataCache, Saved, Binaries, .vs, Build,
        // Script, *.sln, and Intermediate inside each plugin folder.
        command:
          "powershell -NoProfile -Command \"$dirs = @('Intermediate','DerivedDataCache','Saved','Binaries','.vs','Build','Script'); foreach ($d in $dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }; if (Test-Path 'Plugins') { Get-ChildItem 'Plugins' -Directory | ForEach-Object { $i = Join-Path $_.FullName 'Intermediate'; if (Test-Path $i) { Remove-Item -Recurse -Force $i } } }; Get-ChildItem '*.sln' -ErrorAction SilentlyContinue | Remove-Item -Force\"",
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Clear Intermediate' },
          stderr: { name: 'Clear Intermediate Errors', attention: true }
        }
      },
      {
        id: 'unreal-gen-vs',
        icon: '⚙',
        tooltip: 'Generate VS Files',
        command:
          'cmd /c for %f in ("*.uproject") do "${unrealEngine}\\Build\\BatchFiles\\GenerateProjectFiles.bat" -project="%~ff" -game -rocket',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Generate VS Files' },
          stderr: { name: 'Generate VS Files Errors', attention: true }
        }
      }
    ]
  },
  {
    type: 'unity',
    label: 'Unity',
    buttons: [
      {
        id: 'unity-open',
        icon: '🎮',
        tooltip: 'Open in Unity Hub',
        command: 'cmd /c start "" "unityhub://open?projectPath=%cd%"',
        cwd: '${projectRoot}'
      }
    ]
  },
  {
    type: 'python',
    label: 'Python',
    buttons: [
      {
        id: 'python-run',
        icon: '▶',
        tooltip: 'Run main.py',
        command: 'python main.py',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'Python Output' },
          stderr: { name: 'Python Errors', attention: true }
        }
      },
      {
        id: 'python-install',
        icon: '📦',
        tooltip: 'Install requirements',
        command: 'pip install -r requirements.txt',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'pip install' },
          stderr: { name: 'pip errors', attention: true }
        }
      },
      {
        id: 'python-test',
        icon: '🧪',
        tooltip: 'Run pytest',
        command: 'pytest',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'pytest' },
          stderr: { name: 'pytest errors', attention: true }
        }
      }
    ]
  },
  {
    type: 'rust',
    label: 'Rust',
    buttons: [
      {
        id: 'rust-build',
        icon: '🔨',
        tooltip: 'Cargo build',
        command: 'cargo build',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'cargo build' },
          stderr: { name: 'cargo build errors', attention: true }
        }
      },
      {
        id: 'rust-run',
        icon: '▶',
        tooltip: 'Cargo run',
        command: 'cargo run',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'cargo run' },
          stderr: { name: 'cargo run errors', attention: true }
        }
      },
      {
        id: 'rust-test',
        icon: '🧪',
        tooltip: 'Cargo test',
        command: 'cargo test',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'cargo test' },
          stderr: { name: 'cargo test errors', attention: true }
        }
      },
      {
        id: 'rust-check',
        icon: '✓',
        tooltip: 'Cargo check',
        command: 'cargo check',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'cargo check' },
          stderr: { name: 'cargo check errors', attention: true }
        }
      }
    ]
  },
  {
    type: 'go',
    label: 'Go',
    buttons: [
      {
        id: 'go-build',
        icon: '🔨',
        tooltip: 'Go build',
        command: 'go build ./...',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'go build' },
          stderr: { name: 'go build errors', attention: true }
        }
      },
      {
        id: 'go-run',
        icon: '▶',
        tooltip: 'Go run',
        command: 'go run .',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'go run' },
          stderr: { name: 'go run errors', attention: true }
        }
      },
      {
        id: 'go-test',
        icon: '🧪',
        tooltip: 'Go test',
        command: 'go test ./...',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'go test' },
          stderr: { name: 'go test errors', attention: true }
        }
      }
    ]
  },
  {
    type: 'docker',
    label: 'Docker',
    buttons: [
      {
        id: 'docker-build',
        icon: '🐳',
        tooltip: 'Docker build',
        command: 'docker build -t app .',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'docker build' },
          stderr: { name: 'docker build errors', attention: true }
        }
      },
      {
        id: 'docker-compose-up',
        icon: '🐳',
        tooltip: 'Docker Compose up',
        command: 'docker compose up',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'docker compose up' },
          stderr: { name: 'docker compose errors', attention: true }
        }
      },
      {
        id: 'docker-compose-down',
        icon: '🐳',
        tooltip: 'Docker Compose down',
        command: 'docker compose down',
        cwd: '${projectRoot}',
        channels: {
          stdout: { name: 'docker compose down' },
          stderr: { name: 'docker down errors', attention: true }
        }
      }
    ]
  }
]

/**
 * Detect project type from file/dir presence.
 * Returns a PRESET_GROUPS type string or null if unknown.
 */
export function detectProjectType(projectDir: string): string | null {
  try {
    const entries = readdirSync(projectDir)
    if (entries.some((e) => e.endsWith('.uproject'))) return 'unreal'
    if (entries.includes('Assets') && entries.includes('ProjectSettings')) return 'unity'
  } catch {
    // ignore read errors
  }
  if (existsSync(join(projectDir, 'package.json'))) return 'npm'
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'rust'
  if (existsSync(join(projectDir, 'go.mod'))) return 'go'
  if (
    existsSync(join(projectDir, 'requirements.txt')) ||
    existsSync(join(projectDir, 'pyproject.toml')) ||
    existsSync(join(projectDir, 'setup.py'))
  )
    return 'python'
  if (
    existsSync(join(projectDir, 'Dockerfile')) ||
    existsSync(join(projectDir, 'docker-compose.yml'))
  )
    return 'docker'
  return null
}

/**
 * Reads the local .aide/toolbar.json for this project.
 * Returns a ToolbarConfig with defaults if the file is missing/corrupt.
 */
export function readLocalToolbarConfig(projectDir: string): ToolbarConfig {
  const localPath = join(projectDir, '.aide', 'toolbar.json')
  if (!existsSync(localPath)) return { projectType: '', buttons: [] }
  try {
    const raw = readFileSync(localPath, 'utf8')
    const config = JSON.parse(raw) as ToolbarConfig
    return { projectType: config.projectType ?? '', buttons: Array.isArray(config.buttons) ? config.buttons : [] }
  } catch {
    return { projectType: '', buttons: [] }
  }
}

/**
 * Writes the given config to .aide/toolbar.json.
 * Assumes .aide directory already exists (ensureAideDirectory is called first).
 */
export function writeLocalToolbarConfig(projectDir: string, config: ToolbarConfig): void {
  const localPath = join(projectDir, '.aide', 'toolbar.json')
  writeFileSync(localPath, JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Writes default toolbar config to .aide/toolbar.json if it does not exist yet.
 * Called on first project open.
 */
export function ensureDefaultToolbar(projectDir: string): void {
  const localPath = join(projectDir, '.aide', 'toolbar.json')
  if (!existsSync(localPath)) {
    writeFileSync(localPath, JSON.stringify(DEFAULT_TOOLBAR, null, 2), 'utf8')
  }
}

/**
 * Copy bundled toolbar.md to aide/docs/toolbar.md if missing or outdated.
 */
export function deployToolbarDocs(projectPath: string): void {
  const bundledPath = join(__dirname, '../../resources/docs/toolbar.md')
  if (!existsSync(bundledPath)) return

  const destDir = join(projectPath, '.aide', 'docs')
  const destPath = join(destDir, 'toolbar.md')

  const bundled = readFileSync(bundledPath, 'utf8')

  if (existsSync(destPath)) {
    const existing = readFileSync(destPath, 'utf8')
    if (existing === bundled) return // already up to date
  }

  mkdirSync(destDir, { recursive: true })
  writeFileSync(destPath, bundled, 'utf8')
}

/**
 * Reads and merges toolbar buttons from aide/toolbar.json (shared) and
 * .aide/toolbar.json (local). Local wins on duplicate id.
 */
export function readToolbarButtons(projectDir: string): ToolbarButton[] {
  const sharedPath = join(projectDir, 'aide', 'toolbar.json')
  const localPath = join(projectDir, '.aide', 'toolbar.json')

  const readButtons = (filePath: string): ToolbarButton[] => {
    if (!existsSync(filePath)) return []
    try {
      const raw = readFileSync(filePath, 'utf8')
      const config = JSON.parse(raw) as ToolbarConfig
      return Array.isArray(config.buttons) ? config.buttons : []
    } catch {
      return []
    }
  }

  const shared = readButtons(sharedPath)
  const local = readButtons(localPath)

  // Merge: local overrides shared on same id; preserve order (shared first, then local-only)
  const merged = new Map<string, ToolbarButton>()
  for (const btn of shared) merged.set(btn.id, btn)
  for (const btn of local) merged.set(btn.id, btn)

  return [...merged.values()]
}
