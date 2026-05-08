# CLAUDE.md — cca-v6

Read this first if you're an AI assistant working in this repo. Goal: get oriented in 5 minutes and avoid re-introducing the bug taxonomy in the "Bug taxonomy — DO NOT REGRESS" section below (~14 distinct bugs, all fixed since the original v6 release at `7630103`).

## What this is

5-stage Notion → ChatGPT → Gemini → Notion image pipeline. Per chapter:

1. **FETCH** — pulls textbook chapter from Notion (`fetch_chapter.py`)
2. **REFINE** — ChatGPT rewrites it (`refine_chapter.py`, ChatGPT on Chrome :9222)
3. **PROMPTS** — ChatGPT generates 80 image prompts (`generate_prompts.py`)
4. **IMAGES** — Gemini renders 80 PNGs in 10 parallel tabs (`scripts/run_autonomous.cjs`, Gemini on Chrome :9223)
5. **UPLOAD** — `upload_images.py` zips refined MD + 80 PNGs, attaches the zip as a file block on the chapter's "Images" subpage in Notion

Each stage is idempotent — skips if its output is already on disk. Per-chapter driver: `scripts/run_pipeline.cjs`. Multi-chapter driver: a `.bat` loop (see "Launcher pattern" below). **Do not use `scripts/run_batch.cjs`** — it has a broken Windows workaround that races chapters in parallel.

## Critical files

| File | Purpose |
|---|---|
| `scripts/run_pipeline.cjs` | Per-chapter 5-stage orchestrator. Reads `CCA_GRADE`/`CCA_LANG`/`CCA_SUBJECT`/`CCA_CHAPTER` env vars. |
| `scripts/run_autonomous.cjs` | IMAGES-stage orchestrator. Handles rotation, rescue, saver-restart. |
| `scripts/save_images.cjs` | Pulls PNGs off Gemini tabs. Has `detectBlocker()` for explicit 1095/quota UI. |
| `scripts/submit_prompts.cjs` | Opens Gemini tabs, types prompts. Tags tabs in `.cca/tab_map.json`. |
| `scripts/dashboard.cjs` | http://localhost:7777 live status board (binds 127.0.0.1). |
| `auto_login.py` | Multi-account sign-in. Reads `accounts.json` (preferred) or falls back to `.env` env vars. |
| `tools/accounts.py` | Rotator. CLI: `python -m tools.accounts {get|rotate|reset|status} <provider>`. State in `.cca/active_accounts.json`. |
| `tools/browser/gemini.py` | Gemini login flow + image capture helpers. Includes the human-SSO state machine. |
| `upload_images.py` | Stage 5. Zip rebuild logic + Notion multipart upload + `.uploaded.json` marker. |
| `accounts.json` (**gitignored**) | Credentials list, rotation source of truth. Schema in `accounts.json.example`. |
| `.env` (**gitignored**) | Notion API key + Chrome ports + legacy ChatGPT/Gemini env vars. |

## Launcher pattern (the repo ships no end-user launcher)

Per-machine `launch_*.bat` files (gitignored). They:

