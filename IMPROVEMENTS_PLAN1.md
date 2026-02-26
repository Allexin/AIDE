# AIDE — Improvements & Bug Fixes Plan

Each batch is self-contained. After each batch: `npm run typecheck` → `npm run build` → user confirms → commit.

---

## Batch A — Quick Wins

### A1. Fix: Open Recent / Open Folder для текущего проекта

**Баг:** File → Open Recent (или Open Folder) для уже открытого проекта закрывает его и открывает заново.

**Фикс:** В `src/main/menu/index.ts` перед project switch сравниваем выбранный путь с `currentProjectPath`. Если равны — вызываем `win.focus()` и выходим, никакого switch не происходит.

**Файлы:** `src/main/menu/index.ts`

---

### A2. Fix: Терминал теряет фокус после вставки через контекстное меню

**Баг:** После Paste через правый клик терминал теряет фокус — нужно снова кликать мышью.

**Фикс:** В `TerminalPanel.tsx` после записи вставленного текста в PTY вызываем `xterm.focus()`. Если меню ещё не успело закрыться — `setTimeout(() => xterm.focus(), 0)`.

**Файлы:** `src/renderer/src/components/layout/TerminalPanel.tsx`

---

### A3. Иконка приложения

**Задача:** Установить `app_icon.ico` как иконку приложения в dev и prod.

**Реализация:**
- Создать `electron-builder.yml` в корне проекта:
  ```yaml
  win:
    icon: app_icon.ico
  ```
- В каждом `new BrowserWindow(...)` (editor и picker) добавить опцию:
  ```ts
  icon: join(__dirname, '../../app_icon.ico')
  ```
- Файл уже лежит в корне проекта. Замена `app_icon.ico` → автоматически применится в следующем билде.

**Файлы:** `electron-builder.yml` (новый), `src/main/windows/index.ts`

---

## Batch B — Контекстное меню файлов

### B1. Четыре новых пункта в контекстном меню файлового дерева

Все пункты добавляются в `FileTreeColumn.tsx` (right-click menu на файлах).

#### "Открыть в проводнике"
- IPC → main: `shell.showItemInFolder(absolutePath)`
- Windows Explorer открывает папку с выделенным файлом.

#### "Добавить в контекст Клода"
- Определяем путь: если файл находится внутри `projectRoot` → `@relative/path`, иначе → абсолютный путь.
- IPC → main: `pty:write-to-active` → пишем строку в активный PTY tab.
- Добавляем пробел в конце: `@src/foo/bar.ts ` — чтобы пользователь мог сразу продолжить.

#### "Удалить файл"
- Показываем confirm-диалог прямо в рендерере: *"Удалить `filename`? Это действие нельзя отменить."* — кнопки **Удалить** / **Отмена**.
- На confirm: IPC → main → `fs.unlink(absolutePath)`.
- FS-вотчер автоматически убирает файл из дерева и закрывает редактор если файл был открыт.

#### "Переименовать"
- Показываем input-диалог: поле ввода, предзаполненное текущим именем файла (без пути).
- На confirm: IPC → main → `fs.rename(absolutePath, newAbsolutePath)` (в той же директории).
- FS-вотчер автоматически обновляет дерево (удаление старого имени + появление нового). Если файл был открыт в редакторе — закрываем его (удалённое имя) и открываем новое.

#### "Дублировать файл"
- Показываем input-диалог: поле ввода, предзаполненное `<name>_Copy.<ext>` (например, `App_Copy.tsx`).
- На confirm: IPC → main → `fs.copyFile(src, destInSameDir)`.
- FS-вотчер автоматически добавляет новый файл в дерево.

**Новые IPC-хендлеры:**
- `shell:show-item-in-folder` → `shell.showItemInFolder(path)`
- `pty:write-to-active` → запись строки в активный PTY tab
- `fs:delete-file` → `fs.unlink(path)`
- `fs:rename-file` → `fs.rename(oldPath, newPath)`
- `fs:copy-file` → `fs.copyFile(src, dest)`

**Файлы:**
- `src/renderer/src/components/layout/FileTreeColumn.tsx`
- `src/main/ipc/index.ts`
- `src/preload/editor.ts`

---

## Batch C — Drag & Drop в терминал

### C1. Перетаскивание файлов в терминал из проводника и файлового дерева

**Цель:** Дроп файла в область терминала пишет путь в PTY stdin — как и подсказывает Claude Code.

