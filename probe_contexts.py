"""Show all browser contexts and their tabs reachable via CDP."""
import sys, os
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()
CDP_PORT = int(os.environ.get("GEMINI_CDP_PORT", "9223"))

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    print(f"Browser version: {browser.version}")
    print(f"Total contexts: {len(browser.contexts)}\n")
    for i, ctx in enumerate(browser.contexts):
        print(f"=== Context #{i} ===")
        print(f"  Pages: {len(ctx.pages)}")
        for j, p in enumerate(ctx.pages):
            try:
                url = p.url
            except Exception as e:
                url = f"(url err: {e})"
            print(f"  [{i}.{j}] {url[:140]}")
        print()
