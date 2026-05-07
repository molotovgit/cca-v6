"""ChatGPT browser driver.

Connects to the keep-alive Chromium via CDP, finds (or opens) a chatgpt.com
tab in the persistent context, and exposes:

    get_or_open_chatgpt_page(browser)
    is_logged_in(page)
    new_conversation(page)
    send_and_collect(page, text)

Ported from CCA's automation/lib/chatgpt.cjs. Multi-fallback selectors —
ChatGPT's UI rotates frequently, so each interaction tries N selectors in
order and the first visible match wins. When all fail the error includes
a short DOM dump so you can patch SEL.* without guessing.

Auto-login via Google SSO is implemented (login_via_google + ensure_logged_in
below) but is best-effort. Google's reCAPTCHA Enterprise + "verify it's you"
challenges + 2FA can block it; in those cases the helper raises a clear
RuntimeError and the caller should fall back to manual sign-in. After one
successful sign-in (manual or auto), cookies persist in the profile dir
and subsequent runs no-op via is_account_logged_in().
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright


def _host_of(url: str) -> str:
    """Return just the hostname, lowercased. Empty string if unparseable."""
    try:
        return (urlparse(url or "").hostname or "").lower()
    except Exception:
        return ""


CHATGPT_URL = "https://chatgpt.com/"
CHATGPT_URL_PATTERN = re.compile(r"chatgpt\.com|chat\.openai\.com")


SEL = {
    "prompt_input": [
        ("css",   "#prompt-textarea[contenteditable=true]"),
        ("aria",  re.compile(r"^Message ChatGPT$", re.I)),
        ("aria",  re.compile(r"^Message$", re.I)),
        ("css",   "div[contenteditable=true][role=textbox]"),
        ("css",   "div[contenteditable=true]"),
    ],
    "send_button": [
        ("aria",  re.compile(r"^Send (prompt|message)$", re.I)),
        ("data",  "send-button"),
        ("data",  "fruitjuice-send-button"),
        ("aria",  re.compile(r"^Send$", re.I)),
    ],
    "stop_button": [
        ("aria",  re.compile(r"^Stop (generating|streaming)$", re.I)),
        ("data",  "stop-button"),
        ("aria",  re.compile(r"^Stop$", re.I)),
    ],
    "login_indicator": [
        ("aria",  re.compile(r"^Log in$", re.I)),
        ("text",  re.compile(r"Log in to ChatGPT", re.I)),
        ("data",  "login-button"),
    ],
}


@dataclass
class FoundEl:
    method: str
    value: str
    x: float
    y: float
    w: float
    h: float
    tag: str
    text: str


def _find_one(page: Page, registry: list, timeout_ms: int = 8000) -> Optional[FoundEl]:
    """Try each selector in order; return first visible match (poll up to timeout)."""
    deadline = time.time() + timeout_ms / 1000.0
    serialized = []
    for method, value in registry:
        if isinstance(value, re.Pattern):
            serialized.append({"method": method, "source": value.pattern, "flags": _flags_to_js(value.flags)})
        else:
            serialized.append({"method": method, "source": value, "flags": ""})

    while time.time() < deadline:
        try:
            result = page.evaluate(
                """(tries) => {
                    function visible(el) {
                        if (!el) return false;
                        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }
                    for (const t of tries) {
                        let candidates = [];
                        if (t.method === 'css') {
                            candidates = Array.from(document.querySelectorAll(t.source));
                        } else if (t.method === 'aria') {
                            const re = new RegExp(t.source, t.flags);
                            candidates = Array.from(document.querySelectorAll('[aria-label]'))
                                .filter(el => re.test(el.getAttribute('aria-label') || ''));
                        } else if (t.method === 'data') {
                            candidates = Array.from(document.querySelectorAll(`[data-testid="${t.source}"]`));
                        } else if (t.method === 'text') {
                            const re = new RegExp(t.source, t.flags);
                            candidates = Array.from(document.querySelectorAll('button, a, [role=button]'))
                                .filter(el => re.test((el.innerText || '').trim()));
                        }
                        const hit = candidates.find(visible);
                        if (hit) {
                            const r = hit.getBoundingClientRect();
                            return {
                                method: t.method,
                                value: t.source,
                                x: r.x, y: r.y, w: r.width, h: r.height,
                                tag: hit.tagName,
                                text: (hit.innerText || hit.value || '').slice(0, 60),
                            };
                        }
                    }
                    return null;
                }""",
                serialized,
            )
        except Exception as e:
            msg = str(e).lower()
            if "context was destroyed" in msg or "navigation" in msg or "execution context" in msg:
                # Page navigated mid-poll; wait for it to settle and retry.
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=5000)
                except Exception:
                    pass
                time.sleep(0.5)
                continue
            raise
        if result:
            return FoundEl(**result)
        time.sleep(0.25)
    return None


def _flags_to_js(py_flags: int) -> str:
    s = ""
    if py_flags & re.IGNORECASE:
        s += "i"
    if py_flags & re.MULTILINE:
        s += "m"
    if py_flags & re.DOTALL:
        s += "s"
    return s


def _dump_candidates(page: Page, kind: str = "button") -> list:
    """Return up to 30 DOM candidates for debugging selector failures."""
    return page.evaluate(
        """(k) => {
            const tags = k === 'button' ? ['button', '[role=button]'] : ['div[contenteditable]', 'textarea'];
            const out = [];
            for (const sel of tags) {
                for (const el of document.querySelectorAll(sel)) {
                    out.push({
                        tag: el.tagName,
                        aria: el.getAttribute('aria-label') || '',
                        dataTestId: el.getAttribute('data-testid') || '',
                        text: (el.innerText || '').slice(0, 60),
                    });
                }
            }
            return out.slice(0, 30);
        }""",
        kind,
    )


def attach_to_keepalive(cdp_port: int = 9222) -> tuple[Browser, BrowserContext]:
    """Connect to the keep-alive Chromium running with --remote-debugging-port.

    Returns (browser, persistent_context). The persistent context is the
    default one created by launch_persistent_context — that's where the
    ChatGPT login cookies live.
    """
    pw = sync_playwright().start()
    endpoint = f"http://127.0.0.1:{cdp_port}"
    browser = pw.chromium.connect_over_cdp(endpoint)
    if not browser.contexts:
        raise RuntimeError(f"connected to {endpoint} but no contexts found")
    return browser, browser.contexts[0]


def get_or_open_chatgpt_page(context: BrowserContext) -> Page:
    """Find an existing ChatGPT tab or repurpose another one.

    Order of preference:
      1. A page already on chatgpt.com / chat.openai.com.
      2. A page on auth.openai.com (mid-login state — keep using it).
      3. Any non-blank page — navigate it to chatgpt.com.
      4. Brand new page → goto chatgpt.com.

    Uses wait_until='commit' (not 'domcontentloaded') so the heavy
    chatgpt.com SPA doesn't time out while still hydrating.
    """
    # 1. chatgpt.com / chat.openai.com (host-based, not substring — query strings can lie)
    for page in context.pages:
        host = _host_of(page.url)
        if host.endswith("chatgpt.com") or host.endswith("chat.openai.com"):
            return page
    # 2. auth.openai.com or accounts.google.com (mid-login) — keep using
    for page in context.pages:
        host = _host_of(page.url)
        if host.endswith("openai.com") or host.endswith("accounts.google.com") or host.endswith("google.com"):
            return page
    # 3. Any non-blank tab — navigate it
    for page in context.pages:
        try:
            url = page.url or ""
            if url and "about:blank" not in url and "chrome://" not in url:
                page.goto(CHATGPT_URL, wait_until="commit", timeout=60_000)
                return page
        except Exception:
            continue
    # 4. Fresh tab
    page = context.new_page()
    page.goto(CHATGPT_URL, wait_until="commit", timeout=60_000)
    return page


def is_logged_in(page: Page) -> bool:
    """Return True if the prompt input is reachable.

    Note: modern ChatGPT lets guest users send prompts too. A "Log in"
    button can coexist with a working prompt input. We treat presence of
    the prompt input as sufficient — guest mode has lower limits but works.
    For long batches you want to be logged in.
    """
    return _find_one(page, SEL["prompt_input"], timeout_ms=4000) is not None


def new_conversation(page: Page) -> None:
    """Open a fresh ChatGPT thread in the current tab."""
    page.goto(CHATGPT_URL, wait_until="domcontentloaded", timeout=15_000)
    found = _find_one(page, SEL["prompt_input"], timeout_ms=12_000)
    if not found:
        cands = _dump_candidates(page, "editor")
        raise RuntimeError(
            f"prompt input not found on {page.url}.\n"
            f"Top candidates: {cands[:10]}\n"
            f"Patch tools/browser/chatgpt.py SEL['prompt_input']."
        )


def send_prompt(page: Page, text: str) -> int:
    """Type the prompt and click send. Returns baseline assistant message count."""
    prompt = _find_one(page, SEL["prompt_input"], timeout_ms=8000)
    if not prompt:
        raise RuntimeError("cannot find prompt input")

    page.mouse.click(prompt.x + 20, prompt.y + 20, delay=30)
    time.sleep(0.2)

    # Type — Shift+Enter = newline, plain Enter would submit early.
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line:
            page.keyboard.type(line, delay=1)
        if i < len(lines) - 1:
            page.keyboard.down("Shift")
            page.keyboard.press("Enter")
            page.keyboard.up("Shift")
    time.sleep(0.4)

    baseline = page.evaluate(
        "() => document.querySelectorAll('[data-message-author-role=\"assistant\"]').length"
    )

    send = _find_one(page, SEL["send_button"], timeout_ms=8000)
    if not send:
        cands = _dump_candidates(page, "button")
        raise RuntimeError(
            f"send button not found.\n"
            f"Top candidates: {cands[:10]}\n"
            f"Patch tools/browser/chatgpt.py SEL['send_button']."
        )
    page.mouse.click(send.x + send.w / 2, send.y + send.h / 2, delay=30)
    return baseline


def wait_for_response(page: Page, baseline_count: int,
                      max_ms: int = 360_000, poll_ms: int = 1500) -> str:
    """Wait for the Stop button to appear-then-disappear, then read the new assistant message."""
    deadline = time.time() + max_ms / 1000.0
    saw_stop = False
    while time.time() < deadline:
        stop = _find_one(page, SEL["stop_button"], timeout_ms=500)
        if stop:
            saw_stop = True
        elif saw_stop:
            break
        time.sleep(poll_ms / 1000.0)

    text = page.evaluate(
        """(baseline) => {
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (msgs.length <= baseline) return null;
            const last = msgs[msgs.length - 1];
            return last.innerText || last.textContent || '';
        }""",
        baseline_count,
    )
    if not text:
        raise RuntimeError(
            f"no new assistant message after {max_ms / 1000:.0f}s. "
            f"baseline was {baseline_count}; assistant count unchanged."
        )
    return text


def send_and_collect(page: Page, text: str, max_ms: int = 360_000) -> str:
    """Send a prompt, wait for completion, return the assistant's response text."""
    baseline = send_prompt(page, text)
    return wait_for_response(page, baseline, max_ms=max_ms)


