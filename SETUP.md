# Setup — running this project on a new machine

Step-by-step. Do every step in order. Total setup time: ~10–15 min.

---

## 1. Prerequisites

Install these on the new machine **before cloning**.

### Windows 11 — one-shot install via `winget`

Open **PowerShell as Administrator** and paste:

```powershell
winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
winget install --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
winget install --id Google.Chrome      --silent --accept-source-agreements --accept-package-agreements
winget install --id Git.Git            --silent --accept-source-agreements --accept-package-agreements
```

This installs Node.js LTS, Python 3.12, Chrome, and Git. (`winget` ships with Windows 11.) **Close and reopen the terminal** after installation so the new `PATH` takes effect.

### Manual download (any OS)

| Tool | Where to get it |
|---|---|
| **Node.js 20+** | https://nodejs.org/ |
| **Python 3.10+** | https://www.python.org/downloads/ — **check "Add Python to PATH"** during install |
| **Google Chrome** | https://www.google.com/chrome/ |
| **Git** | https://git-scm.com/ |

### Verify

In a fresh terminal:

```
node --version
python --version
git --version
```

All three should print versions. If `python` doesn't work, try `python3`.

---

## 2. Clone the repo

```
git clone https://github.com/molotovgit/Creative_Automation.git
cd Creative_Automation
```

Or download the zip from GitHub and extract it.

---

## 3. Run `setup.bat` (does everything)

**Double-click `setup.bat`** (or run `setup.bat` from a terminal in the repo folder).

It will:
1. Create `.env` from `.env.example` if it doesn't exist (so you only need to edit the values)
2. Run `npm install` — installs `puppeteer` and other deps from `package.json`
3. Run `pip install -r requirements.txt` — installs Python deps (`notion-client`, `python-dotenv`, etc.)
4. Launch **two Chrome windows**:
   - Window 1 (port 9222) → opens chatgpt.com
   - Window 2 (port 9223) → opens gemini.google.com

If Chrome is in a non-standard location, the script may not find it. Edit the `CHROME_PATHS` array in `scripts/setup_chrome.cjs` to point at your `chrome.exe`.

---

## 4. Edit `.env` with your credentials

`setup.bat` already created `.env` for you (copied from `.env.example`). Open it in any text editor and fill in your real values:

```
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CHATGPT_EMAIL=your-chatgpt-email@example.com
CHATGPT_PASSWORD=your-chatgpt-password
GEMINI_EMAIL=your-gemini-email@example.com
GEMINI_PASSWORD=your-gemini-password
CDP_PORT=9222
GEMINI_CDP_PORT=9223
```

Leave `CDP_PORT` and `GEMINI_CDP_PORT` as-is — they must match what the scripts expect.

**Where to get the `NOTION_API_KEY`:**
1. Go to https://www.notion.so/profile/integrations
2. Click "+ New integration"
3. Give it a name, pick the workspace that has your textbooks
4. Copy the "Internal Integration Secret" (starts with `secret_` or `ntn_`)
5. Open your textbook root page in Notion → click "..." (top right) → "+ Add connections" → select your integration

The integration must have access to every page the pipeline will read.

---

## 5. Notion workspace structure

The `fetch_chapter.py` script expects this exact hierarchy in your Notion workspace:

```
<Grade root page>             (search-discoverable: "Grade 7", "7-sinf", etc.)
└── <Subject page>             ("Tarix", "Jahon Tarixi", "Algebra", ...)
    └── <Chapter page>         (titled "1-mavzu: ...", "Chapter 1: ...", etc.)
        └── chapter content
```

If your Notion doesn't follow this layout, the fetch will fail. You'll either need to:
- Restructure your Notion to match, OR
- Edit `tools/notion/navigator.py` to match your structure

---

## 6. Sign in manually inside each Chrome window

**Window 1 (ChatGPT):**
- Log in to chatgpt.com with your account

**Window 2 (Gemini):**
- Log in to gemini.google.com
- **Leave the tab open**

Sign-in is **one-time** — sessions persist in dedicated profile directories (`~/chrome-chatgpt-cdp/` and `~/chrome-gemini-cdp/`). Future runs of `setup.bat` reuse them.

---

## 7. Configure the list of chapters to process

