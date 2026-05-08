// =============================================================================
//  CREATIVE AUTOMATION — END-TO-END PIPELINE ORCHESTRATOR
// =============================================================================
//  ONE SCRIPT, FIVE STAGES, ZERO BABYSITTING.
//
//  Stages (each skipped if its output already exists on disk):
//    1. FETCH    — pull textbook chapter from Notion (Notion API key in .env)
//    2. REFINE   — rewrite chapter via ChatGPT (refine_prompt.txt)
//    3. PROMPTS  — generate 80 image prompts via ChatGPT (80_prompt_formula.txt)
//    4. IMAGES   — generate + save 80 images via Gemini
//    5. UPLOAD   — zip images + upload to chapter's 'Images' subpage in Notion
//
//  PRE-REQS:
//    • ChatGPT signed in on Chrome at port 9222  (start: python chrome_keepalive.py)
//    • Gemini signed in on Chrome at port 9223
//    • .env has NOTION_API_KEY, CHATGPT_EMAIL, CHATGPT_PASSWORD
//    • Notion integration has 'Insert content' capability + access to chapter page
//
//  USAGE:
//    1. Edit the CONFIG block below (paste Notion link, set grade/subject/chapter)
//    2. Run:   node scripts/run_pipeline.cjs
//    3. Walk away. The script will print a SUMMARY when done.
// =============================================================================

'use strict';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Values read from CCA_* environment variables first (set by start.bat), with
// the literals below as fallback when the variable isn't set or is empty.
// To change the targeted chapter, edit the values in start.bat — not here.
function envInt(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}
const CONFIG = {
  NOTION_URL: process.env.CCA_NOTION_URL || 'paste your notion link here',
  GRADE:      envInt('CCA_GRADE', 7),                          // 5–11
  LANG:       process.env.CCA_LANG    || 'uz',                 // 'uz' or 'ru'
  SUBJECT:    process.env.CCA_SUBJECT || 'jahon tarixi',       // fuzzy-matched in Notion
  CHAPTER:    envInt('CCA_CHAPTER', 1),                        // chapter number
};
// ────────────────────────────────────────────────────────────────────────────

const { spawn, spawnSync } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');

const REPO        = path.resolve(__dirname, '..');
const CHATGPT_PORT = 9222;
const GEMINI_PORT  = 9223;

const PYTHON = process.env.PYTHON || 'python';

const ts = () => new Date().toISOString().substring(11, 19);
const log = (stage, msg) => console.log(`${ts()} [${stage}] ${msg}`);

// ── helpers ───────────────────────────────────────────────────────────────
function slugify(text, maxLen = 60) {
  text = text.toLowerCase().trim();
  const repl = {
    'ʼ': '', "'": '', '`': '',
    'ў': 'o', 'қ': 'q', 'ғ': 'g', 'ҳ': 'h', 'ё': 'yo', 'ю': 'yu', 'я': 'ya',
    'ш': 'sh', 'ч': 'ch', 'ц': 'ts', 'ж': 'j', 'й': 'y',
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'з': 'z',
    'и': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p',
    'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'x',
    'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e',
  };
  for (const [k, v] of Object.entries(repl)) text = text.split(k).join(v);
  text = text.replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
  return text.slice(0, maxLen).replace(/-+$/, '') || 'untitled';
}