1. Write `.env`, `accounts.json`, `lessons.txt` from heredocs (credentials embedded inline)
2. `python -m tools.accounts reset gemini` so each batch run starts on `primary` (older runs may have left state on a backup)
3. Install deps with two PATH-fallbacks: `python -m pip install -q -r requirements.txt` (pip is often not on PATH even when python is) and an `npm.cmd` PATH fallback through `%PROGRAMFILES%\nodejs`/`%PROGRAMFILES(X86)%\nodejs`/`%LOCALAPPDATA%\Programs\nodejs` if `where npm` fails
4. Set `PUPPETEER_SKIP_DOWNLOAD=true` and `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` before `npm install` — the codebase uses real Chrome via CDP and doesn't need puppeteer's bundled Chromium (~150 MB download that often fails on restricted networks)
5. `node scripts\setup_chrome.cjs` to launch CDP Chrome on :9222 and :9223 (skips if already up)
6. `start "CCA Dashboard" cmd /k "node scripts\dashboard.cjs"` then `start "" "http://localhost:7777"` — `cmd /k` (not `/MIN`) so the user can see errors if the dashboard crashes
7. `python auto_login.py` — pause for manual sign-in if rc != 0 (CAPTCHA on first-time profile is normal)
8. Per-chapter blocks: `set CCA_CHAPTER=N` then `node scripts\run_pipeline.cjs <nul`. **The `<nul` redirect is required** — without it the child's stdio handle can disrupt the parent batch script's stdin and the .bat exits prematurely (cmd's invisible "Terminate batch job?" auto-Y).
9. Final `cmd /k` so the window doesn't auto-close even if `pause` gets EOF'd by a misbehaving child.

To make a new launcher: copy an existing `launch_*.bat` and edit the chapter blocks at the bottom.

### File-format requirements for .bat files

Cmd.exe's parser is unforgiving:

- **CRLF line endings.** LF-only causes cmd to eat the first 2–3 chars of each line ("setlocal" → "tlocal", "cd /d" → "/d").
- **ASCII only.** Em-dashes, box-drawing characters, Cyrillic, etc. break cmd parsing under non-UTF console code pages — even inside `REM` comments.
- **Write via PowerShell**, not the Write tool default. After any edit:
  ```powershell
  $c = [IO.File]::ReadAllText($path)
  $c = $c -replace "[^\x00-\x7F]","-" -replace "`r`n","`n" -replace "`n","`r`n"
  [IO.File]::WriteAllText($path, $c, (New-Object Text.UTF8Encoding($false)))
  ```

## Hard rules

- **Never push `launch_*.bat`, `accounts.json`, `.env`, `lessons.txt`, or `test_*.py`.** All gitignored. The .bat files embed credentials in plaintext.
- **Never automate Google sign-in past the first manual confirmation.** First-time use of a new account on a fresh Chrome profile triggers reCAPTCHA / "verify it's you" — `auto_login.py` returns rc=1 in that case and `launch_*.bat` pauses for manual sign-in. Do not try to bypass.
- **Do not reintroduce `scripts/run_batch.cjs`** as the multi-chapter driver. Its `spawn(detached: true)` Windows workaround breaks the parent's `await` and races chapters in parallel.
- **Do not remove the `<nul` redirect** from any `node scripts\run_pipeline.cjs` call in a .bat file.
- **`pip install`** must always be `python -m pip install` (pip is often not on PATH).
- **`refine_chapter.py` and `run_pipeline.cjs` preflight** still hard-require `CHATGPT_EMAIL` / `CHATGPT_PASSWORD` in `.env` even though v6's documented credential source is `accounts.json`. The launcher mirrors the primary creds into `.env`. Don't "fix" the env requirement without also patching those two callsites. (Line numbers shift across refactors — search for the env var names.)

## Rotation flow (read this before touching `auto_login.py`, `gemini.py`, or `run_autonomous.cjs`)

Triggered by either:
- Explicit alert: `save_images.cjs::detectBlocker()` writes to `.cca/blocker_alerts.json`, orchestrator's `shouldRotate()` reads it
- **Silent-blocker fallback**: `pending >= SILENT_BLOCKER_PENDING_MIN` AND `stalledMs > SILENT_BLOCKER_STALL_MS` AND cooldown OK

Sequence (`run_autonomous.cjs::triggerRotation`):

1. Kill submit + saver children
2. `python -m tools.accounts rotate gemini` — advances `.cca/active_accounts.json`. Exit 2 = NoMoreAccountsError → orchestrator exits 4.
3. `python auto_login.py --skip-chatgpt --force-resignin` — signs out, signs in to the new account
4. Reset `.cca/tab_map.json` and `.cca/blocker_alerts.json` (old tabs were bound to the old account)
5. **Preserve `.cca/saved_indices.json`** — resume from the same image index
6. Re-spawn submit + save

### Tunable env vars (set at top of `launch_*.bat`)

| Var | Default | Meaning |
|---|---|---|
| `CCA_SILENT_BLOCKER_PENDING_MIN` | 6 | Stuck-tabs threshold |
| `CCA_SILENT_BLOCKER_STALL_MS` | 60_000 | Stall threshold (1 min) |
| `CCA_ROTATION_COOLDOWN_MS` | 60_000 | Min gap between rotations |
| `CCA_MAX_ROTATIONS` | 5 | Bail after N rotations per chapter |
| `CCA_ROTATION_1095_THRESHOLD` | 3 | Alert path: distinct-tab 1095s within window |
| `CCA_ROTATION_WINDOW_MS` | 120_000 | Alert window (2 min) |

Don't set `CCA_SILENT_BLOCKER_STALL_MS` below `CCA_ROTATION_COOLDOWN_MS` — the cooldown will gate it anyway.

## Bug taxonomy — DO NOT REGRESS

Every fix below was burned into the codebase by a real production failure. The commit hash is the canonical reference; `git show <hash>` for the diff. Organized by code area:

### Gemini account-rotation flow

1. **`auto_login.py::_force_signout_gemini`** (`4ea7536`) — opens an anchor tab first, then closes every pre-existing Google/Gemini tab before navigating to `/Logout`. Without this, leftover tabs from `submit_prompts.cjs` show cached UI that fools `login_via_google_human::_pick_best_page` into a false "signed in" return.

2. **`auto_login.py::login_gemini` force_resignin path** (`4ea7536`) — bypasses `find_signed_in_gemini` / `get_gemini_page` (both can return stale `gemini.google.com/app` tabs). Opens a fresh tab and hard-navigates to `accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp`. The `continue=` param is required — without it Google parks the user on `myaccount.google.com` after sign-in and Phase 4 times out even though sign-in succeeded.

3. **`tools/browser/gemini.py::login_via_google_human` Phase 2a** (`4ea7536`) — detects Google's account-chooser page (shown after `/Logout` when the browser has cached Google sessions) and clicks "Use another account" / "Использовать другой аккаунт" before trying to fill the email field. The chooser has no `input[type="email"]` so `fill_field_via_paste` would otherwise time out. Selectors include English + Russian text variants — keep both, don't drop the Russian fallbacks.

4. **`scripts/run_autonomous.cjs` silent-blocker rotation** (`4ea7536`) — `save_images.cjs::detectBlocker()` only fires when a tab is "not still generating", but on 1095 the tab can keep its Stop button. Time-based fallback rotates when `pending >= SILENT_BLOCKER_PENDING_MIN` AND `stalledMs > SILENT_BLOCKER_STALL_MS` AND cooldown OK.

### ChatGPT login flow (separate from Gemini — different OAuth route)

5. **`tools/browser/chatgpt.py::login_via_google` state machine** (`a794e2e`) — the OpenAI auth flow goes `chatgpt.com` → `auth.openai.com/log-in-or-create-account` (intermediate page with its OWN "Continue with Google" button) → `accounts.google.com/...accountchooser`. The original code clicked the chatgpt.com button once and waited for Google forever. Now: explicit URL state machine that clicks Continue-with-Google AGAIN on `auth.openai.com` (one-shot guard), then handles the Google chooser by clicking "Use another account" before filling the email field. Skips the `chatgpt.com` and `auth.openai.com` transients while waiting for the actual Google sign-in form.

### ChatGPT prompt submission (used by both REFINE and PROMPTS)

6. **`tools/browser/chatgpt.py::send_prompt` typing** (`27f0cba`) — uses `page.keyboard.insert_text(text)` for bulk paste, NOT `page.keyboard.type(text, delay=1)`. Char-by-char typing measured at ~25 chars/sec on long prompts (5+ minutes for a 10K-char prompt) because ChatGPT's contenteditable reflows on every keystroke and Playwright auto-waits for the page to settle. `insert_text` writes the whole string at once in well under a second regardless of length. Embedded `\n` is interpreted as newline — desired behavior.

7. **`tools/browser/chatgpt.py::send_prompt` submit** (`c3e207d`) — uses `page.locator(send_button_selector).first.click(timeout=10_000)`, NOT `page.mouse.click(bbox.x, bbox.y)` and NOT `page.keyboard.press("Enter")`. Mouse-bbox click failed on long prompts because the typed text expanded the contenteditable past viewport height; the bbox returned by `_find_one` was at off-screen coordinates. Plain Enter doesn't submit current ChatGPT contenteditable (interpreted as newline). Playwright's `locator.click()` auto-scrolls into view and auto-waits for actionable. Tries multiple send-button selectors (`data-testid="send-button"`, aria-label, id, text) and falls back to Enter as last resort.

### PROMPTS stage (`generate_prompts.py`)

8. **One conversation per batch** (`2e85b3b`) — opens a fresh `cg.new_conversation(page)` for each of the 4 batches and sends the full formula + chapter + batch-specific instruction each time. Previous design sent batch 1 with full context and batches 2-4 as "Continue with prompts 21-40 / 41-60 / 61-80" follow-ups in the same conversation, which always failed at batch 4/4 with "no new assistant message after 300s; assistant count unchanged" — ChatGPT silently throttles long-output conversations after ~3 turns. Per-batch isolation costs ~30s extra per batch (re-sending context) but is reliable.

9. **3-attempt retry on JSON-parse failure** (`2fb8bc5`) — if the response can't be parsed as a JSON array, retries up to 3 times. Attempts 2–3 prepend a stronger preamble: `"IMPORTANT: Output ONLY a raw JSON array. Do NOT write a chapter, do NOT write prose, do NOT include 'Assalomu alaykum', do NOT use any prior conversation memory..."`. ChatGPT sometimes ignores the structured-output instruction and returns refined-chapter prose instead of JSON, especially when memory bleeds across conversations.

### REFINE stage (`refine_chapter.py` + `refine_prompt.txt`)

10. **Imperative TASK directive** in `refine_prompt.txt` (`e4ad903`) — opens with `"TASK: Rewrite the chapter text that appears AFTER the '---' divider below... Do NOT acknowledge these instructions. Do NOT comment on the format. Do NOT say 'Understood' or 'Tushundim'..."`. The original "Here is the formula I'm using for every topic:" framed the prompt as a self-description; ChatGPT replied with "Tushundim. Sizning format quyidagicha..." meta-acknowledgements (~400-800 byte responses) instead of the actual rewritten chapter.

11. **Length validator with no-write-on-failure** (`e4ad903`) — after `cg.send_and_collect`, checks `len(response)` is in `[REFINE_MIN_CHARS, REFINE_MAX_CHARS]` (defaults 5000/9000). On out-of-range, raises `SystemExit` **without writing the file**. Critical: not writing is what makes REFINE re-run cleanly on next launch (otherwise the file-existence skip silently re-uses bad content forever).

12. **3-attempt retry with trim/expand preambles** (`7bbd095`) — if first attempt is out of range, retries up to 3 times with explicit `"PREVIOUS ATTEMPT FAILED — your last response was X chars, but the HARD MAXIMUM is 9000. Output a TRIMMED version of ~7500 characters..."` (or symmetric expand for too-short). Each attempt opens a fresh `cg.new_conversation`. ChatGPT routinely overshoots 9000 by 1-15% even with the formula's "max 9000" rule; explicit "your last try was X chars, target N" works when the rule alone doesn't.

### UPLOAD stage (`upload_images.py`)

13. **Stale-zip detection** (`4ea7536`) — compares the refined MD bytes inside an existing zip against `refined_md` on disk **before** the marker idempotency check. On mismatch, deletes zip + marker so the rebuild + re-upload happens. Without this, regenerating REFINE doesn't update what gets uploaded — the old zip is reused and Notion gets the previous version.

### IMAGES stage spawn (`scripts/run_pipeline.cjs`)

14. **`cmd /c` wrapper for `run_autonomous.cjs`** (`97ae752`, supersedes the earlier `detached:true` attempt at `47a8491`) — the IMAGES stage spawn chain is `run_pipeline.cjs (Node) → run_autonomous.cjs (Node) → submit_prompts.cjs / save_images.cjs (Node)`. Direct Node-to-Node-to-Node chain inherits Windows job-object handles and crashes `run_pipeline.cjs` with `STATUS_BREAKPOINT` (`-2147483645`) the moment grandchildren spawn. The earlier `detached:true + windowsHide:true + stdio:'inherit'` workaround worked when `launch_all.bat` was started via `Start-Process -RedirectStandardOutput`, but failed silently with exit code 1 when `launch_all.bat` was double-clicked (the new-console-then-hidden dance broke stdio inheritance). Current fix: spawn `cmd.exe /c node scripts\run_autonomous.cjs <prompts>` so a `cmd` process sits between `run_pipeline` and `run_autonomous` in the tree, breaking the Node-to-Node depth-spawn assertion. `stdio:'inherit'` works normally because there's no detached/hidden-console dance.

### Dashboard (`scripts/dashboard.cjs`)

15. **Real-time stage updates** (`e645b4f`) — `findLatestLog()` filters `dashboard.*` out of the candidate set (was picking its OWN polling output, mtime ticks every 2s). `parseLog` recognizes the `launch_all.bat` `# CHAPTER N/M : G... / ... / ch N` banner alongside the v5 `═══ LESSON N/M ═══` banner; resets `state.stages` and `state.stageDurations` on each new chapter so prior-chapter status doesn't bleed through. Also parses the `[DEBUG] CCA_LANG=... CCA_SUBJECT=... CCA_GRADE=...` line so the chapter banner inherits lang/subject/grade context (the CHAPTER banner alone doesn't carry lang).

