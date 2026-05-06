// =============================================================================
//  CREATIVE AUTOMATION — BATCH ORCHESTRATOR (v5)
// =============================================================================
//  Reads lessons.txt at the repo root, then runs the 5-stage per-chapter
//  pipeline once for each lesson, in order. Each chapter is processed
//  end-to-end (Notion fetch → ChatGPT refine → ChatGPT prompts → Gemini
//  images → Notion zip upload) before moving to the next.
//
//  Per-chapter idempotency is inherited from run_pipeline.cjs: stages skip
//  if their output is already on disk. So re-running this script after a
//  failure picks up exactly where it left off.
//
//  Failure semantics:
//    - lesson exits 0   → OK, continue
//    - lesson exits 1   → stage failure (per-chapter), log + continue
//    - lesson exits 2   → pre-flight failure (.env, Chrome) — abort batch
//    - lesson exits 130 or anything else → treat as fatal/manual stop, abort
//
//  Dry-run: CCA_DRY_RUN=1 prints the parsed lesson list and exits 0
//  without spawning anything. Use to verify lessons.txt parses correctly.
//
//  Usage:
//      node scripts/run_batch.cjs
//      CCA_DRY_RUN=1 node scripts/run_batch.cjs
// =============================================================================

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const REPO         = path.resolve(__dirname, '..');
const LESSONS_PATH = path.join(REPO, 'lessons.txt');
const PIPELINE     = path.join(REPO, 'scripts', 'run_pipeline.cjs');

const VALID_LANGS = new Set(['uz', 'ru']);

const ts  = () => new Date().toISOString().substring(11, 19);
const log = (msg) => console.log(`${ts()} [BATCH] ${msg}`);

// ── parser ─────────────────────────────────────────────────────────────────
function parseLessons(filePath) {
  if (!fs.existsSync(filePath)) {
    const err = new Error(`lessons.txt not found at ${filePath}`);
    err.helpful = true;
    throw err;
  }
  const text  = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/);

  const lessons = [];
  let lastFull  = null;       // {grade, lang, subject} from most recent full row
  let warnings  = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw     = lines[i];

    // Strip trailing inline comment (everything after first '#').
    // No subject in this domain contains '#', so this is safe.
    let line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;  // blank or comment-only

    const parts = line.split(',').map(s => s.trim());

    // Short form: a single field, must be a chapter number.
    if (parts.length === 1) {
      const ch = Number.parseInt(parts[0], 10);
      if (!Number.isFinite(ch) || String(ch) !== parts[0]) {
        log(`WARN line ${lineNum}: cannot parse "${raw.trim()}" as a chapter number — skipping`);
        warnings++;
        continue;
      }
      if (ch < 1) {
        log(`WARN line ${lineNum}: chapter must be >= 1 (got ${ch}) — skipping`);
        warnings++;
        continue;
      }
      if (!lastFull) {
        log(`WARN line ${lineNum}: short-form "${ch}" but no prior full row to inherit from — skipping`);
        warnings++;
        continue;
      }
      lessons.push({ ...lastFull, chapter: ch, sourceLine: lineNum });
      continue;
    }

    // Full form: at least 4 comma-separated fields.
    // Subject MAY contain commas (defensive); rejoin middle parts.
    if (parts.length < 4) {
      log(`WARN line ${lineNum}: expected at least 4 fields (grade,lang,subject,chapter), got ${parts.length}: "${raw.trim()}" — skipping`);
      warnings++;
      continue;
    }
    const grade   = Number.parseInt(parts[0], 10);
    const lang    = parts[1].toLowerCase();
    const chapter = Number.parseInt(parts[parts.length - 1], 10);
    const subject = parts.slice(2, parts.length - 1).join(', ').trim();

    if (!Number.isFinite(grade) || String(grade) !== parts[0]) {
      log(`WARN line ${lineNum}: invalid grade "${parts[0]}" — skipping`);
      warnings++;
      continue;
    }
    if (!VALID_LANGS.has(lang)) {
      log(`WARN line ${lineNum}: lang must be 'uz' or 'ru' (got "${parts[1]}") — skipping`);
      warnings++;
      continue;
    }
    if (!subject) {
      log(`WARN line ${lineNum}: empty subject — skipping`);
      warnings++;
      continue;
    }
    if (!Number.isFinite(chapter) || String(chapter) !== parts[parts.length - 1] || chapter < 1) {
      log(`WARN line ${lineNum}: invalid chapter "${parts[parts.length - 1]}" — skipping`);
      warnings++;
      continue;
    }

    lastFull = { grade, lang, subject };
    lessons.push({ grade, lang, subject, chapter, sourceLine: lineNum });
  }

  return { lessons, warnings };
}

