// Image → video pipeline via gemini.google.com/app's Create-Video mode (Veo).
//
// For each entry in prompts.json:
//   1. Read existing image at images/.../{idx:03d}-{slug}.png  (must already exist)
//   2. New chat
//   3. Switch to video mode (click "Create video" suggestion chip, OR navigate
//      to the video-mode UTM URL so the chip is preselected)
//   4. Click upload + → "Upload files" → pass the image to the file chooser
//   5. Type motion_script (or "drone shot animated slowly" fallback)
//   6. Click Send, wait for Stop button to disappear
//   7. Find <video> on canvas, download to videos/.../{idx:03d}-{slug}.mp4
//
// Single-tab sequential — Veo is slow (~60-180s/clip), per-account rate-limited.
//
// Usage:
//   node scripts/generate_videos_gemini.cjs <prompts.json> [skip] [limit]
//
//   node scripts/generate_videos_gemini.cjs prompts/.../ch01-...json 0 1
//      → generate first 1 video as smoke test

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
// URL with UTM params that pre-selects video mode (the chip already toggled)
const PLAIN_URL = 'https://gemini.google.com/app';
const FALLBACK_MOTION = 'drone animation slowly and slightly';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function deriveVideosDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'videos';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function ensureVideoMode(page) {
  // If "Create video" pill is already an active chip in the prompt bar, we're in video mode.
  // Look for a small chip-like element next to the prompt input (not the menu item).
  const alreadyOn = await page.evaluate(() => {
    // Look for a chip with × close icon AND "Create video" text
    const chips = Array.from(document.querySelectorAll('button, [role=button], div'));
    return chips.some(el => {
      const t = (el.innerText || '').trim();
      // Active chip looks like "Create video ✕" or similar (short text)
      return /^Create video/i.test(t) && t.length < 30;
    });
  });
  if (alreadyOn) {
    console.log('     [video-mode] already active');
    return true;
  }

  // Step A: click the "Tools" button (next to + in the prompt bar)
  const toolsClicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => {
        const t = (b.innerText || '').trim();
        const a = b.getAttribute('aria-label') || '';
        // The Tools button has aria-label "Tools" and visible text "Tools"
        return /^Tools$/i.test(t) || /^Tools$/i.test(a);
      });
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!toolsClicked) {
    console.log('     [video-mode] Tools button not found');
    return false;
  }
  await sleep(1200);

  // Step B: click "Create video" menu item from the Tools popup
  const videoClicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem], [role=option], button, [role=button], div, span, li'));
    const target = items.find(el => {
      const t = (el.innerText || '').trim();
      return /^Create video$/i.test(t) || /^🎬\s*Create video/i.test(t);
    });
    if (target) {
      // Click the closest button/menuitem ancestor if needed
      let clickEl = target;
      while (clickEl && !['BUTTON','A','LI'].includes(clickEl.tagName) &&
             clickEl.getAttribute('role') !== 'menuitem' && clickEl.getAttribute('role') !== 'option' && clickEl.getAttribute('role') !== 'button') {
        clickEl = clickEl.parentElement;
      }
      (clickEl || target).click();
      return true;
    }
    return false;
  });
  if (!videoClicked) {
    console.log('     [video-mode] "Create video" menu item not found');
    return false;
  }
  await sleep(1500);
  return true;
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
    await sleep(1500);
    return true;
  }
  return false;
}

async function uploadImage(page, imagePath) {
  // Click "+" / "upload file menu" button
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /upload file menu/i.test(b.getAttribute('aria-label') || '') ||
                 /add files/i.test(b.getAttribute('aria-label') || ''));
    if (btn) btn.click();
  });
  await sleep(2500);

  // Dismiss any "Agree" consent dialog
  const agreed = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /^Agree$/i.test((b.innerText || '').trim()));
    if (a) { a.click(); return true; }
    return false;
  });
  if (agreed) {
    await sleep(2000);
    // Re-open the upload menu
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role=button]'))
        .find(b => /upload file menu/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click();
    });
    await sleep(2500);
  }

  // Find the "Upload files" menu item
  const uploadBox = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem], button, [role=button], [role=option]'))
      .find(el => /^Upload files\b/i.test((el.innerText || '').trim()) && el.offsetParent);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!uploadBox) throw new Error('"Upload files" menu item not found');

  // Intercept the file chooser
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10_000 }),
    page.mouse.click(uploadBox.x, uploadBox.y, { delay: 30 }),
  ]);
  await chooser.accept([imagePath]);
  // Wait for image to upload + preview to appear
  await sleep(5000);
}

async function typeMotionScript(page, text) {
  const promptHandle = await page.evaluateHandle(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true]'));
    return eds.find(el => /Enter a prompt for Gemini|Describe your video/i.test(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    )) || eds[0] || null;
  });
  const el = promptHandle.asElement();
  if (!el) throw new Error('prompt input not found after upload');
  await el.click();
  await sleep(400);
  // Strip newlines (sends prematurely otherwise)
  const clean = (text || '').replace(/\s*\n\s*/g, ' ').trim();
  await page.keyboard.type(clean, { delay: 18 });
  await sleep(800);
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

async function waitForVideo(page, maxS = 600) {
  // Poll directly for a <video> element with a usable src. Much more reliable
  // than detecting Stop button visibility (which flashes briefly during the
  // initial spin then disappears for a long "rendering" phase).
  const start = Date.now();
  const deadlineMs = start + maxS * 1000;
  while (Date.now() < deadlineMs) {
    const result = await page.evaluate(() => {
      // Look for any video element on the page with src or <source>
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
        if (src) return { src, w: Math.round(r.width), h: Math.round(r.height) };
      }
      return null;
    }).catch(() => null);
    if (result) return result;
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed > 0 && elapsed % 30 === 0) console.log(`     [t+${elapsed}s] waiting for <video>...`);
    await sleep(4000);
  }
  return null;
}

