"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const utils = require("@electron-toolkit/utils");
const child_process = require("child_process");
const util = require("util");
const nodePty = require("node-pty");
const os = require("os");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const nodePty__namespace = /* @__PURE__ */ _interopNamespaceDefault(nodePty);
const DEFAULTS$2 = {
  editor: {
    maxFileSizeMb: 5,
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: 14,
    minimap: false,
    wordWrap: "off",
    lineNumbers: "on",
    tabSize: 2
  },
  ui: {
    fileTreeWidthPx: 220,
    logPanelExpandedHeightPx: 200
  },
  sessions: {
    maxSessionsInPicker: 20,
    maxRecentProjects: 20
  },
  git: {
    addBatchSize: 10
  }
};
let config = structuredClone(DEFAULTS$2);
let configPath = "";
function initAppConfig() {
  configPath = path.join(electron.app.getPath("userData"), "aide-config.json");
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      config = {
        ...DEFAULTS$2,
        ...parsed,
        editor: { ...DEFAULTS$2.editor, ...parsed.editor ?? {} },
        ui: { ...DEFAULTS$2.ui, ...parsed.ui ?? {} },
        sessions: { ...DEFAULTS$2.sessions, ...parsed.sessions ?? {} },
        git: { ...DEFAULTS$2.git, ...parsed.git ?? {} }
      };
    } catch {
      config = structuredClone(DEFAULTS$2);
    }
  }
}
function getAppConfig() {
  return config;
}
const DEFAULTS$1 = {
  recentProjects: []
};
let state = structuredClone(DEFAULTS$1);
let statePath = "";
function initAppState() {
  statePath = path.join(electron.app.getPath("userData"), "aide-state.json");
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      state = { ...DEFAULTS$1, ...parsed };
    } catch {
      state = structuredClone(DEFAULTS$1);
    }
  }
}
function getAppState() {
  return state;
}
function saveAppState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
function addRecentProject(projectPath, maxRecent) {
  state.recentProjects = [
    { path: projectPath, lastOpened: (/* @__PURE__ */ new Date()).toISOString() },
    ...state.recentProjects.filter((p) => p.path !== projectPath)
  ].slice(0, maxRecent);
  saveAppState();
}
function removeRecentProject(projectPath) {
  state.recentProjects = state.recentProjects.filter((p) => p.path !== projectPath);
  saveAppState();
}
function checkAndAcquireLock(projectDir) {
  const lockPath = path.join(projectDir, ".aide", "lock");
  if (fs.existsSync(lockPath)) {
    const content = fs.readFileSync(lockPath, "utf8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid) && isProcessRunning(pid)) {
      return { acquired: false, pid };
    }
  }
  fs.writeFileSync(lockPath, String(process.pid), "utf8");
  return { acquired: true };
}
function releaseLock(projectDir) {
  const lockPath = path.join(projectDir, ".aide", "lock");
  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
    }
  }
}
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function createPickerWindow() {
  const win = new electron.BrowserWindow({
    width: 500,
    height: 400,
    minWidth: 400,
    minHeight: 300,
    resizable: true,
    title: "AIDE — Open Project",
    icon: path.join(__dirname, "../../app_icon.ico"),
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "../preload/picker.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"] + "/?window=picker");
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), {
      query: { window: "picker" }
    });
  }
  return win;
}
const DEFAULTS = {
  activePanelRatio: 0.75,
  collapsedWidthPx: 20,
  fileTreeWidth: 250
};
function ensureAideDirectory(projectDir) {
  fs.mkdirSync(path.join(projectDir, ".aide"), { recursive: true });
}
function readProjectSettings(projectDir) {
  const settingsPath = path.join(projectDir, ".aide", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}
const DEFAULT_TOOLBAR = {
  projectType: "",
  buttons: [
    {
      id: "open-explorer",
      icon: "📂",
      tooltip: "Open project in Explorer",
      command: "explorer.exe .",
      cwd: "${projectRoot}"
    }
  ]
};
const PRESET_GROUPS = [
  {
    type: "general",
    label: "General",
    buttons: [
      {
        id: "open-explorer",
        icon: "📂",
        tooltip: "Open project in Explorer",
        command: "explorer.exe .",
        cwd: "${projectRoot}"
      }
    ]
  },
  {
    type: "npm",
    label: "npm",
    buttons: [
      {
        id: "npm-build",
        icon: "🔨",
        tooltip: "Build project",
        command: "npm run build",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Build Output" },
          stderr: { name: "Build Errors", attention: true }
        }
      },
      {
        id: "npm-dev",
        icon: "▶",
        tooltip: "Run dev server",
        command: "npm run dev",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Dev Server" },
          stderr: { name: "Dev Errors", attention: true }
        }
      },
      {
        id: "npm-test",
        icon: "🧪",
        tooltip: "Run tests",
        command: "npm test",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Test Output" },
          stderr: { name: "Test Errors", attention: true }
        }
      },
      {
        id: "npm-install",
        icon: "📦",
        tooltip: "Install dependencies",
        command: "npm install",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "npm install" },
          stderr: { name: "npm install errors", attention: true }
        }
      }
    ]
  },
  {
    type: "unreal",
    label: "Unreal Engine",
    buttons: [
      {
        id: "unreal-open",
        icon: "🎮",
        tooltip: "Open in UE Editor",
        // UnrealVersionSelector opens the correct engine version for this project
        command: 'cmd /c for %f in ("*.uproject") do "${unrealVersionSelector}" /editor "%~ff"',
        cwd: "${projectRoot}"
      },
      {
        id: "unreal-build",
        icon: "🔨",
        tooltip: "Build",
        // UnrealBuildTool: <ProjectName>Editor Win64 Development <project.uproject> -rocket
        command: 'cmd /c for %f in ("*.uproject") do "${unrealEngine}\\Engine\\Binaries\\DotNET\\UnrealBuildTool\\UnrealBuildTool.exe" "%~nfEditor" Win64 Development "%~ff" -rocket',
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "UE Build" },
          stderr: { name: "UE Build Errors", attention: true }
        }
      },
      {
        id: "unreal-open-vs",
        icon: "💻",
        tooltip: "Open in Visual Studio",
        command: 'cmd /c for %f in ("*.sln") do start "" "%f"',
        cwd: "${projectRoot}"
      },
      {
        id: "unreal-clear-intermediate",
        icon: "🗑",
        tooltip: "Clear Intermediate",
        // Removes build artifacts: Intermediate, DerivedDataCache, Saved, Binaries, .vs, Build,
        // Script, *.sln, and Intermediate inside each plugin folder.
        command: `powershell -NoProfile -Command "$dirs = @('Intermediate','DerivedDataCache','Saved','Binaries','.vs','Build','Script'); foreach ($d in $dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }; if (Test-Path 'Plugins') { Get-ChildItem 'Plugins' -Directory | ForEach-Object { $i = Join-Path $_.FullName 'Intermediate'; if (Test-Path $i) { Remove-Item -Recurse -Force $i } } }; Get-ChildItem '*.sln' -ErrorAction SilentlyContinue | Remove-Item -Force"`,
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Clear Intermediate" },
          stderr: { name: "Clear Intermediate Errors", attention: true }
        }
      },
      {
        id: "unreal-gen-vs",
        icon: "⚙",
        tooltip: "Generate VS Files",
        command: 'cmd /c for %f in ("*.uproject") do "${unrealEngine}\\Build\\BatchFiles\\GenerateProjectFiles.bat" -project="%~ff" -game -rocket',
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Generate VS Files" },
          stderr: { name: "Generate VS Files Errors", attention: true }
        }
      }
    ]
  },
  {
    type: "unity",
    label: "Unity",
    buttons: [
      {
        id: "unity-open",
        icon: "🎮",
        tooltip: "Open in Unity Hub",
        command: 'cmd /c start "" "unityhub://open?projectPath=%cd%"',
        cwd: "${projectRoot}"
      }
    ]
  },
  {
    type: "python",
    label: "Python",
    buttons: [
      {
        id: "python-run",
        icon: "▶",
        tooltip: "Run main.py",
        command: "python main.py",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "Python Output" },
          stderr: { name: "Python Errors", attention: true }
        }
      },
      {
        id: "python-install",
        icon: "📦",
        tooltip: "Install requirements",
        command: "pip install -r requirements.txt",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "pip install" },
          stderr: { name: "pip errors", attention: true }
        }
      },
      {
        id: "python-test",
        icon: "🧪",
        tooltip: "Run pytest",
        command: "pytest",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "pytest" },
          stderr: { name: "pytest errors", attention: true }
        }
      }
    ]
  },
  {
    type: "rust",
    label: "Rust",
    buttons: [
      {
        id: "rust-build",
        icon: "🔨",
        tooltip: "Cargo build",
        command: "cargo build",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "cargo build" },
          stderr: { name: "cargo build errors", attention: true }
        }
      },
      {
        id: "rust-run",
        icon: "▶",
        tooltip: "Cargo run",
        command: "cargo run",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "cargo run" },
          stderr: { name: "cargo run errors", attention: true }
        }
      },
      {
        id: "rust-test",
        icon: "🧪",
        tooltip: "Cargo test",
        command: "cargo test",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "cargo test" },
          stderr: { name: "cargo test errors", attention: true }
        }
      },
      {
        id: "rust-check",
        icon: "✓",
        tooltip: "Cargo check",
        command: "cargo check",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "cargo check" },
          stderr: { name: "cargo check errors", attention: true }
        }
      }
    ]
  },
  {
    type: "go",
    label: "Go",
    buttons: [
      {
        id: "go-build",
        icon: "🔨",
        tooltip: "Go build",
        command: "go build ./...",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "go build" },
          stderr: { name: "go build errors", attention: true }
        }
      },
      {
        id: "go-run",
        icon: "▶",
        tooltip: "Go run",
        command: "go run .",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "go run" },
          stderr: { name: "go run errors", attention: true }
        }
      },
      {
        id: "go-test",
        icon: "🧪",
        tooltip: "Go test",
        command: "go test ./...",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "go test" },
          stderr: { name: "go test errors", attention: true }
        }
      }
    ]
  },
  {
    type: "docker",
    label: "Docker",
    buttons: [
      {
        id: "docker-build",
        icon: "🐳",
        tooltip: "Docker build",
        command: "docker build -t app .",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "docker build" },
          stderr: { name: "docker build errors", attention: true }
        }
      },
      {
        id: "docker-compose-up",
        icon: "🐳",
        tooltip: "Docker Compose up",
        command: "docker compose up",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "docker compose up" },
          stderr: { name: "docker compose errors", attention: true }
        }
      },
      {
        id: "docker-compose-down",
        icon: "🐳",
        tooltip: "Docker Compose down",
        command: "docker compose down",
        cwd: "${projectRoot}",
        channels: {
          stdout: { name: "docker compose down" },
          stderr: { name: "docker down errors", attention: true }
        }
      }
    ]
  }
];
function detectProjectType(projectDir) {
  try {
    const entries = fs.readdirSync(projectDir);
    if (entries.some((e) => e.endsWith(".uproject"))) return "unreal";
    if (entries.includes("Assets") && entries.includes("ProjectSettings")) return "unity";
  } catch {
  }
  if (fs.existsSync(path.join(projectDir, "package.json"))) return "npm";
  if (fs.existsSync(path.join(projectDir, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(projectDir, "go.mod"))) return "go";
  if (fs.existsSync(path.join(projectDir, "requirements.txt")) || fs.existsSync(path.join(projectDir, "pyproject.toml")) || fs.existsSync(path.join(projectDir, "setup.py")))
    return "python";
  if (fs.existsSync(path.join(projectDir, "Dockerfile")) || fs.existsSync(path.join(projectDir, "docker-compose.yml")))
    return "docker";
  return null;
}
function readLocalToolbarConfig(projectDir) {
  const localPath = path.join(projectDir, ".aide", "toolbar.json");
  if (!fs.existsSync(localPath)) return { projectType: "", buttons: [] };
  try {
    const raw = fs.readFileSync(localPath, "utf8");
    const config2 = JSON.parse(raw);
    return { projectType: config2.projectType ?? "", buttons: Array.isArray(config2.buttons) ? config2.buttons : [] };
  } catch {
    return { projectType: "", buttons: [] };
  }
}
function writeLocalToolbarConfig(projectDir, config2) {
  const localPath = path.join(projectDir, ".aide", "toolbar.json");
  fs.writeFileSync(localPath, JSON.stringify(config2, null, 2), "utf8");
}
function ensureDefaultToolbar(projectDir) {
  const localPath = path.join(projectDir, ".aide", "toolbar.json");
  if (!fs.existsSync(localPath)) {
    fs.writeFileSync(localPath, JSON.stringify(DEFAULT_TOOLBAR, null, 2), "utf8");
  }
}
function readToolbarButtons(projectDir) {
  const sharedPath = path.join(projectDir, "aide", "toolbar.json");
  const localPath = path.join(projectDir, ".aide", "toolbar.json");
  const readButtons = (filePath) => {
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const config2 = JSON.parse(raw);
      return Array.isArray(config2.buttons) ? config2.buttons : [];
    } catch {
      return [];
    }
  };
  const shared = readButtons(sharedPath);
  const local = readButtons(localPath);
  const merged = /* @__PURE__ */ new Map();
  for (const btn of shared) merged.set(btn.id, btn);
  for (const btn of local) merged.set(btn.id, btn);
  return [...merged.values()];
}
function ensureGitignoreEntry(projectDir, entry) {
  const gitignorePath = path.join(projectDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, entry + "\n", "utf8");
    return;
  }
  const content = fs.readFileSync(gitignorePath, "utf8");
  const lines = content.split("\n");
  if (lines.some((line) => line.trim() === entry)) {
    return;
  }
  const newContent = content.endsWith("\n") ? content + entry + "\n" : content + "\n" + entry + "\n";
  fs.writeFileSync(gitignorePath, newContent, "utf8");
}
const execFileAsync = util.promisify(child_process.execFile);
function parsePorcelain(output) {
  const changed = [];
  const deleted = [];
  const untracked = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.substring(0, 2);
    let filePath = line.substring(3);
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ")[1];
    }
    filePath = filePath.trim();
    if (!filePath) continue;
    if (xy === "??") {
      untracked.push(filePath);
    } else if (xy[0] === "D" || xy[1] === "D") {
      deleted.push(filePath);
    } else {
      changed.push(filePath);
    }
  }
  return { changed, deleted, untracked };
}
async function runGitStatus(projectPath) {
  const [statusResult, branchResult] = await Promise.allSettled([
    execFileAsync("git", ["status", "--porcelain"], {
      cwd: projectPath,
      timeout: 15e3,
      windowsHide: true
    }),
    execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectPath,
      timeout: 5e3,
      windowsHide: true
    })
  ]);
  if (statusResult.status === "rejected") {
    return { available: false, changed: [], deleted: [], untracked: [], branch: null };
  }
  const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() || null : null;
  return { available: true, ...parsePorcelain(statusResult.value.stdout), branch };
}
class GitRefreshQueue {
  running = false;
  pending = false;
  async request(projectPath, send) {
    if (this.running) {
      this.pending = true;
      return;
    }
    await this._run(projectPath, send);
  }
  async _run(projectPath, send) {
    this.running = true;
    this.pending = false;
    try {
      send(await runGitStatus(projectPath));
    } finally {
      this.running = false;
      if (this.pending) await this._run(projectPath, send);
    }
  }
}
const watchers = /* @__PURE__ */ new Map();
const DEBOUNCE_MS = 300;
function startProjectWatcher(projectPath, win) {
  if (watchers.has(projectPath)) return;
  const queue = new GitRefreshQueue();
  const entry = { watcher: null, gitIndexWatcher: null, queue, timer: null };
  const sendGit = (status) => {
    if (!win.isDestroyed()) win.webContents.send("filetree:git-status-updated", status);
  };
  const scheduleGitRefresh = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      queue.request(projectPath, sendGit);
    }, DEBOUNCE_MS);
  };
  const onFsEvent = (_event, rawFilename) => {
    if (!rawFilename) return;
    const filename = rawFilename.toString();
    if (filename.split(/[/\\]/).some((p) => p.startsWith("."))) return;
    const fullPath = path__namespace.join(projectPath, filename);
    if (!win.isDestroyed()) win.webContents.send("filetree:fs-changed", { path: fullPath });
    scheduleGitRefresh();
  };
  try {
    entry.watcher = fs__namespace.watch(projectPath, { recursive: true }, onFsEvent);
    entry.watcher.on("error", () => watchers.delete(projectPath));
    watchers.set(projectPath, entry);
  } catch {
  }
  const gitIndexPath = path__namespace.join(projectPath, ".git", "index");
  try {
    entry.gitIndexWatcher = fs__namespace.watch(gitIndexPath, () => scheduleGitRefresh());
    entry.gitIndexWatcher.on("error", () => {
      entry.gitIndexWatcher = null;
    });
  } catch {
  }
}
function stopProjectWatcher(projectPath) {
  const entry = watchers.get(projectPath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  entry.gitIndexWatcher?.close();
  watchers.delete(projectPath);
}
function encodeProjectPath(projectPath) {
  return projectPath.replace(/^([A-Za-z]):[/\\]/, "$1--").replace(/[/\\]/g, "-");
}
function getSessionsDir(projectPath) {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectPath(projectPath));
}
function readSlugFromJsonl(jsonlPath) {
  try {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.slug === "string" && obj.slug) return obj.slug;
      } catch {
      }
    }
  } catch {
  }
  return null;
}
async function scanSessions(projectPath) {
  const sessionsDir = getSessionsDir(projectPath);
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    const entries = fs.readdirSync(sessionsDir);
    const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
    const sessions = jsonlFiles.map((filename) => {
      const sessionId = filename.slice(0, -6);
      const fullPath = path.join(sessionsDir, filename);
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch {
      }
      return { sessionId, slug: readSlugFromJsonl(fullPath), mtime };
    });
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
  } catch {
    return [];
  }
}
function watchSessionsDir(sessionsDir, onNewFile) {
  let stopped = false;
  let watcher = null;
  const knownFiles = /* @__PURE__ */ new Set();
  const startWatcher = () => {
    if (stopped || !fs.existsSync(sessionsDir)) return;
    try {
      fs.readdirSync(sessionsDir).filter((e) => e.endsWith(".jsonl")).forEach((f) => knownFiles.add(f));
      watcher = fs.watch(sessionsDir, (_event, filename) => {
        if (stopped || !filename || !filename.endsWith(".jsonl")) return;
        if (!knownFiles.has(filename)) {
          knownFiles.add(filename);
          const sessionId = filename.slice(0, -6);
          const fullPath = path.join(sessionsDir, filename);
          setTimeout(() => {
            if (!stopped) onNewFile(sessionId, readSlugFromJsonl(fullPath));
          }, 300);
        }
      });
    } catch {
    }
  };
  if (fs.existsSync(sessionsDir)) {
    startWatcher();
    return () => {
      stopped = true;
      watcher?.close();
    };
  }
  const interval = setInterval(() => {
    if (stopped) {
      clearInterval(interval);
      return;
    }
    if (fs.existsSync(sessionsDir)) {
      clearInterval(interval);
      startWatcher();
    }
  }, 500);
  return () => {
    stopped = true;
    clearInterval(interval);
    watcher?.close();
  };
}
function watchJsonlFile(jsonlPath, onSlugFound) {
  let stopped = false;
  let watcher = null;
  const check = () => {
    const slug = readSlugFromJsonl(jsonlPath);
    if (slug) {
      onSlugFound(slug);
      return true;
    }
    return false;
  };
  if (check()) return () => {
  };
  if (!fs.existsSync(jsonlPath)) {
    const interval = setInterval(() => {
      if (stopped) {
        clearInterval(interval);
        return;
      }
      if (fs.existsSync(jsonlPath) && check()) {
        stopped = true;
        clearInterval(interval);
      }
    }, 1e3);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }
  try {
    watcher = fs.watch(jsonlPath, () => {
      if (stopped) return;
      if (check()) {
        stopped = true;
        watcher?.close();
      }
    });
  } catch {
  }
  return () => {
    stopped = true;
    watcher?.close();
  };
}
let tabIdCounter = 0;
function nextTabId() {
  return `tab-${++tabIdCounter}`;
}
class PtyManager {
  tabs = /* @__PURE__ */ new Map();
  win;
  projectPath;
  sessionsDir;
  constructor(win, projectPath) {
    this.win = win;
    this.projectPath = projectPath;
    this.sessionsDir = getSessionsDir(projectPath);
  }
  /** Called on project open: resume most recent session or start fresh. */
  async createInitialTab() {
    const sessions = await scanSessions(this.projectPath);
    if (sessions.length > 0) {
      const newest = sessions[0];
      return this.spawnResumeTab(newest.sessionId, newest.slug);
    }
    return this.spawnNewSessionTab();
  }
  /** Open a brand-new claude session tab. */
  async createNewSessionTab() {
    return this.spawnNewSessionTab();
  }
  /** Resume an existing session by ID. */
  async resumeSessionTab(sessionId) {
    const sessions = await scanSessions(this.projectPath);
    const existing = sessions.find((s) => s.sessionId === sessionId);
    return this.spawnResumeTab(sessionId, existing?.slug || null);
  }
  /** Get snapshot of all open tabs (safe to serialize). */
  getTabs() {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      slug: t.slug
    }));
  }
  write(tabId, data) {
    try {
      this.tabs.get(tabId)?.pty.write(data);
    } catch {
    }
  }
  resize(tabId, cols, rows) {
    try {
      if (cols > 0 && rows > 0) {
        this.tabs.get(tabId)?.pty.resize(cols, rows);
      }
    } catch {
    }
  }
  disposeAll() {
    for (const tab of this.tabs.values()) {
      tab.stopDirWatch?.();
      tab.stopJsonlWatch?.();
      try {
        tab.pty.kill();
      } catch {
      }
    }
    this.tabs.clear();
  }
  // ── Private helpers ───────────────────────────────────────────────────────
  spawnNewSessionTab() {
    const tabId = nextTabId();
    const pty = this.spawnPty(tabId);
    const tab = { tabId, sessionId: null, slug: "Claude Code", pty };
    this.tabs.set(tabId, tab);
    setTimeout(() => {
      if (!this.tabs.has(tabId)) return;
      pty.write("claude\r");
      tab.stopDirWatch = watchSessionsDir(this.sessionsDir, (newSessionId, slugFromDir) => {
        const t = this.tabs.get(tabId);
        if (!t || t.sessionId) return;
        t.sessionId = newSessionId;
        this.send("terminal:tab-session-id", { tabId, sessionId: newSessionId });
        const resolvedSlug = slugFromDir || readSlugFromJsonl(path.join(this.sessionsDir, `${newSessionId}.jsonl`));
        if (resolvedSlug) {
          t.slug = resolvedSlug;
          this.send("terminal:tab-slug-updated", { tabId, slug: resolvedSlug });
        } else {
          t.stopJsonlWatch = watchJsonlFile(
            path.join(this.sessionsDir, `${newSessionId}.jsonl`),
            (slug) => {
              const tt = this.tabs.get(tabId);
              if (!tt) return;
              tt.slug = slug;
              this.send("terminal:tab-slug-updated", { tabId, slug });
            }
          );
        }
        t.stopDirWatch?.();
        t.stopDirWatch = void 0;
      });
    }, 500);
    return { tabId, sessionId: null, slug: "Claude Code" };
  }
  spawnResumeTab(sessionId, slug) {
    const tabId = nextTabId();
    const pty = this.spawnPty(tabId);
    const resolvedSlug = slug || "Claude Code";
    const tab = { tabId, sessionId, slug: resolvedSlug, pty };
    this.tabs.set(tabId, tab);
    setTimeout(() => {
      if (!this.tabs.has(tabId)) return;
      pty.write(`claude --resume ${sessionId}\r`);
      if (!slug) {
        tab.stopJsonlWatch = watchJsonlFile(
          path.join(this.sessionsDir, `${sessionId}.jsonl`),
          (foundSlug) => {
            const t = this.tabs.get(tabId);
            if (!t) return;
            t.slug = foundSlug;
            this.send("terminal:tab-slug-updated", { tabId, slug: foundSlug });
          }
        );
      }
    }, 500);
    return { tabId, sessionId, slug: resolvedSlug };
  }
  spawnPty(tabId) {
    const pty = nodePty__namespace.spawn("powershell.exe", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env: process.env
    });
    pty.onData((data) => this.send("terminal:data", { tabId, data }));
    pty.onExit(() => this.send("terminal:tab-exited", { tabId }));
    return pty;
  }
  send(channel, data) {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
const ptyRegistry = /* @__PURE__ */ new Map();
const pickerEditorMap = /* @__PURE__ */ new Map();
function queryRegSZ(keyPath, valueName) {
  try {
    const output = child_process.execSync(`reg query "${keyPath}" /v "${valueName}"`, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const match = output.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
function getEngineAssociation(projectDir) {
  try {
    const uprojectFile = fs.readdirSync(projectDir).find((e) => e.endsWith(".uproject"));
    if (!uprojectFile) return null;
    const raw = fs.readFileSync(path.join(projectDir, uprojectFile), "utf8");
    const data = JSON.parse(raw);
    return typeof data["EngineAssociation"] === "string" ? data["EngineAssociation"] : null;
  } catch {
    return null;
  }
}
function findUnrealEngineDir(projectDir) {
  const association = getEngineAssociation(projectDir);
  if (!association) return null;
  const hklm = queryRegSZ(
    `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${association}`,
    "InstalledDirectory"
  );
  if (hklm) return hklm;
  const hkcu = queryRegSZ(
    `HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds`,
    association
  );
  if (hkcu) return hkcu;
  return null;
}
function findUnrealVersionSelector() {
  return queryRegSZ("HKCR\\Unreal.ProjectFile\\shell\\switchversion", "Icon");
}
const windowProcesses = /* @__PURE__ */ new Map();
function getMap(win) {
  if (!windowProcesses.has(win)) windowProcesses.set(win, /* @__PURE__ */ new Map());
  return windowProcesses.get(win);
}
function forceKill(proc) {
  if (proc.pid && process.platform === "win32") {
    child_process.spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {
      windowsHide: true,
      shell: false
    });
  } else {
    proc.kill("SIGTERM");
  }
}
function getRunningCount(win) {
  return getMap(win).size;
}
function spawnButtonProcess(win, button, projectRoot) {
  const map = getMap(win);
  if (map.has(button.id)) return;
  let command = button.command.replace(/\$\{projectRoot\}/g, projectRoot);
  let cwd = (button.cwd ?? "${projectRoot}").replace(/\$\{projectRoot\}/g, projectRoot);
  if (command.includes("${unrealEngine}") || cwd.includes("${unrealEngine}")) {
    const engineDir = findUnrealEngineDir(projectRoot) ?? "";
    command = command.replace(/\$\{unrealEngine\}/g, engineDir);
    cwd = cwd.replace(/\$\{unrealEngine\}/g, engineDir);
  }
  if (command.includes("${unrealVersionSelector}") || cwd.includes("${unrealVersionSelector}")) {
    const uvs = findUnrealVersionSelector() ?? "";
    command = command.replace(/\$\{unrealVersionSelector\}/g, uvs);
    cwd = cwd.replace(/\$\{unrealVersionSelector\}/g, uvs);
  }
  const proc = child_process.spawn(command, [], { cwd, shell: true, windowsHide: true });
  map.set(button.id, { proc, button });
  if (!win.isDestroyed()) {
    win.webContents.send("toolbar:process-started", { buttonId: button.id });
  }
  if (proc.stdout && button.channels?.stdout) {
    const channelName = button.channels.stdout.name;
    proc.stdout.on("data", (chunk) => {
      chunk.toString().split("\n").forEach((line) => {
        const t = line.replace(/\r$/, "");
        if (t && !win.isDestroyed()) {
          win.webContents.send("toolbar:output", { channelName, line: t, attention: false });
        }
      });
    });
  }
  if (proc.stderr && button.channels?.stderr) {
    const channelName = button.channels.stderr.name;
    const attention = button.channels.stderr.attention ?? false;
    proc.stderr.on("data", (chunk) => {
      chunk.toString().split("\n").forEach((line) => {
        const t = line.replace(/\r$/, "");
        if (t && !win.isDestroyed()) {
          win.webContents.send("toolbar:output", { channelName, line: t, attention });
        }
      });
    });
  }
  proc.on("close", (code) => {
    if (!map.has(button.id)) return;
    map.delete(button.id);
    if (!win.isDestroyed()) {
      win.webContents.send("toolbar:process-exited", { buttonId: button.id, exitCode: code });
    }
  });
  proc.on("error", (err) => {
    if (!map.has(button.id)) return;
    map.delete(button.id);
    if (!win.isDestroyed()) {
      win.webContents.send("toolbar:process-exited", { buttonId: button.id, exitCode: -1 });
      if (button.channels?.stderr) {
        win.webContents.send("toolbar:output", {
          channelName: button.channels.stderr.name,
          line: `[Error: ${err.message}]`,
          attention: button.channels.stderr.attention ?? false
        });
      }
    }
  });
}
function killButtonProcess(win, buttonId) {
  const map = getMap(win);
  const entry = map.get(buttonId);
  if (!entry) return;
  map.delete(buttonId);
  forceKill(entry.proc);
  if (!win.isDestroyed()) {
    win.webContents.send("toolbar:process-exited", { buttonId, exitCode: null });
  }
}
function killAllProcesses(win) {
  const map = getMap(win);
  for (const [, entry] of [...map.entries()]) {
    forceKill(entry.proc);
  }
  map.clear();
}
function disposeProcessManager(win) {
  killAllProcesses(win);
  windowProcesses.delete(win);
}
const registry = /* @__PURE__ */ new Map();
function registerCommand(id, handler) {
  registry.set(id, handler);
}
let openProjectsRef = null;
let openProjectFn = null;
const editorFileOpenMap = /* @__PURE__ */ new Map();
let switchingProject = false;
function isSwitchingProject() {
  return switchingProject;
}
const editMenuItems = [];
function getEditorWindow() {
  if (!openProjectsRef) return null;
  return openProjectsRef.values().next().value ?? null;
}
function updateEditEnabled() {
  const win = getEditorWindow();
  const enabled = win ? editorFileOpenMap.get(win) ?? false : false;
  for (const item of editMenuItems) {
    item.enabled = enabled;
  }
}
function sendEditCommand(command) {
  const win = getEditorWindow();
  if (!win) return;
  if (!(editorFileOpenMap.get(win) ?? false)) return;
  win.webContents.send("menu:edit-command", command);
}
async function checkRunningAndProceed(win, action) {
  const count = getRunningCount(win);
  if (count === 0) {
    await action();
    return;
  }
  const { response } = await electron.dialog.showMessageBox(win, {
    type: "question",
    title: "AIDE",
    message: `${count} process${count !== 1 ? "es are" : " is"} still running.`,
    detail: "Close AIDE anyway?",
    buttons: ["Yes", "No"],
    defaultId: 1,
    cancelId: 1
  });
  if (response === 0) {
    killAllProcesses(win);
    await action();
  }
}
function switchProject(newPath, currentWin) {
  if (!openProjectFn || !openProjectsRef) return;
  switchingProject = true;
  currentWin.once("closed", () => {
    setImmediate(() => {
      switchingProject = false;
      if (!openProjectFn || !openProjectsRef) return;
      const result = openProjectFn(newPath);
      if (!result.success) createPickerWindow();
    });
  });
  currentWin.destroy();
}
async function handleOpenFolder() {
  const focused = electron.BrowserWindow.getFocusedWindow();
  if (!focused) return;
  const editorWin = getEditorWindow();
  if (editorWin) {
    await checkRunningAndProceed(editorWin, async () => {
      const result = await electron.dialog.showOpenDialog(editorWin, { properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return;
      const newPath = result.filePaths[0];
      if (openProjectsRef?.has(newPath)) {
        openProjectsRef.get(newPath).focus();
        return;
      }
      switchProject(newPath, editorWin);
    });
  } else {
    const result = await electron.dialog.showOpenDialog(focused, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return;
    const newPath = result.filePaths[0];
    if (openProjectsRef?.has(newPath)) {
      openProjectsRef.get(newPath).focus();
      return;
    }
    focused.close();
    if (openProjectFn && openProjectsRef) {
      const openResult = openProjectFn(newPath);
      if (!openResult.success) createPickerWindow();
    }
  }
}
async function handleOpenRecent(projectPath) {
  if (!fs.existsSync(projectPath)) {
    electron.dialog.showErrorBox("AIDE", `Path no longer exists:
${projectPath}`);
    return;
  }
  if (openProjectsRef?.has(projectPath)) {
    openProjectsRef.get(projectPath).focus();
    return;
  }
  const focused = electron.BrowserWindow.getFocusedWindow();
  if (!focused) return;
  const editorWin = getEditorWindow();
  if (editorWin) {
    await checkRunningAndProceed(editorWin, async () => {
      switchProject(projectPath, editorWin);
    });
  } else {
    focused.close();
    if (openProjectFn && openProjectsRef) {
      const openResult = openProjectFn(projectPath);
      if (!openResult.success) createPickerWindow();
    }
  }
}
function rebuildMenu() {
  editMenuItems.length = 0;
  const state2 = getAppState();
  const config2 = getAppConfig();
  const recentProjects = state2.recentProjects.slice(0, config2.sessions.maxRecentProjects);
  const recentSubmenu = recentProjects.length > 0 ? recentProjects.map((p) => ({
    label: path.basename(p.path),
    click: () => {
      handleOpenRecent(p.path);
    }
  })) : [{ label: "No recent projects", enabled: false }];
  const win = getEditorWindow();
  const editEnabled = win ? editorFileOpenMap.get(win) ?? false : false;
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Window", click: () => {
          createPickerWindow();
        } },
        { label: "Open Folder...", click: () => {
          handleOpenFolder();
        } },
        { label: "Open Recent", submenu: recentSubmenu },
        { type: "separator" },
        { label: "Exit", click: () => {
          electron.app.quit();
        } }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", enabled: editEnabled, click: () => sendEditCommand("undo") },
        { label: "Redo", enabled: editEnabled, click: () => sendEditCommand("redo") },
        { type: "separator" },
        { label: "Cut", enabled: editEnabled, click: () => sendEditCommand("cut") },
        { label: "Copy", enabled: editEnabled, click: () => sendEditCommand("copy") },
        { label: "Paste", enabled: editEnabled, click: () => sendEditCommand("paste") }
      ]
    }
  ];
  const appMenu = electron.Menu.buildFromTemplate(template);
  const editMenu = appMenu.items.find((i) => i.label === "Edit");
  if (editMenu?.submenu) {
    for (const item of editMenu.submenu.items) {
      if (item.type !== "separator") editMenuItems.push(item);
    }
  }
  electron.Menu.setApplicationMenu(appMenu);
}
function setEditorFileOpen(win, hasFile) {
  editorFileOpenMap.set(win, hasFile);
  updateEditEnabled();
}
function removeEditorWindow(win) {
  editorFileOpenMap.delete(win);
  updateEditEnabled();
}
function setupMenu(openProjects2, openProject) {
  openProjectsRef = openProjects2;
  openProjectFn = openProject;
  registerCommand("file.newWindow", () => {
    createPickerWindow();
  });
  registerCommand("file.openFolder", () => handleOpenFolder());
  registerCommand("file.exit", () => electron.app.quit());
  registerCommand("edit.undo", () => sendEditCommand("undo"));
  registerCommand("edit.redo", () => sendEditCommand("redo"));
  registerCommand("edit.cut", () => sendEditCommand("cut"));
  registerCommand("edit.copy", () => sendEditCommand("copy"));
  registerCommand("edit.paste", () => sendEditCommand("paste"));
  rebuildMenu();
}
function createEditorWindow(projectPath) {
  const folderName = path.basename(projectPath);
  const win = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    title: `AIDE — ${folderName}`,
    icon: path.join(__dirname, "../../app_icon.ico"),
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "../preload/editor.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"] + "/?window=editor");
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), {
      query: { window: "editor" }
    });
  }
  return win;
}
function openProjectAndTrack(projectPath, openProjects2) {
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: `Path does not exist: ${projectPath}` };
  }
  if (openProjects2.has(projectPath)) {
    openProjects2.get(projectPath).focus();
    return { success: false, error: "Project is already open in this AIDE instance." };
  }
  ensureAideDirectory(projectPath);
  ensureDefaultToolbar(projectPath);
  const lockResult = checkAndAcquireLock(projectPath);
  if (!lockResult.acquired) {
    return {
      success: false,
      error: `This project is already open in another AIDE instance (PID ${lockResult.pid}).`
    };
  }
  ensureGitignoreEntry(projectPath, ".aide");
  addRecentProject(projectPath, getAppConfig().sessions.maxRecentProjects);
  rebuildMenu();
  const editorWin = createEditorWindow(projectPath);
  openProjects2.set(projectPath, editorWin);
  const ptyMgr = new PtyManager(editorWin, projectPath);
  ptyRegistry.set(editorWin, ptyMgr);
  editorWin.webContents.once("did-finish-load", () => {
    startProjectWatcher(projectPath, editorWin);
  });
  editorWin.on("close", (event) => {
    const count = getRunningCount(editorWin);
    if (count > 0) {
      event.preventDefault();
      electron.dialog.showMessageBox(editorWin, {
        type: "question",
        title: "AIDE",
        message: `${count} process${count !== 1 ? "es are" : " is"} still running.`,
        detail: "Close AIDE anyway?",
        buttons: ["Yes", "No"],
        defaultId: 1,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) {
          killAllProcesses(editorWin);
          editorWin.destroy();
        }
      });
    }
  });
  editorWin.on("closed", () => {
    disposeProcessManager(editorWin);
    ptyMgr.disposeAll();
    ptyRegistry.delete(editorWin);
    stopProjectWatcher(projectPath);
    releaseLock(projectPath);
    openProjects2.delete(projectPath);
    removeEditorWindow(editorWin);
  });
  return { success: true };
}
function createSessionPickerWindow(editorWin) {
  const win = new electron.BrowserWindow({
    width: 500,
    height: 400,
    resizable: true,
    title: "Sessions",
    icon: path.join(__dirname, "../../app_icon.ico"),
    backgroundColor: "#1e1e1e",
    parent: editorWin,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/sessionPicker.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"] + "/?window=session-picker");
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), {
      query: { window: "session-picker" }
    });
  }
  pickerEditorMap.set(win, editorWin);
  win.on("closed", () => pickerEditorMap.delete(win));
  return win;
}
function runGitSubcommand(projectPath, args, onLine) {
  return new Promise((resolve) => {
    const proc = child_process.spawn("git", args, { cwd: projectPath });
    const stderrChunks = [];
    proc.stdout.on("data", (d) => {
      d.toString().split("\n").filter((l) => l.length > 0).forEach((l) => onLine(l, "stdout"));
    });
    proc.stderr.on("data", (d) => {
      stderrChunks.push(d);
      d.toString().split("\n").filter((l) => l.length > 0).forEach((l) => onLine(l, "stderr"));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errMsg = Buffer.concat(stderrChunks).toString().trim();
        resolve({ success: false, error: errMsg || `git exited with code ${code}` });
      }
    });
    proc.on("error", (err) => resolve({ success: false, error: err.message }));
  });
}
function setupIpcHandlers(openProjects2) {
  electron.ipcMain.handle("pick:select-folder", async () => {
    const result = await electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  electron.ipcMain.handle("project:open", async (event, projectPath) => {
    const result = openProjectAndTrack(projectPath, openProjects2);
    if (result.success) {
      const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
      senderWin?.close();
    }
    return result;
  });
  electron.ipcMain.handle("path:validate", (_event, projectPath) => {
    return fs.existsSync(projectPath);
  });
  electron.ipcMain.handle("state:remove-recent", (_event, projectPath) => {
    removeRecentProject(projectPath);
  });
  electron.ipcMain.handle("editor:get-project-path", (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return null;
    for (const [path2, win] of openProjects2) {
      if (win === senderWin) return path2;
    }
    return null;
  });
  electron.ipcMain.handle("config:get", () => getAppConfig());
  electron.ipcMain.handle("state:get", () => getAppState());
  electron.ipcMain.handle("editor:get-project-settings", (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { activePanelRatio: 0.75, collapsedWidthPx: 20 };
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const s = readProjectSettings(projectPath);
        return { activePanelRatio: s.activePanelRatio, collapsedWidthPx: s.collapsedWidthPx };
      }
    }
    return { activePanelRatio: 0.75, collapsedWidthPx: 20 };
  });
  electron.ipcMain.handle("filetree:read-dir", (event, dirPath) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    let projectPath = "";
    for (const [p, win] of openProjects2) {
      if (win === senderWin) {
        projectPath = p;
        break;
      }
    }
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const filtered = entries.filter((e) => !e.name.startsWith("."));
      const dirs = filtered.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const files = filtered.filter((e) => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      return [...dirs, ...files].map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = projectPath ? fullPath.slice(projectPath.length + 1).replace(/\\/g, "/") : entry.name;
        return {
          name: entry.name,
          path: fullPath,
          relativePath,
          type: entry.isDirectory() ? "directory" : "file"
        };
      });
    } catch {
      return [];
    }
  });
  electron.ipcMain.handle("filetree:git-status", async (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        return runGitStatus(projectPath);
      }
    }
    return { available: false, changed: [], deleted: [] };
  });
  electron.ipcMain.handle("terminal:create-initial", async (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return null;
    const ptyMgr = ptyRegistry.get(senderWin);
    if (!ptyMgr) return null;
    return ptyMgr.createInitialTab();
  });
  electron.ipcMain.handle("terminal:create-new", async (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return null;
    const ptyMgr = ptyRegistry.get(senderWin);
    if (!ptyMgr) return null;
    return ptyMgr.createNewSessionTab();
  });
  electron.ipcMain.handle("terminal:resume-session", async (event, sessionId) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return null;
    const ptyMgr = ptyRegistry.get(senderWin);
    if (!ptyMgr) return null;
    return ptyMgr.resumeSessionTab(sessionId);
  });
  electron.ipcMain.on("terminal:write", (event, tabId, data) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    ptyRegistry.get(senderWin)?.write(tabId, data);
  });
  electron.ipcMain.on("terminal:resize", (event, tabId, cols, rows) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    ptyRegistry.get(senderWin)?.resize(tabId, cols, rows);
  });
  electron.ipcMain.handle("terminal:get-tabs", (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return [];
    return ptyRegistry.get(senderWin)?.getTabs() ?? [];
  });
  electron.ipcMain.on("terminal:open-session-picker", (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    createSessionPickerWindow(senderWin);
  });
  electron.ipcMain.handle("session-picker:get-sessions", async (event) => {
    const pickerWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!pickerWin) return { diskSessions: [], openTabs: [] };
    const editorWin = pickerEditorMap.get(pickerWin);
    if (!editorWin) return { diskSessions: [], openTabs: [] };
    const ptyMgr = ptyRegistry.get(editorWin);
    const openTabs = ptyMgr?.getTabs() ?? [];
    let projectPath;
    for (const [p, w] of openProjects2) {
      if (w === editorWin) {
        projectPath = p;
        break;
      }
    }
    const diskSessions = projectPath ? await scanSessions(projectPath) : [];
    const maxSessions = getAppConfig().sessions.maxSessionsInPicker;
    return { diskSessions: diskSessions.slice(0, maxSessions), openTabs };
  });
  electron.ipcMain.on("session-picker:switch-tab", (event, tabId) => {
    const pickerWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!pickerWin) return;
    const editorWin = pickerEditorMap.get(pickerWin);
    if (editorWin && !editorWin.isDestroyed()) {
      editorWin.webContents.send("terminal:switch-tab", { tabId });
    }
    pickerWin.close();
  });
  electron.ipcMain.handle("session-picker:resume-session", async (event, sessionId) => {
    const pickerWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!pickerWin) return;
    const editorWin = pickerEditorMap.get(pickerWin);
    if (!editorWin || editorWin.isDestroyed()) return;
    const ptyMgr = ptyRegistry.get(editorWin);
    if (!ptyMgr) return;
    const tabInfo = await ptyMgr.resumeSessionTab(sessionId);
    editorWin.webContents.send("terminal:new-tab", tabInfo);
    pickerWin.close();
  });
  electron.ipcMain.handle("editor:read-file", async (_event, filePath) => {
    const [stat, content] = await Promise.all([
      fs.promises.stat(filePath),
      fs.promises.readFile(filePath, "utf-8")
    ]);
    return { content, mtime: stat.mtimeMs, size: stat.size };
  });
  electron.ipcMain.handle("editor:write-file", async (_event, filePath, content) => {
    await fs.promises.writeFile(filePath, content, "utf-8");
    const stat = await fs.promises.stat(filePath);
    return { mtime: stat.mtimeMs };
  });
  electron.ipcMain.handle("editor:git-show-head", async (event, relPath) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    let projectPath = "";
    for (const [p, win] of openProjects2) {
      if (win === senderWin) {
        projectPath = p;
        break;
      }
    }
    if (!projectPath) return { error: "other" };
    return new Promise((resolve) => {
      const proc = child_process.spawn("git", ["show", `HEAD:${relPath}`], { cwd: projectPath });
      const chunks = [];
      const errChunks = [];
      proc.stdout.on("data", (d) => chunks.push(d));
      proc.stderr.on("data", (d) => errChunks.push(d));
      proc.on("close", (code) => {
        if (code !== 0) {
          const errMsg = Buffer.concat(errChunks).toString();
          if (errMsg.includes("exists on disk") || errMsg.includes("did not match any") || errMsg.includes("does not exist")) {
            resolve({ error: "untracked" });
          } else {
            resolve({ error: "other" });
          }
        } else {
          resolve({ content: Buffer.concat(chunks).toString("utf-8") });
        }
      });
      proc.on("error", () => resolve({ error: "other" }));
    });
  });
  electron.ipcMain.handle("toolbar:get-info", (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { buttons: [], projectType: "", suggestedType: null };
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath);
        const projectType = localConfig.projectType ?? "";
        const buttons = readToolbarButtons(projectPath);
        const suggestedType = projectType === "" ? detectProjectType(projectPath) : null;
        return { buttons, projectType, suggestedType };
      }
    }
    return { buttons: [], projectType: "", suggestedType: null };
  });
  electron.ipcMain.handle("toolbar:get-presets", () => PRESET_GROUPS);
  electron.ipcMain.handle("toolbar:save-buttons", (event, buttons) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return [];
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath);
        localConfig.buttons = buttons;
        writeLocalToolbarConfig(projectPath, localConfig);
        return readToolbarButtons(projectPath);
      }
    }
    return [];
  });
  electron.ipcMain.handle("toolbar:set-project-type", (event, type) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath);
        localConfig.projectType = type;
        writeLocalToolbarConfig(projectPath, localConfig);
        return;
      }
    }
  });
  electron.ipcMain.handle("toolbar:run-button", (event, buttonId) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { success: false, error: "No window" };
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const buttons = readToolbarButtons(projectPath);
        const button = buttons.find((b) => b.id === buttonId);
        if (!button) return { success: false, error: "Button not found" };
        spawnButtonProcess(senderWin, button, projectPath);
        return { success: true };
      }
    }
    return { success: false, error: "Project not found" };
  });
  electron.ipcMain.handle("toolbar:kill-button", (event, buttonId) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (senderWin) killButtonProcess(senderWin, buttonId);
  });
  electron.ipcMain.handle("toolbar:kill-restart-button", async (event, buttonId) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    killButtonProcess(senderWin, buttonId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const [projectPath, win] of openProjects2) {
      if (win === senderWin) {
        const buttons = readToolbarButtons(projectPath);
        const button = buttons.find((b) => b.id === buttonId);
        if (button) spawnButtonProcess(senderWin, button, projectPath);
        break;
      }
    }
  });
  electron.ipcMain.handle("git:get-commit-files", async (event) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!senderWin)
      return { available: false, changed: [], deleted: [], untracked: [], truncated: false };
    let projectPath = "";
    for (const [p, win] of openProjects2) {
      if (win === senderWin) {
        projectPath = p;
        break;
      }
    }
    if (!projectPath)
      return { available: false, changed: [], deleted: [], untracked: [], truncated: false };
    return new Promise((resolve) => {
      const proc = child_process.spawn("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: projectPath,
        windowsHide: true
      });
      const chunks = [];
      proc.stdout.on("data", (d) => chunks.push(d));
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve({ available: false, changed: [], deleted: [], untracked: [], truncated: false });
          return;
        }
        const output = Buffer.concat(chunks).toString();
        const changed = [];
        const deleted = [];
        const untracked = [];
        const MAX = 2e3;
        const lines = output.split("\n").filter((l) => l.length >= 4);
        for (const line of lines) {
          if (changed.length + deleted.length + untracked.length >= MAX) break;
          const xy = line.substring(0, 2);
          let filePath = line.substring(3);
          if (filePath.includes(" -> ")) filePath = filePath.split(" -> ")[1];
          filePath = filePath.trim();
          if (!filePath || filePath.endsWith("/")) continue;
          if (xy === "??") untracked.push(filePath);
          else if (xy[0] === "D" || xy[1] === "D") deleted.push(filePath);
          else changed.push(filePath);
        }
        resolve({ available: true, changed, deleted, untracked, truncated: lines.length > MAX });
      });
      proc.on(
        "error",
        () => resolve({ available: false, changed: [], deleted: [], untracked: [], truncated: false })
      );
    });
  });
  electron.ipcMain.handle(
    "git:run-commit",
    async (event, { files, message, stageAll }) => {
      const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
      if (!senderWin) return { success: false, error: "No window" };
      let projectPath = "";
      for (const [p, win] of openProjects2) {
        if (win === senderWin) {
          projectPath = p;
          break;
        }
      }
      if (!projectPath) return { success: false, error: "Project not found" };
      const sendLine = (line, stream) => {
        if (!senderWin.isDestroyed()) {
          senderWin.webContents.send("git:commit-output", { line, stream });
        }
      };
      if (stageAll) {
        sendLine("> git add -A", "stdout");
        const addResult = await runGitSubcommand(projectPath, ["add", "-A"], sendLine);
        if (!addResult.success) return { success: false, error: addResult.error };
      } else {
        const batchSize = Math.max(1, getAppConfig().git.addBatchSize);
        const totalBatches = Math.ceil(files.length / batchSize);
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;
          const label = totalBatches > 1 ? `> git add [batch ${batchNum}/${totalBatches}: ${batch.length} files]` : `> git add [${batch.length} file${batch.length !== 1 ? "s" : ""}]`;
          sendLine(label, "stdout");
          const addResult = await runGitSubcommand(projectPath, ["add", "--", ...batch], sendLine);
          if (!addResult.success) return { success: false, error: addResult.error };
        }
      }
      const msgPreview = message.includes("\n") ? message.split("\n")[0].trimEnd() + " …" : message;
      sendLine(`> git commit -m "${msgPreview}"`, "stdout");
      const commitResult = await runGitSubcommand(
        projectPath,
        ["commit", "-m", message],
        sendLine
      );
      return { success: commitResult.success, error: commitResult.error };
    }
  );
  electron.ipcMain.on("menu:editor-file-changed", (event, hasFile) => {
    const senderWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (senderWin) setEditorFileOpen(senderWin, hasFile);
  });
  electron.ipcMain.handle("session-picker:new-session", async (event) => {
    const pickerWin = electron.BrowserWindow.fromWebContents(event.sender);
    if (!pickerWin) return;
    const editorWin = pickerEditorMap.get(pickerWin);
    if (!editorWin || editorWin.isDestroyed()) return;
    const ptyMgr = ptyRegistry.get(editorWin);
    if (!ptyMgr) return;
    const tabInfo = await ptyMgr.createNewSessionTab();
    editorWin.webContents.send("terminal:new-tab", tabInfo);
    pickerWin.close();
  });
}
const openProjects = /* @__PURE__ */ new Map();
function resolveStartupProject() {
  const userArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cliArg = userArgs[0];
  if (cliArg) {
    const resolved = path.join(process.cwd(), cliArg);
    const candidate = fs.existsSync(resolved) ? resolved : cliArg;
    if (fs.existsSync(candidate)) return candidate;
  }
  const aideDirInCwd = path.join(process.cwd(), ".aide");
  if (fs.existsSync(aideDirInCwd)) return process.cwd();
  return null;
}
electron.app.whenReady().then(() => {
  initAppConfig();
  initAppState();
  setupIpcHandlers(openProjects);
  setupMenu(openProjects, (path2) => openProjectAndTrack(path2, openProjects));
  const startupPath = resolveStartupProject();
  if (startupPath) {
    const result = openProjectAndTrack(startupPath, openProjects);
    if (!result.success) {
      createPickerWindow();
    }
  } else {
    createPickerWindow();
  }
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createPickerWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isSwitchingProject()) {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  for (const [projectPath] of openProjects) {
    releaseLock(projectPath);
  }
});
