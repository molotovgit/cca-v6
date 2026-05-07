"""Gemini (gemini.google.com/app) browser driver.

Connects to gemini_keepalive via CDP, signs in via Google SSO using human-mimicking
mouse + typing, then drives image generation using Imagen built into Gemini.

Image generation in Gemini: just type 'Generate an image of <prompt>' (or just the
visual prompt — Gemini auto-detects). Image renders inline in the chat. We then
extract the image URL and download via the page's authenticated context.

The human_* helpers below (Bezier mouse curves, jittered typing, etc.) defeat
reCAPTCHA Enterprise behavioral scoring during Google SSO sign-in.
"""

from __future__ import annotations

import os
import random
import re
import time
from typing import Optional
from urllib.parse import urlparse

import httpx
from playwright.sync_api import sync_playwright, BrowserContext, Page


GEMINI_URL = "https://gemini.google.com/app"


# ─── CDP helpers ───

def _cdp_get(port: int, path: str = "/json") -> list:
    try:
        return httpx.get(f"http://127.0.0.1:{port}{path}", timeout=5).json()
    except Exception:
        return []


def close_intercept_tabs(cdp_port: int) -> int:
    """Close chrome:// dialogs (managed-user-profile-notice, dice-intercept) via CDP REST API."""
    closed = 0
    for t in _cdp_get(cdp_port):
        url = t.get("url", "")
        if (
            url.startswith("chrome://")
            or "managed-user-profile-notice" in url
            or "signin-dice" in url
        ):
            try:
                httpx.put(f"http://127.0.0.1:{cdp_port}/json/close/{t['id']}", timeout=5)
                closed += 1
            except Exception:
                pass
    return closed


def attach_to_keepalive(cdp_port: int):
    """Returns just the Browser. Caller picks the right context (persistent vs incognito)."""
    pw = sync_playwright().start()
    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
    if not browser.contexts:
        raise RuntimeError(f"connected to :{cdp_port} but no contexts found")
    return browser


