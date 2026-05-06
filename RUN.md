# How to run — step-by-step

This is the click-by-click runbook. For broader docs see `GUIDE.md` / `SETUP.md` / `QUICKSTART.md`.

---

## Before you start — checklist

You need:

- [ ] Windows machine with Node.js, Python, Chrome, Git installed
- [ ] A **Notion integration secret** (`ntn_...` or `secret_...`) with **Insert content** capability, connected to every chapter page you'll process
- [ ] A **ChatGPT account** (free or paid)
- [ ] A **Gemini account** (preferably a fresh one — see "Known issues" below)
- [ ] Each chapter you want to process must have a child page titled **"Images"** (or "Images 1" / "Images (1)") in Notion. The pipeline uploads the zip to this subpage.

---

## Part 1 — First-time setup (do once per machine)

### Step 1.1 — Launch the two Chrome windows

Double-click **`setup.bat`** (in the v5 folder).

Two Chrome windows open:
- **Window 1** → port 9222, profile `~/chrome-chatgpt-cdp/`
- **Window 2** → port 9223, profile `~/chrome-gemini-cdp/`

### Step 1.2 — Sign in (one-time)

| Window | URL | Account |
|---|---|---|
| Window 1 (port 9222) | `chatgpt.com` | Your ChatGPT account |
| Window 2 (port 9223) | `gemini.google.com` | Your Gemini account (read "Known issues" first) |

Sessions persist in the profile dirs. You only sign in once per profile.

**Leave both Chrome windows open.** Don't close them between runs.

---

## Part 2 — Every run

### Step 2.1 — Edit `lessons.txt`

Open `D:\tmp\cca_v5\lessons.txt` in any text editor (or wait for `start.bat` to open it for you on first run).

Format — one chapter per line:

```
grade,lang,subject,chapter
```

A bare chapter number on its own line inherits grade/lang/subject from the previous full row. Lines starting with `#` are comments.

Example — process 5 chapters of Jahon Tarixi grade 7 + 2 of Fizika grade 8:

```
7,uz,jahon tarixi,11
12
13
14
15
8,uz,fizika,1
2
```

Save the file.

### Step 2.2 — (Optional) Verify your list parses correctly

Before burning credentials, dry-run to confirm `lessons.txt` parses as expected:

```
cd D:\tmp\cca_v5
set CCA_DRY_RUN=1
node scripts\run_batch.cjs
```

You'll see the parsed list. If it looks right, clear the var:

```
set CCA_DRY_RUN=
```

### Step 2.3 — Configure credentials (first run only)

**v6 uses `accounts.json` for ChatGPT + Gemini credentials** (was `.env` in v5). The `.env` file still holds the Notion API key + Chrome ports.

Copy `accounts.json.example` to `accounts.json` and fill in real values:

```json
{
  "chatgpt": [
    { "label": "primary", "email": "your-chatgpt@example.com", "password": "your-password" }
  ],
  "gemini": [
    { "label": "primary",  "email": "your-gemini-1@example.com", "password": "your-password-1" },
    { "label": "backup-1", "email": "your-gemini-2@example.com", "password": "your-password-2" }
  ]
}
```

**Why a list?** v6 auto-rotates Gemini accounts when it detects 1095 (content-policy filter) or "Image Generation Limit Reached" (daily quota). Add as many backup Gemini accounts as you want; rotation advances through them in order.

`.env` should still contain:
```
NOTION_API_KEY=ntn_...
CDP_PORT=9222
GEMINI_CDP_PORT=9223
```

(If `accounts.json` is absent, v6 falls back to reading `CHATGPT_EMAIL/PASSWORD` and `GEMINI_EMAIL/PASSWORD` from `.env` for backward compatibility.)

Save and close Notepad. The terminal continues.

### Step 2.4 — Run

If you skipped 2.3 because `.env` already exists, just **double-click `start.bat`** now.

The terminal will:
1. Verify Node + Python installed
2. Open `lessons.txt` in Notepad if missing (first run only)
3. `npm install` + `pip install` (1–2 min first run, instant after)
4. Launch Chrome windows if not already up (skips if both ports respond)
5. Pause: **"Press ENTER to start the pipeline"** → press ENTER
6. Run the batch over every chapter in `lessons.txt`

**Walk away.** ~60–90 min per chapter, sequential.

---

## What happens during the run

For each chapter in `lessons.txt`:

| Stage | Time | What |
|---|---|---|
| 1. FETCH | ~10 sec | Pulls chapter text from Notion |
| 2. REFINE | 3–6 min | ChatGPT rewrites the chapter |
| 3. PROMPTS | 10–20 min | ChatGPT generates 80 image prompts (4 batches × 20) |
| 4. IMAGES | ~60 min | Gemini generates 80 PNGs (10 parallel tabs) |
| 5. UPLOAD | 1–2 min | Zip + multi-part upload to chapter's "Images" subpage in Notion |

