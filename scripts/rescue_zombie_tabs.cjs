// Zombie-tab rescue helper.
//
// Reads .cca/tab_map.json + .cca/saved_indices.json, finds tabs whose idx is
// NOT in the saved set (i.e. Gemini never produced an image for that prompt),
// closes those tabs in Chrome, and removes them from tab_map.json.
//
// Also rebuilds saved_indices.json from actual on-disk PNGs so the state file
// reflects ground truth before the orchestrator decides whether to re-submit.
//
// Exits with the number of zombies cleared (so the caller can tell whether
// any rescue work happened). Stdout is JSON for parseability:
//   {"cleared": 4, "missing": [37,44,50,75], "saved_on_disk": 76, "total": 80}
//
// Usage:
//   node scripts/rescue_zombie_tabs.cjs <prompts.json>

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);

const REPO         = path.resolve(__dirname, '..');
const STATE_DIR    = path.join(REPO, '.cca');
const TAB_MAP_FILE = path.join(STATE_DIR, 'tab_map.json');
const SAVED_FILE   = path.join(STATE_DIR, 'saved_indices.json');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} if (e.code !== 'ENOENT') throw e; }
}

function chapterImagesDir(promptsPath) {
  const abs = path.resolve(promptsPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`prompts path missing 'prompts' segment: ${abs}`);
  const out = parts.slice();
  out[idx] = 'images';
  out[out.length - 1] = out[out.length - 1].replace(/\.json$/i, '');
  return out.join(path.sep);
}

function diskSavedIndices(imagesDir) {
  if (!fs.existsSync(imagesDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(imagesDir)) {
    if (!f.toLowerCase().endsWith('.png')) continue;
    if (fs.statSync(path.join(imagesDir, f)).size < 10 * 1024) continue;
    const m = f.match(/^(\d+)-/);
    if (m) out.push(parseInt(m[1], 10));
  }
  return out.sort((a, b) => a - b);
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    process.stderr.write('Usage: node rescue_zombie_tabs.cjs <prompts.json>\n');
    process.exit(1);
  }
  if (!fs.existsSync(promptsPath)) {
    process.stderr.write(`prompts file not found: ${promptsPath}\n`);
    process.exit(1);
  }

  const prompts  = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const total    = prompts.length;
  const imagesDir = chapterImagesDir(promptsPath);

  // Ground truth from disk
  const onDisk = diskSavedIndices(imagesDir);
  const savedSet = new Set(onDisk);
  writeJson(SAVED_FILE, [...savedSet].sort((a, b) => a - b));

  const tabMap = readJsonOr(TAB_MAP_FILE, {});
  const zombieTids = Object.entries(tabMap)
    .filter(([_tid, m]) => !savedSet.has(m.idx))
    .map(([tid]) => tid);

  let closed = 0;
  let connectErr = null;

  if (zombieTids.length > 0) {
    let browser = null;
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${CDP_PORT}`,
        defaultViewport: null,
      });
      const wantedSet = new Set(zombieTids);
      for (const ctx of browser.browserContexts()) {
        for (const page of await ctx.pages()) {
          let tid;
          try { tid = page.target()._targetId; } catch (_) { continue; }
          if (!wantedSet.has(tid)) continue;
          try {
            await page.close({ runBeforeUnload: false });
            closed++;
          } catch (_) { /* tab may already be gone */ }
        }
      }
    } catch (e) {
      connectErr = e.message;
    } finally {
      if (browser) { try { await browser.disconnect(); } catch (_) {} }
    }
  }

  // ALWAYS clear zombies from tab_map regardless of whether the Chrome close
  // succeeded — submit_prompts uses tab_map to count "pending", so leaving the
  // entry would re-block the rescue. Worst case: a stale tab stays open in
  // Chrome but is no longer tracked.
  const cleanMap = {};
  for (const [tid, m] of Object.entries(tabMap)) {
    if (savedSet.has(m.idx)) cleanMap[tid] = m;
  }
  writeJson(TAB_MAP_FILE, cleanMap);

  const missing = [];
  for (const e of prompts) if (!savedSet.has(e.idx)) missing.push(e.idx);
  missing.sort((a, b) => a - b);

  process.stdout.write(JSON.stringify({
    cleared:       zombieTids.length,
    closed_in_chrome: closed,
    missing,
    saved_on_disk: onDisk.length,
    total,
    connect_error: connectErr,
  }) + '\n');
  process.exit(0);
})().catch(e => {
  process.stderr.write(`rescue fatal: ${e.stack || e.message}\n`);
  process.exit(2);
});