def find_signed_in_gemini(browser) -> tuple:
    """Search ALL contexts for a gemini.google.com tab that's signed in.

    User may have logged in via the persistent profile OR via an incognito window
    (separate context). We scan both and pick whichever has the chat interface
    available (prompt input visible).

    Returns (context, page). Raises if no signed-in Gemini tab anywhere.
    """
    all_gemini = []  # list of (ctx, page, score)
    for ctx in browser.contexts:
        for p in ctx.pages:
            try:
                url = p.url or ""
                if "gemini.google.com" not in url:
                    continue
                # Score by signals of being signed in
                score = 0
                if _bbox_of_first_visible(p, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea'):
                    score += 10
                # Lower score if Sign in button is visible (means signed out)
                if _bbox_of_first_visible(p, 'a:has-text("Sign in"), button:has-text("Sign in")'):
                    score -= 5
                all_gemini.append((ctx, p, score))
            except Exception:
                continue

    if not all_gemini:
        raise RuntimeError("no gemini.google.com tab found in any context — log in to Gemini in the keepalive window first")

    # Pick highest-scoring tab; prefer signed-in
    all_gemini.sort(key=lambda x: -x[2])
    ctx, page, score = all_gemini[0]
    print(f"[gem] picked Gemini tab (score={score}) in context {browser.contexts.index(ctx)}")
    return ctx, page


def get_gemini_page(context: BrowserContext) -> Page:
    """Find or open a Gemini tab in the given context."""
    for p in context.pages:
        if "gemini.google.com" in (p.url or ""):
            p.bring_to_front()
            return p
    p = context.new_page()
    p.goto(GEMINI_URL, wait_until="commit", timeout=60_000)
    return p


# ─── Human-like interaction helpers ───
# (Defeats reCAPTCHA Enterprise behavioral scoring during sign-in.)

_CURRENT_MOUSE: list = [None, None]


def human_delay(min_s: float = 0.8, max_s: float = 2.0) -> None:
    time.sleep(random.uniform(min_s, max_s))


def _bezier_points(start: tuple, end: tuple, n: int) -> list:
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    length = max((dx * dx + dy * dy) ** 0.5, 1.0)
    perp = (-dy / length, dx / length)
    mid_t = random.uniform(0.40, 0.60)
    mx = sx + dx * mid_t
    my = sy + dy * mid_t
    offset = length * random.uniform(0.05, 0.20) * random.choice([-1, 1])
    cx = mx + perp[0] * offset
    cy = my + perp[1] * offset
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * ex
        y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ey
        pts.append((x, y))
    return pts


def human_move(page: Page, x: float, y: float, duration_min: float = 0.4, duration_max: float = 1.1) -> None:
    if _CURRENT_MOUSE[0] is None:
        viewport = page.viewport_size or {"width": 1280, "height": 720}
        _CURRENT_MOUSE[0] = viewport["width"] / 2
        _CURRENT_MOUSE[1] = viewport["height"] / 2

    duration = random.uniform(duration_min, duration_max)
    n_points = max(20, int(duration * 50))
    points = _bezier_points((_CURRENT_MOUSE[0], _CURRENT_MOUSE[1]), (x, y), n_points)
    per_step = duration / max(len(points) - 1, 1)
    for px, py in points:
        page.mouse.move(px, py)
        time.sleep(per_step * random.uniform(0.7, 1.3))
    _CURRENT_MOUSE[0] = x
    _CURRENT_MOUSE[1] = y


def human_click(page: Page, x: float, y: float, jitter_px: int = 8) -> None:
    over_x = x + random.uniform(-jitter_px * 2, jitter_px * 2)
    over_y = y + random.uniform(-jitter_px * 2, jitter_px * 2)
    human_move(page, over_x, over_y)
    time.sleep(random.uniform(0.18, 0.45))
    final_x = x + random.uniform(-jitter_px, jitter_px)
    final_y = y + random.uniform(-jitter_px, jitter_px)
    page.mouse.move(final_x, final_y, steps=random.randint(6, 14))
    _CURRENT_MOUSE[0] = final_x
    _CURRENT_MOUSE[1] = final_y
    time.sleep(random.uniform(0.05, 0.15))
    page.mouse.click(final_x, final_y, delay=random.randint(80, 220))


def human_type(page: Page, text: str) -> None:
    """Slow typing with thinking pauses — use ONLY for the high-bot-detection sign-in flow."""
    for ch in text:
        page.keyboard.type(ch)
        delay_ms = random.uniform(45, 130)
        if random.random() < 0.05:
            delay_ms = random.uniform(450, 1300)
        if ch in ".,!?:;":
            delay_ms = max(delay_ms, random.uniform(180, 380))
        elif ch == " ":
            delay_ms = max(delay_ms, random.uniform(80, 200))
        time.sleep(delay_ms / 1000.0)


def fast_type(page: Page, text: str) -> None:
    """Fast typing for in-app prompt submission. ~5-15 ms/char, no thinking pauses."""
    page.keyboard.type(text, delay=random.randint(5, 15))


def paste_text(page: Page, text: str) -> bool:
    """Set clipboard via JS, then Ctrl+V to paste. Bypasses keystroke fingerprinting.

    Returns True on success. Requires the context to have clipboard-write permission
    (set in gemini_keepalive.py's launch_persistent_context options).
    """
    try:
        # Write to clipboard via the async clipboard API
        page.evaluate(
            "async (t) => { await navigator.clipboard.writeText(t); }",
            text,
        )
        time.sleep(random.uniform(0.2, 0.5))
        page.keyboard.press("Control+V")
        time.sleep(random.uniform(0.3, 0.7))
        return True
    except Exception as e:
        print(f"[paste] failed, falling back to typing: {e}")
        return False


def fill_field_via_paste(page: Page, selector: str, text: str, timeout_s: int = 15) -> None:
    """Click field via human mouse, then paste text from clipboard. Falls back to typing if paste fails."""
    deadline = time.time() + timeout_s
    bbox = None
    while time.time() < deadline:
        bbox = _bbox_of_first_visible(page, selector)
        if bbox:
            break
        time.sleep(0.4)
    if not bbox:
        raise RuntimeError(f"field not found within {timeout_s}s: {selector}")
    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)
    human_delay(0.5, 1.2)
    if not paste_text(page, text):
        # Clipboard paste failed — fall back to slow human typing
        human_type(page, text)


def _bbox_of_first_visible(page: Page, selector: str) -> Optional[dict]:
    try:
        loc = page.locator(selector)
        n = loc.count()
    except Exception:
        return None
    if n == 0:
        return None
    for i in range(min(n, 20)):
        try:
            el = loc.nth(i)
            if not el.is_visible(timeout=500):
                continue
            box = el.bounding_box(timeout=500)
            if box and box.get("width", 0) > 0 and box.get("height", 0) > 0:
                return {"x": box["x"], "y": box["y"], "w": box["width"], "h": box["height"]}
        except Exception:
            continue
    return None