// ── child runner ──────────────────────────────────────────────────────────
function runChapter(lesson) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CCA_GRADE:      String(lesson.grade),
      CCA_LANG:       lesson.lang,
      CCA_SUBJECT:    lesson.subject,
      CCA_CHAPTER:    String(lesson.chapter),
      CCA_NOTION_URL: process.env.CCA_NOTION_URL || '',  // informational, optional
    };
    // detached:true breaks the Windows Job Object inheritance so the
    // 4-deep spawn chain (batch→pipeline→autonomous→{submit,save})
    // doesn't fail with "AssignProcessToJobObject (87)" on the inner spawn.
    // We still wait for exit; this only affects process-group nesting.
    const child = spawn(process.execPath, [PIPELINE], {
      cwd:        REPO,
      stdio:      'inherit',
      env,
      detached:   process.platform === 'win32',
      windowsHide: true,
    });
    child.on('exit',  (code, sig) => resolve({ code: code ?? 1, signal: sig }));
    child.on('error', (err)        => resolve({ code: 1, signal: null, error: err.message }));
  });
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CREATIVE AUTOMATION — BATCH PIPELINE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  lessons file: ${LESSONS_PATH}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  let parsed;
  try {
    parsed = parseLessons(LESSONS_PATH);
  } catch (e) {
    console.error(`\n  ✗ ${e.message}\n`);
    if (e.helpful) {
      console.error(`  Create lessons.txt at the repo root with one chapter per line.`);
      console.error(`  See lessons.txt.example for the format.\n`);
    }
    process.exit(2);
  }

  const { lessons, warnings } = parsed;
  if (lessons.length === 0) {
    console.error(`\n  ✗ no parseable lessons in ${LESSONS_PATH}`);
    console.error(`  Add at least one row in the format: grade,lang,subject,chapter`);
    console.error(`  See lessons.txt.example for details.\n`);
    process.exit(2);
  }

  log(`parsed ${lessons.length} lesson${lessons.length === 1 ? '' : 's'}` +
      (warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''));
  lessons.forEach((l, i) => {
    console.log(`     ${String(i + 1).padStart(3)}. G${l.grade}/${l.lang}/${l.subject}/ch${l.chapter}  (line ${l.sourceLine})`);
  });
  console.log('');

  if (process.env.CCA_DRY_RUN === '1') {
    log('CCA_DRY_RUN=1 — parsed list shown above; not running anything.');
    process.exit(0);
  }

  const results = [];
  const t0      = Date.now();
  let aborted   = false;

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    const banner = `═══ LESSON ${i + 1}/${lessons.length} : G${lesson.grade}/${lesson.lang}/${lesson.subject}/ch${lesson.chapter} ═══`;
    console.log(`\n${banner}`);

    const lT0 = Date.now();
    const { code, signal, error } = await runChapter(lesson);
    const lDt = ((Date.now() - lT0) / 1000 / 60).toFixed(1);

    let status;
    if (code === 0) {
      status = 'ok';
      log(`✓ lesson ${i + 1}/${lessons.length} OK in ${lDt} min`);
    } else if (code === 1) {
      status = 'stage_fail';
      log(`✗ lesson ${i + 1}/${lessons.length} stage failure (exit=${code}) in ${lDt} min — continuing to next`);
    } else if (code === 2) {
      status = 'preflight_fail';
      log(`✗ lesson ${i + 1}/${lessons.length} pre-flight failure (exit=${code}) — same problem will hit every lesson, ABORTING batch`);
      results.push({ lesson, status, code, signal, error, minutes: lDt });
      aborted = true;
      break;
    } else {
      // 130 (SIGINT), spawn errors, anything unexpected
      status = 'fatal';
      log(`✗ lesson ${i + 1}/${lessons.length} fatal exit=${code} signal=${signal || 'none'}${error ? ' err=' + error : ''} — ABORTING batch`);
      results.push({ lesson, status, code, signal, error, minutes: lDt });
      aborted = true;
      break;
    }
    results.push({ lesson, status, code, signal, minutes: lDt });
  }

  const totalDt = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const ok      = results.filter(r => r.status === 'ok').length;
  const failed  = results.length - ok;
  const skipped = lessons.length - results.length;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  BATCH SUMMARY  —  ${totalDt} min total`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Lessons in list:   ${lessons.length}`);
  console.log(`  Attempted:         ${results.length}`);
  console.log(`  ✓ OK:              ${ok}`);
  console.log(`  ✗ failed:          ${failed}`);
  if (skipped > 0) console.log(`  - not attempted:   ${skipped}  (batch aborted before reaching them)`);

  if (failed > 0 || skipped > 0) {
    console.log('\n  Per-lesson results:');
    results.forEach((r, i) => {
      const tag = r.status === 'ok' ? '✓ ok    ' : `✗ ${r.status.padEnd(8)}`;
      console.log(`     ${String(i + 1).padStart(3)}. ${tag}  G${r.lesson.grade}/${r.lesson.lang}/${r.lesson.subject}/ch${r.lesson.chapter}  exit=${r.code}  ${r.minutes} min`);
    });
    if (skipped > 0) {
      console.log('  Not attempted (batch aborted):');
      lessons.slice(results.length).forEach((l, i) => {
        console.log(`     ${String(results.length + i + 1).padStart(3)}.            G${l.grade}/${l.lang}/${l.subject}/ch${l.chapter}`);
      });
    }
    console.log('\n  Re-run start.bat to retry — completed lessons skip automatically.');
  }
  console.log('');

  process.exit(aborted ? 1 : (failed > 0 ? 1 : 0));
})();
