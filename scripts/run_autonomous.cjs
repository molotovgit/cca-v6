// Autonomous orchestrator: owns submit_prompts + save_images, monitors them,
// auto-restarts the saver if it stalls, respawns the submitter if it dies
// with work remaining. Exits when all expected images are saved.
//
// Run-and-forget — doesn't need any user intervention until done.
//
// Recovery layers (in order of escalation):
//   1. Saver-restart   — saver alive but no progress for STALL_TIMEOUT_MS.
//      Cheap kill+respawn. Cooldown = STALL_TIMEOUT_MS so successive restarts
//      don't fire faster than the underlying watchdog can detect new stalls.
//   2. Zombie-rescue   — submit has exited and stall exceeds RESCUE_TIMEOUT_MS
//      with images still missing on disk. The Gemini tabs in tab_map.json are
//      polling forever for an image that will never render (silent content
//      filter, blank canvas, error banner). Spawns rescue_zombie_tabs.cjs to
//      close those tabs in Chrome + clear them from tab_map, then re-spawns
//      submit which re-issues only the missing indices via its disk filter.
//   3. Give-up         — after MAX_RESCUE_ATTEMPTS failed rescue cycles, exit
//      with code 3 so run_pipeline.cjs halts before ANIMATE.
//
// Exit codes: 0 = all images saved, 3 = gave up after rescues, 1/2 = startup error.
//
// Usage:
//   node scripts/run_autonomous.cjs <prompts.json>
//   node scripts/run_autonomous.cjs <prompts.json> --max-open 10
//
// Tunables (env, all optional — defaults in code):
//   CCA_POLL_MS, CCA_STALL_TIMEOUT_MS, CCA_SAVER_RESTART_MS,
//   CCA_RESCUE_TIMEOUT_MS, CCA_RESCUE_COOLDOWN_MS, CCA_MAX_RESCUE_ATTEMPTS

'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const REPO       = path.resolve(__dirname, '..');
const STATE_DIR  = path.join(REPO, '.cca');
const SAVED_FILE = path.join(STATE_DIR, 'saved_indices.json');
const TAB_MAP_FILE = path.join(STATE_DIR, 'tab_map.json');
const BLOCKER_ALERTS_FILE = path.join(STATE_DIR, 'blocker_alerts.json');
const PYTHON      = process.env.PYTHON || 'python';
const GEMINI_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);

const PROMPTS_PATH = process.argv[2];
if (!PROMPTS_PATH) {
  console.error('Usage: node run_autonomous.cjs <prompts.json> [--max-open N]');
  process.exit(1);
}
if (!fs.existsSync(PROMPTS_PATH)) {
  console.error(`prompts file not found: ${PROMPTS_PATH}`);
  process.exit(1);
}
const TOTAL = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf-8')).length;

const maxOpenIdx = process.argv.indexOf('--max-open');
const maxOpen = (maxOpenIdx > 0 && process.argv[maxOpenIdx + 1]) ? process.argv[maxOpenIdx + 1] : '10';