function checkPort(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(!!JSON.parse(data).Browser); } catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function runChild(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: false,
    });
    child.on('exit', (code, sig) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited code=${code} sig=${sig}`));
    });
    child.on('error', reject);
  });
}

// Same as runChild but resolves with the exit code instead of rejecting on
// non-zero. Caller is responsible for inspecting the code (e.g. ChatGPT rate-
// limit signal = 50, see refine_chapter.py / generate_prompts.py).
function runChildExitCode(cmd, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: false,
    });
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ── ChatGPT account rotation (run_pipeline-level) ──────────────────────────
// Triggered when refine_chapter.py / generate_prompts.py exit with code 50
// (the ChatGPTRateLimitError sentinel from tools/browser/chatgpt.py).
//
// Mechanics mirror run_autonomous.cjs's Gemini rotation, but the trigger is
// stage-level rather than alert-driven (no per-tab signal to inspect — REFINE
// and PROMPTS are single-conversation calls that simply time out when the
// account is rate-limited):
//   1. Advance accounts.json pointer:  python -m tools.accounts rotate chatgpt
//   2. Force sign-out + sign-in on :9222: python auto_login.py --skip-gemini --force-resignin
//   3. Caller retries the failed stage from the top.
//
// Returns 'ok' | 'exhausted' | 'login_failed'.
const MAX_CHATGPT_ROTATIONS = envInt('CCA_MAX_CHATGPT_ROTATIONS', 5);

function runShell(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf-8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function rotateChatgpt() {
  log('CHATGPT-ROT', `attempting rotation (rate-limit detected on current account)`);
  const rot = runShell(PYTHON, ['-m', 'tools.accounts', 'rotate', 'chatgpt']);
  if (rot.code === 2) {
    log('CHATGPT-ROT', `EXHAUSTED — no more chatgpt accounts in accounts.json`);
    log('CHATGPT-ROT', `add another entry to chatgpt[] in accounts.json and re-run`);
    return 'exhausted';
  }
  if (rot.code !== 0) {
    log('CHATGPT-ROT', `accounts.py rotate failed: ${rot.stderr.trim()}`);
    return 'login_failed';
  }
  let newAccount = {};
  try { newAccount = JSON.parse(rot.stdout); } catch (_) {}
  log('CHATGPT-ROT', `rotated to chatgpt account: [${newAccount.label || '?'} #${newAccount.index ?? '?'}] ${newAccount.email || '?'}`);

  // Propagate new creds to process.env so children spawned by runChildExitCode
  // (which inherits process.env) see the rotated account. Without this, the
  // python script's ensure_logged_in() fallback to login_via_google would use
  // the OLD .env-derived creds if the post-rotation browser ever falls back
  // to the login surface.
  if (newAccount.email && newAccount.password) {
    process.env.CHATGPT_EMAIL    = newAccount.email;
    process.env.CHATGPT_PASSWORD = newAccount.password;
  }

  // Force sign-out + sign-in on the ChatGPT Chrome (:9222 only).
  const login = runShell(PYTHON, ['auto_login.py', '--skip-gemini', '--force-resignin'], { stdio: 'inherit' });
  if (login.code !== 0) {
    log('CHATGPT-ROT', `auto_login failed for new chatgpt account (rc=${login.code})`);
    return 'login_failed';
  }
  log('CHATGPT-ROT', `new chatgpt account signed in successfully`);
  return 'ok';
}

// Run a Python stage that uses ChatGPT (refine_chapter.py / generate_prompts.py),
// rotating to the next chatgpt account in accounts.json on exit code 50.
// `stageName` is just for logging.
async function runChatgptStage(stageName, pyScript, pyArgs, env = {}) {
  for (let attempt = 0; attempt <= MAX_CHATGPT_ROTATIONS; attempt++) {
    const rc = await runChildExitCode(PYTHON, [pyScript, ...pyArgs], env);
    if (rc === 0) return;
    if (rc === 50) {
      log(stageName, `ChatGPT rate-limit (exit 50) on attempt ${attempt + 1}/${MAX_CHATGPT_ROTATIONS + 1}`);
      if (attempt >= MAX_CHATGPT_ROTATIONS) {
        throw new Error(`${stageName} hit ChatGPT rate-limit after ${MAX_CHATGPT_ROTATIONS} rotations — all accounts exhausted or still throttled`);
      }
      const result = await rotateChatgpt();
      if (result !== 'ok') {
        throw new Error(`${stageName} cannot rotate chatgpt account (${result}) — halting`);
      }
      log(stageName, `retrying after rotation`);
      continue;
    }
    throw new Error(`${pyScript} exited code=${rc} (non-rate-limit failure)`);
  }
  throw new Error(`${stageName} exhausted retries`);
}

function findChapterFile(stage, ext = '.md') {
  // Find ch{NN}-*.{ext} (excluding .meta.json / .raw.md) in the stage folder
  const subjectSlug = slugify(CONFIG.SUBJECT);
  const folder = path.join(REPO, stage, `g${CONFIG.GRADE}-${CONFIG.LANG}`, subjectSlug);
  if (!fs.existsSync(folder)) return null;
  const padded = String(CONFIG.CHAPTER).padStart(2, '0');
  const matches = fs.readdirSync(folder)
    .filter(f => f.startsWith(`ch${padded}-`) && f.endsWith(ext))
    .filter(f => !f.endsWith('.meta.json') && !f.endsWith('.raw.md'));
  return matches.length ? path.join(folder, matches[0]) : null;
}

function countFiles(dir, suffix, minBytes = 0) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f =>
    f.toLowerCase().endsWith(suffix) &&
    fs.statSync(path.join(dir, f)).size > minBytes
  ).length;
}

