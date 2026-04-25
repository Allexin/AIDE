# Cursor Account Switch + Usage API Reverse Spec

## Goal

This document describes how Cursor stores account/session data locally and how it requests usage/limits from backend services, so AIDE can implement:

1. transparent account switching;
2. fetching current limits/usage and showing them in AIDE UI.

The spec is based on reverse-engineering of local Cursor installation/runtime behavior on Windows.

---

## Environment that was analyzed

- Cursor executable: `T:\Program Files\cursor\Cursor.exe`
- App resources: `T:\Program Files\cursor\resources\app\out`
- User data root: `%APPDATA%\Cursor`
- Main persistent DB: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

---

## 1) Where account data is stored

Cursor keeps account/session state in multiple places. For reliable switching, treat them as one logical account bundle.

## 1.1 `%APPDATA%\Cursor\auth.json`

Contains raw session tokens:

- `accessToken`
- `refreshToken`

This file is plain JSON on filesystem.

## 1.2 `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

SQLite database, table `ItemTable(key TEXT, value BLOB/TEXT, ...)`.

Important keys:

- `cursorAuth/accessToken`
- `cursorAuth/refreshToken`
- `cursorAuth/cachedEmail`
- `cursorAuth/cachedSignUpType`
- `cursorAuth/stripeMembershipType`
- `cursorAuth/stripeSubscriptionStatus`
- `cursorAuth/onboardingDate`
- `cursorAuth/openAIKey` (BYOK, optional)
- `cursorAuth/claudeKey` (BYOK, optional)
- `cursorAuth/googleKey` (BYOK, optional)

Also important:

- `src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser`

This key is a JSON object that duplicates part of account state and backend config, including:

- `membershipType` (example: `pro`)
- `subscriptionStatus` (example: `active`)
- `cursorCreds`:
  - `backendUrl` (example: `https://api2.cursor.sh`)
  - `websiteUrl` (example: `https://cursor.com`)
  - `authClientId`
  - `authDomain`
  - `repoBackendUrl`
  - `telemBackendUrl`
  - `cmdkBackendUrl`
  - `agentBackendUrlPrivacy`
  - `agentBackendUrlNonPrivacy`
- `aiSettings`:
  - `teamIds`
  - `usageHardLimit`
  - `isUsagePricingEnabled`

---

## 2) Backend endpoints used for limits/usage

Cursor constructs dashboard client over `aiserver.v1.DashboardService` with base URL from:

- `applicationUser.cursorCreds.backendUrl` (normally `https://api2.cursor.sh`)

Method URL pattern:

- `POST {backendUrl}/aiserver.v1.DashboardService/{MethodName}`

Relevant methods:

- `GetCurrentPeriodUsage`
- `GetPlanInfo`
- `GetHardLimit`
- `GetUsageBasedPremiumRequests`
- `GetUsageLimitPolicyStatus`
- `GetUsageLimitStatusAndActiveGrants`
- `GetCreditGrantsBalance`
- `GetTokenUsage`

---

## 3) Headers used by Cursor

## 3.1 Required

- `Authorization: Bearer <accessToken>`

## 3.2 Request identity/tracing (Cursor helper `Kb(Wr())`)

- `X-Request-ID: <uuid>`
- `X-Amzn-Trace-Id: Root=<same-uuid>`
- optional trace context:
  - `traceparent`
  - `backend-traceparent`

## 3.3 Cursor metadata headers (helper `setCommonHeaders`)

- `x-ghost-mode`
- `x-new-onboarding-completed`
- `x-session-id` (if present)
- `x-cursor-client-version`
- `x-cursor-client-type` (`ide`)
- `x-cursor-client-device-type` (`desktop`)
- `x-cursor-timezone`
- sometimes `x-client-key`, plus OS/arch headers

For AIDE integration, start with required auth + request-id headers and add metadata headers if backend behavior requires parity.

---

## 4) Request/response schema (reverse extracted)

Field names below are from generated protobuf descriptors in Cursor bundle.

## 4.1 `GetCurrentPeriodUsage`

Request: empty object.

Response:

- `billing_cycle_start` (int64)
- `billing_cycle_end` (int64)
- `plan_usage`:
  - `total_spend` (int cents)
  - `included_spend` (int cents)
  - `bonus_spend` (int cents)
  - `remaining` (int cents)
  - `limit` (int cents)
  - `remaining_bonus` (optional bool)
  - `bonus_tooltip` (optional string)
  - `auto_spend` (optional int cents)
  - `api_spend` (optional int cents)
  - `auto_limit` (optional int cents)
  - `api_limit` (optional int cents)
  - `auto_percent_used` (optional float)
  - `api_percent_used` (optional float)
  - `total_percent_used` (optional float)
- `spend_limit_usage`:
  - contains user/team spend-limit counters (includes fields like `individual_limit`, `individual_used`, etc.)
- `display_threshold` (optional int)
- `enabled` (bool)
- `display_message` (string)
- `auto_model_selected_display_message` (optional string)
- `named_model_selected_display_message` (optional string)
- `auto_bucket_models` (string[])

## 4.2 `GetPlanInfo`

Request: empty object.

Response:

- `plan_info`:
  - `plan_name` (string)
  - `included_amount_cents` (int)
  - `price` (optional string)
  - `billing_cycle_end` (optional int64)
- `next_upgrade`:
  - `tier` (string)
  - `name` (string)
  - `included_amount_cents` (int)
  - `price` (string)
  - `description` (string)

## 4.3 `GetHardLimit`

