// Gemini image generator — adapted from D:/Homeworks/scripts/gemini_app_batch.cjs.
//
// Sequential generation in one tab. For each prompt:
//   1. Click "New chat"
//   2. Click contenteditable prompt input
//   3. Type prompt fast (25ms/char) — newlines stripped (Gemini sends on \n\n)
//   4. Click "Send message" button
//   5. Wait for "Stop" button to appear-then-disappear
//   6. Find the new <img> on canvas, canvas-export to PNG
//
// Connects via CDP to the Python gemini_keepalive (port 9223 by default).
// User must be signed in to gemini.google.com in the keepalive's Chromium
// (manual one-time login — auto-SSO via automation is unreliable).
//
// Usage:
//   node scripts/generate_images_gemini.cjs <prompts.json>            # all
//   node scripts/generate_images_gemini.cjs <prompts.json> 5          # first 5
//   node scripts/generate_images_gemini.cjs <prompts.json> 0 10       # skip 0, do 10

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const REPO      = path.resolve(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function deriveOutputDir(promptsJsonPath) {
  // promptsJsonPath: D:\Creative_Automation\prompts\g7-uz\jahon-tarixi\ch01-...json
  // outputDir:       D:\Creative_Automation\images\g7-uz\jahon-tarixi\ch01-...\
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) {
    throw new Error(`input path missing 'prompts' segment: ${abs}`);
  }
  const newParts = parts.slice();
  newParts[idx] = 'images';
  // Strip .json extension to get the basename folder
  const file = newParts[newParts.length - 1];
  const base = file.replace(/\.json$/i, '');
  newParts[newParts.length - 1] = base;
  return newParts.join(path.sep);
}

