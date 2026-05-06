'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      const url = page.url() || '';
      if (!/gemini\.google\.com/.test(url)) continue;
      const tid = page.target()._targetId;
      const info = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')).map(i => ({
          src: (i.src || '').slice(0, 100),
          w: Math.round(i.getBoundingClientRect().width),
          h: Math.round(i.getBoundingClientRect().height),
        })).filter(x => x.w >= 100);
        const stopBtn = Array.from(document.querySelectorAll('button, [role=button]'))
          .find(b => /^Stop /i.test(b.getAttribute('aria-label') || '') ||
                     /^Stop$/i.test((b.innerText || '').trim()));
        const errText = (document.body.innerText || '').match(/error|failed|cannot|unable|sorry|try again/gi);
        const conv = document.querySelector('main, [role=main]');
        const lastText = conv ? (conv.innerText || '').slice(-300) : '';
        return {
          imgCount: imgs.length,
          imgs: imgs.slice(0, 5),
          isGenerating: !!stopBtn,
          stopBtnText: stopBtn ? (stopBtn.innerText || stopBtn.getAttribute('aria-label')) : null,
          errMatches: errText ? errText.slice(0, 5) : [],
          lastConvText: lastText,
        };
      }).catch(e => ({ error: e.message }));
      console.log(`\nTab ${tid.slice(0, 8)}  url=${url.slice(0, 80)}`);
      console.log(JSON.stringify(info, null, 2));
    }
  }
  await browser.disconnect();
})();
