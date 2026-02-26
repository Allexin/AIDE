type CommandHandler = () => void | Promise<void>

const registry = new Map<string, CommandHandler>()

export function registerCommand(id: string, handler: CommandHandler): void {
  registry.set(id, handler)
}

export function executeCommand(id: string): void {
  const handler = registry.get(id)
  if (handler) {
    Promise.resolve(handler()).catch(console.error)
  }
}