Open `lessons.txt` in any text editor. (On first `start.bat` run it's auto-created from `lessons.txt.example` and opened in Notepad.)

Format — one chapter per line:

```
grade,lang,subject,chapter
```

A bare chapter number on its own line inherits `grade,lang,subject` from the previous full row. Comments start with `#`.

Example:

```
7,uz,jahon tarixi,11
12
13
8,uz,fizika,1
2
```

Save the file when you're done.

---

## 8. Run the pipeline

**Double-click `start.bat`** (or `node scripts/run_pipeline.cjs`).

The batch runner will:
1. Parse `lessons.txt` and print the list of chapters it'll process
2. For each chapter in order: verify Chrome + `.env`, run 5 stages (fetch → refine → prompts → images → upload)
3. Continue past per-chapter failures (logged); abort the whole batch on pre-flight failure (`.env` missing, Chrome down)
4. Print a per-lesson pass/fail summary at the end

**Walk away.** Total time: ~60–90 min **per chapter**, sequential. For 5 chapters expect ~5–7 hours.

**Notion permissions for the UPLOAD stage:** the integration must have `Insert content` capability (Notion → Settings & members → My connections → your integration → Capabilities), and must be connected to each chapter page (... → Add connections). FETCH/REFINE only need read access; UPLOAD adds the write requirement.

If anything fails partway, fix the issue and **re-run `start.bat`** — completed stages skip automatically (file-existence-driven).

---

## Output locations

All outputs land under the repo root:

```
chapters/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md     ← Notion fetch
refined/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md       ← ChatGPT-refined
prompts/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.json    ← 80 prompts
images/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}/*.png    ← 80 PNGs
zips/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.zip        ← uploaded to Notion
zips/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.uploaded.json   ← upload marker (sha256 + block_id)
```

---

## Troubleshooting

**"Chrome not reachable on port 9222 / 9223"**
The Chrome window is closed. Re-run `setup.bat` (skips windows that are already up).

**"ModuleNotFoundError: No module named 'notion_client'"**
Python deps not installed. Run `setup.bat` (it installs them) or manually: `pip install -r requirements.txt`.

**"Cannot connect to keep-alive on :9222" (during REFINE)**
ChatGPT Chrome window is closed, or the keepalive Python script isn't running. The simplest fix is re-running `setup.bat`.

**"Auto-login failed"**
You need to log in once manually inside the Chrome window opened by `setup.bat`. Sessions persist after that.

**"No fetched chapter found"**
The Notion structure doesn't match (see step 5), or the integration doesn't have access to the textbook pages (see step 4: edit `.env` and verify connections in Notion).

**Stage failed mid-run**
Re-run `start.bat`. Completed stages skip; the pipeline picks up where it left off.

**Want to redo a specific stage**
Delete that stage's output folder/file (e.g., delete `images/...` to redo image generation), then re-run `start.bat`.

---

## File reference

| File | Purpose |
|---|---|
| `setup.bat` | One-time setup — bootstraps `.env`, installs Node + Python deps, launches Chrome windows |
| `start.bat` | Run-anytime — executes the full pipeline |
| `lessons.txt` | **The list of chapters to process.** Edit me. |
| `lessons.txt.example` | Template (committed; copied to `lessons.txt` by `start.bat` on first run) |
| `scripts/run_batch.cjs` | Reads `lessons.txt` and runs `run_pipeline.cjs` once per chapter |
| `scripts/run_pipeline.cjs` | Per-chapter 5-stage orchestrator (called by `run_batch.cjs`) |
| `scripts/setup_chrome.cjs` | Launches the two debug-port Chrome windows |
| `scripts/run_autonomous.cjs` | IMAGES stage wrapper (autonomous orchestrator) |
| `.env.example` | Template — committed; copied to `.env` by `setup.bat` |
| `.env` | Your real API keys & passwords (gitignored — auto-created from `.env.example`) |
| `requirements.txt` | Python deps |
| `package.json` | Node deps |
| `refine_prompt.txt` | The formula ChatGPT uses to refine chapters |
| `80_prompt_formula.txt` | The formula ChatGPT uses to generate image prompts |
| `GUIDE.md` | Quick-reference guide for day-to-day use |
