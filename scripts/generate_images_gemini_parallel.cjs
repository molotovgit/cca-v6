// Gemini image generator — parallel N-tab version of generate_images_gemini.cjs.
//
// For each batch of N (default 10):
//   1. Open N fresh tabs on gemini.google.com/app in the signed-in context
//   2. For each tab in rapid succession: type prompt + click Send
//   3. Wait for ALL N images to render server-side (overlapping)
//   4. Download all N (canvas-export handles blob:/data:/http URLs)
//   5. Close the N tabs, move to next batch
//
// 80 prompts → 8 batches → roughly 8-12 minutes total (vs ~63 min sequential).
// Risk: Gemini may rate-limit Workspace accounts doing N concurrent gens.
//
// Usage:
//   node scripts/generate_images_gemini_parallel.cjs <prompts.json>
//   node scripts/generate_images_gemini_parallel.cjs <prompts.json> 0 10        # skip 0, do 10 (one batch)
//   node scripts/generate_images_gemini_parallel.cjs <prompts.json> 0 80 10     # skip 0, do 80, batch=10

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT  = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const GEMINI_URL = 'https://gemini.google.com/app';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── Per-tab steps ──

async function submitPromptOnTab(page, promptText) {
  // Strip newlines (Gemini sends on \n\n)
  const prompt = (promptText || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!prompt) throw new Error('empty prompt');

  // Click prompt input
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

  // Fast-type the prompt
  await page.keyboard.type(prompt, { delay: 15 });
  await sleep(500);

  // Click Send message
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

async function waitGenDoneOnTab(page, maxS = 300) {
  let sawStop = false;
  for (let i = 0; i < maxS / 2; i++) {
    await sleep(2000);
    const isGenerating = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role=button]'))
        .some(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                   /^Stop$/i.test((b.innerText || '').trim()))
    ).catch(() => false);
    if (isGenerating) sawStop = true;
    else if (sawStop) return true;
  }
  return sawStop;
}

async function findNewImageOnTab(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    let best = null;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
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
  });
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
  // http(s) — fetch from page context (carries cookies)
  const arr = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const ab = await r.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, src);
  return Buffer.from(arr);
}

