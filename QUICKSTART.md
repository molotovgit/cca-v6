# Quickstart — new setup method (single double-click)

The fast path. Edit one file, double-click, walk away.

> Prefer the long-form walkthrough? See [SETUP.md](SETUP.md).

---

## 1. Install prerequisites (one-time, per machine)

Open **PowerShell as Administrator** and paste:

```powershell
winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
winget install --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
winget install --id Google.Chrome      --silent --accept-source-agreements --accept-package-agreements
winget install --id Git.Git            --silent --accept-source-agreements --accept-package-agreements
```

**Close and reopen** your terminal afterwards so the new `PATH` takes effect.

> Not on Windows 11? See [SETUP.md § 1 — Manual download](SETUP.md#manual-download-any-os).

---

## 2. Clone the repo

```
git clone https://github.com/molotovgit/Creative_Automation_New_Machine.git
cd Creative_Automation_New_Machine
```

> Already have the folder (e.g., copied via USB)? Skip this step.

---

## 3. Edit `lessons.txt` — set the list of chapters to process

Open `lessons.txt` in any text editor. (On first `start.bat` run it's auto-created from `lessons.txt.example` and opened in Notepad.)

Format — one chapter per line:

```
grade,lang,subject,chapter
```

Bare chapter number = inherit grade/lang/subject from previous full row. Comments start with `#`.

Example (5 chapters of one subject + 2 of another):

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

---

## 4. Double-click `start.bat`

That's it. `start.bat` does everything end-to-end, in this order:

1. **Checks** Node.js + Python are installed (clear error if not — re-do step 1)
2. **First run only:** copies `.env.example` → `.env` and **opens it in Notepad**. Fill in your real credentials, save, and **close Notepad** to continue:

   ```
   NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CHATGPT_EMAIL=your-chatgpt-email@example.com
   CHATGPT_PASSWORD=your-chatgpt-password
   GEMINI_EMAIL=your-gemini-email@example.com
   GEMINI_PASSWORD=your-gemini-password
   CDP_PORT=9222               ← leave as-is
   GEMINI_CDP_PORT=9223        ← leave as-is
   ```

   See [§ Where to get the Notion API key](#where-to-get-the-notion-api-key) below.

3. **Installs** Node deps (`npm install`) and Python deps (`pip install`) — idempotent, fast on re-runs
4. **Launches** both Chrome windows (port 9222 ChatGPT, port 9223 Gemini). Skips windows already up.
5. **Pauses** — sign in inside each Chrome window if first time:
   - Window 1 → chatgpt.com
   - Window 2 → gemini.google.com

   Sign-in is **once per machine** — sessions persist between runs. Press **ENTER** in the terminal when ready (or immediately if already signed in).

6. **Runs the batch** — for each chapter in `lessons.txt`, runs 5 stages (fetch → refine → prompts → images → upload). Walk away. ~60–90 min **per chapter**, sequential.

---

## Running another batch

1. Edit `lessons.txt` with the new list of chapters
2. Double-click `start.bat`

To **retry failed chapters** from a previous run, just double-click `start.bat` again — completed chapters skip in seconds; only failures actually retry.

`.env` and Chrome sign-ins persist — you only do steps 1–2 of the first-time setup once.

---

## Where to get the Notion API key

1. Go to https://www.notion.so/profile/integrations
2. Click "+ New integration"
3. Give it a name, pick the workspace that has your textbooks
4. Copy the "Internal Integration Secret" (starts with `secret_` or `ntn_`)
5. Open your textbook root page in Notion → click "..." (top right) → "+ Add connections" → select your integration

The integration must have access to every page the pipeline will read.

---

## Notion workspace structure (must match)

The pipeline expects this hierarchy in your Notion workspace:

```
<Grade root page>             (search-discoverable: "Grade 7", "7-sinf", etc.)
└── <Subject page>             ("Tarix", "Jahon Tarixi", "Algebra", ...)
    └── <Chapter page>         (titled "1-mavzu: ...", "Chapter 1: ...", etc.)
        └── chapter content
```

If your Notion doesn't follow this, the FETCH stage will fail. Either restructure Notion or edit `tools/notion/navigator.py` to match your structure.

---

## Output locations

```
chapters/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md     ← Notion fetch
refined/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md       ← ChatGPT-refined
prompts/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.json    ← 80 prompts
images/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}/*.png    ← 80 PNGs
zips/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.zip        ← uploaded to chapter's "Images" subpage in Notion
```

---

## Troubleshooting

**"ERROR: Node.js not installed" / "ERROR: Python not installed"**
Step 1 wasn't done, or the terminal hasn't picked up the new `PATH`. Close and reopen the terminal, then re-run.

**"Chrome not reachable on port 9222 / 9223"**
A Chrome window was closed. Just re-run `start.bat` — it relaunches missing windows.

**"Auto-login failed" or stuck on a Google login page**
You need to sign in once manually inside the Chrome window the script launched. Sessions persist after that.

**"No fetched chapter found"**
Your Notion structure doesn't match (see above), or your integration doesn't have access to the textbook pages (re-check the "Add connections" step on your textbook page in Notion).

**Stage failed mid-run**
Re-run `start.bat`. Completed stages skip; the pipeline picks up where it left off (file-existence-driven).

**Want to redo a specific stage**
Delete that stage's output folder/file (e.g., delete `images/g7-uz/...` to redo image generation), then re-run `start.bat`.

---

## What `start.bat` actually does (under the hood)

| Step | Action | Idempotent? |
|---|---|---|
| 1 | `where node` / `where python` — fail-fast prereq check | yes |
| 2 | `if not exist .env: copy .env.example .env && notepad .env` | yes — won't overwrite existing `.env` |
| 3 | `call npm install --silent` | yes — npm skips already-installed packages |
| 4 | `pip install -q -r requirements.txt` | yes — pip skips already-installed packages |
| 5 | `node scripts/setup_chrome.cjs` — launches Chrome windows | yes — skips windows already up |
| 6 | `pause` — wait for user to confirm Chrome sign-in | n/a |
| 7 | `node scripts/run_batch.cjs` — reads `lessons.txt`, runs the 5-stage pipeline once per chapter | yes — chapters and stages both skip if output already exists |

`scripts/run_batch.cjs` reads `lessons.txt` and spawns `scripts/run_pipeline.cjs` once per lesson, setting `CCA_GRADE` / `CCA_LANG` / `CCA_SUBJECT` / `CCA_CHAPTER` env vars per chapter. `run_pipeline.cjs` then runs the 5 stages for that chapter. Per-chapter idempotency: if a chapter's outputs are already on disk, every stage skips.
