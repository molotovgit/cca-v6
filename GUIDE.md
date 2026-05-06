# Creative Automation — Quick Guide (v5 batch mode)

Turn a **list of Notion textbook chapters** into 80 images each, zipped and uploaded to Notion. **One file (`lessons.txt`), one double-click.**

---

## First-time setup (do once)

1. **Double-click `setup.bat`** (in `D:\Creative_Automation\`)
   - Installs Python dependencies
   - Launches **two Chrome windows** (one for ChatGPT, one for Gemini)
2. **Sign in inside each window:**
   - **Window 1 (ChatGPT)** → log in to chatgpt.com
   - **Window 2 (Gemini)** → log in to gemini.google.com
3. **Leave both Chrome windows open.** Sign-in is one-time — sessions persist.

---

## Run a list of chapters

1. **Open `lessons.txt`** in the repo root. (On first run of `start.bat` it's auto-created from `lessons.txt.example` and opened in Notepad.)
2. **Add one chapter per line.** Format: `grade,lang,subject,chapter`. Example:

   ```
   7,uz,jahon tarixi,11
   12
   13
   8,uz,fizika,1
   2
   ```

   - A line with **just a chapter number** inherits grade/lang/subject from the previous full row.
   - Lines starting with `#` are comments. Blank lines OK.
   - Lessons run in list order.

3. **Save `lessons.txt`** (close Notepad if it's open).
4. **Double-click `start.bat`.**
5. **Walk away.** Total time ≈ 60–90 min **per chapter**. The batch processes them sequentially.

### Re-running after a failure

Just double-click `start.bat` again. Per-chapter idempotency means already-completed lessons skip in seconds; only failed ones actually retry. If the same chapter fails twice for the same reason, it's a real problem (read its log, fix, re-run).

### Account-limit caveats for big batches

- **ChatGPT** ~ 50 messages per session. Each chapter sends ~5 (1 refine + 4 prompt batches). **~10 chapters per ChatGPT-account-limit window.**
- **Gemini** image generation has a daily cap (varies by plan). 80 images/chapter × N chapters can hit it. If image stage starts failing silently mid-batch, that's the limit.
- For very large batches, split into multiple `start.bat` runs across days, or use multiple accounts.

---

## What runs (5 stages)

| # | Stage | What happens | Time |
|---|---|---|---|
| 1 | **FETCH** | Pulls chapter text from Notion | ~10 sec |
| 2 | **REFINE** | ChatGPT rewrites the chapter | 3–6 min |
| 3 | **PROMPTS** | ChatGPT generates 80 image prompts (4 batches × 20) | 10–20 min |
| 4 | **IMAGES** | Gemini generates + saves 80 PNGs (10 parallel tabs) | ~60 min |
| 5 | **UPLOAD** | Zip + upload to chapter's "Images" subpage in Notion (multi-part) | 1–2 min |

**Each stage skips itself if its output already exists** — re-running after a crash picks up exactly where it left off.

---

## Where everything is saved

All paths under `D:\Creative_Automation\`:

| Stage output | Folder |
|---|---|
| Raw chapter (Notion) | `chapters\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.md` |
| Refined chapter (ChatGPT) | `refined\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.md` |
| 80 prompts (the JSON the rest of the pipeline reads) | `prompts\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.json` |
| 80 images | `images\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}\NNN-{slug}.png` |
| Zip uploaded to Notion + idempotency marker | `zips\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.zip` (+ `.uploaded.json`) |

**Concrete example** (G7 Uzbek, jahon tarixi, ch10 Saljuqiylar):

```
chapters\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.md
refined\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.md
prompts\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.json
images\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati\001-...png ... 080-...png
```

---

## Troubleshooting

**Pipeline halts on stage 1 with "ModuleNotFoundError"** — run `setup.bat` once (it installs Python deps).

**Pipeline halts on pre-flight with "Chrome not reachable"** — your Chrome window for that port is closed. Run `setup.bat` again (it skips windows that are already up).

**A stage failed mid-run** — fix whatever the error says, then double-click `start.bat` again. Completed stages skip automatically.

**Image stage halts with "GIVING UP — N/80 on disk after 5 rescues"** — Gemini consistently failed to render the same N missing prompts (silent content filter or hard error). The orchestrator exits with code 3 and `run_pipeline.cjs` halts. Open the prompts JSON, soften the wording on the missing indices listed in the log, then re-run `start.bat`. The image stage will pick up only the missing ones.

**UPLOAD stage fails with "Notion 403 on block attach"** — the integration lacks `Insert content` capability OR isn't connected to the Images page. Fix in Notion: Settings & members → My connections → your integration → Capabilities → enable "Insert content"; then on the chapter page in Notion: ⋯ → Add connections → select your integration. Re-run `start.bat`.

**UPLOAD stage fails with "no 'Images' subpage on chapter page"** — the chapter doesn't have a child page titled "Images" (or "Images 1", etc.). Create one in Notion as a child of the chapter page, then re-run. To skip the upload entirely: set `CCA_SKIP_UPLOAD=1` before running.

**Want to redo the upload** — delete the `.uploaded.json` marker file in `zips/...` and re-run. (The previous Notion file block stays; manage duplicates manually.)

**Want to redo a stage** — delete its output file/folder, then re-run `start.bat`.

**Want to run a different list of chapters** — edit `lessons.txt`, save, double-click `start.bat`.

---

## File reference

| File | Purpose |
|---|---|
| `setup.bat` | Run **once** to install deps and launch Chrome windows |
| `start.bat` | Run **every time** to start the batch |
| `lessons.txt` | **The list of chapters to process** (one per line; edit me) |
| `lessons.txt.example` | Template with format docs |
| `scripts\run_batch.cjs` | Reads `lessons.txt`, loops over each chapter |
| `scripts\run_pipeline.cjs` | Per-chapter 5-stage orchestrator (called by `run_batch`) |
| `.env` | API keys + accounts (don't share) |
| `refine_prompt.txt` | The formula ChatGPT uses to refine chapters |
| `80_prompt_formula.txt` | The formula ChatGPT uses to generate image prompts |
