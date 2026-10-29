# Showcase shooting plan

All shots are taken in one project, `E:\Projects\AIDE\UEMetaProject` (UE 5.7 C++,
builds and passes its automation test). The order is chosen so that each case
leaves the project in the state the next one needs, and nothing has to be
staged twice.

Kit (copied into the project when a step says so):

| Path in this folder | Goes to | What |
|---|---|---|
| `ue/aide/toolbar.json` | `UEMetaProject/aide/toolbar.json` | 11 UE buttons in 5 groups (project files, build, run, tests/log, ship) |
| `ue/aide/scripts/ue.ps1` | `UEMetaProject/aide/scripts/` | One script behind every button and the pipeline checks; finds the engine from the `.uproject` |
| `ue/aide/scripts/validate-art.py` | `UEMetaProject/aide/scripts/` | Art check of the pipeline |
| `ue/aide/pipelines/` | `UEMetaProject/aide/pipelines/` | `game-feature` machine (Code: implement → build → tests → Codex review; Graphics: generate art → validate → visual review; commit) and its roles. Passes AIDE's validator with no warnings |

Screenshots go to `site/shots/<name>.png`; `python site/tools/to-webp.py` makes
the site images.

## 0. Once before shooting

1. Commit the project as it is (`git commit -m "Initial project"` in UEMetaProject) so the tree starts clean.
2. Open the project in AIDE, then size the window:
   `powershell -NoProfile -ExecutionPolicy Bypass -File site/tools/aide-window.ps1`
   (1920×1080 logical; at >100% Windows scaling the shot is larger and `to-webp.py` scales it down).
3. Things that end up in every frame: the status bar shows the account e-mail and usage. Switch to an account you are fine showing, or accept it.
4. Window shots: Win+Shift+S → window mode, or Alt+PrintScreen. Same tool for every shot.

## 1. Toolbar — `toolbar-1-prompt`, `toolbar-2-result`

The project has no shared toolbar yet: the first frame is the "before".

1. Open `Source/UEMetaProject/Private/MetaCharacter.cpp` in the editor (something UE-looking on screen).
2. In the Claude Code tab type `I want a toolbar for working with this Unreal Engine project` — **do not press Enter**. Shoot **toolbar-1-prompt**.
3. Press Enter and let the agent do it for real (it has `.aide/docs/toolbar.md`).
   - If its toolbar looks good, keep it — that is the honest version. Make sure it has a build button with a log channel.
   - If not: copy `ue/aide/toolbar.json` and `ue/aide/scripts/` over its files and ask the agent `Summarize the toolbar in aide/toolbar.json in a few lines`, so the terminal matches what is on screen.
4. Run `Clean` (🧹), then click `Build Editor` (🔨). The build takes ~1 minute: spinner on the button, `UE Build` log open and streaming. Shoot **toolbar-2-result** while it compiles.
5. Commit the toolbar (`aide/`).

## 2. Every agent CLI — `cli-1-claude` … `cli-4-opencode`

Open four tabs: Claude Code, Codex, Cursor Agent, OpenCode. Start all four, then click through them while they work (a CLI that is thinking/editing is the shot; a finished one is not). Tasks touch different files so they don't collide:

| Tab | Prompt |
|---|---|
| Claude Code | `Add a sprint to AMetaCharacter: hold Left Shift, speed multiplier as a clamped UPROPERTY, Enhanced Input action.` |
| Codex | `Write an automation test for the air jump of AMetaCharacter in Source/UEMetaProject/Private/Tests/.` |
| Cursor Agent | `Review MetaCharacter.cpp for frame-rate dependent logic and input edge cases. Report only, don't edit.` |
| OpenCode | `Document the classes of this project in README.md: what each one does and its tunable properties.` |

Order of shots: Claude Code first (it starts fastest), then Codex, Cursor, OpenCode — the tab strip shows all four in every frame.

Afterwards throw the changes away so the orchestration starts clean:
`git restore . ; git clean -fd Source README.md`

## 3. Remote access — `remote-1-desktop`, `remote-2-phone`, `remote-3-browser`

Use one tab (Claude Code) with a task that prints for a while, e.g. `Explain how AMetaCharacter handles input, step by step, with code references.`

1. Shoot **remote-1-desktop** while it answers.
2. Main menu → Remote Connect → scan the QR with the phone. Scroll to the same part of the answer. Phone screenshot → **remote-2-phone** (portrait is fine).
3. Open the same remote URL in a desktop browser (a normal window, roughly 1600 wide), same spot → **remote-3-browser**.

## 4. Orchestration — `orch-1-prompt`, `orch-2-run`

Last, because the run commits into the project.

1. Copy `ue/aide/pipelines/` and `ue/aide/scripts/validate-art.py` (and `ue.ps1` if the agent's toolbar from step 1 did not use it) into `UEMetaProject/aide/`. Commit.
2. Main menu → Orchestration → open the orchestrator tab.
3. Type, without Enter:
   `I want to make a game out of this project. First feature: a dash — double-tap a direction to dash 600 units with a short cooldown. It needs art: a dash trail texture and a HUD icon for the cooldown, clean flat style. Use the game-feature pipeline.`
   Shoot **orch-1-prompt**. Press Enter.
4. The orchestrator starts `game-feature`. The best frame is in the **Graphics** phase: the Code group is all ✓ (build, tests, Codex review passed), `generateArt` or `visualReview` is running, the transcript shows the images being made. Shoot **orch-2-run** then (about 10–20 minutes into the run).

## After

`python site/tools/to-webp.py`, check the frames on the page (`site/index.html`), edit captions in its `scenarios` array if a shot shows something else, then `bash site/deploy.sh`.
