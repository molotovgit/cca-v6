// Fire-and-forget VIDEO submitter — opens tabs, uploads image, types motion, sends, moves on.
// Doesn't wait for video, doesn't download, doesn't close tabs.
// Run save_videos.cjs in parallel to capture videos as they appear.
//
// Per-tab flow: New chat → Tools → Create video → Upload image → Type motion → Send → next tab.
//
// State files (separate from image flow):
//   .cca/video_tab_map.json
//   .cca/video_saved_indices.json
//
// Usage:
//   node scripts/submit_videos.cjs <prompts.json>
//   node scripts/submit_videos.cjs <prompts.json> 1 5 15      # skip 1, do 5, max_open=15

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const PLAIN_URL = 'https://gemini.google.com/app';
const FALLBACK_MOTION = 'drone animation slowly and slightly';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
function targetIdOf(page) { return page.target()._targetId; }

function deriveImagesDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'images';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function clickNewChat(page) {
  const box = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button], a'))
      .find(b => /^New chat$/i.test(b.getAttribute('aria-label') || '') ||
                 /^New chat$/i.test((b.innerText || '').trim()));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (box) {
    await page.mouse.click(box.x, box.y, { delay: 30 });
    await sleep(1200);
    return true;
  }
  return false;
}

async function ensureVideoMode(page) {
  // Click Tools button
  const toolsClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^Tools$/i.test((b.innerText || '').trim()) || /^Tools$/i.test(b.getAttribute('aria-label') || ''));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!toolsClicked) return false;
  await sleep(1000);

  // Click "Create video" menu item
  const videoClicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem], [role=option], button, [role=button], div, span, li'));
    const target = items.find(el => /^Create video$/i.test((el.innerText || '').trim()));
    if (target) {
      let clickEl = target;
      while (clickEl && !['BUTTON','A','LI'].includes(clickEl.tagName) &&
             !['menuitem','option','button'].includes(clickEl.getAttribute('role') || '')) {
        clickEl = clickEl.parentElement;
      }
      (clickEl || target).click();
      return true;
    }
    return false;
  });
  await sleep(1200);
  return videoClicked;
}

async function uploadImage(page, imagePath) {
  // Click "+" / upload menu
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /upload file menu/i.test(b.getAttribute('aria-label') || '') ||
                 /add files/i.test(b.getAttribute('aria-label') || ''));
    if (btn) btn.click();
  });
  await sleep(2000);

  // Dismiss "Agree" consent if present
  const agreed = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^Agree$/i.test((b.innerText || '').trim()));
    if (a) { a.click(); return true; }
    return false;
  });
  if (agreed) {
    await sleep(1500);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role=button]'))
        .find(b => /upload file menu/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click();
    });
    await sleep(2000);
  }

  // Click "Upload files" menu item with file chooser intercept
  const uploadBox = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem], button, [role=button], [role=option]'))
      .find(el => /^Upload files\b/i.test((el.innerText || '').trim()) && el.offsetParent);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!uploadBox) throw new Error('"Upload files" menu item not found');

  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10_000 }),
    page.mouse.click(uploadBox.x, uploadBox.y, { delay: 30 }),
  ]);
  await chooser.accept([imagePath]);
  await sleep(4500);  // wait for image preview to appear
}

async function typeMotion(page, text) {
  const promptHandle = await page.evaluateHandle(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true]'));
    return eds.find(el => /Enter a prompt for Gemini|Describe your video/i.test(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    )) || eds[0] || null;
  });
  const el = promptHandle.asElement();
  if (!el) throw new Error('prompt input not found after upload');
  await el.click();
  await sleep(300);
  const clean = (text || '').replace(/\s*\n\s*/g, ' ').trim();
  await page.keyboard.type(clean, { delay: 12 });
  await sleep(500);
}

async function clickSend(page) {
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
    console.error('Usage: node submit_videos.cjs <prompts.json> [skip] [limit] [max_open]');
    process.exit(1);
  }
  const skip = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const maxOpen = parseInt(process.argv[5] || '15', 10) || 15;
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset = prompts.slice(skip, skip + limit);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const imagesDir = deriveImagesDir(promptsPath);

  console.log(`[vsub] ${subset.length} prompts to submit (skip=${skip}, limit=${limit}, max_open=${maxOpen})`);
  console.log(`[vsub] images source: ${imagesDir}`);
  console.log(`[vsub] connecting to Chrome on http://127.0.0.1:${CDP_PORT}`);

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CDP_PORT}`,
    defaultViewport: null,
  });

  // Find signed-in Gemini context (check incognito too)
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
    console.error('[vsub] no signed-in Gemini context found');
    await browser.disconnect();
    process.exit(2);
  }
  console.log('[vsub] found signed-in Gemini context');

  const savedIdxSet = new Set(readJsonOr(SAVED_FILE, []));
  const todo = subset.filter(e => !savedIdxSet.has(e.idx));
  console.log(`[vsub] ${subset.length - todo.length} already saved, ${todo.length} to submit`);

  let submitted = 0, errors = 0;
  for (const entry of todo) {
    const padIdx = String(entry.idx).padStart(3, '0');
    const imgPath = path.join(imagesDir, `${padIdx}-${entry.slug}.png`);
    if (!fs.existsSync(imgPath)) {
      console.log(`[vsub] ${padIdx} ✗ source image missing: ${imgPath}`);
      errors++;
      continue;
    }

    // Throttle: wait until pending tabs < max_open
    while (true) {
      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      const savedNow = new Set(readJsonOr(SAVED_FILE, []));
      const pending = Object.entries(tabMap).filter(([_, m]) => !savedNow.has(m.idx)).length;
      if (pending < maxOpen) break;
      await sleep(3000);
    }

    let page = null;
    try {
      page = await ctx.newPage();
      await page.goto(PLAIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2500);

      console.log(`[vsub] ${padIdx} :: ${entry.slug}  (Tools → Create video)`);
      const modeOk = await ensureVideoMode(page);
      if (!modeOk) throw new Error('failed to enable video mode');

      console.log(`[vsub] ${padIdx} uploading image`);
      await uploadImage(page, imgPath);

      const motion = (entry.motion_script || '').trim() || FALLBACK_MOTION;
      console.log(`[vsub] ${padIdx} typing motion: "${motion.slice(0, 60)}..."`);
      await typeMotion(page, motion);

      console.log(`[vsub] ${padIdx} send`);
      await clickSend(page);

      const tid = targetIdOf(page);
      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      tabMap[tid] = {
        idx: entry.idx,
        slug: entry.slug,
        prompts_path: path.resolve(promptsPath),
        submitted_at: new Date().toISOString(),
        motion_used: motion,
      };
      writeJson(TAB_MAP_FILE, tabMap);

      submitted++;
      console.log(`[vsub] ${padIdx} ✓ submitted to tab ${tid.slice(0, 8)}  (${submitted}/${todo.length})`);
    } catch (e) {
      errors++;
      console.log(`[vsub] ${padIdx} ✗ ${e.message}`);
      if (page) {
        try { await page.close(); } catch (_) {}
      }
    }
    await sleep(800);
  }

  console.log(`\n[vsub] DONE submitting — ${submitted} ok, ${errors} errors`);
  console.log(`[vsub] tab_map at ${TAB_MAP_FILE}`);
  await browser.disconnect();
})();
