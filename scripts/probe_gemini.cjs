// Quick probe of the Gemini page state.
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9223',
    defaultViewport: null,
  });
  let page = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      if (/gemini\.google\.com/.test(p.url() || '')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.log('no gemini tab'); process.exit(1); }
  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  console.log('');
  const items = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a, [role=button], input, [contenteditable=true]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        aria: el.getAttribute('aria-label') || '',
        text: (el.innerText || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
      });
    }
    return out.slice(0, 40);
  });
  console.log('--- Visible interactive elements ---');
  items.forEach((it, i) => console.log(`  [${String(i).padStart(2)}] ${it.tag.padEnd(8)} type=${it.type.padEnd(6)} aria=${JSON.stringify(it.aria.slice(0,30)).padEnd(32)} text=${JSON.stringify(it.text)}`));
  await browser.disconnect();
})();
