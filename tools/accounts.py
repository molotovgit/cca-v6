"""Account rotator for v6.

Reads accounts.json (list of accounts per provider, in priority order) and
tracks which account is currently "active" for each provider. State persists
in .cca/active_accounts.json across runs.

Public API:
    load_accounts(repo_root)         -> dict {chatgpt: [...], gemini: [...]}
    get_active(provider, repo_root)  -> dict {label, email, password, index}
    rotate(provider, repo_root)      -> dict {label, email, password, index} (next account)
                                        raises NoMoreAccountsError when exhausted
    reset(provider, repo_root)       -> dict (resets to index 0)

The 1095/quota-driven IMAGES-stage rotation (planned for next v6 iteration)
will call rotate() when it detects the failure mode and re-launch sign-in.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


class NoMoreAccountsError(RuntimeError):
    """Raised when rotate() is called past the last account in the list."""


class AccountsFileMissingError(RuntimeError):
    """Raised when accounts.json doesn't exist (caller should fall back to .env)."""


def _accounts_path(repo_root: Path) -> Path:
    return repo_root / "accounts.json"


def _state_path(repo_root: Path) -> Path:
    return repo_root / ".cca" / "active_accounts.json"


def load_accounts(repo_root: Path) -> dict:
    p = _accounts_path(repo_root)
    if not p.exists():
        raise AccountsFileMissingError(f"{p} not found — run from accounts.json.example or fill in credentials")
    raw = json.loads(p.read_text(encoding="utf-8"))
    out = {}
    for provider in ("chatgpt", "gemini"):
        accs = raw.get(provider, [])
        if not isinstance(accs, list):
            raise ValueError(f"accounts.json: '{provider}' must be a list, got {type(accs).__name__}")
        # Strip any with placeholder values
        cleaned = []
        for a in accs:
            email = (a.get("email") or "").strip()
            password = (a.get("password") or "").strip()
            if not email or not password:
                continue
            if email.startswith("your-") or "example.com" in email or password.startswith("your-"):
                continue
            cleaned.append({
                "label":    a.get("label") or f"acct-{len(cleaned)+1}",
                "email":    email,
                "password": password,
            })
        out[provider] = cleaned
    return out


def _read_state(repo_root: Path) -> dict:
    sp = _state_path(repo_root)
    if not sp.exists():
        return {}
    try:
        return json.loads(sp.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_state(repo_root: Path, state: dict) -> None:
    sp = _state_path(repo_root)
    sp.parent.mkdir(parents=True, exist_ok=True)
    tmp = sp.with_suffix(sp.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(sp)


def _active_index(repo_root: Path, provider: str) -> int:
    return int(_read_state(repo_root).get(provider, {}).get("index", 0) or 0)


def _set_active_index(repo_root: Path, provider: str, idx: int, label: str) -> None:
    state = _read_state(repo_root)
    state[provider] = {"index": idx, "label": label}
    _write_state(repo_root, state)


def get_active(provider: str, repo_root: Path, *, override_index: Optional[int] = None) -> dict:
    """Return the currently-active account for `provider`. If `override_index`
    is given, use that instead (does NOT update persisted state)."""
    accs = load_accounts(repo_root)[provider]
    if not accs:
        raise NoMoreAccountsError(f"no usable {provider} accounts in accounts.json")
    if override_index is not None:
        if override_index < 0 or override_index >= len(accs):
            raise IndexError(f"{provider} account index {override_index} out of range (0..{len(accs)-1})")
        a = dict(accs[override_index])
        a["index"] = override_index
        return a
    idx = _active_index(repo_root, provider)
    if idx >= len(accs):
        # Stale state — reset
        idx = 0
    a = dict(accs[idx])
    a["index"] = idx
    return a


def rotate(provider: str, repo_root: Path) -> dict:
    """Advance to the next account; persist state. Raises NoMoreAccountsError
    if already on the last one."""
    accs = load_accounts(repo_root)[provider]
    cur = _active_index(repo_root, provider)
    nxt = cur + 1
    if nxt >= len(accs):
        raise NoMoreAccountsError(
            f"{provider} accounts exhausted (was at index {cur}/{len(accs)-1}). "
            f"Add another account to accounts.json or reset()."
        )
    a = dict(accs[nxt])
    a["index"] = nxt
    _set_active_index(repo_root, provider, nxt, a["label"])
    return a


def reset(provider: str, repo_root: Path) -> dict:
    """Reset active index to 0."""
    accs = load_accounts(repo_root)[provider]
    if not accs:
        raise NoMoreAccountsError(f"no {provider} accounts to reset to")
    a = dict(accs[0])
    a["index"] = 0
    _set_active_index(repo_root, provider, 0, a["label"])
    return a


def status(repo_root: Path) -> dict:
    """Return summary suitable for printing — used by auto_login.py and dashboard."""
    out = {"chatgpt": None, "gemini": None}
    try:
        accs = load_accounts(repo_root)
    except AccountsFileMissingError:
        return out
    for provider in ("chatgpt", "gemini"):
        provider_list = accs.get(provider, [])
        if not provider_list:
            continue
        idx = _active_index(repo_root, provider)
        if idx >= len(provider_list):
            idx = 0
        a = provider_list[idx]
        out[provider] = {
            "active_label":  a["label"],
            "active_index":  idx,
            "active_email":  a["email"],
            "total_accounts": len(provider_list),
        }
    return out


# ─── CLI for shell callers (e.g. run_autonomous.cjs) ─────────────────────────
# Usage:
#   python -m tools.accounts get <provider>     -> JSON of active account, exit 0
#   python -m tools.accounts rotate <provider>  -> JSON of new active, exit 0; or exit 2 if exhausted
#   python -m tools.accounts reset  <provider>  -> JSON of index-0 account
#   python -m tools.accounts status             -> JSON status summary
if __name__ == "__main__":
    import argparse
    import json as _json
    import sys as _sys

    REPO = Path(__file__).resolve().parent.parent

    p = argparse.ArgumentParser(prog="python -m tools.accounts")
    p.add_argument("cmd", choices=["get", "rotate", "reset", "status"])
    p.add_argument("provider", nargs="?", default=None,
                   help="chatgpt | gemini  (required for get/rotate/reset)")
    args = p.parse_args()

    try:
        if args.cmd == "status":
            print(_json.dumps(status(REPO), indent=2))
        elif args.cmd == "get":
            if not args.provider:
                print("provider required (chatgpt|gemini)", file=_sys.stderr); _sys.exit(1)
            print(_json.dumps(get_active(args.provider, REPO)))
        elif args.cmd == "rotate":
            if not args.provider:
                print("provider required (chatgpt|gemini)", file=_sys.stderr); _sys.exit(1)
            print(_json.dumps(rotate(args.provider, REPO)))
        elif args.cmd == "reset":
            if not args.provider:
                print("provider required (chatgpt|gemini)", file=_sys.stderr); _sys.exit(1)
            print(_json.dumps(reset(args.provider, REPO)))
    except NoMoreAccountsError as e:
        print(f"NoMoreAccountsError: {e}", file=_sys.stderr)
        _sys.exit(2)
    except AccountsFileMissingError as e:
        print(f"AccountsFileMissingError: {e}", file=_sys.stderr)
        _sys.exit(3)
    except (KeyError, ValueError, IndexError) as e:
        print(f"{type(e).__name__}: {e}", file=_sys.stderr)
        _sys.exit(4)