async function generateOne(page, entry, outFile) {
  const idx = entry.idx;
  const slug = entry.slug;
  // Strip embedded newlines — Gemini's contenteditable interprets \n\n as send
  const prompt = (entry.image_prompt || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!prompt) throw new Error(`empty prompt for idx ${idx}`);

  // 1. New chat (resets context)
  const newChatBox = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^New chat$/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (newChatBox) {
    await page.mouse.click(newChatBox.x, newChatBox.y, { delay: 30 });
    await sleep(1500);
  }

  // 2. Capture baseline image srcs BEFORE submission
  const baselineSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map(i => i.src || ''));

  // 3. Find the contenteditable prompt input + click it
  const promptHandle = await page.evaluateHandle(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true]'));
    return eds.find(el => /Enter a prompt for Gemini/i.test(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    )) || eds[0] || null;
  });
  const promptEl = promptHandle.asElement();
  if (!promptEl) throw new Error('prompt input not found');
  await promptEl.click();
  await sleep(400);

  // 4. Type prompt fast (25ms/char — proven in working script)
  await page.keyboard.type(prompt, { delay: 25 });
  await sleep(800);

  // 5. Click Send message button (proven aria-label)
  const sendBox = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^Send message$/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!sendBox) throw new Error('Send message button not found');
  await page.mouse.click(sendBox.x, sendBox.y, { delay: 30 });

  // 6. Wait for completion: Send button is replaced by Stop button while
  //    generating. Poll until Stop disappears. Cap 300s.
  let sawStop = false;
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const isGenerating = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role=button]'))
        .some(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                   /^Stop$/i.test((b.innerText || '').trim()))
    );
    if (isGenerating) {
      sawStop = true;
    } else if (sawStop) {
      break;
    }
    if ((i + 1) % 5 === 0) console.log(`     [t+${(i + 1) * 2}s] still generating...`);
  }
  await sleep(2000);

  // 7. Find the largest new <img> not in baseline
  const found = await page.evaluate((baseline) => {
    const baselineSet = new Set(baseline);
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      const src = img.src || '';
      if (!src) continue;
      if (baselineSet.has(src)) continue;
      if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;  // avatar
      if (/avatar|profile|logo|emoji/i.test(src)) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) best = { src, w: Math.round(r.width), h: Math.round(r.height), area };
    }
    return best;
  }, baselineSrcs);
  if (!found) throw new Error('no new image after generation');

  // 8. Canvas-export the image (handles blob:, data:, http URLs)
  let buf;
  if (found.src.startsWith('data:image')) {
    buf = Buffer.from(found.src.split(',', 2)[1], 'base64');
  } else if (found.src.startsWith('blob:')) {
    const dataUrl = await page.evaluate((src) => {
      const img = Array.from(document.querySelectorAll('img')).find(i => i.src === src);
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth  || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }, found.src);
    if (!dataUrl) throw new Error('canvas export failed');
    buf = Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  } else {
    buf = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, found.src).then(arr => Buffer.from(arr));
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { w: found.w, h: found.h, bytes: buf.length };
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node generate_images_gemini.cjs <prompts.json> [skip] [limit]');
    process.exit(1);
  }
  if (!fs.existsSync(promptsPath)) {
    console.error(`prompts file not found: ${promptsPath}`);
    process.exit(1);
  }

  const skip  = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset = prompts.slice(skip, skip + limit);

  const outDir = deriveOutputDir(promptsPath);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[gen] loaded ${prompts.length} prompts from ${path.basename(promptsPath)}`);
  console.log(`[gen] processing ${subset.length} (skip=${skip}, limit=${limit})`);
  console.log(`[gen] output dir: ${outDir}`);
  console.log(`[gen] connecting to keepalive on http://127.0.0.1:${CDP_PORT}`);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    });
  } catch (e) {
    console.error(`[gen] CDP connect failed: ${e.message}`);
    console.error(`[gen] start it: python gemini_keepalive.py`);
    process.exit(2);
  }

  // Find the most-progressed Gemini tab across ALL contexts (incognito too)
  let page = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      const url = p.url() || '';
      if (/gemini\.google\.com/.test(url)) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) {
    console.error('[gen] no gemini.google.com tab found in any context');
    console.error('[gen] sign in to Gemini in the keepalive Chromium first');
    await browser.disconnect();
    process.exit(3);
  }
  await page.bringToFront();
  console.log(`[on-page] ${page.url()}`);

  // Sanity check: contenteditable visible (proves signed-in state)
  const hasInput = await page.evaluate(() =>
    !!document.querySelector('[contenteditable=true]'));
  if (!hasInput) {
    console.error('[gen] no contenteditable on page — sign in manually first');
    await browser.disconnect();
    process.exit(4);
  }
  console.log('[gen] prompt input present — signed in');

  let ok = 0, err = 0;
  for (let i = 0; i < subset.length; i++) {
    const entry = subset[i];
    const idx = entry.idx;
    const padIdx = String(idx).padStart(3, '0');
    const outFile = path.join(outDir, `${padIdx}-${entry.slug}.png`);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
      console.log(`[${i + 1}/${subset.length}] ${padIdx} skip (already exists)`);
      ok++;
      continue;
    }
    try {
      const t0 = Date.now();
      console.log(`[${i + 1}/${subset.length}] ${padIdx} :: ${entry.slug}`);
      const r = await generateOne(page, entry, outFile);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`           ✓ ${r.w}x${r.h}  ${(r.bytes / 1024).toFixed(0)} KB  ${dt}s  → ${path.basename(outFile)}`);
      ok++;
    } catch (e) {
      console.log(`           ✗ ${e.message}`);
      err++;
      if (err >= 3 && i >= 2) {
        // 3 consecutive errors — likely rate-limited, stop
        console.log('[stop] 3+ errors — stopping early');
        break;
      }
    }
    // Pacing between calls (proven 2.5s)
    await sleep(2500);
  }

  console.log(`\n[gen] DONE — ${ok} ok, ${err} errors`);
  console.log(`[gen] images at: ${outDir}`);
  await browser.disconnect();
})();
