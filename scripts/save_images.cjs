// CONTINUOUS image saver — scans all Gemini tabs in the browser, saves any
// rendered image to disk, marks the tab as saved, and closes the tab.
// Reads .cca/tab_map.json (written by submit_prompts.cjs) for tab → entry mapping.
//
// Usage:
//   node scripts/save_images.cjs <prompts.json>          # exits when all expected saved
//   node scripts/save_images.cjs <prompts.json> --watch  # poll forever
//   node scripts/save_images.cjs <prompts.json> --no-close

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POLL_MS = 3000;

const REPO     = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO, '.cca');
const TAB_MAP_FILE       = path.join(STATE_DIR, 'tab_map.json');
const SAVED_FILE         = path.join(STATE_DIR, 'saved_indices.json');
const BLOCKER_ALERTS_FILE = path.join(STATE_DIR, 'blocker_alerts.json');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid-suffix the .tmp so concurrent writers don't share the same file
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Best-effort cleanup if rename fails; don't crash the process
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (e.code !== 'ENOENT') throw e;
  }
}

function deriveOutputDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'images';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function findNewImageOnTab(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      // width gate only — Gemini varies aspect ratio per prompt; "wide" prompts
      // can produce 456×193 images that the prior height>=200 check rejected.
      // Avatars are filtered by URL pattern below, not by size.
      if (r.width < 200) continue;
      if (r.width * r.height < 30_000) continue;  // area floor catches small UI bits
      const src = img.src || '';
      if (!src) continue;
      if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;
      if (/avatar|profile|logo|emoji/i.test(src)) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) {
        best = { src, w: Math.round(r.width), h: Math.round(r.height), area };
      }
    }
    return best;
  }).catch(() => null);
}

