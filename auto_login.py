"""Auto-login wrapper for CCA v5.

Runs after setup_chrome.cjs has launched both Chrome windows, before the
pipeline starts. For each (ChatGPT on :9222, Gemini on :9223):
  1. Attach to running Chrome via CDP.
  2. Find the relevant tab (chatgpt.com or gemini.google.com).
  3. If signed in, skip.
  4. If not, run the existing ensure_logged_in() flow with .env creds.
  5. Surface clear status.

Exit codes:
  0 — both signed in (or auto-login succeeded for both)
  1 — auto-login hit a human-required blocker (CAPTCHA / 2FA / verify-it's-you)
  2 — wrong credentials
  3 — transient / connection error

start.bat invokes this between Chrome launch and the manual-sign-in pause.
On non-zero exit, the pause becomes the fallback — user signs in manually
in whichever window failed.

Usage:
  python auto_login.py
  python auto_login.py --chatgpt-port 9224 --gemini-port 9225  # for testing on alt profiles
  python auto_login.py --skip-gemini                             # only do ChatGPT
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Force UTF-8 console output on Windows (matches fetch_chapter.py convention).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parent
load_dotenv(REPO / ".env")
sys.path.insert(0, str(REPO))

from tools.browser import chatgpt as cg
from tools.browser import gemini as gm
from tools import accounts as acct
from playwright.sync_api import sync_playwright


def _classify_error(msg: str) -> int:
    """Map RuntimeError messages from login_via_google[_human] to exit codes."""
    m = (msg or "").lower()
    if any(s in m for s in ["verify it's you", "verify it is you",
                            "couldn't sign you in", "browser may not be secure",
                            "browser or app may not be secure",
                            "2fa", "2-step", "two-step", "verification code"]):
        return 1  # human-required blocker
    if any(s in m for s in ["wrong password", "incorrect password", "rejected the password"]):
        return 2  # wrong credentials
    return 3  # transient/unknown


def login_chatgpt(pw, port: int, email: str, password: str) -> int:
    """Sign in to ChatGPT in the Chrome instance at `port`. `pw` is a live
    sync_playwright handle managed by the caller (one instance for the whole
    process — separate sync_playwright().start() calls conflict)."""
    print(f"\n=== ChatGPT auto-login on :{port} ===")
    if not email or not password:
        print("[chatgpt] no credentials in .env — skipping")
        return 0
    try:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        if not browser.contexts:
            print(f"[chatgpt] connected to :{port} but no contexts found")
            return 3
        context = browser.contexts[0]
    except Exception as e:
        print(f"[chatgpt] cannot attach to Chrome :{port} — {e}")
        return 3
    try:
        page = cg.get_or_open_chatgpt_page(context)
        cg.ensure_logged_in(page, email, password, cdp_port=port)
        print("[chatgpt] OK — signed in")
        return 0
    except RuntimeError as e:
        print(f"[chatgpt] FAIL — {e}")
        return _classify_error(str(e))
    except Exception as e:
        print(f"[chatgpt] FAIL — unexpected: {type(e).__name__}: {e}")
        return 3


def _force_signout_gemini(context, port: int) -> None:
    """Navigate to Google Logout URL to clear the current session before signing
    in to a different account (rotation case).

    BUG FIX: previously this only navigated ONE tab to /Logout, leaving every
    OTHER Google/Gemini tab (the dozens that submit_prompts.cjs opened during
    image generation) alive on gemini.google.com/app showing CACHED UI. The
    subsequent login_via_google_human::_pick_best_page would pick one of those
    stale tabs, see a prompt textarea, and falsely declare "signed in" without
    ever running the actual sign-in flow. Then submit_prompts would respawn
    and enter prompts on tabs that weren't really authenticated.

    Fix: open a fresh anchor tab first (so Chrome doesn't collapse), close ALL
    pre-existing Google/Gemini tabs, THEN navigate the anchor to /Logout. After
    this, only the anchor tab remains, on accounts.google.com — no stale UI
    to fool the post-login verification."""
    import time

    # 1. Anchor tab first (guarantees the context isn't empty when we close others)
    anchor = context.new_page()

    # 2. Close every pre-existing Google/Gemini tab — their cached UI is what
    #    fooled the verification. The submit_prompts/save_images children
    #    were already killed by triggerRotation, but their tabs persist in Chrome.
    closed = 0
    for p in list(context.pages):
        if p is anchor:
            continue
        url = p.url or ""
        if "gemini.google.com" in url or "google.com" in url:
            try:
                p.close()
                closed += 1
            except Exception:
                pass
    if closed:
        print(f"[gemini] closed {closed} stale Google/Gemini tabs before sign-out")
        time.sleep(1)

    # 3. Now navigate the anchor to /Logout (clean slate)
    try:
        print("[gemini] force sign-out (rotation): navigating to accounts.google.com/Logout")
        anchor.goto("https://accounts.google.com/Logout", wait_until="domcontentloaded", timeout=30_000)
        time.sleep(3)
    except Exception as e:
        print(f"[gemini] force-signout warning: {e}")

    # 4. Close any chrome:// intercept tabs the logout may have spawned
    gm.close_intercept_tabs(port)


def login_gemini(pw, port: int, email: str, password: str, *, force_resignin: bool = False) -> int:
    """Sign in to Gemini in the Chrome instance at `port`. See login_chatgpt
    for the `pw` lifecycle note. If `force_resignin` is True (rotation case),
    explicitly sign out the current Google session first."""
    print(f"\n=== Gemini auto-login on :{port} {'(FORCE RESIGN-IN)' if force_resignin else ''} ===")
    if not email or not password:
        print("[gemini] no credentials in .env — skipping")
        return 0
    try:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        if not browser.contexts:
            print(f"[gemini] connected to :{port} but no contexts found")
            return 3
        if force_resignin:
            _force_signout_gemini(browser.contexts[0], port)
            # BUG FIX: previously we then called find_signed_in_gemini /
            # get_gemini_page, which would either return a stale gemini.google.com/app
            # tab still showing CACHED UI (post-logout, the page reads as "signed in"
            # because the React app doesn't refresh until a hard reload) — or open
            # a new Gemini tab that Google immediately redirects to gemini.google.com
            # /app from the post-logout cookie state. Either way, login_via_google_human::
            # _pick_best_page picked that gemini-looking page, Phase 1b's "no Sign-in
            # CTA + prompt input present → assumed signed in" branch falsely returned
            # success, and the rotation never actually entered new credentials.
            #
            # Force-resignin path now: close every remaining Gemini tab in the context,
            # open a fresh tab, and HARD-NAVIGATE it to accounts.google.com/AccountChooser
            # so login_via_google_human starts on a known clean Google sign-in page —
            # no cached Gemini UI to fool _pick_best_page.
            import time as _t
            context = browser.contexts[0]
            closed_extra = 0
            for p in list(context.pages):
                if "gemini.google.com" in (p.url or ""):
                    try:
                        p.close()
                        closed_extra += 1
                    except Exception:
                        pass
            if closed_extra:
                print(f"[gemini] closed {closed_extra} additional Gemini tabs that reappeared after logout")
            page = context.new_page()
            try:
                # Use continue=gemini.google.com/app so Google routes the
                # post-sign-in redirect through to Gemini. Without continue=,
                # Google parks the user on myaccount.google.com and Phase 4's
                # "wait for gemini.google.com" times out even though sign-in
                # succeeded.
                chooser_url = (
                    "https://accounts.google.com/AccountChooser"
                    "?continue=https%3A%2F%2Fgemini.google.com%2Fapp"
                )
                print(f"[gemini] navigating to AccountChooser with continue=gemini.google.com/app")
                page.goto(chooser_url, wait_until="domcontentloaded", timeout=30_000)
                _t.sleep(2)
            except Exception as e:
                print(f"[gemini] navigation to AccountChooser warning: {e}")
        else:
            # Non-rotation (first-time) path: try to find an existing signed-in
            # Gemini tab; otherwise open a fresh one.
            try:
                context, page = gm.find_signed_in_gemini(browser)
            except RuntimeError:
                context = browser.contexts[0]
                page = gm.get_gemini_page(context)
    except Exception as e:
        print(f"[gemini] cannot attach to Chrome :{port} — {e}")
        return 3
    try:
        gm.ensure_logged_in(page, email, password, cdp_port=port)
        print("[gemini] OK — signed in")
        return 0
    except RuntimeError as e:
        print(f"[gemini] FAIL — {e}")
        return _classify_error(str(e))
    except Exception as e:
        print(f"[gemini] FAIL — unexpected: {type(e).__name__}: {e}")
        return 3


def _resolve_credentials(args) -> dict:
    """Source of truth ordering:
       1. accounts.json via tools/accounts.py (preferred — supports rotation)
       2. .env CHATGPT_EMAIL/PASSWORD/GEMINI_EMAIL/PASSWORD (backward-compat fallback)
       Returns dict {provider: {email, password, label}}.
    """
    out = {"chatgpt": None, "gemini": None}
    use_accounts_json = False
    try:
        for provider in ("chatgpt", "gemini"):
            override = getattr(args, f"{provider}_account_index", None)
            try:
                a = acct.get_active(provider, REPO, override_index=override)
            except IndexError as e:
                print(f"  ✗ {provider} account index out of range — {e}")
                sys.exit(2)
            out[provider] = {"email": a["email"], "password": a["password"],
                             "label": a["label"], "index": a["index"]}
        use_accounts_json = True
        print(f"  source: accounts.json")
    except acct.AccountsFileMissingError:
        # Fall back to .env
        cg_email = (os.getenv("CHATGPT_EMAIL") or "").strip().strip('"').strip("'")
        cg_pwd   = (os.getenv("CHATGPT_PASSWORD") or "").strip().strip('"').strip("'")
        gm_email = (os.getenv("GEMINI_EMAIL") or "").strip().strip('"').strip("'")
        gm_pwd   = (os.getenv("GEMINI_PASSWORD") or "").strip().strip('"').strip("'")
        if cg_email and cg_pwd:
            out["chatgpt"] = {"email": cg_email, "password": cg_pwd, "label": "(.env)", "index": 0}
        if gm_email and gm_pwd:
            out["gemini"] = {"email": gm_email, "password": gm_pwd, "label": "(.env)", "index": 0}
        print(f"  source: .env (legacy — accounts.json not found)")
    except acct.NoMoreAccountsError as e:
        print(f"  source: accounts.json — {e}")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Auto-login wrapper for CCA v6.")
    p.add_argument("--chatgpt-port", type=int,
                   default=int(os.getenv("CDP_PORT", 9222)))
    p.add_argument("--gemini-port", type=int,
                   default=int(os.getenv("GEMINI_CDP_PORT", 9223)))
    p.add_argument("--skip-chatgpt", action="store_true",
                   help="skip ChatGPT auto-login")
    p.add_argument("--skip-gemini", action="store_true",
                   help="skip Gemini auto-login")
    p.add_argument("--chatgpt-account-index", type=int, default=None,
                   help="override active ChatGPT account index (does not persist state)")
    p.add_argument("--gemini-account-index", type=int, default=None,
                   help="override active Gemini account index (does not persist state)")
    p.add_argument("--force-resignin", action="store_true",
                   help="rotation mode: sign OUT current Google session before signing in")
    args = p.parse_args()

    print("════════════════════════════════════════════════════════════════")
    print("  CCA v6 — auto-login (multi-account)")
    print("════════════════════════════════════════════════════════════════")
    creds = _resolve_credentials(args)
    cg_creds = creds["chatgpt"] or {"email": "", "password": "", "label": "(missing)", "index": -1}
    gm_creds = creds["gemini"]  or {"email": "", "password": "", "label": "(missing)", "index": -1}
    print(f"  ChatGPT  :{args.chatgpt_port}  [{cg_creds['label']} #{cg_creds['index']}]  "
          f"email={cg_creds['email'] or '(missing)'}  {'(skip)' if args.skip_chatgpt else ''}")
    print(f"  Gemini   :{args.gemini_port}   [{gm_creds['label']} #{gm_creds['index']}]  "
          f"email={gm_creds['email'] or '(missing)'}  {'(skip)' if args.skip_gemini else ''}")

    rc_cg = 0
    rc_gm = 0

    # Single Playwright lifecycle for the whole process — calling
    # sync_playwright().start() twice in the same process leaves the first
    # event loop alive and the second errors out with
    # "using Playwright Sync API inside the asyncio loop".
    with sync_playwright() as pw:
        if not args.skip_chatgpt:
            rc_cg = login_chatgpt(pw, args.chatgpt_port, cg_creds["email"], cg_creds["password"])
        if not args.skip_gemini:
            rc_gm = login_gemini(pw, args.gemini_port, gm_creds["email"], gm_creds["password"],
                                 force_resignin=args.force_resignin)

    rc = max(rc_cg, rc_gm)

    print()
    print("════════════════════════════════════════════════════════════════")
    if rc == 0:
        print("  ✓ AUTO-LOGIN OK — pipeline can start")
    elif rc == 1:
        print("  ⚠ human verification required (CAPTCHA / 2FA / verify-it's-you)")
        print("    Open the Chrome window listed above and complete sign-in manually,")
        print("    then re-run. Sessions persist after first manual sign-in.")
    elif rc == 2:
        print("  ✗ wrong credentials — check accounts.json or .env")
    else:
        print("  ✗ transient error — try again, or sign in manually as fallback")
    print("════════════════════════════════════════════════════════════════")

    sys.exit(rc)


if __name__ == "__main__":
    main()
