// FIRE-AND-FORGET prompt submitter — opens tabs, submits prompts, exits.
// Doesn't wait for image, doesn't download, doesn't close tabs.
// Run save_images.cjs in parallel to capture images as they appear.
//
// Tags each opened tab with the prompt entry by writing the target ID
// → entry mapping to .cca/tab_map.json. The saver reads this map.
//
// Usage:
//   node scripts/submit_prompts.cjs <prompts.json>
//   node scripts/submit_prompts.cjs <prompts.json> 0 80 10
//       skip=0, limit=80, max_open_tabs=10 (waits for saver to close tabs before opening more)

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const GEMINI_URL = 'https://gemini.google.com/app';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REPO     = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO, '.cca');
const TAB_MAP_FILE = path.join(STATE_DIR, 'tab_map.json');
const SAVED_FILE   = path.join(STATE_DIR, 'saved_indices.json');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (e.code !== 'ENOENT') throw e;
  }
}

function targetIdOf(page) {
  return page.target()._targetId;
}

// Derive the chapter's images folder from the prompts.json path.
// Mirror of run_autonomous.cjs derive logic.
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
  return out;
}

async function submitPromptOnTab(page, promptText) {
  const prompt = (promptText || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!prompt) throw new Error('empty prompt');

  const promptHandle = await page.evaluateHandle(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true]'));
    return eds.find(el => /Enter a prompt for Gemini/i.test(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    )) || eds[0] || null;
  });
  const el = promptHandle.asElement();
  if (!el) throw new Error('prompt input not found');
  await el.click();
  await sleep(300);
  await page.keyboard.type(prompt, { delay: 12 });
  await sleep(400);

  const sendBox = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^Send message$/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendBox) throw new Error('Send message button not found');
  await page.mouse.click(sendBox.x, sendBox.y, { delay: 30 });
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node submit_prompts.cjs <prompts.json> [skip] [limit] [max_open_tabs]');
    process.exit(1);
  }
  const skip = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const maxOpen = parseInt(process.argv[5] || '10', 10) || 10;
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset = prompts.slice(skip, skip + limit);

  fs.mkdirSync(STATE_DIR, { recursive: true });

  console.log(`[sub] ${subset.length} prompts to submit (skip=${skip}, limit=${limit}, max_open=${maxOpen})`);
  console.log(`[sub] connecting to keepalive on http://127.0.0.1:${CDP_PORT}`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`,
    defaultViewport: null,
  });

  let ctx = null;
  for (const c of browser.browserContexts()) {
    for (const p of await c.pages()) {
      if (/gemini\.google\.com/.test(p.url() || '')) {
        const ok = await p.evaluate(() => !!document.querySelector('[contenteditable=true]')).catch(() => false);
        if (ok) { ctx = c; break; }
      }
    }
    if (ctx) break;
  }
  if (!ctx) {
    console.error('[sub] no signed-in Gemini context found');
    await browser.disconnect();
    process.exit(2);
  }
  console.log('[sub] found signed-in Gemini context');

  // Skip indices that are EITHER on disk OR in the state file. Disk is authoritative
  // (state file can lag or be wiped between runs); union covers both.
  const imagesDir = chapterImagesDir(promptsPath);
  const onDiskSet = new Set(diskSavedIndices(imagesDir));
  const stateSet  = new Set(readJsonOr(SAVED_FILE, []));
  const savedIdxSet = new Set([...onDiskSet, ...stateSet]);
  const todo = subset.filter(e => !savedIdxSet.has(e.idx));
  console.log(`[sub] disk=${onDiskSet.size}, state=${stateSet.size}, union=${savedIdxSet.size}; ${subset.length - todo.length} already saved, ${todo.length} to submit`);

  let submitted = 0, errors = 0;
  for (const entry of todo) {
    while (true) {
      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      const savedNow = new Set(readJsonOr(SAVED_FILE, []));
      const pending = Object.entries(tabMap).filter(([_tid, m]) => !savedNow.has(m.idx)).length;
      if (pending < maxOpen) break;
      await sleep(2500);
    }

    let page = null;
    try {
      page = await ctx.newPage();
      await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2500);
      await submitPromptOnTab(page, entry.image_prompt);
      const tid = targetIdOf(page);

      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      tabMap[tid] = {
        idx: entry.idx,
        slug: entry.slug,
        prompts_path: path.resolve(promptsPath),
        submitted_at: new Date().toISOString(),
      };
      writeJson(TAB_MAP_FILE, tabMap);

      submitted++;
      console.log(`[sub] ${String(entry.idx).padStart(3, '0')} submitted  (tab ${tid.slice(0, 8)}, ${submitted}/${todo.length})`);
    } catch (e) {
      errors++;
      console.log(`[sub] ${String(entry.idx).padStart(3, '0')} FAIL: ${e.message}`);
      if (page) {
        try { await page.close(); } catch (_) {}
      }
    }
    await sleep(800);
  }

  console.log(`\n[sub] DONE submitting — ${submitted} ok, ${errors} errors`);
  console.log(`[sub] tab_map at ${TAB_MAP_FILE}`);
  await browser.disconnect();
})();