async function processBatch(ctx, entries, outDir, batchNum, totalBatches) {
  console.log(`\n[batch ${batchNum}/${totalBatches}] === ${entries.length} prompts (idx ${entries[0].idx}..${entries[entries.length - 1].idx}) ===`);

  // 1. Open N tabs
  console.log(`[batch ${batchNum}] opening ${entries.length} tabs...`);
  const tabs = [];
  for (const entry of entries) {
    const p = await ctx.newPage();
    try {
      await p.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      console.log(`[batch ${batchNum}] tab ${entry.idx} goto warn: ${e.message}`);
    }
    tabs.push({ page: p, entry });
    await sleep(700);  // stagger so we don't open all 10 at the same instant
  }

  // 2. Brief settle
  await sleep(5000);

  // 3. Submit prompt to each tab in rapid succession
  console.log(`[batch ${batchNum}] submitting prompts...`);
  for (let i = 0; i < tabs.length; i++) {
    const { page, entry } = tabs[i];
    try {
      await page.bringToFront();
      await submitPromptOnTab(page, entry.image_prompt);
      console.log(`[batch ${batchNum}]   ${String(entry.idx).padStart(3, '0')} submitted (tab ${i + 1})`);
    } catch (e) {
      console.log(`[batch ${batchNum}]   ${String(entry.idx).padStart(3, '0')} submit FAIL: ${e.message}`);
      tabs[i].submitFailed = true;
    }
    await sleep(1500);  // small gap between submissions
  }

  // 4. Wait for ALL tabs in parallel, download each
  console.log(`[batch ${batchNum}] waiting for ${entries.length} generations...`);
  const results = await Promise.all(tabs.map(async ({ page, entry, submitFailed }, i) => {
    if (submitFailed) return { idx: entry.idx, slug: entry.slug, ok: false, err: 'submit failed' };
    try {
      await waitGenDoneOnTab(page, 300);
      const found = await findNewImageOnTab(page);
      if (!found) return { idx: entry.idx, slug: entry.slug, ok: false, err: 'no image' };
      const buf = await exportToBuffer(page, found.src);
      const outFile = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, buf);
      console.log(`[batch ${batchNum}]   ${String(entry.idx).padStart(3, '0')} OK ${found.w}x${found.h} ${(buf.length / 1024).toFixed(0)} KB`);
      return { idx: entry.idx, slug: entry.slug, ok: true, w: found.w, h: found.h, bytes: buf.length };
    } catch (e) {
      console.log(`[batch ${batchNum}]   ${String(entry.idx).padStart(3, '0')} FAIL: ${e.message}`);
      return { idx: entry.idx, slug: entry.slug, ok: false, err: e.message };
    }
  }));

  // 5. Close tabs
  console.log(`[batch ${batchNum}] closing tabs...`);
  for (const { page } of tabs) {
    try { await page.close(); } catch (_) {}
  }

  return results;
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node generate_images_gemini_parallel.cjs <prompts.json> [skip] [limit] [batch_size]');
    process.exit(1);
  }
  if (!fs.existsSync(promptsPath)) {
    console.error(`prompts file not found: ${promptsPath}`);
    process.exit(1);
  }

  const skip      = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg  = process.argv[4];
  const batchSize = parseInt(process.argv[5] || '10', 10) || 10;
  const prompts   = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit     = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset    = prompts.slice(skip, skip + limit);

  const outDir = deriveOutputDir(promptsPath);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[gen] loaded ${prompts.length} prompts from ${path.basename(promptsPath)}`);
  console.log(`[gen] processing ${subset.length} (skip=${skip}, limit=${limit}, batch=${batchSize})`);
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
    process.exit(2);
  }

  // Find the context with a signed-in Gemini tab
  let signedInCtx = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      const url = p.url() || '';
      if (/gemini\.google\.com/.test(url)) {
        // Quick check that prompt input exists (= signed in)
        try {
          const hasInput = await p.evaluate(() =>
            !!document.querySelector('[contenteditable=true]'));
          if (hasInput) { signedInCtx = ctx; break; }
        } catch (_) { /* ignore */ }
      }
    }
    if (signedInCtx) break;
  }
  if (!signedInCtx) {
    console.error('[gen] no signed-in Gemini context found — sign in manually first');
    await browser.disconnect();
    process.exit(3);
  }
  console.log('[gen] found signed-in Gemini context');

  // Filter out entries whose output file already exists
  const todo = subset.filter(entry => {
    const outFile = path.join(outDir, `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`);
    return !(fs.existsSync(outFile) && fs.statSync(outFile).size > 1024);
  });
  if (todo.length < subset.length) {
    console.log(`[gen] ${subset.length - todo.length} already exist, skipping`);
  }

  const totalBatches = Math.ceil(todo.length / batchSize);
  let allOk = 0, allErr = 0;

  for (let bi = 0; bi < totalBatches; bi++) {
    const batchEntries = todo.slice(bi * batchSize, (bi + 1) * batchSize);
    const t0 = Date.now();
    const results = await processBatch(signedInCtx, batchEntries, outDir, bi + 1, totalBatches);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = results.filter(r => r.ok).length;
    const err = results.filter(r => !r.ok).length;
    allOk += ok;
    allErr += err;
    console.log(`[batch ${bi + 1}/${totalBatches}] done in ${dt}s — ${ok} ok, ${err} err  (total: ${allOk} ok, ${allErr} err)`);

    // Inter-batch pause
    if (bi < totalBatches - 1) {
      const wait = 8 + Math.random() * 8;
      console.log(`[gen] sleeping ${wait.toFixed(1)}s before next batch`);
      await sleep(wait * 1000);
    }
  }

  console.log(`\n[gen] DONE — ${allOk} ok, ${allErr} errors`);
  console.log(`[gen] images at: ${outDir}`);
  await browser.disconnect();
})();
