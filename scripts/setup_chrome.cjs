// =============================================================================
//  CHROME SETUP — launches the two Chrome windows the pipeline needs.
// =============================================================================
//  • Port 9222 → ChatGPT   (opens chatgpt.com)
//  • Port 9223 → Gemini    (opens gemini.google.com)
//
//  Each window uses its own isolated profile dir so cookies/sessions persist
//  between runs (you only sign in ONCE, ever).
//
//  Skips a launch if that port is already up.
//
//  USAGE:
//    node scripts/setup_chrome.cjs
//
//  Then sign in manually inside each window — the pipeline does the rest.
// =============================================================================

'use strict';
const { spawn } = require('child_process');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
];

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  throw new Error('Chrome not found in standard locations. Edit CHROME_PATHS in this script.');
}

function checkPort(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(!!JSON.parse(data).Browser); } catch (_) { resolve(false); }
      });
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function launchChrome(chromePath, port, profileDir, urls) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    ...urls,
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CHROME SETUP for Creative Automation pipeline');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const chrome = findChrome();
  console.log(`  Chrome:  ${chrome}\n`);

  const HOME = os.homedir();
  const profile9222 = path.join(HOME, 'chrome-chatgpt-cdp');
  const profile9223 = path.join(HOME, 'chrome-gemini-cdp');

  // Port 9222 — ChatGPT
  if (await checkPort(9222)) {
    console.log('  [9222] ChatGPT Chrome — already running. Skipping.');
  } else {
    const pid = launchChrome(chrome, 9222, profile9222, ['https://chatgpt.com/']);
    console.log(`  [9222] ChatGPT Chrome — launched (PID ${pid})`);
    console.log(`         profile: ${profile9222}`);
  }

  await sleep(1500);

  // Port 9223 — Gemini
  if (await checkPort(9223)) {
    console.log('  [9223] Gemini Chrome — already running. Skipping.');
  } else {
    const pid = launchChrome(chrome, 9223, profile9223, [
      'https://gemini.google.com/app',
    ]);
    console.log(`  [9223] Gemini Chrome — launched (PID ${pid})`);
    console.log(`         profile: ${profile9223}`);
  }

  console.log('\n  Waiting 4s for windows to settle...');
  await sleep(4000);

  // Verify both ports
  const [c9222, c9223] = await Promise.all([checkPort(9222), checkPort(9223)]);
  console.log('');
  console.log(`  [9222] ChatGPT       → ${c9222 ? 'UP ✓' : 'DOWN ✗'}`);
  console.log(`  [9223] Gemini        → ${c9223 ? 'UP ✓' : 'DOWN ✗'}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  NEXT STEPS — sign in manually inside each window:');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Window 1 (ChatGPT):');
  console.log('    • Sign in to chatgpt.com');
  console.log('');
  console.log('  Window 2 (Gemini):');
  console.log('    • Sign in to gemini.google.com');
  console.log('    • Leave the tab OPEN');
  console.log('');
  console.log('  When done signing in, start the pipeline:');
  console.log('    node scripts/run_pipeline.cjs');
  console.log('');
  console.log('  Sessions persist — you only sign in ONCE. Future runs of this');
  console.log('  setup script will skip launches if windows are already up.');
  console.log('');
})();
