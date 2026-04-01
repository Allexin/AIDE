# Спецификация: добавление нового CLI Tool в AIDE

Этот документ — полное руководство по реализации нового AI CLI Tool (например, Aider, Gemini CLI, Codex и т.д.) с нуля. Следуя ему, можно добавить поддержку любого инструмента без изменения существующей логики AIDE.

---

## Оглавление

1. [Архитектура системы CLI Tools](#1-архитектура-системы-cli-tools)
2. [Интерфейс CliTool — полный справочник](#2-интерфейс-clitool--полный-справочник)
3. [Минимальная реализация](#3-минимальная-реализация)
4. [Управление сессиями на диске](#4-управление-сессиями-на-диске)
5. [Полная реализация — каждый метод](#5-полная-реализация--каждый-метод)
6. [Регистрация инструмента](#6-регистрация-инструмента)
7. [Настройки (Settings)](#7-настройки-settings)
8. [Аккаунты (Accounts)](#8-аккаунты-accounts)
9. [Чеклист реализации](#9-чеклист-реализации)

---

## 1. Архитектура системы CLI Tools

### Как работает система

Каждый CLI Tool — это объект, реализующий интерфейс `CliTool` (`src/main/pty/cliTools/types.ts`). AIDE управляет этими объектами через единый реестр (`registry.ts`). Пользователь активирует инструменты через UI (Tools → Manage CLI Tools), после чего AIDE использует их для создания PTY-сессий в терминальных вкладках.

### Жизненный цикл сессии

```
Пользователь нажимает "New Session"
    │
    ▼
PtyManager.createNewSessionTab(toolId)
    │
    ├─ tool.prepareProject(projectPath)   // однократная подготовка (если нужна)
    │
    ├─ spawn PowerShell PTY
    │
    ├─ write tool.newSessionCommand()     // запуск CLI в PTY
    │
    ├─ tool.checkStartupHealth(output)    // мониторинг готовности
    │
    └─ tool.watchForNewSessions()         // ожидание файла сессии на диске
           │
           └─ sessionId → tab.sessionId присвоен
```

### Жизненный цикл восстановления сессии

```
Проект открыт, есть сохранённые сессии
    │
    ▼
PtyManager.createInitialTabs(saved[])
    │
    └─ для каждой saved[i]:
         tool = getToolById(saved[i].toolId)
         │
         ├─ tool.prepareProject(projectPath)
         │
         ├─ spawn PowerShell PTY
         │
         └─ write tool.resumeCommand(saved[i].sessionId)
```

### Файловая структура

```
src/main/pty/cliTools/
  types.ts            — интерфейс CliTool, SettingsField, UsageInfo
  registry.ts         — реестр инструментов, getDefaultTool()
  claudeCode.ts       — эталонная реализация (Claude Code)
  claudeCodeScanner.ts — сканер сессий на диске (специфично для Claude Code)
  plainShell.ts       — встроенный fallback (Terminal)
  cliLogger.ts        — утилита логирования

  yourTool.ts         ← НОВЫЙ ФАЙЛ (твоя реализация)
```

---

## 2. Интерфейс CliTool — полный справочник

Полный интерфейс (`src/main/pty/cliTools/types.ts`):

### Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | `string` | Стабильный машинный идентификатор. Хранится в `aide-state.json` и `.aide/settings.json`. **Никогда не менять после публикации.** Пример: `'aider'`, `'gemini-cli'` |
| `name` | `string` | Человекочитаемое имя. Показывается в UI. Пример: `'Aider'`, `'Gemini CLI'` |

### Обязательные методы

| Метод | Сигнатура | Описание |
|-------|-----------|----------|
| `isInstalled` | `() => Promise<boolean>` | Проверяет наличие бинарника в системе. Вызывается при активации инструмента в UI. **Не кешировать.** |
| `newSessionCommand` | `() => string` | Команда, которая записывается в PTY stdin для запуска нового сеанса. Например: `'aider'`. |
| `resumeCommand` | `(sessionId: string) => string` | Команда для возобновления существующего сеанса по его ID. |
| `scanSessions` | `(projectPath: string) => Promise<CliSession[]>` | Сканирует диск и возвращает список существующих сессий для проекта. Сортировка: новые первые. |
| `watchForNewSessions` | `(projectPath, onNew) => () => void` | Подписывается на появление новых файлов сессий на диске. Возвращает функцию отписки. |

### Опциональные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `installUrl` | `string` | Ссылка на инструкцию по установке. Показывается в CLI Tools Manager рядом с кнопкой Activate. |

### Опциональные методы — запуск и рантайм

| Метод | Сигнатура | Описание |
|-------|-----------|----------|
| `prepareProject` | `(projectPath) => Promise<void>` | Однократная подготовка перед первым сеансом. Например: запись config-файла, чтобы CLI не спрашивал разрешений. |
| `checkStartupHealth` | `(accumulated, elapsedMs) => 'ok' \| 'dead' \| 'pending'` | Анализирует накопленный вывод PTY. Возвращает `'ok'` когда CLI готов, `'dead'` при фатальной ошибке. |
| `getEnvOverrides` | `() => Record<string, string>` | Переменные окружения, которые добавляются в PTY при каждом spawn. |
| `resolveOwnerPid` | `(candidatePids: number[]) => Promise<number \| null>` | При наличии нескольких вкладок определяет, какая PTY-вкладка породила новый файл сессии. |
| `watchSessionLabel` | `(projectPath, sessionId, onLabel) => () => void` | Стримит обновления заголовка для запущенной сессии. |
| `detectTitleEvent` | `(prevTitle, newTitle) => string \| null` | Возвращает имя события при смене OSC-заголовка терминала. |
| `contextInsert` | `(relPath: string) => string \| null` | Возвращает текст для вставки в терминал при добавлении файла в контекст AI. Если `null` — пункт меню скрыт. |
| `getSessionPreview` | `(projectPath, sessionId) => Promise<[{role, text}]>` | Последние сообщения сессии для предпросмотра в Session Picker. |
| `getSessionFilePath` | `(projectPath, sessionId) => string \| null` | Путь к файлу данных сессии. Используется `ThinkingWatcher`. |

### Опциональные методы — настройки

| Метод | Сигнатура | Описание |
|-------|-----------|----------|
| `settingsFields` | `() => SettingsField[]` | Описание полей для отображения в Settings UI. |
| `getSettings` | `() => Promise<Record<string, unknown>>` | Загружает текущие значения настроек. |
| `updateSettings` | `(values) => Promise<void>` | Сохраняет обновлённые настройки. |

### Опциональные методы — аккаунты

| Метод | Сигнатура | Описание |
|-------|-----------|----------|
| `isLoggedIn` | `() => Promise<boolean>` | Проверяет, авторизован ли пользователь. |
| `getLoginIdentifier` | `() => Promise<string \| null>` | Возвращает email или username. |
| `credentialsMatch` | `(saved) => Promise<boolean>` | Проверяет совпадение сохранённых credentials с текущими. |
| `exportCredentials` | `() => Promise<Record<string, unknown> \| null>` | Экспортирует текущие credentials в сериализуемый объект. |
| `importCredentials` | `(credentials) => Promise<void>` | Восстанавливает сохранённые credentials. |
| `clearCredentials` | `() => Promise<void>` | Удаляет локальные credentials (без revoke на сервере). |
| `getUsageInfo` | `() => Promise<UsageInfo \| null>` | Возвращает данные об использовании для статусной строки. |

---

## 3. Минимальная реализация

Минимальный набор для полностью работающего инструмента — только обязательные члены. Пример для гипотетического инструмента `mytool`:

```typescript
// src/main/pty/cliTools/myTool.ts
import { execFile } from 'child_process'
import type { CliTool, CliSession } from './types'

const TOOL_ID = 'my-tool'
const TOOL_NAME = 'My Tool'

export const myTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,

  installUrl: 'https://example.com/install',

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      // Используй 'where' (Windows) для поиска бинарника в PATH
      execFile('where', ['mytool'], { timeout: 3000 }, (err) => resolve(!err))
    })
  },

  newSessionCommand(): string {
    // Команда, которая запускает сеанс в PTY
    return 'mytool'
  },

  resumeCommand(sessionId: string): string {
    // Команда для продолжения сохранённой сессии
    return `mytool --resume ${sessionId}`
  },

  async scanSessions(_projectPath: string): Promise<CliSession[]> {
    // Если инструмент не хранит сессии на диске — вернуть []
    return []
  },

  watchForNewSessions(_projectPath: string, _onNew: (session: CliSession) => void): () => void {
    // Если сессии не хранятся — вернуть no-op
    return () => {}
  }
}
```

После создания файла — **зарегистрировать** в `registry.ts` (см. [раздел 6](#6-регистрация-инструмента)).

---

## 4. Управление сессиями на диске

Большинство CLI хранят сессии в виде файлов. Ниже — паттерны реализации для двух сценариев.

### Сценарий A: инструмент НЕ хранит сессии (stateless)

Если CLI не имеет понятия "сессий" или возобновляемых разговоров:

```typescript
async scanSessions(_projectPath: string): Promise<CliSession[]> {
  return []
},

watchForNewSessions(_projectPath, _onNew) {
  return () => {}
},

resumeCommand(_sessionId: string): string {
  // Игнорируем sessionId — всегда стартуем заново
  return 'mytool'
}
```

### Сценарий B: инструмент хранит сессии в файлах

Типичный паттерн: файлы `~/.mytool/sessions/<sessionId>.json` или аналогичные.

```typescript
import { existsSync, readdirSync, statSync, watch } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function getSessionsDir(projectPath: string): string {
  // Директория, специфичная для проекта
  const encoded = projectPath.replace(/[:\\\/]/g, '-')
  return join(homedir(), '.mytool', 'sessions', encoded)
}

async scanSessions(projectPath: string): Promise<CliSession[]> {
  const dir = getSessionsDir(projectPath)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const sessions: CliSession[] = []

  for (const file of files) {
    const filePath = join(dir, file)
    const stat = statSync(filePath)
    const sessionId = file.replace('.json', '')

    sessions.push({
      sessionId,
      slug: TOOL_NAME,           // fallback-заголовок до получения OSC-заголовка
      lastModified: stat.mtime
    })
  }

  // Сортировка: новые первые
  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
},

watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
  const dir = getSessionsDir(projectPath)

  // Убедиться, что директория существует перед watch
  if (!existsSync(dir)) {
    // Папки ещё нет — возвращаем no-op; AIDE вызовет scanSessions позже
    return () => {}
  }

  const watcher = watch(dir, (event, filename) => {
    if (event !== 'rename' || !filename?.endsWith('.json')) return
    const filePath = join(dir, filename)
    if (!existsSync(filePath)) return // удаление файла, а не создание

    const sessionId = filename.replace('.json', '')
    onNew({
      sessionId,
      slug: TOOL_NAME,
      lastModified: new Date()
    })
  })

  return () => watcher.close()
}
```

### Тип CliSession

```typescript
interface CliSession {
  sessionId: string       // уникальный ID (передаётся в resumeCommand)
  slug: string            // начальный заголовок вкладки
  summary?: string        // AI-сгенерированный заголовок (опционально)
  lastModified: Date      // для сортировки
}
```

---

## 5. Полная реализация — каждый метод

### `prepareProject`

Вызывается **один раз** перед первым сеансом для данного проекта (и при восстановлении сессий). Используется для:
- Записи config-файла, чтобы CLI не показывал диалоги подтверждения
- Создания нужных директорий

```typescript
async prepareProject(projectPath: string): Promise<void> {
  const configPath = join(homedir(), '.mytool', 'trustedProjects.json')
  let config: Record<string, boolean> = {}

  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  if (config[projectPath] !== true) {
    config[projectPath] = true
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }
}
```

### `checkStartupHealth`

Анализирует накопленный вывод PTY. AIDE вызывает этот метод периодически пока статус `'pending'`.

```typescript
checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
  // Обнаружение фатальной ошибки по выводу
  if (accumulated.includes('command not found')) return 'dead'
  if (accumulated.includes('Error: ')) return 'dead'

  // Обнаружение готовности по выводу
  if (accumulated.includes('> ')) return 'ok'          // prompt появился
  if (accumulated.includes('My Tool v')) return 'ok'   // banner распарсен

  // Таймаут — считать готовым через 15 секунд
  if (elapsedMs > 15000) return 'ok'

  return 'pending'
}
```

**Важно:** Возвращай `'dead'` только при явных признаках ошибки. При сомнениях — `'pending'` вплоть до таймаута.

### `getEnvOverrides`

Возвращает объект с переменными окружения, которые мержатся с окружением PTY при каждом spawn.

```typescript
getEnvOverrides(): Record<string, string> {
  const proxy = getToolConfig(TOOL_ID).proxy as string
  if (!proxy) return {}
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy
  }
}
```

### `resolveOwnerPid`

Нужен только если несколько вкладок могут одновременно ждать новую сессию. Определяет, какой PTY-процесс породил новый файл сессии.

```typescript
async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
  // Запросить дерево процессов через PowerShell
  const json = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command',
       'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { timeout: 5000 },
      (err, stdout) => err ? reject(err) : resolve(stdout.trim())
    )
  })

  const allProcs = JSON.parse(json) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>
  const parentMap = new Map(allProcs.map(p => [p.ProcessId, p.ParentProcessId]))
  const pidSet = new Set(candidatePids)

  for (const proc of allProcs) {
    if (!proc.Name.toLowerCase().startsWith('mytool')) continue
    // Подняться по дереву процессов до одного из candidatePids
    let pid = proc.ParentProcessId
    while (pid) {
      if (pidSet.has(pid)) return pid
      pid = parentMap.get(pid) ?? 0
    }
  }
  return null
}
```

### `detectTitleEvent`

Вызывается при каждом изменении OSC-заголовка терминала. Используется для звуковых уведомлений и индикации завершения.

```typescript
detectTitleEvent(prevTitle: string | null, newTitle: string): string | null {
  // prevTitle === null — первое присвоение при старте, игнорировать
  if (prevTitle === null) return null

  // Пример: инструмент показывает "✓ Ready" когда закончил
  if (!prevTitle.startsWith('✓') && newTitle.startsWith('✓')) {
    return 'completeAndWait'   // стандартное имя события — триггерит звук в toolbar
  }
  return null
}
```

**Стандартные имена событий:** `'completeAndWait'` — используется для звукового уведомления о завершении задачи. Можно возвращать любые строки — они логируются, но только `'completeAndWait'` обрабатывается toolbar-звуковой системой.

### `contextInsert`

Возвращает текст для вставки в терминал при выборе "Add to context" в файловом дереве.

```typescript
contextInsert(relPath: string): string | null {
  // Claude Code: "@src/file.ts"
  // Aider: "/add src/file.ts"
  // Если инструмент не поддерживает — вернуть null (пункт меню скрыт)
  return `/add ${relPath}`
}
```

### `getSessionPreview`

Возвращает последние сообщения для предпросмотра в Session Picker.

```typescript
async getSessionPreview(
  projectPath: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const filePath = join(getSessionsDir(projectPath), `${sessionId}.json`)
  if (!existsSync(filePath)) return []

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    // Вернуть последние 3 сообщения
    return (data.messages ?? []).slice(-3).map((m: { role: string; content: string }) => ({
      role: m.role as 'user' | 'assistant',
      text: m.content.slice(0, 200)
    }))
  } catch {
    return []
  }
}
```

### `getSessionFilePath`

Путь к файлу сессии. Используется `ThinkingWatcher` для отслеживания состояния "мышления" AI.

```typescript
getSessionFilePath(projectPath: string, sessionId: string): string | null {
  return join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
  // Вернуть null, если инструмент не использует файловое хранилище
}
```

---

## 6. Регистрация инструмента

Единственное место, где нужно зарегистрировать новый инструмент:

**`src/main/pty/cliTools/registry.ts`**

```typescript
import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'
import { myTool } from './myTool'           // ← добавить import
import { plainShellTool } from './plainShell'

/** AI CLI tools that users can activate. */
const cliToolRegistry: CliTool[] = [
  claudeCodeTool,
  myTool,           // ← добавить в массив
]

const builtinTools: CliTool[] = [plainShellTool]

export function getRegisteredTools(): CliTool[] {
  return cliToolRegistry
}

export function getToolById(id: string): CliTool | undefined {
  return [...cliToolRegistry, ...builtinTools].find((t) => t.id === id)
}

export function getDefaultTool(activatedTools: string[]): CliTool {
  const first = cliToolRegistry.find((t) => activatedTools.includes(t.id))
  return first ?? plainShellTool
}
```

После регистрации инструмент появится в CLI Tools Manager (Tools → Manage CLI Tools) и будет доступен для активации.

---

## 7. Настройки (Settings)

Если инструмент имеет конфигурируемые параметры, реализуй три метода: `settingsFields`, `getSettings`, `updateSettings`. AIDE отобразит секцию в Settings UI автоматически.

### Хранение настроек

Используй встроенную систему хранения конфигурации инструментов:

```typescript
// src/main/config/appConfig.ts — уже существует
import { getToolConfig, updateToolConfig } from '../../config/appConfig'

const TOOL_ID = 'my-tool'

async getSettings(): Promise<Record<string, unknown>> {
  return getToolConfig(TOOL_ID)
  // Данные хранятся в aide-config.json (Electron userData) под ключом tools['my-tool']
},

async updateSettings(values: Record<string, unknown>): Promise<void> {
  updateToolConfig(TOOL_ID, values)
}
```

### Описание полей

```typescript
import type { SettingsField } from './types'

settingsFields(): SettingsField[] {
  return [
    {
      key: 'apiKey',
      label: 'API Key',
      description: 'Your My Tool API key from https://example.com/settings',
      type: 'password',          // скрывает значение в UI
    },
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'model-fast', label: 'Fast (cheaper)' },
        { value: 'model-smart', label: 'Smart (more capable)' },
      ],
      default: 'model-fast'
    },
    {
      key: 'proxy',
      label: 'Proxy address',
      description: 'Leave empty to use no proxy (e.g. http://127.0.0.1:1080)',
      type: 'string',
      default: ''
    },
    {
      key: 'verbose',
      label: 'Verbose output',
      type: 'boolean',
      default: false
    }
  ]
}
```

### Типы полей (`SettingsField.type`)

| Тип | Рендеринг | Примечание |
|-----|-----------|------------|
| `'string'` | Text input | |
| `'password'` | Password input | Значение скрыто |
| `'boolean'` | Checkbox | |
| `'number'` | Number input | |
| `'select'` | Dropdown | Требует `options` |

### Использование настроек в getEnvOverrides

```typescript
getEnvOverrides(): Record<string, string> {
  const config = getToolConfig(TOOL_ID)
  const env: Record<string, string> = {}

  const apiKey = config.apiKey as string
  if (apiKey) env['MYTOOL_API_KEY'] = apiKey

  const proxy = config.proxy as string
  if (proxy) {
    env['HTTP_PROXY'] = proxy
    env['HTTPS_PROXY'] = proxy
  }

  return env
}
```

---

## 8. Аккаунты (Accounts)

Если инструмент использует аутентификацию, реализуй методы группы accounts. Они отображаются в Settings → Accounts.

### Минимальный набор

Для базового отображения статуса аутентификации достаточно:

```typescript
async isLoggedIn(): Promise<boolean> {
  // Проверить наличие токена/credentials на диске
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return false
  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    return !!auth.token
  } catch {
    return false
  }
},

async getLoginIdentifier(): Promise<string | null> {
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return null
  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    return auth.email ?? auth.username ?? null
  } catch {
    return null
  }
}
```

### Полная реализация с переключением аккаунтов

AIDE поддерживает сохранение нескольких аккаунтов. Для этого нужны четыре метода:

```typescript
/** Какие ключи из auth.json хранить как credentials */
const CREDENTIAL_KEYS = ['token', 'email', 'userId'] as const
const AUTH_PATH = join(homedir(), '.mytool', 'auth.json')

async credentialsMatch(saved: Record<string, unknown>): Promise<boolean> {
  if (!existsSync(AUTH_PATH)) return false
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    // Сравнить по стабильному уникальному полю
    return auth.userId === saved.userId
  } catch {
    return false
  }
},

async exportCredentials(): Promise<Record<string, unknown> | null> {
  if (!existsSync(AUTH_PATH)) return null
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    if (!auth.token) return null
    const creds: Record<string, unknown> = {}
    for (const key of CREDENTIAL_KEYS) {
      if (auth[key] !== undefined) creds[key] = auth[key]
    }
    return creds
  } catch {
    return null
  }
},

async importCredentials(credentials: Record<string, unknown>): Promise<void> {
  let auth: Record<string, unknown> = {}
  if (existsSync(AUTH_PATH)) {
    try { auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) } catch {}
  }
  for (const key of CREDENTIAL_KEYS) {
    if (credentials[key] !== undefined) auth[key] = credentials[key]
  }
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf-8')
},

async clearCredentials(): Promise<void> {
  if (!existsSync(AUTH_PATH)) return
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    for (const key of CREDENTIAL_KEYS) delete auth[key]
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf-8')
  } catch {}
}
```

### Usage Info (статусная строка)

Если инструмент предоставляет API для получения информации об использовании:

```typescript
async getUsageInfo(): Promise<UsageInfo | null> {
  // Простой пример без кеширования
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return null

  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    const res = await fetch('https://api.example.com/usage', {
      headers: { Authorization: `Bearer ${auth.token}` }
    })
    if (!res.ok) return null

    const data = await res.json() as { used: number; limit: number }
    const percent = Math.round((data.used / data.limit) * 100)
    const level: UsageInfo['level'] = percent >= 90 ? 'critical' : percent >= 70 ? 'warn' : 'normal'

    return {
      summary: `${percent}%`,
      tooltip: `Used: ${data.used} / ${data.limit}`,
      level,
      fetchedAt: Date.now()
    }
  } catch {
    return null
  }
}
```

**Рекомендация:** добавь кеширование (аналогично `claudeCode.ts`) и backoff при 429-ошибках — этот метод вызывается часто.

---

## 9. Чеклист реализации

### Обязательный минимум

- [ ] Создан файл `src/main/pty/cliTools/yourTool.ts`
- [ ] Реализованы все обязательные члены: `id`, `name`, `isInstalled`, `newSessionCommand`, `resumeCommand`, `scanSessions`, `watchForNewSessions`
- [ ] Инструмент добавлен в `cliToolRegistry` в `registry.ts`
- [ ] `npm run typecheck` проходит без ошибок

### Рекомендуется

- [ ] Добавлен `installUrl` — ссылка на инструкцию по установке
- [ ] Реализован `checkStartupHealth` — чтобы AIDE знал, когда CLI готов
- [ ] Реализован `prepareProject` — если CLI требует подтверждений при первом запуске
- [ ] Реализован `contextInsert` — для добавления файлов в контекст через правую кнопку

### Для инструментов с сессиями на диске

- [ ] `scanSessions` возвращает реальные данные
- [ ] `watchForNewSessions` реагирует на появление файлов
- [ ] `resumeCommand` корректно собирает команду из `sessionId`
- [ ] `getSessionFilePath` возвращает путь к файлу (для `ThinkingWatcher`)

### Для инструментов с настройками

- [ ] Реализованы `settingsFields`, `getSettings`, `updateSettings`
- [ ] Настройки используются в `getEnvOverrides` или `prepareProject`

### Для инструментов с аутентификацией

- [ ] Реализованы `isLoggedIn`, `getLoginIdentifier`
- [ ] Реализованы `exportCredentials`, `importCredentials`, `clearCredentials` (для переключения аккаунтов)
- [ ] Реализован `credentialsMatch` (для корректного определения активного аккаунта)

### Финальная проверка

- [ ] `npm run typecheck` проходит
- [ ] `npm run build` проходит
- [ ] Инструмент появляется в Tools → Manage CLI Tools
- [ ] Activate → `isInstalled()` отрабатывает корректно
- [ ] New Session запускает `newSessionCommand()` в терминале
- [ ] `sessionId` присваивается вкладке после появления файла сессии
- [ ] Закрытие и переоткрытие проекта восстанавливает сессии