def human_fill(page: Page, selector: str, text: str, timeout_s: int = 15) -> None:
    deadline = time.time() + timeout_s
    bbox = None
    while time.time() < deadline:
        bbox = _bbox_of_first_visible(page, selector)
        if bbox:
            break
        time.sleep(0.4)
    if not bbox:
        raise RuntimeError(f"field not found within {timeout_s}s: {selector}")
    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)
    human_delay(0.5, 1.2)
    human_type(page, text)


def _host(url: str) -> str:
    try:
        return (urlparse(url or "").hostname or "").lower()
    except Exception:
        return ""


# ─── Sign-in flow ───

def is_signed_in_to_gemini(page: Page) -> bool:
    """Strict signed-in check — looks for a visible Sign-in CTA (means NOT signed in)
    OR for a prompt input (means signed in). URL alone isn't sufficient because
    gemini.google.com hosts both the signed-out landing page AND the app.
    """
    h = _host(page.url)
    if not h.endswith("gemini.google.com"):
        return False

    # If a Sign-in CTA is visible, we're definitely NOT signed in.
    # NOTE: removed `a[href*="accounts.google.com"]` — false-positive on
    # signed-in /app pages which contain benign account-management links to
    # accounts.google.com in headers/menus.
    for sel in [
        'a:has-text("Sign in")',
        'button:has-text("Sign in")',
        'a:has-text("Try Gemini")',
    ]:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible(timeout=500):
                return False
        except Exception:
            continue

    # If a prompt input exists, definitely signed in
    if _bbox_of_first_visible(page, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea'):
        return True

    # Ambiguous — assume not signed in (forces login attempt, which is idempotent)
    return False


def login_via_google_human(page: Page, email: str, password: str, cdp_port: int,
                           timeout_s: int = 240) -> Page:
    """Full Google SSO flow with slow curved-mouse + jittered typing.

    Re-finds the best tab after each navigation step; returns the final signed-in page.
    """
    deadline = time.time() + timeout_s
    context = page.context

    def _pick_best_page() -> Page:
        for p in context.pages:
            if "gemini.google.com" in (p.url or ""):
                return p
        for p in context.pages:
            host = _host(p.url)
            if "google.com" in host and "gemini" not in host and "accounts" in host:
                return p
        for p in context.pages:
            if "google.com" in (p.url or ""):
                return p
        return page

    def _check_blockers(p: Page):
        try:
            body = (p.evaluate("() => document.body.innerText.slice(0, 1000)") or "").lower()
        except Exception:
            return
        if "couldn't sign you in" in body or "this browser or app may not be secure" in body:
            raise RuntimeError("Google blocked sign-in: 'browser not secure' (bot detection)")
        if "verify it's you" in body or "verify it is you" in body:
            raise RuntimeError("Google asking for identity verification — manual step needed once")
        if "2-step" in body or "verification code" in body or "enter the code" in body:
            raise RuntimeError("Google requires 2FA")
        if "wrong password" in body or "incorrect password" in body:
            raise RuntimeError("Google rejected the password")

    cur = _pick_best_page()
    cur.bring_to_front()
    print(f"[login] starting at: {cur.url[:100]}")

    # Phase 1: ensure on Gemini app page
    if "gemini.google.com" not in (cur.url or "") and "accounts.google.com" not in (cur.url or ""):
        cur.goto(GEMINI_URL, wait_until="commit", timeout=60_000)
        try:
            cur.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        time.sleep(3)

    # Phase 1b: if on gemini.google.com (signed-out landing), human-click "Sign in"
    cur = _pick_best_page()
    cur.bring_to_front()
    h = _host(cur.url)
    if h.endswith("gemini.google.com"):
        # Look for Sign in CTA
        for sel in [
            'a:has-text("Sign in")',
            'button:has-text("Sign in")',
            'a[href*="accounts.google.com"]',
        ]:
            bbox = _bbox_of_first_visible(cur, sel)
            if bbox:
                print(f"[login] human-clicking 'Sign in' CTA at ({int(bbox['x'])}, {int(bbox['y'])})")
                human_click(cur, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
                human_delay(2.5, 4.5)
                break
        else:
            # No Sign in button — maybe already on the app surface but prompt not loaded yet
            time.sleep(3)
            if _bbox_of_first_visible(cur, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea'):
                print(f"[login] no Sign-in CTA; prompt input present → assumed signed in")
                return cur

    # Wait for Google sign-in tab to appear OR for Gemini app to load
    nav_end = time.time() + 30
    while time.time() < nav_end:
        close_intercept_tabs(cdp_port)
        cur = _pick_best_page()
        cur.bring_to_front()
        host = _host(cur.url)
        if host.endswith("gemini.google.com"):
            if _bbox_of_first_visible(cur, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea'):
                # Ensure we land on /app (not / landing) so the chat is visibly
                # rendered — downstream is_signed_in_to_gemini() needs the prompt
                # input visible, which only appears on /app.
                if not cur.url.rstrip("/").endswith("gemini.google.com/app"):
                    try:
                        cur.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=20_000)
                        time.sleep(2)
                    except Exception:
                        pass
                print(f"[login] reached Gemini app (signed in): {cur.url[:80]}")
                return cur
        if "accounts.google.com" in host:
            print(f"[login] reached Google sign-in: {cur.url[:80]}")
            break
        time.sleep(1)

    # Phase 2: fill email via clipboard paste (no keystroke fingerprint)
    cur = _pick_best_page()
    cur.bring_to_front()
    h = _host(cur.url)
    if "google.com" in h and "gemini" not in h:
        # Read-pause: humans look at the page for several seconds before typing
        print("[login] page-read pause (3-6s)...")
        human_delay(3.0, 6.0)

        # Phase 2a: handle the account-chooser page that Google shows AFTER a
        # /Logout (rotation case). The chooser lists previously-used accounts
        # plus a "Use another account" / "Использовать другой аккаунт" link.
        # Without clicking that link there's no email field — fill_field_via_paste
        # below would time out. Detect the chooser by the presence of the link
        # OR by the absence of input[type="email"], and click through.
        chooser_selectors = [
            '[data-identifier="-1"]',                             # Google's internal id for "Use another account"
            'div[role="link"]:has-text("Use another account")',
            'div[role="link"]:has-text("другой аккаунт")',         # Russian: "Использовать другой аккаунт"
            'div[role="button"]:has-text("Use another account")',
            'div[role="button"]:has-text("другой аккаунт")',
            'a:has-text("Use another account")',
            'a:has-text("другой аккаунт")',
            'li:has-text("Use another account")',
            'li:has-text("другой аккаунт")',
        ]
        chooser_bbox = None
        for sel in chooser_selectors:
            chooser_bbox = _bbox_of_first_visible(cur, sel)
            if chooser_bbox:
                print(f"[login] account-chooser detected; clicking 'Use another account' (selector: {sel})")
                break
        if chooser_bbox:
            human_click(cur, chooser_bbox["x"] + chooser_bbox["w"] / 2,
                        chooser_bbox["y"] + chooser_bbox["h"] / 2)
            # Wait for the email-entry page to load
            try:
                cur.wait_for_selector('input[type="email"]', timeout=15_000)
            except Exception:
                pass
            human_delay(1.5, 3.0)
            cur = _pick_best_page()
            cur.bring_to_front()
            _check_blockers(cur)

        print(f"[login] entering email via clipboard paste: {email}")
        _check_blockers(cur)
        fill_field_via_paste(cur, 'input[type="email"]', email, timeout_s=20)
        human_delay(1.5, 3.0)

        next_bbox = _bbox_of_first_visible(cur, '#identifierNext button, button:has-text("Next")')
        if next_bbox:
            print("[login] clicking Next (after email)")
            human_click(cur, next_bbox["x"] + next_bbox["w"] / 2, next_bbox["y"] + next_bbox["h"] / 2)
        else:
            cur.keyboard.press("Enter")
        human_delay(2.5, 4.5)

    # Phase 3: fill password via clipboard paste
    cur = _pick_best_page()
    cur.bring_to_front()
    pw_deadline = time.time() + 30
    pw_bbox = None
    while time.time() < pw_deadline and time.time() < deadline:
        _check_blockers(cur)
        pw_bbox = _bbox_of_first_visible(cur, 'input[type="password"]')
        if pw_bbox:
            break
        time.sleep(0.6)
    if not pw_bbox:
        raise RuntimeError(f"password field never appeared. Last URL: {cur.url}")

    # Read-pause before password too
    print("[login] page-read pause (2-4s)...")
    human_delay(2.0, 4.0)

    print("[login] entering password via clipboard paste")
    human_click(cur, pw_bbox["x"] + pw_bbox["w"] / 2, pw_bbox["y"] + pw_bbox["h"] / 2)
    human_delay(0.6, 1.4)
    if not paste_text(cur, password):
        human_type(cur, password)
    human_delay(1.5, 3.0)

    next_bbox = _bbox_of_first_visible(cur, '#passwordNext button, button:has-text("Next")')
    if next_bbox:
        print("[login] clicking Next (after password)")
        human_click(cur, next_bbox["x"] + next_bbox["w"] / 2, next_bbox["y"] + next_bbox["h"] / 2)
    else:
        cur.keyboard.press("Enter")

    # Phase 4: wait for redirect back to gemini.google.com
    # Bug fix: previous code used `"gemini.google.com" in url` which matched
    # the Google challenge URL `?continue=https://gemini.google.com/app` and
    # returned a false-positive success. Now we host-match strictly AND verify
    # by waiting for the prompt input to be present.
    print("[login] waiting for redirect to gemini.google.com...")
    while time.time() < deadline:
        close_intercept_tabs(cdp_port)
        cur = _pick_best_page()
        cur.bring_to_front()
        cur_host = _host(cur.url)
        # STRICT host check (not substring) — only the actual gemini.google.com host
        if cur_host.endswith("gemini.google.com"):
            time.sleep(3)
            # Also confirm the chat is actually rendered (prompt input visible)
            if _bbox_of_first_visible(cur, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea[aria-label*="prompt" i]'):
                print(f"[login] success — back on Gemini and chat ready: {cur.url[:80]}")
                return cur
            # On gemini host but UI not yet rendered — keep waiting
        # Blocker check on any accounts.google.* host (any ccTLD)
        if cur_host.startswith("accounts.google."):
            _check_blockers(cur)
        time.sleep(1)

    raise RuntimeError(f"login timed out. Last URL: {cur.url}")


def ensure_logged_in(page: Page, email: str, password: str, cdp_port: int) -> Page:
    if is_signed_in_to_gemini(page):
        # Double-check by looking for the prompt input (not just URL)
        if _bbox_of_first_visible(page, 'rich-textarea, [contenteditable="true"][role="textbox"], textarea[aria-label*="prompt" i]'):
            print("[login] already signed in — skip")
            return page
    print(f"[login] not signed in — running human SSO as {email}")
    return login_via_google_human(page, email, password, cdp_port)


# ─── Image generation ───

def open_new_chat(page: Page) -> None:
    """Click 'New chat' to start a fresh conversation. Best-effort."""
    for sel in [
        'button:has-text("New chat")',
        '[data-test-id="new-conversation-button"]',
        'button[aria-label*="New chat" i]',
    ]:
        bbox = _bbox_of_first_visible(page, sel)
        if bbox:
            human_click(page, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
            human_delay(1.5, 3.0)
            return


def click_new_chat(page: Page) -> bool:
    """Click 'New chat' button. Returns True if clicked. Best-effort — the user
    might already be in a fresh chat."""
    try:
        # Proven selector from working CJS
        bbox = _bbox_of_first_visible(page, 'button[aria-label="New chat"]')
        if bbox:
            human_click(page, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
            time.sleep(1.5)
            return True
    except Exception:
        pass
    return False


def submit_prompt(page: Page, prompt_text: str) -> None:
    """Click Gemini prompt input, FAST-type prompt, click Send. Uses proven selectors.

    Strips embedded newlines because Gemini's contenteditable sends on \\n\\n
    (early-send bug from the working CJS script).
    """
    # Strip newlines — Gemini contenteditable interprets \n as send
    prompt_text = re.sub(r"\s*\n\s*", " ", prompt_text)

    # Proven prompt-input selector: contenteditable with aria-label "Enter a prompt for Gemini"
    candidates = [
        '[contenteditable="true"][aria-label*="Enter a prompt for Gemini" i]',
        '[contenteditable="true"][role="textbox"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]',
    ]
    bbox = None
    for sel in candidates:
        bbox = _bbox_of_first_visible(page, sel)
        if bbox:
            break
    if not bbox:
        raise RuntimeError("Gemini prompt input not found")

    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)
    human_delay(0.3, 0.7)

    # FAST typing inside the app — proven 25ms delay from CJS
    page.keyboard.type(prompt_text, delay=random.randint(15, 30))
    human_delay(0.6, 1.0)

    # Proven send-button selector: aria-label="Send message"
    send_bbox = _bbox_of_first_visible(page, 'button[aria-label="Send message"]')
    if not send_bbox:
        # Fallback to broader match
        send_bbox = _bbox_of_first_visible(
            page,
            'button[aria-label*="Send" i], button[aria-label*="Submit" i]',
        )
    if send_bbox:
        human_click(page, send_bbox["x"] + send_bbox["w"] / 2, send_bbox["y"] + send_bbox["h"] / 2)
    else:
        page.keyboard.press("Enter")
    human_delay(0.4, 0.9)


def capture_baseline_image_srcs(page: Page) -> list:
    """Snapshot of current image srcs — used to detect the NEW image after generation."""
    try:
        return page.evaluate(
            "() => Array.from(document.querySelectorAll('img')).map(i => i.src || '')"
        ) or []
    except Exception:
        return []


def wait_for_generation_done(page: Page, max_s: int = 300) -> bool:
    """Wait for the 'Stop' button to appear (= generating) then disappear (= done).

    This is the PROVEN pattern from the working CJS script — much more reliable
    than polling for new img tags (which can race or miss blob:/data: URLs).
    """
    deadline = time.time() + max_s
    saw_stop = False
    while time.time() < deadline:
        try:
            is_generating = page.evaluate(r"""() => {
                return Array.from(document.querySelectorAll('button, [role=button]')).some(b => {
                    const aria = (b.getAttribute('aria-label') || '').trim();
                    const text = (b.innerText || '').trim();
                    return /^Stop /i.test(aria) || /^Stop$/i.test(text);
                });
            }""")
            if is_generating:
                saw_stop = True
            elif saw_stop:
                time.sleep(2)  # let the image render fully
                return True
        except Exception:
            pass
        time.sleep(2)
    return saw_stop  # timed out — return whether we ever saw it generating


def find_new_image(page: Page, baseline_srcs: list) -> Optional[dict]:
    """Find the largest new <img> on the page that wasn't in the baseline. Returns {src, w, h}."""
    try:
        return page.evaluate(
            r"""(baseline) => {
                const baselineSet = new Set(baseline);
                const imgs = Array.from(document.querySelectorAll('img'));
                let best = null;
                for (const img of imgs) {
                    const r = img.getBoundingClientRect();
                    if (r.width < 200 || r.height < 200) continue;
                    const src = img.src || '';
                    if (!src) continue;
                    if (baselineSet.has(src)) continue;
                    if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;  // avatar
                    if (/avatar|profile|logo|emoji/i.test(src)) continue;
                    const area = r.width * r.height;
                    if (!best || area > best.area) {
                        best = {src, w: Math.round(r.width), h: Math.round(r.height), area};
                    }
                }
                return best;
            }""",
            baseline_srcs,
        )
    except Exception:
        return None


def download_image(page: Page, image_url: str, save_path) -> bool:
    """Download an image — handles blob:, data:, and http(s) URLs.

    blob: needs canvas export (the URL is page-local). data: is base64 in-line.
    http(s) URLs work via the page's authenticated request context.
    """
    import base64
    try:
        save_path.parent.mkdir(parents=True, exist_ok=True)

        if image_url.startswith("data:image"):
            b64 = image_url.split(",", 1)[1]
            save_path.write_bytes(base64.b64decode(b64))
            return True

        if image_url.startswith("blob:"):
            data_url = page.evaluate(
                r"""(src) => {
                    const img = Array.from(document.querySelectorAll('img')).find(i => i.src === src);
                    if (!img) return null;
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || img.width;
                    c.height = img.naturalHeight || img.height;
                    c.getContext('2d').drawImage(img, 0, 0);
                    return c.toDataURL('image/png');
                }""",
                image_url,
            )
            if not data_url:
                print(f"[download] canvas export failed for blob: {image_url[:80]}")
                return False
            b64 = data_url.split(",", 1)[1]
            save_path.write_bytes(base64.b64decode(b64))
            return True

        # http(s) — fetch via page's authenticated context
        response = page.request.get(image_url, timeout=60_000)
        if response.status != 200:
            print(f"[download] HTTP {response.status} for {image_url[:80]}")
            return False
        save_path.write_bytes(response.body())
        return True
    except Exception as e:
        print(f"[download] error: {e}")
        return False


# Backward-compat alias for the old single-call API
def wait_for_generated_image(page: Page, max_s: int = 300) -> Optional[str]:
    """Compat wrapper: wait for generation to finish, then return the new image URL."""
    baseline = capture_baseline_image_srcs(page)
    wait_for_generation_done(page, max_s=max_s)
    found = find_new_image(page, baseline)
    return found["src"] if found else None