After all chapters complete, the terminal prints a per-lesson pass/fail summary.

---

## Output locations

For each successful chapter, files land in:

```
D:\tmp\cca_v5\
├── chapters\g{N}-{lang}\{subj-slug}\ch{NN}-{title}.md          ← Notion fetch
├── refined\g{N}-{lang}\{subj-slug}\ch{NN}-{title}.md           ← ChatGPT-refined
├── prompts\g{N}-{lang}\{subj-slug}\ch{NN}-{title}.json         ← 80 prompts
├── images\g{N}-{lang}\{subj-slug}\ch{NN}-{title}\NNN-slug.png  ← 80 images
└── zips\g{N}-{lang}\{subj-slug}\ch{NN}-{title}.zip             ← uploaded to Notion
                                          .uploaded.json        ← idempotency marker
```

The zip is also attached as a file block to the chapter's Notion **Images** subpage.

---

## Re-running / resuming

**Just double-click `start.bat` again.** Per-chapter idempotency means:

- Already-completed chapters skip in seconds (file-existence checks)
- Failed chapters retry from where they stopped
- Each individual stage skips if its output is already on disk

If you want to **redo a specific stage** for a chapter, delete that stage's output (e.g., `images/g7-uz/jahon-tarixi/ch11-...` to redo IMAGES). Re-run.

To **redo the upload** for a chapter, delete its `.uploaded.json` marker and re-run. The previous Notion file block stays — manage duplicates manually.

---

## Known issues

### Gemini error 1095 / quota — **auto-rotation as of v6**

When Gemini hits the content safety filter (1095) or the daily image-generation quota, **v6 auto-detects and rotates to the next account** in `accounts.json`. The saver writes alerts to `.cca/blocker_alerts.json`; the orchestrator picks them up on its next tick and triggers rotation:

```
[ORCH] blocker alerts detected (1095) — rotating account
[ORCH] === ROTATION TRIGGERED ===  reason=1095  attempt #1/5
[ORCH] rotated to gemini account: [backup-1 #1] alt-account@example.com
[gemini] force sign-out (rotation): navigating to accounts.google.com/Logout
[ORCH] new account signed in successfully
[ORCH] rotation complete — resumed at 47/80
```

**Thresholds** (env-overridable):
- 1095 detected on 3+ distinct tabs within 2 min → rotate
- Any quota detection → rotate immediately
- Cooldown: 60s between rotations
- Hard cap: 5 rotation attempts per chapter (then exit code 4)

**If rotation fails** (no more accounts in `accounts.json`):
- Exit code 4 with clear message — add another Gemini entry to `accounts.json` and re-run.

**Manual workarounds still available:**
- Soften the prompts in `prompts/.../ch{NN}-X.json` for failing indices (avoid named religious figures, weapons in active use, named conquests — see `feedback_gemini_1095_triggers.md` memory)
- Wait ~24h for daily quota reset.

### Pre-flight failure (Chrome down or `.env` missing)

The batch aborts immediately on the first lesson — wouldn't help to keep trying with the same broken state. Fix the issue (relaunch Chrome via `setup.bat`, or fix `.env`) and re-run.

### Account rate limits on big batches

- **ChatGPT** ~50 messages per session window. Each chapter sends ~5. **~10 chapters per ChatGPT-account-limit cycle.**
- **Gemini** image generation has a daily cap (varies by plan). 80 images/chapter × N chapters can hit it.

For batches > ~10 chapters, plan to split across days or accounts.

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Chrome not reachable on port 9222 / 9223` | A Chrome window was closed | Re-run `setup.bat` (relaunches missing windows) |
| `.env missing` | First run, hasn't been bootstrapped | `start.bat` will create it from `.env.example` and open Notepad |
| `lessons.txt not found` | First run, hasn't been bootstrapped | `start.bat` will create it from the example and open Notepad |
| `Notion 401 — API token is invalid` | `NOTION_API_KEY` in `.env` is the placeholder, or the integration is wrong | Open `.env`, paste a real `ntn_...` or `secret_...` key |
| `Notion 403 on block attach` (UPLOAD stage) | Integration lacks **Insert content** capability or isn't connected to the chapter page | Notion → Settings & members → My connections → your integration → enable "Insert content"; on the chapter page → Add connections → select your integration |
| `no 'Images' subpage on chapter page` | The chapter doesn't have a child page titled "Images" | Create the subpage in Notion (titled exactly "Images") and re-run |
| IMAGES stage stuck at `pending=10, stall growing` for many minutes | Gemini 1095 deadlock | See "Known issues" above |

---

## tl;dr per-batch flow

```
1. Open lessons.txt → write your chapter list → save
2. Make sure both Chrome windows are open + signed in
3. Double-click start.bat
4. Press ENTER when prompted
5. Walk away
6. Re-run start.bat to retry any failures
```