16. **Accounts rotation panel** (`fd51cba`) — reads `accounts.json` + `.cca/active_accounts.json` and renders per-provider: `<used>/<total> used · <remaining> remaining`, currently-active account in a green-tinted highlight, full list with `▶ active` / `✓ past` (strikethrough) / `· future` markers. Updates live as rotations advance the rotator pointer.

## Common extension requests

### Add another Gemini account

Edit the `accounts.json` heredoc block in each `launch_*.bat`. N accounts → N-1 rotations possible per chapter.

```json
{
  "gemini": [
    { "label": "primary",  "email": "...", "password": "..." },
    { "label": "backup-1", "email": "...", "password": "..." },
    { "label": "backup-2", "email": "...", "password": "..." }
  ]
}
```

If N > 5, also raise `CCA_MAX_ROTATIONS` in the launcher.

### Add another chapter

Add a block at the bottom of `launch_*.bat`:

```bat
echo ###############################################################
echo #  CHAPTER N : G{grade} / {subject} / ch {N}
echo ###############################################################
set CCA_CHAPTER={N}
node scripts\run_pipeline.cjs <nul
set RC_X=%errorlevel%
echo === Chapter {N} exit code: %RC_X% ===
```

State persists between chapters within one .bat run — rotator stays on whichever account ch N-1 ended on.

### Run all chapters in one go (autonomous)

Make a single `launch_all.bat` with all chapter blocks. One reset at the top → primary used maximally, then backup-1, etc., across every chapter. Saved indices on disk make any interrupted run resumable.

## Diagnostic scripts (gitignored, local only)

- `test_chooser_detection.py` — verifies the account-chooser selectors against current Chrome :9223 state. Read-only, doesn't touch other tabs.
- `test_page_state.py` — dumps current tab URLs, the body text, and visible buttons of the most-relevant tab. Use when login times out and you don't know what page Google is showing.

Both connect via CDP, open one throwaway tab, close it on exit. Safe to run during a live pipeline.

## Things upstream still has wrong (don't "fix" without explicit ask)

- `scripts/run_batch.cjs:144` — `detached: process.platform === 'win32'` workaround. Replaced by shell-level loops in `launch_*.bat`. Don't re-enable as the multi-chapter driver.
- `refine_chapter.py`, `generate_prompts.py`, `run_pipeline.cjs` preflight — hard-require `CHATGPT_EMAIL` / `CHATGPT_PASSWORD` in `.env` despite `accounts.json` being v6's documented source. Launcher mirrors the primary creds into both. (Line numbers shift across refactors — search for the env var names.)