async function findVideoSrc(page) {
  return page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll('video'));
    let best = null;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
      if (!src) continue;
      const area = r.width * r.height;
      if (!best || area > best.area) {
        best = { src, w: Math.round(r.width), h: Math.round(r.height), area };
      }
    }
    return best;
  });
}

async function downloadViaNode(url, page) {
  const https = require('https');
  // Cookies for the target URL's domain (contribution-rt.usercontent.google.com),
  // not just gemini.google.com — pass URL to .cookies() so Puppeteer scopes correctly.
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

async function downloadVideo(page, src) {
  if (src.startsWith('data:video') || src.startsWith('data:application')) {
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
  // http(s) — usually a signed URL on contribution-rt.usercontent.google.com.
  // page.evaluate(fetch) blocks on CORS for cross-origin user-content URLs, so
  // fall straight to the Node-side https client which has no CORS enforcement.
  try {
    return await downloadViaNode(src, page);
  } catch (e) {
    // Last-ditch fallback: try page-side fetch (works for same-origin URLs)
    console.log(`     [download] node-side failed (${e.message}), trying page-side fetch`);
    const arr = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, src);
    return Buffer.from(arr);
  }
}

async function processOne(page, entry, imagePath, outFile) {
  console.log(`     → New chat`);
  await clickNewChat(page);

  console.log(`     → Tools → Create video`);
  const modeOk = await ensureVideoMode(page);
  if (!modeOk) throw new Error('failed to enable video mode (Tools → Create video)');

  console.log(`     → Upload image: ${path.basename(imagePath)}`);
  await uploadImage(page, imagePath);

  const motion = (entry.motion_script || '').trim() || FALLBACK_MOTION;
  console.log(`     → Type motion: "${motion}"`);
  await typeMotionScript(page, motion);

  console.log(`     → Click Send`);
  await clickSend(page);

  console.log(`     → Wait for <video> to appear (up to 10 min)`);
  const found = await waitForVideo(page, 600);
  if (!found) throw new Error('no <video> element appeared within 10 min');
  console.log(`     → Got video ${found.w}x${found.h}, src=${found.src.slice(0, 60)}`);

  const buf = await downloadVideo(page, found.src);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { w: found.w, h: found.h, bytes: buf.length };
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node generate_videos_gemini.cjs <prompts.json> [skip] [limit]');
    process.exit(1);
  }
  if (!fs.existsSync(promptsPath)) {
    console.error(`prompts file not found: ${promptsPath}`);
    process.exit(1);
  }

  const skip = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset = prompts.slice(skip, skip + limit);

  const imagesDir = deriveImagesDir(promptsPath);
  const videosDir = deriveVideosDir(promptsPath);
  fs.mkdirSync(videosDir, { recursive: true });

  console.log(`[vgen] ${prompts.length} prompts loaded; processing ${subset.length}`);
  console.log(`[vgen] images: ${imagesDir}`);
  console.log(`[vgen] videos: ${videosDir}`);
  console.log(`[vgen] connecting to Chrome on http://127.0.0.1:${CDP_PORT}`);

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });

  // Find the signed-in Gemini context (incognito or persistent)
  let ctx = null, page = null;
  for (const c of browser.browserContexts()) {
    for (const p of await c.pages()) {
      if (/gemini\.google\.com/.test(p.url() || '')) {
        const ok = await p.evaluate(() => !!document.querySelector('[contenteditable=true]')).catch(() => false);
        if (ok) { ctx = c; page = p; break; }
      }
    }
    if (ctx) break;
  }
  if (!ctx) {
    console.error('[vgen] no signed-in Gemini context found — sign in first');
    await browser.disconnect();
    process.exit(2);
  }
  await page.bringToFront();
  console.log(`[vgen] working tab: ${page.url().slice(0, 100)}`);

  // Make sure we're on a fresh /app (not stuck on a prior chat)
  if (!/gemini\.google\.com\/app$/.test(page.url())) {
    console.log(`[vgen] navigating to plain /app`);
    await page.goto(PLAIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(3500);
  }

  let ok = 0, err = 0;
  for (let i = 0; i < subset.length; i++) {
    const entry = subset[i];
    const padIdx = String(entry.idx).padStart(3, '0');
    const imgFile = path.join(imagesDir, `${padIdx}-${entry.slug}.png`);
    const outFile = path.join(videosDir, `${padIdx}-${entry.slug}.mp4`);

    if (!fs.existsSync(imgFile)) {
      console.log(`[${i + 1}/${subset.length}] ${padIdx} ✗ image missing: ${imgFile}`);
      err++;
      continue;
    }
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 50 * 1024) {
      console.log(`[${i + 1}/${subset.length}] ${padIdx} skip (already exists)`);
      ok++;
      continue;
    }

    try {
      const t0 = Date.now();
      console.log(`\n[${i + 1}/${subset.length}] ${padIdx} :: ${entry.slug}`);
      const r = await processOne(page, entry, imgFile, outFile);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`           ✓ ${r.w}x${r.h}  ${(r.bytes / 1024 / 1024).toFixed(2)} MB  ${dt}s`);
      ok++;
    } catch (e) {
      console.log(`           ✗ ${e.message}`);
      err++;
      if (err >= 3 && i >= 2) {
        console.log('[stop] 3+ errors — stopping early');
        break;
      }
    }
    await sleep(3000);  // pacing
  }

  console.log(`\n[vgen] DONE — ${ok} ok, ${err} errors`);
  console.log(`[vgen] videos at: ${videosDir}`);
  await browser.disconnect();
})();