**Правило пути:** файл из `projectRoot` → `@relative/path`; файл снаружи → абсолютный путь.

**Из Windows Explorer (внешний drag):**
- На контейнере xterm в `TerminalPanel.tsx`: `onDragOver` (preventDefault), `onDrop`.
- В `onDrop`: читаем `event.dataTransfer.files`. В Electron `file.path` даёт абсолютный путь.
- Вычисляем относительный путь если файл внутри проекта, иначе абсолютный.
- Пишем путь в активный PTY через `pty:write-to-active`, добавляем пробел.
- После записи вызываем `xterm.focus()`.

**Из файлового дерева (внутренний drag):**
- На каждом файловом узле в `FileTreeColumn.tsx`: `draggable={true}`, `onDragStart` → `event.dataTransfer.setData('aide/absolute-path', absolutePath)`.
- `onDrop` в терминале проверяет `dataTransfer.getData('aide/absolute-path')` первым; если есть — берёт оттуда.
- Вычисляем путь по тому же правилу (файл внутри проекта → relative, снаружи → absolute). Для файлов из файлового дерева всегда будет relative.

**Файлы:**
- `src/renderer/src/components/layout/TerminalPanel.tsx`
- `src/renderer/src/components/layout/FileTreeColumn.tsx`
- `src/main/ipc/index.ts` (реиспользуем `pty:write-to-active`)
- `src/preload/editor.ts`

---

## Batch D — Названия вкладок терминала

### D1. Использовать xterm.js `onTitleChange` вместо JSONL slug

**Проблема:** Текущие slug'и читаются из JSONL-файлов и содержат внутренние идентификаторы. Claude Code при работе выставляет читаемые названия через стандартные VT escape-последовательности — так же, как в нативном PowerShell.

**Подтверждено:** заголовок PowerShell меняется при работе с Claude Code → значит он шлёт `ESC]0;title\007`.

**Решение:**
- В `TerminalPanel.tsx`, при создании каждого xterm-инстанса подписываемся: `xterm.onTitleChange(title => updateTabLabel(tabId, title))`.
- Когда приходит title — обновляем метку вкладки в локальном стейте (не нужно IPC в main).
- JSONL slug остаётся как начальное значение до первого `onTitleChange`. После этого title-события имеют приоритет.
- Старую логику просмотра JSONL для slug можно оставить как fallback или убрать — по результату тестирования.

**Файлы:** `src/renderer/src/components/layout/TerminalPanel.tsx`

---

## Batch E — Абстракция CLI-инструментов

### E1. Отвязать PTY Manager от Claude Code

**Цель:** Сделать ядро tool-agnostic. Всё Claude-специфичное выносится в отдельный модуль. В будущем — добавить Aider или OpenCoder = реализовать один интерфейс.

**Также:** везде при запуске Claude Code добавляем флаг `--dangerously-skip-permissions` — убирает prompt доверия к проекту.

**Интерфейс `CliTool`:**

```typescript
// src/main/pty/cliTools/types.ts

export interface CliSession {
  sessionId: string
  slug: string        // человекочитаемое имя (fallback до title escape)
  lastModified: Date
}

export interface CliTool {
  readonly id: string
  readonly name: string  // "Claude Code", "Aider", ...

  /** Найти существующие сессии для проекта на диске */
  scanSessions(projectPath: string): Promise<CliSession[]>

  /** Команда для resume сессии */
  resumeCommand(sessionId: string): string

  /** Команда для новой сессии */
  newSessionCommand(): string

  /** Следить за появлением новых сессий (например, новый .jsonl файл) */
  watchForNewSessions(
    projectPath: string,
    onNew: (session: CliSession) => void
  ): () => void  // returns unsubscribe

  /** Следить за обновлением label сессии (опционально) */
  watchSessionLabel?(
    projectPath: string,
    sessionId: string,
    onLabel: (label: string) => void
  ): () => void
}
```

**`ClaudeCodeTool` реализация:**
- `scanSessions` ← текущий `scanSessions()` из `sessionScanner.ts`
- `resumeCommand(id)` → `'claude --resume <id> --dangerously-skip-permissions'`
- `newSessionCommand()` → `'claude --dangerously-skip-permissions'`
- `watchForNewSessions` ← текущий `watchSessionsDir()` из `sessionScanner.ts`
- `watchSessionLabel` ← текущая JSONL-watch логика

