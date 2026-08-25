import { existsSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import type { StartupTerminalOptions } from './pty/ptyManager'

export interface StartupArgs {
  projectPath: string | null
  terminal: StartupTerminalOptions
  noGlobalState: boolean
}

export function getCommandLineArgumentsHelp(): string {
  return [
    'Usage:',
    '  aide [projectPath] [options]',
    '  aide --project <projectPath> [options]',
    '',
    'Options:',
    '  <projectPath>             Open this project directly.',
    '  --project <projectPath>    Open this project directly.',
    '  --project=<projectPath>    Open this project directly.',
    '  --no-restore              Exclude saved AIDE tabs from startup suggestions.',
    '  --cli <toolId>            Use a registered CLI tool for the initial tab during this launch only.',
    '  --cli=<toolId>            Use a registered CLI tool for the initial tab during this launch only.',
    '  --no-global-state         Do not add the project to recent projects or read/write saved open sessions.',
    '  --help, -h                Show this help.',
    '',
    'Examples:',
    '  aide E:\\Projects\\Foo',
    '  aide --project E:\\Projects\\Foo --no-restore',
    '  aide E:\\Projects\\Foo --no-restore --cli codex',
    '',
    'Tip:',
    '  Tool ids are shown in CLI > Manage CLI Tools. Click a toolId there to copy it.'
  ].join('\n')
}

export function hasCommandLineHelpArg(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

function resolveProjectPath(input: string, cwd: string): string | null {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input)
  return existsSync(candidate) ? candidate : null
}

export function resolveStartupArgs(userArgs: string[], cwd: string): StartupArgs {
  let projectArg: string | null = null
  const terminal: StartupTerminalOptions = {}
  let noGlobalState = false

  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]

    if (arg === '--') {
      if (!projectArg && userArgs[i + 1]) projectArg = userArgs[i + 1]
      break
    }

    if (arg === '--no-restore') {
      terminal.noRestore = true
      continue
    }

    if (arg === '--no-global-state') {
      noGlobalState = true
      continue
    }

    if (arg === '--project') {
      projectArg = userArgs[++i] ?? null
      continue
    }

    if (arg.startsWith('--project=')) {
      projectArg = arg.slice('--project='.length)
      continue
    }

    if (arg === '--cli') {
      terminal.toolId = userArgs[++i]
      continue
    }

    if (arg.startsWith('--cli=')) {
      terminal.toolId = arg.slice('--cli='.length)
      continue
    }

    if (arg.startsWith('--')) {
      continue
    }

    if (!projectArg) projectArg = arg
  }

  if (projectArg) {
    const projectPath = resolveProjectPath(projectArg, cwd)
    if (projectPath) return { projectPath, terminal, noGlobalState }
  }

  // cwd with .aide/ is recognized as a previously-opened AIDE project.
  if (existsSync(join(cwd, '.aide'))) return { projectPath: cwd, terminal, noGlobalState }

  return { projectPath: null, terminal, noGlobalState }
}
