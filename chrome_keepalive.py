"""Long-running Chromium with persistent profile + CDP enabled.

Run this ONCE per work session and leave it running. It opens a visible
Chromium window with:

  - Persistent profile dir at chrome_keepalive_profile/
    (chatgpt.com login cookies persist across runs)

  - CDP exposed on 127.0.0.1:CDP_PORT so the pipeline scripts can attach.

ONE-TIME SETUP:
  1. Run this script.
  2. In the Chromium window, log into chatgpt.com using the credentials
     in .env (CHATGPT_EMAIL / CHATGPT_PASSWORD). Use Google SSO.
  3. After login, leave this window open. Subsequent pipeline runs will
     attach automatically and the session stays logged-in.

Usage:
    python chrome_keepalive.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

REPO = Path(__file__).resolve().parent
PROFILE_DIR = REPO / "chrome_keepalive_profile"
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
CHATGPT_URL = "https://chatgpt.com/"
EMAIL = os.environ.get("CHATGPT_EMAIL", "<unset>")


def main() -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[setup] launching Chromium with CDP on :{CDP_PORT}")
    print(f"[setup] profile dir: {PROFILE_DIR}")

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport=None,  # use the actual window size
            args=[
                "--start-maximized",
                f"--remote-debugging-port={CDP_PORT}",
                "--disable-blink-features=AutomationControlled",
                "--no-default-browser-check",
                "--no-first-run",
                # Disable Chrome's "Add account to Chrome?" intercept — it
                # opens a chrome:// dialog that hijacks the post-login redirect
                # and stalls automation.
                "--disable-features=DiceWebSigninInterception,SigninInterceptBubbleV2,ProfileSwitcherPromo",
            ],
            ignore_default_args=["--enable-automation"],
        )

        # Open ChatGPT in the first tab.
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(CHATGPT_URL, wait_until="domcontentloaded", timeout=30_000)
        except Exception as e:
            print(f"[warn] failed to open ChatGPT: {e} — open it manually")

        print("")
        print("─" * 70)
        print("  CDP endpoint:  http://127.0.0.1:{}/json/version".format(CDP_PORT))
        print("")
        print("  ONE-TIME LOGIN STEPS:")
        print(f"    1. In the Chromium window, log into chatgpt.com.")
        print(f"    2. Use the account: {EMAIL}")
        print(f"       (password is in .env if you need it)")
        print(f"    3. Use Google SSO. Cookies persist in:")
        print(f"       {PROFILE_DIR}")
        print("")
        print("  KEEP THIS WINDOW OPEN. Run pipeline scripts in another shell:")
        print("       python refine_chapter.py --input chapters/.../ch01-...md")
        print("─" * 70)
        print("")

        # Keep alive until user closes the window or hits Ctrl+C.
        try:
            while True:
                time.sleep(5)
                if not context.pages:
                    print("[exit] all pages closed")
                    break
        except KeyboardInterrupt:
            print("\n[exit] Ctrl+C")
        finally:
            context.close()


if __name__ == "__main__":
    main()
