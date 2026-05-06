"""Long-running Chromium for gemini.google.com/app with persistent profile + CDP.

Runs alongside chrome_keepalive.py (the ChatGPT one) — separate ports/profiles
so the two Google accounts don't collide:

    chrome_keepalive.py    -> port 9222, profile chrome_keepalive_profile/   (ChatGPT)
    gemini_keepalive.py    -> port 9223, profile chrome_gemini_profile/      (Gemini)

ONE-TIME LOGIN:
  1. Run this script.
  2. The image generator (generate_images_gemini.py) auto-runs SSO with
     GEMINI_EMAIL / GEMINI_PASSWORD from .env on first call. Cookies persist
     in chrome_gemini_profile/ across runs.

Usage:
    python gemini_keepalive.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

REPO = Path(__file__).resolve().parent
PROFILE_DIR = REPO / "chrome_gemini_profile"
CDP_PORT = int(os.environ.get("GEMINI_CDP_PORT", "9223"))
GEMINI_URL = "https://gemini.google.com/app"
EMAIL = os.environ.get("GEMINI_EMAIL", "<unset>")


def main() -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[setup] launching Chromium with CDP on :{CDP_PORT}")
    print(f"[setup] profile dir: {PROFILE_DIR}")

    with sync_playwright() as pw:
        # Maxed-out anti-detection context options:
        #  - timezone + locale match a plausible real region (Asia/Tashkent / en-US)
        #  - explicit viewport matches a common laptop screen
        #  - clipboard permissions enable paste-based input (no keystroke fingerprint)
        #  - realistic extra HTTP headers
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1920, "height": 1080},
            screen={"width": 1920, "height": 1080},
            device_scale_factor=1.0,
            is_mobile=False,
            has_touch=False,
            timezone_id="Asia/Tashkent",
            locale="en-US",
            permissions=["clipboard-read", "clipboard-write"],
            color_scheme="light",
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9,uz;q=0.8,ru;q=0.7",
            },
            args=[
                "--start-maximized",
                f"--remote-debugging-port={CDP_PORT}",
                "--disable-blink-features=AutomationControlled",
                "--no-default-browser-check",
                "--no-first-run",
                "--disable-features=DiceWebSigninInterception,SigninInterceptBubbleV2,ProfileSwitcherPromo",
            ],
            ignore_default_args=["--enable-automation"],
        )

        try:
            Stealth().apply_stealth_sync(context)
            print("[setup] playwright-stealth applied to context")
        except Exception as e:
            print(f"[setup] WARNING: stealth apply failed: {e}")

        # Extra init-script: belt-and-suspenders patches on top of stealth
        # (some are duplicates of stealth but harmless; some are extras)
        context.add_init_script(r"""
            // Hide the navigator.webdriver flag completely
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            // Pretend to have plugins (real Chrome has at least PDF viewer)
            Object.defineProperty(navigator, 'plugins', {
                get: () => [{name: 'Chrome PDF Plugin'}, {name: 'Chrome PDF Viewer'}, {name: 'Native Client'}]
            });
            // Languages — match Accept-Language header
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'uz'] });
            // chrome.runtime — exists on real Chrome
            window.chrome = window.chrome || {};
            window.chrome.runtime = window.chrome.runtime || {};
            // Permissions API: claim 'notifications' is 'default' (real Chrome behavior)
            const origQuery = (navigator.permissions && navigator.permissions.query) ? navigator.permissions.query.bind(navigator.permissions) : null;
            if (origQuery) {
                navigator.permissions.query = (params) =>
                    params && params.name === 'notifications'
                        ? Promise.resolve({state: Notification.permission})
                        : origQuery(params);
            }
        """)

        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(GEMINI_URL, wait_until="commit", timeout=60_000)
        except Exception as e:
            print(f"[warn] failed to open Gemini: {e} — open it manually")

        print("")
        print("─" * 70)
        print(f"  CDP endpoint:  http://127.0.0.1:{CDP_PORT}/json/version")
        print(f"  Sign-in account: {EMAIL}")
        print(f"  Profile: {PROFILE_DIR}")
        print("")
        print("  KEEP THIS WINDOW OPEN.")
        print("       python generate_images_gemini.py --grade 7 --lang uz --subject 'jahon tarixi' --chapter 1")
        print("─" * 70)
        print("")

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
