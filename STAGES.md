# AIDE — Stage Completion Log

## Stage 11 — Menu Bar + Command Registry
- Native menu set via `Menu.setApplicationMenu`
- File menu: New Window, Open Folder…, Open Recent (submenu from recentProjects), Exit
- Edit menu: Undo, Redo, Cut, Copy, Paste — enabled when a file is open in the editor
- Command registry: `src/main/menu/commandRegistry.ts` — named commands for future hotkey binding
- Per-window file-open state tracked in `menu/index.ts`; menu rebuilt on state change
- Running-processes check before project switch (same dialog as window close guard)
- Project switch closes current editor window and opens new editor in its place
- Edit commands routed via IPC: main → `menu:edit-command` → renderer → Monaco trigger
- Renderer notifies main via `menu:editor-file-changed` IPC on file open/close