// All thresholds env-overridable for testing (CCA_*).
const envInt = (k, def) => {
  const v = process.env[k];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
const POLL_MS          = envInt('CCA_POLL_MS',          15_000);   // status interval
const STALL_TIMEOUT_MS = envInt('CCA_STALL_TIMEOUT_MS', 150_000);  // 2.5 min → restart save
const SAVER_RESTART_MS = envInt('CCA_SAVER_RESTART_MS', 3_000);
// Rescue path: when submit has exited and the saver is stalled on tabs that
// will never produce an image (Gemini failed silently — content filter, error
// banner, blank canvas), close those tabs and re-submit only the missing
// indices. Threshold is intentionally larger than STALL_TIMEOUT_MS so the
// cheap saver-restart gets a chance first.
const RESCUE_TIMEOUT_MS   = envInt('CCA_RESCUE_TIMEOUT_MS',   180_000);  // 3 min stall → rescue
const RESCUE_COOLDOWN_MS  = envInt('CCA_RESCUE_COOLDOWN_MS',   60_000);  // gap between rescues
const MAX_RESCUE_ATTEMPTS = envInt('CCA_MAX_RESCUE_ATTEMPTS',        5); // bail after N
const SKIP_INITIAL_SUBMIT = process.env.CCA_SKIP_INITIAL_SUBMIT === '1'; // test-only

// Account-rotation thresholds (v6 phase 2). When save_images.cjs detects 1095 /
// quota and writes alerts to .cca/blocker_alerts.json, the orchestrator decides
// whether to rotate the active Gemini account.
const ROTATION_1095_THRESHOLD = envInt('CCA_ROTATION_1095_THRESHOLD', 3);    // ≥N distinct-tab 1095 alerts within window
const ROTATION_WINDOW_MS      = envInt('CCA_ROTATION_WINDOW_MS', 120_000);   // alerts within last 2 min
const ROTATION_COOLDOWN_MS    = envInt('CCA_ROTATION_COOLDOWN_MS', 60_000);  // min gap between rotations
const MAX_ROTATIONS           = envInt('CCA_MAX_ROTATIONS', 5);              // bail after N — likely a real problem

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Derive the chapter's images folder from the prompts.json path.
// prompts/g7-uz/jahon-tarixi/ch10-X.json  →  images/g7-uz/jahon-tarixi/ch10-X/
function chapterImagesDir(promptsPath) {
  const abs = path.resolve(promptsPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`prompts path missing 'prompts' segment: ${abs}`);
  const out = parts.slice();
  out[idx] = 'images';
  out[out.length - 1] = out[out.length - 1].replace(/\.json$/i, '');
  return out.join(path.sep);
}

function diskSavedIndices(imagesDir) {
  if (!fs.existsSync(imagesDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(imagesDir)) {
    if (!f.toLowerCase().endsWith('.png')) continue;
    if (fs.statSync(path.join(imagesDir, f)).size < 10 * 1024) continue;
    const m = f.match(/^(\d+)-/);
    if (m) out.push(parseInt(m[1], 10));
  }
  return out.sort((a, b) => a - b);
}

let submitProc = null;
let saveProc   = null;
let saveSpawnPending = false;  // true between scheduling spawn and child actually running
let lastSaveCount = 0;
let lastProgressTime = Date.now();    // last time saved.length increased; NEVER reset by restarts
let lastSaverRestartTime = 0;          // for cooldown between cheap saver restarts
let saverRestarts = 0;
let rescueAttempts = 0;
let lastRescueTime = 0;
let rescueInFlight = false;
let rotationCount = 0;
let lastRotationTime = 0;
let rotationInFlight = false;

function ts() {
  return new Date().toISOString().substring(11, 19);
}

function logSubmit(buf) {
  process.stdout.write(buf.toString().split('\n').filter(l => l).map(l => `${ts()} [SUB] ${l}\n`).join(''));
}
function logSave(buf) {
  process.stdout.write(buf.toString().split('\n').filter(l => l).map(l => `${ts()} [SAV] ${l}\n`).join(''));
}

function spawnSubmit() {
  console.log(`${ts()} [ORCH] spawning submit_prompts (max-open=${maxOpen})`);
  const p = spawn('node', ['scripts/submit_prompts.cjs', PROMPTS_PATH, '0', String(TOTAL), maxOpen], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', logSubmit);
  p.stderr.on('data', d => process.stderr.write(`${ts()} [SUB-ERR] ${d}`));
  p.on('exit', (code, sig) => {
    console.log(`${ts()} [ORCH] submit exited code=${code} sig=${sig}`);
    submitProc = null;
  });
  submitProc = p;
}

function spawnSave() {
  saveSpawnPending = false;
  saverRestarts++;
  console.log(`${ts()} [ORCH] spawning save_images (restart #${saverRestarts})`);
  const p = spawn('node', ['scripts/save_images.cjs', PROMPTS_PATH, '--watch'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', logSave);
  p.stderr.on('data', d => process.stderr.write(`${ts()} [SAV-ERR] ${d}`));
  p.on('exit', (code, sig) => {
    console.log(`${ts()} [ORCH] save exited code=${code} sig=${sig}`);
    saveProc = null;
  });
  saveProc = p;
}

function scheduleSaveSpawn(reason) {
  if (saveSpawnPending) {
    return;  // already scheduled; don't double-schedule
  }
  saveSpawnPending = true;
  console.log(`${ts()} [ORCH] scheduling save respawn in ${SAVER_RESTART_MS}ms (${reason})`);
  setTimeout(spawnSave, SAVER_RESTART_MS);
}

function killSave() {
  if (saveProc) {
    try { saveProc.kill(); } catch (_) {}
    saveProc = null;
  }
}

function killAll() {
  if (submitProc) { try { submitProc.kill(); } catch (_) {} submitProc = null; }
  killSave();
}

// Run the rescue helper. Resolves with the parsed JSON result (or null on
// any failure). Caller is expected to act on `result.missing` to decide
// whether to re-spawn submit.
function runRescue() {
  return new Promise(resolve => {
    console.log(`${ts()} [ORCH] launching rescue helper (attempt ${rescueAttempts}/${MAX_RESCUE_ATTEMPTS})`);
    const p = spawn('node', ['scripts/rescue_zombie_tabs.cjs', PROMPTS_PATH], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => process.stderr.write(`${ts()} [RESCUE-ERR] ${d}`));
    p.on('exit', code => {
      if (code !== 0) { console.log(`${ts()} [ORCH] rescue exited code=${code}`); resolve(null); return; }
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop();
        const r = JSON.parse(last);
        console.log(`${ts()} [ORCH] rescue → cleared=${r.cleared} closed_in_chrome=${r.closed_in_chrome} missing=[${r.missing.join(',')}] disk=${r.saved_on_disk}/${r.total}`);
        resolve(r);
      } catch (e) {
        console.log(`${ts()} [ORCH] rescue parse error: ${e.message}; raw=${stdout.slice(0, 200)}`);
        resolve(null);
      }
    });
    p.on('error', e => { console.log(`${ts()} [ORCH] rescue spawn error: ${e.message}`); resolve(null); });
  });
}

// Trigger the full rescue cycle: kill saver, run rescue helper, re-spawn
// submit (which will only pick up missing indices via its disk+state filter),
// then re-spawn saver with a fresh state.
async function triggerRescue() {
  if (rescueInFlight) return;
  rescueInFlight = true;
  try {
    rescueAttempts++;
    lastRescueTime = Date.now();
    console.log(`${ts()} [ORCH] === RESCUE TRIGGERED ===`);

    // Kill children before mutating state, so the saver doesn't write back
    // a stale tab_map and the submitter doesn't open more tabs mid-rescue.
    if (submitProc) { try { submitProc.kill(); } catch (_) {} submitProc = null; }
    killSave();
    await new Promise(r => setTimeout(r, 1500));

    const result = await runRescue();
    if (!result) {
      console.log(`${ts()} [ORCH] rescue failed — will retry on next stall`);
      lastProgressTime = Date.now();  // reset stall clock so we don't hammer
      // Respawn saver so the watchdog stays alive
      scheduleSaveSpawn('post-rescue-failed');
      return;
    }

    if (result.missing.length === 0) {
      console.log(`${ts()} [ORCH] rescue: nothing missing — done`);
      // Main loop will detect saved >= TOTAL on next tick and exit cleanly
      scheduleSaveSpawn('post-rescue-complete-check');
      return;
    }

    // Reset stall clock and counters; the missing-index re-submit is fresh work
    lastSaveCount = result.saved_on_disk;
    lastProgressTime = Date.now();

    // Re-spawn submit FIRST (it'll skip already-saved indices via its
    // savedIdxSet check), then schedule the saver. Use scheduleSaveSpawn
    // (not raw setTimeout) so the saveSpawnPending flag prevents the main
    // loop's dead-respawn from racing us.
    spawnSubmit();
    scheduleSaveSpawn('post-rescue');
    console.log(`${ts()} [ORCH] rescue: re-spawned submit+save for ${result.missing.length} missing`);
  } finally {
    rescueInFlight = false;
  }
}

// ─── Account rotation (v6 phase 2) ──────────────────────────────────────────
// Rotation is triggered when save_images.cjs has recorded blocker alerts
// (1095 / quota) sufficient to indicate the failure is account-level rather
// than prompt-level. The current Gemini account is rotated to the next entry
// in accounts.json; if exhausted, the orchestrator exits with code 4.
function readBlockerAlerts() { return readJsonOr(BLOCKER_ALERTS_FILE, []); }

function shouldRotate() {
  const now = Date.now();
  const all = readBlockerAlerts();
  const recent = all.filter(a => (now - a.t) < ROTATION_WINDOW_MS);
  // Quota → rotate immediately on any single alert (no recovery without account switch)
  if (recent.some(a => a.type === 'quota')) return 'quota';
  // 1095 → rotate after N distinct-tab alerts in window
  const unique1095 = new Set(recent.filter(a => a.type === '1095').map(a => a.idx));
  if (unique1095.size >= ROTATION_1095_THRESHOLD) return '1095';
  return null;
}

// Synchronous shell-out — small commands, blocking is fine here since the
// orchestrator's main loop is paused via rotationInFlight anyway.
function runShell(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf-8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function triggerRotation(reason) {
  if (rotationInFlight) return;
  rotationInFlight = true;
  try {
    rotationCount++;
    lastRotationTime = Date.now();
    console.log(`${ts()} [ORCH] === ROTATION TRIGGERED ===  reason=${reason}  attempt #${rotationCount}/${MAX_ROTATIONS}`);

    if (rotationCount > MAX_ROTATIONS) {
      console.error(`${ts()} [ORCH] === GIVING UP ===  exceeded MAX_ROTATIONS=${MAX_ROTATIONS}`);
      killAll();
      process.exit(4);
    }

    // 1. Kill children
    if (submitProc) { try { submitProc.kill(); } catch (_) {} submitProc = null; }
    killSave();
    await new Promise(r => setTimeout(r, 1500));

    // 2. Advance the rotator pointer for Gemini
    const rot = runShell(PYTHON, ['-m', 'tools.accounts', 'rotate', 'gemini']);
    if (rot.code === 2) {
      console.error(`${ts()} [ORCH] === GIVING UP ===  no more Gemini accounts in accounts.json (current rotation exhausted)`);
      console.error(`${ts()} [ORCH]   add another entry to the gemini[] array and re-run.`);
      killAll();
      process.exit(4);
    }
    if (rot.code !== 0) {
      console.error(`${ts()} [ORCH] rotation aborted — accounts.py rotate failed: ${rot.stderr.trim()}`);
      killAll();
      process.exit(5);
    }
    let newAccount = {};
    try { newAccount = JSON.parse(rot.stdout); } catch (_) {}
    console.log(`${ts()} [ORCH] rotated to gemini account: [${newAccount.label || '?'} #${newAccount.index ?? '?'}] ${newAccount.email || '?'}`);

    // 3. Sign out + sign in to the new account on the Gemini Chrome
    const login = runShell(PYTHON, ['auto_login.py', '--skip-chatgpt', '--force-resignin'], { stdio: 'inherit' });
    if (login.code !== 0) {
      console.error(`${ts()} [ORCH] auto_login failed for new account (rc=${login.code}). Halting.`);
      killAll();
      process.exit(login.code === 1 ? 6 : 5);  // 6 = human verification needed; 5 = generic
    }
    console.log(`${ts()} [ORCH] new account signed in successfully`);

    // 4. Reset transient state — keep saved_indices (already-done images skip)
    writeJson(TAB_MAP_FILE, {});
    writeJson(BLOCKER_ALERTS_FILE, []);
    lastProgressTime = Date.now();
    lastSaveCount = (readJsonOr(SAVED_FILE, []) || []).length;

    // 5. Re-spawn children
    spawnSubmit();
    scheduleSaveSpawn('post-rotation');
    console.log(`${ts()} [ORCH] rotation complete — resumed at ${lastSaveCount}/${TOTAL}`);
  } finally {
    rotationInFlight = false;
  }
}

process.on('SIGINT',  () => { console.log('\n[orch] SIGINT received, shutting down'); killAll(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[orch] SIGTERM received, shutting down'); killAll(); process.exit(0); });

(async () => {
  console.log(`${ts()} [ORCH] starting — target ${TOTAL} images`);
  console.log(`${ts()} [ORCH] prompts: ${PROMPTS_PATH}`);
  console.log(`${ts()} [ORCH] poll=${POLL_MS}ms, stall_timeout=${STALL_TIMEOUT_MS}ms, max_open=${maxOpen}`);
  console.log('');

  // Source of truth = ACTUAL files on disk for THIS chapter, not the global
  // .cca/saved_indices.json (which leaks between chapters and would falsely
  // mark a fresh chapter as already-complete).
  const imagesDir = chapterImagesDir(PROMPTS_PATH);
  const onDisk = diskSavedIndices(imagesDir);
  // ALWAYS sync state files to disk + clear tab_map. Tab_map is per-run state
  // (Chrome tab IDs from a previous run point at dead tabs); no cross-run value.
  // Submit_prompts will repopulate tab_map fresh. saved_indices is mirrored to disk.
  console.log(`${ts()} [ORCH] state reset: syncing saved_indices to ${onDisk.length} on-disk entries, clearing tab_map`);
  writeJson(SAVED_FILE, onDisk);
  writeJson(TAB_MAP_FILE, {});
  lastSaveCount = onDisk.length;
  console.log(`${ts()} [ORCH] images dir: ${imagesDir}`);
  console.log(`${ts()} [ORCH] starting with ${lastSaveCount}/${TOTAL} already on disk`);
  if (lastSaveCount >= TOTAL) {
    console.log(`${ts()} [ORCH] already complete — nothing to do`);
    process.exit(0);
  }

  if (SKIP_INITIAL_SUBMIT) {
    console.log(`${ts()} [ORCH] CCA_SKIP_INITIAL_SUBMIT=1 — not spawning submit (test mode: simulating submit-already-dead)`);
  } else {
    spawnSubmit();
  }
  spawnSave();

  setInterval(async () => {
    if (rescueInFlight) return;  // skip ticks while rescue is mutating state

    const saved = readJsonOr(SAVED_FILE, []);
    const tabs  = readJsonOr(TAB_MAP_FILE, {});
    const pending = Object.entries(tabs).filter(([_tid, m]) => !saved.includes(m.idx)).length;

    if (saved.length > lastSaveCount) {
      lastSaveCount = saved.length;
      lastProgressTime = Date.now();
    }
    const stalledMs = Date.now() - lastProgressTime;

    console.log(
      `${ts()} [ORCH] saved=${saved.length}/${TOTAL}` +
      `  pending=${pending}` +
      `  submit=${submitProc ? 'alive' : 'DEAD'}` +
      `  save=${saveProc ? 'alive' : 'DEAD'}` +
      `  stall=${Math.floor(stalledMs / 1000)}s`
    );

    // Done condition (check first so a complete run exits before any rescue).
    if (saved.length >= TOTAL) {
      const imagesDir = chapterImagesDir(PROMPTS_PATH);
      const onDisk = diskSavedIndices(imagesDir).length;
      if (onDisk >= TOTAL) {
        console.log(`\n${ts()} [ORCH] === DONE ===  ${saved.length}/${TOTAL} saved (disk-verified ${onDisk}/${TOTAL})`);
        console.log(`${ts()} [ORCH] images at: ${imagesDir}`);
        console.log(`${ts()} [ORCH] saver restarted ${Math.max(0, saverRestarts - 1)} times, rescued ${rescueAttempts} times`);
        killAll();
        process.exit(0);
      }
      // State file says complete but disk disagrees — fall through to rescue path
      console.log(`${ts()} [ORCH] state says complete but disk has only ${onDisk}/${TOTAL} — continuing`);
    }

    // ROTATION PATH (v6): if save_images recorded enough 1095/quota alerts to
    // indicate an account-level failure, rotate to the next Gemini account
    // BEFORE attempting rescue (which won't help on a flagged/exhausted account).
    const rotationCooldownOk = (Date.now() - lastRotationTime) > ROTATION_COOLDOWN_MS;
    const rotateReason = shouldRotate();
    if (rotateReason && rotationCooldownOk && !rotationInFlight) {
      console.log(`${ts()} [ORCH] blocker alerts detected (${rotateReason}) — rotating account`);
      triggerRotation(rotateReason);
      return;
    }

    // RESCUE PATH: submit has exited, saver is stalled, and there are missing
    // images on disk. Either the zombie tabs need clearing or the missing
    // indices were never submitted in the first place.
    const cooldownOk = (Date.now() - lastRescueTime) > RESCUE_COOLDOWN_MS;
    const stallNeedsRescue = !submitProc && stalledMs > RESCUE_TIMEOUT_MS && saved.length < TOTAL && cooldownOk;
    if (stallNeedsRescue) {
      if (rescueAttempts >= MAX_RESCUE_ATTEMPTS) {
        const imagesDir = chapterImagesDir(PROMPTS_PATH);
        const onDisk = diskSavedIndices(imagesDir).length;
        console.error(`\n${ts()} [ORCH] === GIVING UP ===  ${onDisk}/${TOTAL} on disk after ${rescueAttempts} rescues`);
        console.error(`${ts()} [ORCH] manual intervention needed — check Gemini for blocked prompts`);
        killAll();
        process.exit(3);
      }
      // Async — but we set rescueInFlight so subsequent ticks bail
      triggerRescue();
      return;
    }

    // Restart save if stalled while there's pending work, OR respawn if it died.
    // saveSpawnPending guards against multiple ticks scheduling concurrent spawns
    // before the previous setTimeout has fired. We DO NOT reset lastProgressTime
    // here — that would mask the rescue trigger (which needs to see real stall
    // duration, not "duration since last cosmetic restart").
    const restartCooldownOk = (Date.now() - lastSaverRestartTime) > STALL_TIMEOUT_MS;
    if (saveProc && pending > 0 && stalledMs > STALL_TIMEOUT_MS && restartCooldownOk) {
      console.log(`${ts()} [ORCH] saver STALLED ${Math.floor(stalledMs / 1000)}s with ${pending} pending — restarting`);
      killSave();
      lastSaverRestartTime = Date.now();
      scheduleSaveSpawn('stall-restart');
    } else if (!saveProc && saved.length < TOTAL) {
      scheduleSaveSpawn('dead-respawn');
    }

    // Respawn submit if it died but tabs+saved < total (i.e. submitter
    // crashed mid-loop with un-attempted prompts). The rescue path above
    // handles the case where saved+pending == total but Gemini went silent.
    if (!submitProc && (saved.length + pending) < TOTAL) {
      console.log(`${ts()} [ORCH] submit dead with work remaining — respawning`);
      setTimeout(spawnSubmit, SAVER_RESTART_MS);
    }
  }, POLL_MS);
})();