# ──────────────────────── Google SSO auto-login ──────────────────────────

def login_via_google(page: Page, email: str, password: str,
                     timeout_ms: int = 180_000, cdp_port: int = 9222) -> None:
    """Attempt ChatGPT login via Google SSO. State-aware: can resume mid-flow.

    Routes based on current page URL:
      - On chatgpt.com (logged out)  -> click Log in -> Continue with Google
      - On auth.openai.com           -> click Continue with Google
      - On accounts.google.com       -> jump straight to email/password
      - Anywhere else                -> navigate to chatgpt.com login page

    Uses Playwright locators (auto-wait for visible+enabled+stable) instead of
    raw ElementHandles, which avoid the 'element not attached to DOM' races
    that happen during Google's identifier-to-password animations.

    Raises RuntimeError on any detectable failure mode:
      - 'Couldn't sign you in' / 'browser may not be secure' (bot detection)
      - 'Verify it's you' identity challenge
      - 2FA prompt
      - Wrong password
      - Did not return to chatgpt.com within timeout
    """
    deadline = time.time() + timeout_ms / 1000.0

    def _body():
        try:
            return (page.evaluate("() => document.body.innerText.slice(0, 1200)") or "").lower()
        except Exception:
            return ""

    def _check_blockers():
        b = _body()
        if "couldn't sign you in" in b or "this browser or app may not be secure" in b:
            raise RuntimeError(
                "login: Google blocked the sign-in ('couldn't sign you in / browser not secure'). "
                "Auto-login won't work for this account/browser combo."
            )
        if "verify it's you" in b or "verify it is you" in b:
            raise RuntimeError(
                "login: Google asking for identity verification ('verify it's you'). "
                "Auto-login can't proceed. Log in manually once to clear the challenge."
            )
        if "2-step" in b or "two-step" in b or ("verification code" in b and "enter" in b):
            raise RuntimeError("login: Google is asking for a 2FA code. Auto-login can't proceed.")
        if "wrong password" in b or "incorrect password" in b:
            raise RuntimeError("login: Google rejected the password.")

    def _wait_for(predicate, timeout_s, label):
        """Poll predicate() until True or timeout. Checks blockers each iteration."""
        end = time.time() + timeout_s
        while time.time() < end and time.time() < deadline:
            _check_blockers()
            if predicate():
                return True
            time.sleep(0.4)
        raise RuntimeError(f"login: timeout waiting for {label}. Current URL: {page.url}")

    # ── Step 0: Route based on current state (host-based, not substring) ──
    host = _host_of(page.url)
    print(f"[login] current host: {host}")

    if host.endswith("accounts.google.com") or host.endswith("google.com"):
        print("[login] already on Google sign-in — skipping chatgpt.com step")
    elif host.endswith("openai.com"):
        print("[login] on OpenAI auth — looking for Continue with Google")
    else:
        # Either on chatgpt.com or unrelated. Navigate to login.
        print("[login] navigating to chatgpt.com/auth/login")
        page.goto("https://chatgpt.com/auth/login", wait_until="commit", timeout=60_000)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        time.sleep(3.0)
        # If already logged in, prompt input is reachable.
        if _find_one(page, SEL["prompt_input"], timeout_ms=2000):
            return
        # /auth/login redirects to auth.openai.com — wait for that to settle.
        wait_end = time.time() + 15
        while time.time() < wait_end:
            new_host = _host_of(page.url)
            if new_host.endswith("openai.com") or new_host.endswith("google.com"):
                break
            time.sleep(0.5)
        print(f"[login] after auth-login redirect, host = {_host_of(page.url)}")

    # ── Step 0.5: On chatgpt.com/auth/login the actual auth form is hidden
    # behind a "Log in" CTA (testid='login-button'). Click it first.
    host = _host_of(page.url)
    if host.endswith("chatgpt.com"):
        print("[login] clicking 'Log in' CTA on chatgpt.com")
        if not _click_first_visible(page, [
            ("data", "login-button"),
            ("aria", re.compile(r"^Log in$", re.I)),
            ("text", re.compile(r"^Log in$", re.I)),
        ], timeout_ms=15000):
            raise RuntimeError(f"login: 'Log in' button not found on {page.url}")
        # After click, page navigates to auth.openai.com or shows next step.
        wait_end = time.time() + 15
        while time.time() < wait_end:
            new_host = _host_of(page.url)
            if new_host.endswith("openai.com") and not new_host.endswith("chatgpt.com"):
                break
            if new_host.endswith("google.com"):
                break
            time.sleep(0.5)
        time.sleep(2.0)
        print(f"[login] after Log-in click, host = {_host_of(page.url)}")

    # ── Step 1: Click Continue with Google (if not already on Google) ──
    host = _host_of(page.url)
    if not host.endswith("google.com"):
        print("[login] looking for 'Continue with Google' button...")
        if not _click_first_visible(page, [
            ("text", re.compile(r"Continue with Google", re.I)),
            ("aria", re.compile(r"Continue with Google", re.I)),
            ("css",  'button[data-provider="google"]'),
            ("css",  'a[href*="google"]'),
        ], timeout_ms=20000):
            raise RuntimeError(
                f"login: 'Continue with Google' button not found on {page.url}."
            )
        print("[login] clicked Continue with Google")

    # ── Step 3: Wait for Google email page or chooser ──
    # State machine: after "Continue with Google", we may pass through an
    # OpenAI intermediate page (auth.openai.com/log-in-or-create-account)
    # before reaching either:
    #   (a) Google email form        — input[type="email"] visible
    #   (b) Google account chooser   — URL contains "accountchooser"
    #   (c) Google password page     — input[type="password"] visible (if a
    #                                   previous attempt cached the email)
    # We poll until ONE of these stable states is reached (or we time out).
    # Then if (b), click "Use another account" so we pivot to (a).
    print("[login] waiting for Google email page or chooser...")
    state_deadline = time.time() + 120
    state = None
    last_url_logged = ""
    clicked_openai_continue = False  # the OpenAI intermediate page has its own
                                     # 'Continue with Google' button — click once
    while time.time() < state_deadline:
        cur_url = (page.url or "").lower()
        if cur_url != last_url_logged:
            print(f"[login] url -> {cur_url[:120]}")
            last_url_logged = cur_url

        # auth.openai.com/log-in-or-create-account is OpenAI's auth landing
        # page that sometimes sits between chatgpt.com and Google. It has
        # its OWN 'Continue with Google' button that must be clicked to
        # actually redirect to Google. Click it ONCE.
        if "auth.openai.com" in cur_url and not clicked_openai_continue:
            print("[login] on auth.openai.com intermediate page — clicking Continue with Google here too")
            for sel in (
                'button:has-text("Continue with Google")',
                'a:has-text("Continue with Google")',
                'button[data-provider="google"]',
                'a[href*="google.com"]',
            ):
                try:
                    btn = page.locator(sel).first
                    if btn.count() > 0 and btn.is_visible():
                        print(f"[login] clicked Continue-with-Google on auth.openai.com (sel={sel})")
                        btn.click()
                        clicked_openai_continue = True
                        break
                except Exception as e:
                    print(f"[login] openai-continue probe [{sel}] error: {e}")
            time.sleep(2.0)
            continue

        # Skip chatgpt.com transient
        if "chatgpt.com" in cur_url:
            time.sleep(0.8); continue

        # Chooser is unambiguous from URL alone.
        if "accountchooser" in cur_url:
            state = "chooser"; break
        # Only inspect form fields on actual Google sign-in pages.
        if "accounts.google" in cur_url:
            try:
                email_loc = page.locator('input[type="email"]').first
                if email_loc.count() > 0 and email_loc.is_visible():
                    state = "email"; break
            except Exception:
                pass
            try:
                pw_loc = page.locator('input[type="password"]').first
                if pw_loc.count() > 0 and pw_loc.is_visible():
                    state = "password"; break
            except Exception:
                pass
        time.sleep(0.8)

    print(f"[login] settled state={state}  URL host: {(page.url or '')[:100]}")
    if state is None:
        raise RuntimeError(f"login: no Google email / chooser / password page after 60s. URL={page.url}")

    # ── Step 3a: Account-chooser handling (mirror of gemini.py fix) ──
    # When the user previously signed in to a Google account in this Chrome
    # profile, Google redirects ChatGPT's OAuth through
    # accounts.google.com/v3/signin/accountchooser BEFORE showing the email
    # form. The chooser has a hidden input[type="email"] in the DOM that
    # ISN'T actionable, so the fill() below would time out. Click
    # "Use another account" / "Использовать другой аккаунт" so the email
    # form actually appears.
    if state == "chooser":
        try:
            page.wait_for_load_state("domcontentloaded", timeout=10_000)
        except Exception:
            pass
        time.sleep(1.5)  # let dynamic chooser content render

        # ALWAYS click "Use another account" / "Использовать другой аккаунт" —
        # the user's explicit policy. Do NOT auto-pick the existing row even
        # if the target email is listed on the chooser.
        click_strategies = [
            ('text="Use another account"',                       "text-en"),
            ('text="Использовать другой аккаунт"',                "text-ru"),
            ('div[role="link"]:has-text("Use another account")', "role-link-en"),
            ('div[role="link"]:has-text("другой аккаунт")',      "role-link-ru"),
            ('li:has-text("Use another account")',               "li-en"),
            ('li:has-text("другой аккаунт")',                    "li-ru"),
        ]
        clicked_use_another = False
        for sel, label in click_strategies:
            try:
                loc = page.locator(sel).first
                cnt = loc.count()
                vis = loc.is_visible() if cnt > 0 else False
                print(f"[login] use-another probe [{label}] count={cnt} vis={vis}")
                if cnt > 0 and vis:
                    print(f"[login] account-chooser detected; clicking 'Use another account' (sel={sel})")
                    loc.click()
                    clicked_use_another = True
                    break
            except Exception as e:
                print(f"[login] use-another probe [{label}] error: {e}")
                continue
        if not clicked_use_another:
            raise RuntimeError(
                "login: on accountchooser but no 'Use another account' selector matched"
            )

        try:
            page.wait_for_selector('input[type="email"]:visible', timeout=15_000)
            print("[login] email form appeared after 'Use another account' click")
        except Exception as e:
            raise RuntimeError(f"login: email form did not appear after 'Use another account' click: {e}")
        time.sleep(1.5)

    if page.locator('input[type="email"]').count() > 0:
        # Wait for the field to settle, then fill.
        try:
            page.locator('input[type="email"]').first.wait_for(state="visible", timeout=15_000)
        except Exception:
            pass
        time.sleep(1.0)
        print(f"[login] entering email: {email}")
        try:
            page.locator('input[type="email"]').first.fill(email, timeout=15_000)
        except Exception as e:
            raise RuntimeError(f"login: failed to fill email field: {e}")
        time.sleep(0.6)
        page.keyboard.press("Enter")

        # Wait for navigation to password page.
        print("[login] waiting for password page...")
        _wait_for(
            lambda: page.locator('input[type="password"]').count() > 0,
            timeout_s=30,
            label="Google password field",
        )

    # ── Step 4: Fill password ──
    try:
        page.locator('input[type="password"]').first.wait_for(state="visible", timeout=15_000)
    except Exception:
        pass
    time.sleep(1.5)
    print("[login] entering password")
    try:
        page.locator('input[type="password"]').first.fill(password, timeout=15_000)
    except Exception as e:
        raise RuntimeError(f"login: failed to fill password field: {e}")
    time.sleep(0.6)
    page.keyboard.press("Enter")

    # ── Step 5: Wait for redirect back to chatgpt.com ──
    # Two fixes vs the previous loop:
    #   - Close chrome:// intercept tabs every iteration (signin-dice-web-intercept,
    #     managed-user-profile-notice). They block the redirect from completing.
    #   - Check is_account_logged_in() as success rather than URL-pattern matching.
    #     Google sign-in often hops through accounts.google.<ccTLD> (e.g. .co.uz)
    #     before landing on chatgpt.com, and the intercept tab can be the active
    #     page.url — so URL alone is unreliable.
    print("[login] waiting for chatgpt.com redirect...")
    import httpx as _httpx  # local import — already a dep
    while time.time() < deadline:
        # Close any chrome:// intercept tabs in this Chrome instance.
        try:
            for t in _httpx.get(f"http://127.0.0.1:{cdp_port}/json", timeout=3).json():
                u = t.get("url", "")
                if u.startswith("chrome://") and ("signin-dice" in u or "managed-user-profile-notice" in u):
                    try:
                        _httpx.put(f"http://127.0.0.1:{cdp_port}/json/close/{t['id']}", timeout=3)
                    except Exception:
                        pass
        except Exception:
            pass

        # Re-pick the chatgpt page if the intercept stole focus
        try:
            for p in page.context.pages:
                if "chatgpt.com" in (p.url or ""):
                    page = p
                    break
        except Exception:
            pass

        # Success: account-level logged-in check (URL-tolerant)
        try:
            if is_account_logged_in(page):
                return
        except Exception:
            pass

        # Blocker check on any accounts.google.* host (any ccTLD)
        url = page.url or ""
        if "accounts.google." in url:
            _check_blockers()
        time.sleep(1.0)

    raise RuntimeError(
        f"login: timed out waiting to return to chatgpt.com. Last URL: {page.url}"
    )