// ── stage runners ────────────────────────────────────────────────────────
async function stageFetch() {
  if (findChapterFile('chapters', '.md')) {
    log('FETCH', `skip — chapter already fetched`);
    return;
  }
  log('FETCH', `Notion → grade=${CONFIG.GRADE} subject="${CONFIG.SUBJECT}" ch=${CONFIG.CHAPTER}`);
  await runChild(PYTHON, [
    'fetch_chapter.py',
    '--grade',   String(CONFIG.GRADE),
    '--lang',    CONFIG.LANG,
    '--subject', CONFIG.SUBJECT,
    '--chapter', String(CONFIG.CHAPTER),
  ]);
  if (!findChapterFile('chapters', '.md')) throw new Error('fetch produced no output');
}

async function stageRefine() {
  if (findChapterFile('refined', '.md')) {
    log('REFINE', `skip — refined chapter already exists`);
    return;
  }
  log('REFINE', `ChatGPT — refining chapter (this can take 3-6 min)`);
  await runChatgptStage('REFINE', 'refine_chapter.py', [
    '--grade',   String(CONFIG.GRADE),
    '--lang',    CONFIG.LANG,
    '--subject', CONFIG.SUBJECT,
    '--chapter', String(CONFIG.CHAPTER),
  ]);
  if (!findChapterFile('refined', '.md')) throw new Error('refine produced no output');
}

async function stagePrompts() {
  const json = findChapterFile('prompts', '.json');
  if (json) {
    try {
      const arr = JSON.parse(fs.readFileSync(json, 'utf-8'));
      if (Array.isArray(arr) && arr.length === 80) {
        log('PROMPTS', `skip — 80 prompts already generated`);
        return json;
      }
      log('PROMPTS', `existing prompts.json has ${arr.length} entries — regenerating`);
    } catch (_) {}
  }
  log('PROMPTS', `ChatGPT — generating 80 prompts in 4 batches (~10-20 min)`);
  await runChatgptStage('PROMPTS', 'generate_prompts.py', [
    '--grade',   String(CONFIG.GRADE),
    '--lang',    CONFIG.LANG,
    '--subject', CONFIG.SUBJECT,
    '--chapter', String(CONFIG.CHAPTER),
  ]);
  const out = findChapterFile('prompts', '.json');
  if (!out) throw new Error('prompts produced no .json');
  return out;
}

async function stageImages(promptsJson) {
  const arr = JSON.parse(fs.readFileSync(promptsJson, 'utf-8'));
  const total = arr.length;
  const subjectSlug = slugify(CONFIG.SUBJECT);
  const base = path.basename(promptsJson, '.json');
  const imagesDir = path.join(REPO, 'images', `g${CONFIG.GRADE}-${CONFIG.LANG}`, subjectSlug, base);
  const have = countFiles(imagesDir, '.png', 10 * 1024);
  if (have >= total) {
    log('IMAGES', `skip — ${have}/${total} already saved`);
    return;
  }
  log('IMAGES', `Gemini — generating ${total - have} of ${total} images (autonomous orchestrator)`);
  // Wrap run_autonomous.cjs in cmd /c instead of spawning node directly.
  // Why: this stage spawns run_autonomous which spawns submit_prompts +
  // save_images (3 Node processes deep). Direct node-to-node chain caused:
  //   (a) STATUS_BREAKPOINT (-2147483645) crash in run_pipeline on Windows
  //       when the chain inherits job-object handles, OR
  //   (b) silent exit code 1 from run_autonomous when we tried to fix (a)
  //       with detached:true + windowsHide:true — that combo breaks stdio
  //       inheritance when launch_all.bat is double-clicked.
  // Wrapping in cmd /c puts cmd.exe between run_pipeline (Node) and
  // run_autonomous (Node), so the depth-4 Node-to-Node assertion never
  // triggers, AND stdio:'inherit' works normally because there's no
  // detached/hidden-console dance.
  await new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd  = isWin ? 'cmd' : 'node';
    const args = isWin
      ? ['/c', 'node', 'scripts\\run_autonomous.cjs', promptsJson]
      : ['scripts/run_autonomous.cjs', promptsJson];
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: 'inherit',
      env: process.env,
      shell: false,
    });
    child.on('exit', (code, sig) => {
      if (code === 0) resolve();
      else reject(new Error(`run_autonomous.cjs exited code=${code} sig=${sig}`));
    });
    child.on('error', reject);
  });
  const after = countFiles(imagesDir, '.png', 10 * 1024);
  if (after < total) throw new Error(`image stage finished with only ${after}/${total}`);
}

