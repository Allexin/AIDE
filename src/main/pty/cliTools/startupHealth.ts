/**
 * Readiness of a full-screen TUI started through PowerShell in a ConPTY.
 *
 * ConPTY emits CSI sequences (and even shows the cursor) the moment PowerShell
 * starts, seconds before the CLI exists, so any CSI is no proof — input written
 * then can be lost. The TUI is ready for input once it has entered the
 * alternate screen and then shown the cursor in its prompt box.
 */
export function tuiReadyForInput(accumulated: string): boolean {
  const altScreen = accumulated.indexOf('\x1b[?1049h')
  return altScreen !== -1 && accumulated.indexOf('\x1b[?25h', altScreen) !== -1
}