def _click_first_visible(page: Page, registry: list, timeout_ms: int = 8000,
                         optional: bool = False) -> bool:
    """Try selectors; click the first visible match. Returns True if clicked."""
    found = _find_one(page, registry, timeout_ms=timeout_ms)
    if not found:
        if optional:
            return False
        return False
    page.mouse.click(found.x + found.w / 2, found.y + found.h / 2, delay=30)
    return True


def is_account_logged_in(page: Page) -> bool:
    """Stricter check: look for the 'Log in' / 'Sign up' surface.

    is_logged_in() returns True even in guest mode (prompt input is
    reachable). This one returns False whenever a Log-in button is on
    the page, forcing the SSO flow.
    """
    # If a Log-in button / sign-up CTA is visible, we're a guest.
    login_btn = _find_one(page, SEL["login_indicator"], timeout_ms=2500)
    if login_btn:
        return False
    # If we got past the Log-in surface AND the prompt input exists, we're in.
    return is_logged_in(page)


def ensure_logged_in(page: Page, email: str, password: str, cdp_port: int = 9222) -> None:
    """If a Log-in button is visible, run the Google SSO flow. Else no-op.
    cdp_port is forwarded to login_via_google so it can close intercept tabs
    on the correct Chrome instance during the post-password redirect wait."""
    # Close any stale extra tabs that may pollute the login flow (e.g. an
    # auth.openai.com tab left over from a prior failed run).
    context = page.context
    for other in list(context.pages):
        if other is page:
            continue
        try:
            url = other.url or ""
            if "openai.com" in url and "chatgpt.com" not in url:
                print(f"[login] closing stale tab: {url}")
                other.close()
        except Exception:
            pass

    # Make sure our working page is on chatgpt.com.
    if not CHATGPT_URL_PATTERN.search(page.url or ""):
        page.goto(CHATGPT_URL, wait_until="commit", timeout=60_000)
        time.sleep(2.5)

    if is_account_logged_in(page):
        print(f"[login] already logged in as account holder — skip")
        return

    print(f"[login] guest / logged-out — attempting Google SSO as {email}")
    login_via_google(page, email, password, cdp_port=cdp_port)
    if not is_account_logged_in(page):
        time.sleep(3)
        if not is_account_logged_in(page):
            raise RuntimeError("login: completed flow but page still shows guest UI")
    print(f"[login] success — logged in as {email}")
