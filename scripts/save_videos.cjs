// Continuous VIDEO saver — scans Gemini tabs in .cca/video_tab_map.json,
// downloads any rendered video to disk via Node-side https (avoids CORS on
// contribution-rt.usercontent.google.com), closes the tab.
//
// Usage:
//   node scripts/save_videos.cjs <prompts.json>          # exits when all done
//   node scripts/save_videos.cjs <prompts.json> --watch  # poll forever
//   node scripts/save_videos.cjs <prompts.json> --no-close

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POLL_MS = 4000;

const REPO     = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO, '.cca');
const TAB_MAP_FILE = path.join(STATE_DIR, 'video_tab_map.json');
const SAVED_FILE   = path.join(STATE_DIR, 'video_saved_indices.json');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function deriveOutputDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'videos';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function findVideoOnTab(page) {
  return page.evaluate(() => {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
      if (src) return { src, w: Math.round(r.width), h: Math.round(r.height) };
    }
    return null;
  }).catch(() => null);
}

async function downloadViaNode(url, page) {
  const cookies = await page.cookies(url);
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ua = await page.evaluate(() => navigator.userAgent);

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': ua,
        'Accept': '*/*',
        'Referer': 'https://gemini.google.com/',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        downloadViaNode(res.headers.location, page).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function downloadVideoBuf(page, src) {
  if (src.startsWith('data:')) {
    return Buffer.from(src.split(',', 2)[1], 'base64');
  }
  if (src.startsWith('blob:')) {
    const arr = await page.evaluate(async (s) => {
      const r = await fetch(s);
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, src);
    return Buffer.from(arr);
  }
  // http(s) signed URL on contribution-rt.usercontent.google.com — Node-side
  return downloadViaNode(src, page);
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node save_videos.cjs <prompts.json> [--watch] [--no-close]');
    process.exit(1);
  }
  const watchMode = process.argv.includes('--watch');
  const closeTabs = !process.argv.includes('--no-close');
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const outDir = deriveOutputDir(promptsPath);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[vsave] watching ${path.basename(promptsPath)}  (${prompts.length} expected)`);
  console.log(`[vsave] output: ${outDir}`);
  console.log(`[vsave] close-tabs: ${closeTabs}, watch: ${watchMode}`);

  const savedIdxs = new Set(readJsonOr(SAVED_FILE, []));
  for (const entry of prompts) {
    const expected = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.mp4`);
    if (fs.existsSync(expected) && fs.statSync(expected).size > 50 * 1024) {
      savedIdxs.add(entry.idx);
    }
  }
  writeJson(SAVED_FILE, [...savedIdxs]);
  console.log(`[vsave] starting with ${savedIdxs.size} already saved`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`,
    defaultViewport: null,
  });

  let iter = 0;
  while (true) {
    iter++;
    const tabMap = readJsonOr(TAB_MAP_FILE, {});
    const wantedTids = new Set(
      Object.entries(tabMap).filter(([_, m]) => !savedIdxs.has(m.idx)).map(([tid]) => tid)
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

        // Wake without focus-stealing (timeout race)
        try {
          await Promise.race([
            page.screenshot({ type: 'jpeg', quality: 1, fullPage: false }),
            new Promise((_, rj) => setTimeout(() => rj(new Error('screenshot timeout')), 4000)),
          ]);
        } catch (_) {}
        try {
          await Promise.race([
            page.evaluate(() => {
              try {
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                document.dispatchEvent(new Event('visibilitychange'));
              } catch (_) {}
            }),
            new Promise((_, rj) => setTimeout(() => rj(new Error('eval timeout')), 3000)),
          ]);
        } catch (_) {}

        const found = await findVideoOnTab(page);
        if (!found) continue;

        try {
          const buf = await downloadVideoBuf(page, found.src);
          const outFile = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.mp4`);
          fs.writeFileSync(outFile, buf);
          savedIdxs.add(entry.idx);
          writeJson(SAVED_FILE, [...savedIdxs]);
          savedThisIter++;
          console.log(`[vsave] ${String(entry.idx).padStart(3, '0')} ${entry.slug}  → ${found.w}x${found.h} ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

          if (closeTabs) {
            try { await page.close(); } catch (_) {}
            const m2 = readJsonOr(TAB_MAP_FILE, {});
            delete m2[tid];
            writeJson(TAB_MAP_FILE, m2);
          }
        } catch (e) {
          console.log(`[vsave] ${String(entry.idx).padStart(3, '0')} download error: ${e.message}`);
        }
      }
    }

    if ((iter % 4) === 1) {
      console.log(`[vsave] iter ${iter}: ${scanned} pending, +${savedThisIter} this round  (total ${savedIdxs.size}/${prompts.length})`);
    }

    if (savedIdxs.size >= prompts.length && !watchMode) {
      console.log(`[vsave] all ${prompts.length} saved — exiting`);
      break;
    }

    await sleep(POLL_MS);
  }

  console.log(`\n[vsave] DONE — ${savedIdxs.size} / ${prompts.length} saved`);
  await browser.disconnect();
})();