**Рефакторинг `PtyManager`:**
- Конструктор принимает `CliTool` (дефолт — `claudeCodeTool`)
- Все строки `'claude'`, `'claude --resume'`, пути к JSONL → удаляются из `PtyManager`
- `PtyManager` работает только через методы интерфейса

**Новые файлы:**
- `src/main/pty/cliTools/types.ts`
- `src/main/pty/cliTools/claudeCode.ts` (извлечено из `sessionScanner.ts` + `ptyManager.ts`)

**Изменённые файлы:**
- `src/main/pty/ptyManager.ts`
- `src/main/pty/sessionScanner.ts` (либо остаётся вспомогательным, либо удаляется)

---

## Batch F — Улучшения тулбара

### F1. Hot reload конфига тулбара

**Задача:** При изменении `aide/toolbar.json` или `.aide/toolbar.json` тулбар обновляется без перезапуска.

**Реализация:**
- В `src/main/toolbar/` добавляем `fs.watch` на оба файла (если существуют).
- При изменении: перечитываем и мержим конфиги → шлём в рендерер IPC-событие `toolbar:config-updated` с новым списком кнопок.
- Рендерер в `MainToolbar.tsx` / `useToolbarStore` подписывается и обновляет стейт.
- Если процесс кнопки запущен в момент изменения конфига — процесс продолжает работать, обновляется только визуальное представление кнопки.

**Файлы:**
- `src/main/toolbar/` (watcher)
- `src/renderer/src/store/useToolbarStore.ts`
- `src/preload/editor.ts`

---

### F2. Автодеплой документации тулбара

**Задача:** При каждом открытии проекта гарантировать наличие актуальной документации в `aide/docs/toolbar.md`.

**Реализация:**
- Документ `toolbar.md` хранится как статический ресурс внутри приложения: `resources/docs/toolbar.md`.
- При открытии проекта: сравниваем содержимое bundled-документа с `<projectRoot>/aide/docs/toolbar.md` (hash или string compare).
- Если отличается или отсутствует → пишем bundled-версию в проект (создаём `aide/docs/` если нужно). Молча, без уведомлений.
- Документ покрывает: `aide/toolbar.json` vs `.aide/toolbar.json`, все поля кнопки, `${projectRoot}`, форматы иконок, логику мержа.

**Файлы:**
- `resources/docs/toolbar.md` (новый)
- `src/main/index.ts` или хендлер project-open

---

### F3. AI-помощник в диалоге настройки тулбара

**Задача:** Добавить в `PresetDialog` текстовое поле, через которое пользователь может попросить Claude Code добавить/настроить кнопки тулбара.

**UI — добавляем в низ `PresetDialog`:**
```
────────────────────────────────────────────────
Попросить Claude Code настроить тулбар:
┌──────────────────────────────────────────────┐
│ Добавь кнопку для запуска Jest тестов        │
└──────────────────────────────────────────────┘
                            [ Спросить Claude Code ]
```

**Поведение по клику "Спросить Claude Code":**
1. Валидируем — поле не пустое.
2. Закрываем диалог тулбара.
3. Стартуем **новую** Claude Code сессию (не resume) с флагом `--dangerously-skip-permissions`.
4. Переключаем активную вкладку терминала на новую сессию.
5. После инициализации сессии (небольшая задержка) автоматически пишем в PTY stdin prompt:
   ```
   Please read aide/docs/toolbar.md to understand the toolbar configuration format, then help with:

   <текст пользователя>
   ```

**Файлы:**
- `src/renderer/src/components/layout/MainToolbar.tsx` (добавление в `PresetDialog`)
- `src/main/pty/ptyManager.ts` (метод для записи initial prompt после spawn)
- `src/preload/editor.ts`

---

## Порядок реализации

| Batch | Содержание | Сложность |
|---|---|---|
| **A** | A1 Open Recent fix, A2 terminal focus, A3 app icon | Низкая |
| **B** | B1 Контекстное меню (4 пункта) | Средняя |
| **D** | D1 Tab naming через onTitleChange | Низкая |
| **C** | C1 Drag & drop в терминал | Средняя |
| **E** | E1 CLI tool abstraction | Высокая |
| **F** | F1 hot reload, F2 docs, F3 AI-помощник | Средняя–Высокая |

**Рекомендация:** начать с A (всё мелкое и независимое), потом B+D (оба затрагивают терминал и файловое дерево), затем C, потом E как отдельный крупный рефакторинг, потом F.
