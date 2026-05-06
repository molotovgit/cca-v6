# Creative Content Automation v6 (CCA v6)

Notion → ChatGPT → Gemini → Notion images pipeline. **v6 adds multi-account auto-login + auto-rotation** when Gemini hits 1095 (content-policy filter) or "Image Generation Limit Reached" (daily quota).

```
FETCH ─→ REFINE ─→ PROMPTS ─→ IMAGES ─→ UPLOAD
Notion    ChatGPT    ChatGPT    Gemini     Notion (zip + refined MD)
                                  ↓
                           on 1095 or quota
                                  ↓
                  rotate accounts.json → sign-out → sign-in next account → resume
```

## Quick start

1. Extract the zip / clone this repo
2. `setup.bat` (one-time — installs deps + launches the two Chrome windows)
3. Sign in to ChatGPT (Window 1, port 9222) and Gemini (Window 2, port 9223) — or fill `accounts.json` and v6 will auto-login
4. Edit `lessons.txt` with chapters to generate
5. `start.bat`

See **[RUN.md](RUN.md)** for the full runbook.

## What's new vs v5

- **`accounts.json`** — multi-account credentials file (gitignored). Schema in `accounts.json.example`.
- **`auto_login.py`** — Python wrapper that signs into ChatGPT + Gemini using accounts.json (falls back to .env for backward compat). `start.bat` invokes it before the manual-sign-in pause.
- **`tools/accounts.py`** — rotator with persistent state in `.cca/active_accounts.json`. CLI: `python -m tools.accounts {get|rotate|reset|status} <provider>`.
- **`scripts/save_images.cjs`** — adds `detectBlocker()` that catches Gemini 1095/quota error UI and logs to `.cca/blocker_alerts.json`.
- **`scripts/run_autonomous.cjs`** — reads alerts each tick; on threshold (3+ unique-tab 1095 in 2 min, or any quota) triggers full rotation cycle: kill children → rotate accounts.json pointer → `auto_login.py --force-resignin --skip-chatgpt` → respawn.

## v5 → v6 migration

If you have a working v5 install, you can keep it. v6's auto-login falls back to v5's `.env`-based credentials when `accounts.json` is absent. To get rotation, create `accounts.json` from the example and add 2+ Gemini accounts.

## Requirements

Same as v5: Windows, Node ≥ 14, Python ≥ 3.10, Chrome installed, Notion integration with Insert content.

## License

MIT.
