// One-shot: download the #40 image from orphan tab F4C8 and save it.
'use strict';
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TARGET_TID = 'F4C8012F71A7DEEFE44FA43EFC9A764D';
const OUT = 'D:\\Creative_Automation\\images\\g7-uz\\jahon-tarixi\\ch10-saljuqiylar-davlati\\040-transition-to-golden-age.png';

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      const tid = page.target()._targetId;
      if (tid !== TARGET_TID) continue;
      console.log(`found target tab, url=${page.url()}`);
      const result = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        let best = null;
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (r.width < 200) continue;
          if (r.width * r.height < 30_000) continue;
          const src = img.src || '';
          if (!src) return null;
          if (/lh3\.googleusercontent\.com\/a\//.test(src)) continue;
          if (/avatar|profile|logo|emoji/i.test(src)) continue;
          if (!best || (r.width * r.height) > best.area) {
            best = { src, w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height };
          }
        }
        return best;
      });
      if (!result) {
        console.log('no image found');
        process.exit(1);
      }
      console.log(`image: ${result.w}x${result.h}  src=${result.src.slice(0, 60)}...`);
      const buf = await page.evaluate(async (s) => {
        const img = Array.from(document.querySelectorAll('img')).find(i => i.src === s);
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        return Array.from(atob(dataUrl.split(',')[1]), ch => ch.charCodeAt(0));
      }, result.src);
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, Buffer.from(buf));
      console.log(`saved ${(buf.length / 1024).toFixed(0)} KB → ${OUT}`);
      await browser.disconnect();
      process.exit(0);
    }
  }
  console.log(`tab ${TARGET_TID} not found`);
  await browser.disconnect();
  process.exit(2);
})();
