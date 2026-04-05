# AIDE                                                                                                                                                                                                                                         
                                                                                                                                                                                                                                                 
  > A lightweight desktop code editor built with Electron, React, and Monaco Editor.                                                                                                                                                             
  > Designed as a native shell for AI-assisted coding workflows (e.g. Claude Code).                                                                                                                                                                 
  ---                                                                                                                                                                                                                                            
                                                      
  ## This is a release mirror development happen on **GitVerse**:                                                                                                                                                                           

  **[gitverse.ru/basovav/AIDE](https://gitverse.ru/basovav/AIDE)**

  This repository contains **releases only** — each release includes source archives.

  ---

  AIDE – AI Driven Editor for Claude Code(and other CLI)

  When I switched from Cursor to Claude Code, the workflow felt broken. Where's multi-chat? Where's the diff view? Where's the toolbar? Where's session history? 
  So I built AIDE - a VS Code-like desktop shell specifically for CLI AI tools. Think of it as the UI layer Claude Code never had.                                                                              

  What it is: An Electron + React app that wraps Claude Code in a proper editor environment. The architecture is multi-CLI by design - the repo includes a spec doc, feed it to your favorite CLI and you can add support for any CLI tool in ~5 minutes (Qwen Code as example).


  Why use AIDE if you already use Claude Code CLI:

  - Session picker with message preview - see first/last message per session at a glance, hover to preview full content. Resume any past session with complete history including all tool calls
  - Multiple sessions per project - independent Claude Code sessions in one workspace, switch between them instantly
  - Auto-resizing workspace - editor/terminal split adjusts automatically based on what's active (no more manually dragging the pane every time you want to read a file)
  - Diff view - compare current file against last commit to see exactly what your CLI changed
  - Programmable toolbar - buttons that run any script and route output to AIDE's log panel; error = audible alert. You don't need to configure it manually - just ask Claude to create a new button and you get a ready tool
  - Structured log panel - toolbar output organized by channels, 10k line buffer, filter with hide/dim modes, attention system (blinking tab on new output)
  - Audible alert when Claude finishes and is waiting for input
  - "Modified only" file tree filter - shows only changed files with directory hierarchy. Extremely useful when Claude touched 20 files
  - Git commit dialog - file selection + message + streaming progress, right inside AIDE
  - Git status indicators in the file tree - ● modified, visual at a glance
  - Conflict detection - if Claude modifies a file while you're editing it, AIDE catches it and shows a dialog. If you edited something and moved on, it'll prompt you to save before there's a conflict        

  And of course it's open source. Instead of using a release build, you can clone the repo and run directly from source - modify and extend AIDE however you want. Claude understand the codebase well and will make whatever changes you need without a sweat.

  If you use Claude Code on Windows regularly, worth a try.

  Currently Windows only, but cross-platform at the core.
  Literally three targeted fixes to support your OS. 
  The only reason I haven't done it is I don't have a Mac or Linux machine to test on - and shipping untested cross-platform support would just be fake cross-platform support.
  
  Full Repo: https://gitverse.ru/basovav/AIDE/releases

  ## License

    MIT