Request:

- `team_id` (optional int)

Response:

- `hard_limit` (int)
- `no_usage_based_allowed` (bool)
- `hard_limit_per_user` (optional int)
- `per_user_monthly_limit_dollars` (int)
- `is_dynamic_team_limit` (bool)

## 4.4 `GetUsageBasedPremiumRequests`

Request:

- `team_id` (int)

Response:

- `usage_based_premium_requests` (bool)

## 4.5 Additional usage policy methods

- `GetUsageLimitPolicyStatus` returns:
  - `is_in_slow_pool`, `error_title`, `error_detail`, `slowness_ms`, `features` map,
  - `can_configure_spend_limit`, `limit_type`, `has_pending_request`,
  - `allowed_model_ids`, `allowed_model_tags`.
- `GetUsageLimitStatusAndActiveGrants` returns policy status + `active_grants`.
- `GetCreditGrantsBalance` returns:
  - `has_credit_grants`, `credit_balance_cents`, `total_cents`, `used_cents`.
- `GetTokenUsage` request has `usage_uuid`, response has `input_tokens`/`output_tokens`.

---

## 5) Account switching design for AIDE

## 5.1 Canonical account profile object in AIDE

Store one profile per account:

- `email`
- `accessToken`
- `refreshToken`
- `signUpType`
- `membershipType`
- `subscriptionStatus`
- optional BYOK keys
- optional cached `teamIds`

## 5.2 Switch algorithm (recommended)

1. **Stop Cursor process** (or ensure it is not running), otherwise it can overwrite files back.
2. **Backup**:
   - `%APPDATA%\Cursor\auth.json`
   - `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
3. **Write `auth.json`** with target account tokens.
4. **Open SQLite transaction** on `state.vscdb`.
5. Update `ItemTable` keys:
   - `cursorAuth/accessToken`
   - `cursorAuth/refreshToken`
   - `cursorAuth/cachedEmail`
   - `cursorAuth/cachedSignUpType`
   - `cursorAuth/stripeMembershipType`
   - `cursorAuth/stripeSubscriptionStatus`
6. Load JSON from key  
   `src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser`,
   then update at least:
   - `membershipType`
   - `subscriptionStatus`
   - optional `aiSettings.teamIds` reset to `[]` if unknown
7. Save JSON back to same key.
8. Commit transaction.
9. Start Cursor (or trigger app restart in AIDE flow).
10. On first start, force a membership/usage refresh call to converge server truth.

## 5.3 Why both `auth.json` and `state.vscdb` must be updated

Cursor reads/writes both storages. If only one is updated:

- UI can show old plan/email;
- service clients may use stale in-memory state;
- account appears partially switched.

---

## 6) Getting limits/usage in AIDE

## 6.1 Token lifecycle

Refresh endpoint observed in Cursor:

- `POST {backendUrl}/oauth/token`

Payload shape:

- `grant_type: "refresh_token"`
- `client_id: cursorCreds.authClientId`
- `refresh_token: <refreshToken>`

Use refresh before usage calls if token is near expiry.

## 6.2 Minimal call set for UI

For personal/pro accounts:

1. `GetCurrentPeriodUsage`
2. `GetPlanInfo`

For enterprise/team-aware screens:

1. resolve team id (`GetTeams`, first team with seats/billing logic),
2. `GetHardLimit(team_id)`
3. `GetUsageBasedPremiumRequests(team_id)`
4. optional policy/grants methods.

## 6.3 Normalized UI model in AIDE (recommended)

Build one internal model:

- `planName`
- `billingCycleEnd`
- `includedUsd`, `usedUsd`, `bonusUsd`, `limitUsd`
- `autoUsd`, `apiUsd`
- `usagePercent` (`total_percent_used` fallback to computed)
- `spendLimitUsd`, `spendLimitUsedUsd`
- `usagePricingEnabled`
- `hardLimitUsd`
- `messages` (`display_message`, model-selected messages)
- `isInSlowPool`
- `creditGrantsBalanceUsd`

All cents -> dollars conversion in one helper.

---

## 7) Practical SQL snippets

## 7.1 Read keys

```sql
SELECT key, value
FROM ItemTable
WHERE key LIKE 'cursorAuth/%'
   OR key = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
```

## 7.2 Upsert a key

```sql
INSERT INTO ItemTable(key, value)
VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
```

Use one transaction for all account-related updates.

---

## 8) Failure modes and mitigations

- **Cursor running during switch** -> writes state back.  
  Mitigation: stop process or use lock around switch.
- **Token switched, membership stale** -> wrong UI labels.  
  Mitigation: also update DB membership fields + force backend refresh.
- **Team-dependent calls with no `team_id`** -> empty/incorrect hard limit data.  
  Mitigation: resolve teams first for enterprise accounts.
- **Partial write crash** -> broken account state.  
  Mitigation: backup + atomic DB transaction + rollback.

---

## 9) Verification checklist

After implementing switch:

1. switch A -> B -> A without relogin;
2. Cursor shows correct email/plan each time;
3. usage panel numbers change with account;
4. `GetCurrentPeriodUsage` and `GetPlanInfo` succeed for both accounts;
5. refresh token flow works after access token expiry;
6. no stale values after app restart.

---

## 10) Notes for implementation strategy in AIDE

- Keep account switch logic in one service (for example `CursorAccountService`).
- Keep usage API logic in separate service (for example `CursorUsageService`).
- Make switch idempotent and journal operations.
- Never log raw tokens.

