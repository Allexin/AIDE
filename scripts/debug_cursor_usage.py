import json
import os
import sqlite3
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


APP_USER_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"


def decode_db_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if isinstance(value, str):
        return value
    return str(value)


def read_cursor_state(cursor_root: Path) -> Dict[str, Any]:
    db_path = cursor_root / "User" / "globalStorage" / "state.vscdb"
    if not db_path.exists():
        return {}

    conn = sqlite3.connect(str(db_path))
    try:
        conn.row_factory = sqlite3.Row
        keys = [
            "cursorAuth/accessToken",
            "cursorAuth/refreshToken",
            "cursorAuth/cachedEmail",
            "cursorAuth/cachedSignUpType",
            "cursorAuth/stripeMembershipType",
            "cursorAuth/stripeSubscriptionStatus",
            APP_USER_KEY,
        ]
        placeholders = ",".join("?" for _ in keys)
        rows = conn.execute(
            f"SELECT key, value FROM ItemTable WHERE key IN ({placeholders})",
            keys,
        ).fetchall()

        out: Dict[str, Any] = {}
        for row in rows:
            key = row["key"]
            decoded = decode_db_value(row["value"])
            if decoded is not None:
                out[key] = decoded
        return out
    finally:
        conn.close()


def load_tokens_and_config() -> Tuple[Optional[str], Optional[str], str, Optional[str], Optional[str]]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set")

    cursor_root = Path(appdata) / "Cursor"
    auth_path = cursor_root / "auth.json"

    auth_json: Dict[str, Any] = {}
    if auth_path.exists():
        auth_json = json.loads(auth_path.read_text(encoding="utf-8"))

    state = read_cursor_state(cursor_root)
    app_user_raw = state.get(APP_USER_KEY)
    app_user: Dict[str, Any] = {}
    if isinstance(app_user_raw, str):
        try:
            app_user = json.loads(app_user_raw)
        except json.JSONDecodeError:
            app_user = {}

    backend_url = (
        ((app_user.get("cursorCreds") or {}).get("backendUrl"))
        or "https://api2.cursor.sh"
    )
    auth_client_id = ((app_user.get("cursorCreds") or {}).get("authClientId"))

    access_token = state.get("cursorAuth/accessToken") or auth_json.get("accessToken")
    refresh_token = state.get("cursorAuth/refreshToken") or auth_json.get("refreshToken")
    email = state.get("cursorAuth/cachedEmail")

    return access_token, refresh_token, backend_url, auth_client_id, email


def post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str]) -> Tuple[int, str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.getcode(), resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        return e.code, text


def common_headers(access_token: str) -> Dict[str, str]:
    req_id = str(uuid.uuid4())
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-Request-ID": req_id,
        "X-Amzn-Trace-Id": f"Root={req_id}",
        "x-cursor-client-type": "ide",
        "x-cursor-client-device-type": "desktop",
    }


def refresh_access_token(backend_url: str, auth_client_id: str, refresh_token: str) -> Optional[str]:
    status, text = post_json(
        f"{backend_url}/oauth/token",
        {
            "grant_type": "refresh_token",
            "client_id": auth_client_id,
            "refresh_token": refresh_token,
        },
        {"Content-Type": "application/json"},
    )
    print(f"[refresh] status={status}")
    if status < 200 or status >= 300:
        print("[refresh] body:")
        print(text)
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        print("[refresh] invalid json")
        return None
    token = payload.get("access_token")
    if isinstance(token, str) and token:
        return token
    return None


def print_json_info(label: str, status: int, text: str) -> None:
    print(f"\n[{label}] status={status}")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        print("[body] non-json:")
        print(text)
        return

    if isinstance(payload, dict):
        print(f"[keys] {list(payload.keys())}")
        plan_usage = payload.get("plan_usage") or payload.get("planUsage")
        if isinstance(plan_usage, dict):
            print(f"[plan_usage keys] {list(plan_usage.keys())}")
        plan_info = payload.get("plan_info") or payload.get("planInfo")
        if isinstance(plan_info, dict):
            print(f"[plan_info keys] {list(plan_info.keys())}")

    print("[json]")
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def main() -> None:
    access_token, refresh_token, backend_url, auth_client_id, email = load_tokens_and_config()
    print(f"[account] email={email!r}")
    print(f"[backend] {backend_url}")
    print(f"[has access token] {bool(access_token)}")
    print(f"[has refresh token] {bool(refresh_token)}")
    print(f"[has auth client id] {bool(auth_client_id)}")

    if not access_token:
        raise RuntimeError("No access token found in Cursor auth storage")

    headers = common_headers(access_token)
    usage_url = f"{backend_url}/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
    plan_url = f"{backend_url}/aiserver.v1.DashboardService/GetPlanInfo"

    usage_status, usage_text = post_json(usage_url, {}, headers)
    plan_status, plan_text = post_json(plan_url, {}, headers)

    if (usage_status == 401 or plan_status == 401) and refresh_token and auth_client_id:
        print("[auth] received 401, trying refresh_token flow")
        new_access = refresh_access_token(backend_url, auth_client_id, refresh_token)
        if new_access:
            headers = common_headers(new_access)
            usage_status, usage_text = post_json(usage_url, {}, headers)
            plan_status, plan_text = post_json(plan_url, {}, headers)

    print_json_info("GetCurrentPeriodUsage", usage_status, usage_text)
    print_json_info("GetPlanInfo", plan_status, plan_text)


if __name__ == "__main__":
    main()
