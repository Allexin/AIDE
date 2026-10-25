# Pipeline Account Pool

When a pipeline step stops on a CLI usage limit, AIDE can switch that CLI to
another saved account and resume the run by itself. Implemented in
`src/main/pipeline/accountPool.ts`; the switch itself is
`src/main/accounts/accountSwitch.ts`.

## Setup

In the Account Manager, every saved account has a checkbox: checked accounts are
the pool, switched to top to bottom (the ↑ / ↓ buttons set the order). Nothing is
switched while no account is checked.

- The active account does not have to be checked: AIDE switches away from an
  unchecked account to a checked one, and never back to an unchecked one.
- With one checked account that is also the active one there is nothing to
  switch to; the Account Manager says so under the list.
- The orchestrator is not told about accounts: the setup is the user's, in the
  Account Manager.

## What happens on a limit

Only pipeline runs trigger a switch (limits in interactive tabs are not detected), and only
a limit a step has just hit: after an AIDE restart the run waiting for a limit resumes by
itself at its time, and hitting the limit again then triggers the pool.
The engine stops the run with `run_stopped` (`reason: "usage_limit"`, `cli`,
`visitStartedAt`, `resumeAt` when the CLI said when the limit resets) and keeps the
step's session. The pool then, one CLI at a time:

1. Skips the switch when AIDE changed this CLI's account after the step started —
   the limit belongs to the previous account — and only resumes the run.
2. Marks the active account exhausted until `resumeAt`, or until it is loaded by
   hand when the reset time is unknown.
3. Loads the next checked account that is not exhausted. The current credentials
   are saved into the active account's record first, so a rotated token is kept.
4. Restarts the CLI's tabs in every window (the credentials are the CLI's, shared by
   every session on the machine). The tab of an orchestrator connected to the
   project gets a message once its CLI is ready: which account was switched to
   which, that the restart cut off its `pipeline_wait`, and the `since` to continue
   with.
5. Records `account_switched` in the run (report, not the orchestrator feed), logs
   to the Log Panel (`Accounts`) and the diagnostics trail, and resumes the run.

When every checked account is exhausted, the account that resets soonest — among
the checked ones and the active one — is loaded (if it is not already active), and
the run's automatic resume is moved to that time (`run_stopped` again, with
`rescheduled: true`). When no exhausted account reports a reset time, the run stays
stopped until `pipeline_resume`.

Loading an account by hand (Account Manager or the Load Account menu) clears its
exhausted mark.

## Storage

`aide-accounts.db`, table `accounts`: `in_pool`, `sort_order` (list and switching
order), `exhausted_at_ms`, `exhausted_until_ms` (null with `exhausted_at_ms` set:
until cleared). Columns are added to databases created before the pool.

## CLIs

Every CLI with an account system and a headless adapter takes part: Claude Code,
Codex, Cursor, Devin and OpenCode 2.

- **OpenCode 2** accounts are AIDE's, not OpenCode's own: an account is the set of
  active provider credentials (`credential` table, one per provider; a credential
  with `active` unset — migrated from OpenCode 1.x — is in effect while its provider
  has no active one, verified by the key OpenCode sends). Loading it
  logs out each of its providers' credentials and imports the saved one
  (`opencode auth logout` / `auth import --standalone`; `auth import` only adds
  unknown ids and a sole credential becomes active). A credential is sent over a key
  in `opencode.json`, so a key kept only in the config file cannot be pooled —
  add it with `opencode auth login` and save the account.
- OpenCode limits: `provider.quota` (e.g. DeepSeek 402 "Insufficient Balance") ends
  the run at once; a rate limit (429) is retried by OpenCode forever, so after three
  empty attempts the adapter reads the retry from the database
  (`session_message.data.retry`), stops the process and reports a limit with
  "try again in N minutes" from `retryAfterMs`.
- Limit texts of Cursor and Devin are not verified (it takes an exhausted account);
  they are matched by the generic limit markers.
