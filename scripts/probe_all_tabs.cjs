// Scan EVERY Gemini tab in Chrome and report what's in each: title, URL,
// any rendered image, and the user-typed prompt (first chat message).
// Useful for finding generated images that fell outside our tab_map.

'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });

  let i = 0;
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      const url = page.url() || '';
      if (!/gemini\.google\.com/.test(url)) continue;
      i++;
      let tid;
      try { tid = page.target()._targetId; } catch { tid = '?'; }
      let title = '';
      try { title = await page.title(); } catch {}
      console.log(`\n[${i}] tab id=${tid.slice(0, 8)}`);
      console.log(`    url:   ${url.slice(0, 120)}`);
      console.log(`    title: ${title}`);

      // Check first user-typed prompt (if any chat was started)
      let firstPrompt = '';
      try {
        firstPrompt = await page.evaluate(() => {
          const el = document.querySelector('user-query, [data-test-id*="user"], [class*="user-query"]');
          if (!el) return '';
          return (el.innerText || '').slice(0, 200);
        });
      } catch {}
      if (firstPrompt) console.log(`    first prompt: ${firstPrompt.slice(0, 100)}`);

      // Find any large image
      const img = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        let best = null;
        for (const i of imgs) {
          const r = i.getBoundingClientRect();
          if (r.width < 200 || r.height < 200) continue;
          const src = i.src || '';
          if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;
          if (/avatar|profile|logo|emoji/i.test(src)) continue;
          const area = r.width * r.height;
          if (!best || area > best.area) best = { src: src.slice(0, 80), w: Math.round(r.width), h: Math.round(r.height), area };
        }
        return best;
      }).catch(() => null);
      if (img) console.log(`    IMAGE: ${img.w}x${img.h}  src=${img.src}`);
      else     console.log(`    image: none`);

      // Still generating?
      const generating = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role=button]'))
          .some(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                     /^Stop$/i.test((b.innerText || '').trim()))
      ).catch(() => false);
      if (generating) console.log(`    STILL GENERATING`);
    }
  }
  await browser.disconnect();
})();