// Detect Gemini failure modes that look like "tab is pending forever" but are
// actually unrecoverable for this account: 1095 content-policy + daily quota.
// Returns 'quota' | '1095' | null.
async function detectBlocker(page) {
  try {
    let title = '';
    try { title = await page.title() || ''; } catch (_) {}
    if (/Image Generation Limit/i.test(title)) return 'quota';
    if (/(I can.{1,5}help with that|can't help)/i.test(title)) return '1095';
    // Body-text fallback for explicit error codes / policy strings
    const body = await page.evaluate(() =>
      ((document.body && document.body.innerText) || '').slice(0, 2500)
    ).catch(() => '');
    if (/error 1095|gemini\.google\.com\/.*1095/i.test(body)) return '1095';
    if (/Image Generation Limit Reached/i.test(body)) return 'quota';
    if (/I can.{1,5}help with that|safety policy|content policy/i.test(body)) return '1095';
    return null;
  } catch (_) { return null; }
}

function recordBlocker(idx, slug, type) {
  let alerts = readJsonOr(BLOCKER_ALERTS_FILE, []);
  if (!Array.isArray(alerts)) alerts = [];
  alerts.push({ t: Date.now(), idx, slug, type });
  // Keep last 200 only
  if (alerts.length > 200) alerts.splice(0, alerts.length - 200);
  writeJson(BLOCKER_ALERTS_FILE, alerts);
}

async function isStillGenerating(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button, [role=button]'))
      .some(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                 /^Stop$/i.test((b.innerText || '').trim()))
  ).catch(() => false);
}

async function exportToBuffer(page, src) {
  if (src.startsWith('data:image')) {
    return Buffer.from(src.split(',', 2)[1], 'base64');
  }
  if (src.startsWith('blob:')) {
    const dataUrl = await page.evaluate((s) => {
      const img = Array.from(document.querySelectorAll('img')).find(i => i.src === s);
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth  || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }, src);
    if (!dataUrl) throw new Error('canvas export failed');
    return Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  }
  const arr = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, src);
  return Buffer.from(arr);
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node save_images.cjs <prompts.json> [--watch] [--no-close]');
    process.exit(1);
  }
  const watchMode = process.argv.includes('--watch');
  const closeTabs = !process.argv.includes('--no-close');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const outDir = deriveOutputDir(promptsPath);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[save] watching ${path.basename(promptsPath)}  (${prompts.length} expected)`);
  console.log(`[save] output: ${outDir}`);
  console.log(`[save] close-tabs after save: ${closeTabs}, watch: ${watchMode}`);

  const savedIdxs = new Set(readJsonOr(SAVED_FILE, []));
  for (const entry of prompts) {
    const expected = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
    if (fs.existsSync(expected) && fs.statSync(expected).size > 5 * 1024) {
      savedIdxs.add(entry.idx);
    }
  }
  writeJson(SAVED_FILE, [...savedIdxs]);
  console.log(`[save] starting with ${savedIdxs.size} already-saved entries`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`,
    defaultViewport: null,
  });

  let iter = 0;
  while (true) {
    iter++;
    const tabMap = readJsonOr(TAB_MAP_FILE, {});

    const wantedTids = new Set(
      Object.entries(tabMap)
        .filter(([_tid, m]) => !savedIdxs.has(m.idx))
        .map(([tid]) => tid)
    );

    let scanned = 0, savedThisIter = 0;
    for (const ctx of browser.browserContexts()) {
      for (const page of await ctx.pages()) {
        let tid;
        try { tid = page.target()._targetId; } catch (_) { continue; }
        if (!wantedTids.has(tid)) continue;
        const entry = tabMap[tid];
        if (!entry) continue;

        scanned++;

        // Wake the background tab WITHOUT stealing focus. screenshot() forces
        // a render; we discard the bytes. Hard 4s timeout so a hung tab can't
        // freeze the entire saver loop.
        try {
          await Promise.race([
            page.screenshot({ type: 'jpeg', quality: 1, fullPage: false }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 4000)),
          ]);
        } catch (_) {}
        // Override visibility state — some apps pause rendering when hidden
        try {
          await Promise.race([
            page.evaluate(() => {
              try {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                document.dispatchEvent(new Event('visibilitychange'));
              } catch (_) {}
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('eval timeout')), 3000)),
          ]);
        } catch (_) {}
        await sleep(200);

        if (await isStillGenerating(page)) continue;

        const found = await findNewImageOnTab(page);
        if (!found) {
          // Tab is no longer generating AND has no image — check for known blockers
          // (1095 content-policy / daily-quota). If detected, record an alert so the
          // orchestrator can decide to rotate accounts; close the tab so the queue
          // keeps moving regardless.
          const blocker = await detectBlocker(page);
          if (blocker) {
            console.log(`[save] ${String(entry.idx).padStart(3, '0')} BLOCKER ${blocker.toUpperCase()} on ${entry.slug}  → recording alert + closing tab`);
            recordBlocker(entry.idx, entry.slug, blocker);
            if (closeTabs) {
              try { await page.close(); } catch (_) {}
              const m2 = readJsonOr(TAB_MAP_FILE, {});
              delete m2[tid];
              writeJson(TAB_MAP_FILE, m2);
            }
          }
          continue;
        }

        try {
          const buf = await exportToBuffer(page, found.src);
          const outFile = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
          fs.writeFileSync(outFile, buf);
          savedIdxs.add(entry.idx);
          writeJson(SAVED_FILE, [...savedIdxs]);
          savedThisIter++;
          console.log(`[save] ${String(entry.idx).padStart(3, '0')} ${entry.slug}  → ${found.w}x${found.h} ${(buf.length / 1024).toFixed(0)} KB`);

          if (closeTabs) {
            try { await page.close(); } catch (_) {}
            const m2 = readJsonOr(TAB_MAP_FILE, {});
            delete m2[tid];
            writeJson(TAB_MAP_FILE, m2);
          }
        } catch (e) {
          console.log(`[save] ${String(entry.idx).padStart(3, '0')} export error: ${e.message}`);
        }
      }
    }

    if ((iter % 4) === 1) {
      console.log(`[save] iter ${iter}: ${scanned} pending tabs, +${savedThisIter} this round  (total ${savedIdxs.size}/${prompts.length})`);
    }

    if (savedIdxs.size >= prompts.length && !watchMode) {
      console.log(`[save] all ${prompts.length} saved — exiting`);
      break;
    }

    await sleep(POLL_MS);
  }

  console.log(`\n[save] DONE — ${savedIdxs.size} / ${prompts.length} saved`);
  console.log(`[save] images at: ${outDir}`);
  await browser.disconnect();
})();
