# AIDE Task Tracker

The tracker is the project's state: what is in the project, what we are doing,
and what we decided not to do. One task is one file, `aide/tasks/<id>.md`, that
AIDE writes; you change it with the `task_*` tools, never by hand.

Reading works in any session. Writing needs an AIDE terminal tab: a session
started outside AIDE can read only.

## What is a task

**A task is what the user will ask about a week from now**: a feature, a change
of behaviour, a decision. Anything needed only to get the current work done —
research, intermediate steps, a refactoring on the way — belongs in a plan
(`plan_guide`), not in the tracker. Plans do not become tasks; a plan may solve
one task or several.

| Thing | Answers |
|---|---|
| Tracker | What are we doing, what is in the project, what we decided not to do |
| Plan | How a piece of work gets done, step by step |
| `docs/` | How and why, where one line is not enough |
| `CLAUDE.md` | How to work here: rules and conventions, not state |

**A work item goes to `task_create`, never into a TODO in a file.** A TODO in
code or a "Planned" line in a document is forgotten state; a task is found.

## States

- `backlog`: an idea or need, not committed to.
- `planned`: we intend to do it; ordered by `rank` (smaller first, fractions
  allowed: to put a task between 2 and 3, give it 2.5).
- `active`: someone works on it now. `task_start` makes it active and the
  current task of your tab; start the task before you work on it. Pausing is
  `task_update` status `planned`.
- `blocked`: from backlog, planned or active, with a `reason`; unblocking returns
  it to where it came from.
- `done`: finished. If it carries a claim, the claim is true.
- `cancelled`: we decided not to do it.
- **History**: a done or cancelled task that is no longer true or no longer
  relevant. Out of view, found by `task_search` with `history: true`.
- **Reopen**: a done task goes back to active when the work turned out
  unfinished (`task_reopen`). Its claim stays, marked reopened until the next
  close.

## Claims and labels

A task that adds something to the project closes with a **claim**: a statement
about the project in the present tense, one to three lines, checkable against
the code, with a short noun **label**.

> Title: Add titles to terminal tabs
> Label: Terminal tab titles
> Claim: Terminal tab titles are stored in `.aide/Titles/{sessionId}.txt`; the
> default is "Claude Code"; the session picker shows the saved title.

- The title stays the action it was; the label names the thing.
- The claims of the tasks not in history are what the project has. Write them
  for someone who has to rely on them.

## `code`: where the feature lives

`code` lists globs, relative to the project root, of the files **the feature
lives in** — not every file the change passes through. A feature backed by IPC
names its own module, not `ipc/index.ts` and the preload files every such
feature touches. A glob that matches a whole tree says nothing.

## Closing

`task_close` with `outcome` `done` or `cancelled`:

- **A new feature**: `done` with `label` and `claim` (and `code`).
- **Internal work** (a refactoring, a fix that makes an existing claim true
  again): `done` without a claim. Such a task goes to history on close.
- **Refining a claim**: `supersedes` the task whose claim changes, and a claim
  that states the combined result. The superseded tasks go to history pointing
  at the new one, and `task_get` follows that chain.
- **Removing a feature**: `done`, `supersedes` the feature's task, no claim.
- **Decided against**: `decidedAgainst: "We do not do X because Y"` on a task
  without a claim (a cancelled idea, or a removal that should not be proposed
  again). It stays visible, so the idea is not proposed again.

Only closed tasks can be superseded. This AIDE version closes without checking
the other claims your change may have touched; read the claims of the area you
changed (`task_search` by tag) and supersede those that are no longer true.

## Revisions

Every write that changes an existing task passes the `baseRevision` you read
with `task_get`. When the task changed since, nothing is written and the
answer names what changed: read it again and retry.

## Journal

`task_note` adds a line to a task's journal: a short decision or finding that
outlives the current work ("decided to keep titles out of JSONL"). It is not a
transcript of what you did.

## Migrating an existing project

To record what a project already has, `task_create` a task per feature with
`status: "done"`, `label`, `claim`, `code` and `source` (the file the state came
from, e.g. `STAGES.md`). Such a claim is marked unverified until it is checked.
What is not done yet becomes `planned` or `backlog`.