async function stageUpload() {
  // upload_images.py owns its own skip / idempotency logic (marker file +
  // sha256). Set CCA_SKIP_UPLOAD=1 to bypass entirely.
  log('UPLOAD', `Notion — zipping images and uploading to chapter's 'Images' subpage`);
  await runChild(PYTHON, [
    'upload_images.py',
    '--grade',   String(CONFIG.GRADE),
    '--lang',    CONFIG.LANG,
    '--subject', CONFIG.SUBJECT,
    '--chapter', String(CONFIG.CHAPTER),
  ]);
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CREATIVE AUTOMATION — PIPELINE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Notion URL:  ${CONFIG.NOTION_URL}`);
  console.log(`  Target:      G${CONFIG.GRADE} / ${CONFIG.LANG} / ${CONFIG.SUBJECT} / ch${CONFIG.CHAPTER}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Pre-flight: both Chrome instances reachable?
  log('PRE', 'checking Chrome instances...');
  const [chatgpt, gemini] = await Promise.all([checkPort(CHATGPT_PORT), checkPort(GEMINI_PORT)]);
  log('PRE', `ChatGPT Chrome :${CHATGPT_PORT} → ${chatgpt ? 'UP' : 'DOWN'}`);
  log('PRE', `Gemini Chrome :${GEMINI_PORT} → ${gemini ? 'UP' : 'DOWN'}`);
  if (!chatgpt) { console.error('\n  ✗ ChatGPT Chrome not reachable. Start: python chrome_keepalive.py\n'); process.exit(2); }
  if (!gemini)  { console.error('\n  ✗ Gemini Chrome not reachable. Launch real chrome.exe with --remote-debugging-port=9223 and sign in to gemini.google.com\n'); process.exit(2); }

  // .env sanity
  const dotenvPath = path.join(REPO, '.env');
  if (!fs.existsSync(dotenvPath)) { console.error('\n  ✗ .env missing\n'); process.exit(2); }
  const envText = fs.readFileSync(dotenvPath, 'utf-8');
  if (!/NOTION_API_KEY=/.test(envText))      { console.error('  ✗ .env missing NOTION_API_KEY');      process.exit(2); }
  if (!/CHATGPT_EMAIL=/.test(envText))       { console.error('  ✗ .env missing CHATGPT_EMAIL');       process.exit(2); }
  if (!/CHATGPT_PASSWORD=/.test(envText))    { console.error('  ✗ .env missing CHATGPT_PASSWORD');    process.exit(2); }
  log('PRE', '.env OK');
  console.log('');

  const t0 = Date.now();
  const stages = [
    { name: '1/5 FETCH',   fn: stageFetch   },
    { name: '2/5 REFINE',  fn: stageRefine  },
    { name: '3/5 PROMPTS', fn: stagePrompts },
    { name: '4/5 IMAGES',  fn: stageImages  },
    { name: '5/5 UPLOAD',  fn: stageUpload  },
  ];

  let promptsJson = null;
  for (const s of stages) {
    const banner = `─── STAGE ${s.name} ───────────────────────────────────────`;
    console.log(`\n${banner}`);
    const sT0 = Date.now();
    try {
      const result = await s.fn(promptsJson);
      if (s.name.includes('PROMPTS') && result) promptsJson = result;
      // Re-resolve promptsJson after PROMPTS stage if we skipped it
      if (s.name.includes('PROMPTS') && !promptsJson) promptsJson = findChapterFile('prompts', '.json');
      const dt = ((Date.now() - sT0) / 1000).toFixed(1);
      log(s.name, `✓ done in ${dt}s`);
    } catch (e) {
      console.error(`\n  ✗ STAGE FAILED: ${s.name}`);
      console.error(`    ${e.message}`);
      console.error(`\n  Pipeline halted. Fix the issue and re-run — completed stages will be skipped.\n`);
      process.exit(1);
    }
  }

  const dt = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ✓ PIPELINE DONE  —  ${dt} min`);
  console.log('═══════════════════════════════════════════════════════════════');
  const subjectSlug = slugify(CONFIG.SUBJECT);
  const base = path.basename(promptsJson || '', '.json');
  console.log(`  Chapter:  chapters/g${CONFIG.GRADE}-${CONFIG.LANG}/${subjectSlug}/`);
  console.log(`  Refined:  refined/g${CONFIG.GRADE}-${CONFIG.LANG}/${subjectSlug}/`);
  console.log(`  Prompts:  prompts/g${CONFIG.GRADE}-${CONFIG.LANG}/${subjectSlug}/${base}.json`);
  console.log(`  Images:   images/g${CONFIG.GRADE}-${CONFIG.LANG}/${subjectSlug}/${base}/  (80 PNGs)`);
  console.log(`  Zip:      zips/g${CONFIG.GRADE}-${CONFIG.LANG}/${subjectSlug}/${base}.zip  (uploaded to Notion)`);
  console.log('');
})();
