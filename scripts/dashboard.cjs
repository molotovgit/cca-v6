// =============================================================================
//  CCA v5 — Realtime HTML dashboard
// =============================================================================
//  Single-file Node HTTP server, no dependencies.
//  Reads: reports/batch_*.log, .cca/saved_indices.json, .cca/tab_map.json,
//         images/**, prompts/**, lessons.txt
//  Serves: http://localhost:7777
// =============================================================================
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PORT = 7777;

const DANGER_KEYWORDS = ['xristian','salib','crusade','dind','islam','xalifalik','madaniyat','urush','janglar','bossagan'];

// ─── helpers ────────────────────────────────────────────────────────────────
function safeJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function fileExists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function countFiles(dir, ext) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith(ext)).length; }
  catch { return 0; }
}
function tailLines(p, n) {
  try {
    const text = fs.readFileSync(p, 'utf-8');
    const lines = text.split(/\r?\n/);
    return lines.slice(-n).filter(x => x.length > 0);
  } catch { return []; }
}
function findLatestLog() {
  const reports = path.join(REPO, 'reports');
  if (!fileExists(reports)) return null;
  // Exclude the dashboard's own stdout/stderr logs (dashboard.log /
  // dashboard.err) — they have a more recent mtime than batch.log because
  // the dashboard polls every 2s, but they don't contain pipeline output.
  // Picking dashboard.log here makes parseLog see no CHAPTER/STAGE lines
  // and the UI shows an empty state.
  const candidates = fs.readdirSync(reports)
    .filter(f => f.endsWith('.log'))
    .filter(f => !/^dashboard\b/i.test(f))
    .map(f => ({ name: f, path: path.join(reports, f), mtime: fs.statSync(path.join(reports, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'')
    .replace(/['‘’ʻ`]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

// ─── parser: log → state ─────────────────────────────────────────────────────
function parseLog(lines) {
  const state = {
    currentLesson: null,           // {grade, lang, subject, chapter, idx, total}
    stages: { FETCH: 'pending', REFINE: 'pending', PROMPTS: 'pending', IMAGES: 'pending', UPLOAD: 'pending' },
    stageDurations: {},
    lastOrch: null,                // {saved, pending, submit, save, stall}
    rescueCount: 0,
    error1095: false,
    finalStatus: null,             // 'running' | 'done' | 'failed' | 'aborted'
    lessonsList: [],               // from BATCH header
  };

  // Track current grade/lang/subject so the launch_all.bat-style CHAPTER
  // banner (which doesn't itself contain those) can inherit them.
  let curGrade = null, curLang = null, curSubject = null;

  for (const line of lines) {
    // launch_all.bat-style banner: "#  CHAPTER 1/6 : G8 / jahon tarixi / ch 15"
    const chapterMatch = line.match(/CHAPTER (\d+)\/(\d+)\s*:\s*G(\d+)\s*\/\s*([^\/]+?)\s*\/\s*ch\s*(\d+)/);
    if (chapterMatch) {
      const grade = parseInt(chapterMatch[3]);
      const subject = chapterMatch[4].trim();
      const chapter = parseInt(chapterMatch[5]);
      state.currentLesson = {
        idx:     parseInt(chapterMatch[1]),
        total:   parseInt(chapterMatch[2]),
        grade,
        lang:    curLang || 'uz',
        subject,
        chapter,
      };
      curGrade = grade; curSubject = subject;
      state.stages = { FETCH: 'pending', REFINE: 'pending', PROMPTS: 'pending', IMAGES: 'pending', UPLOAD: 'pending' };
      state.stageDurations = {};
    }

    // [DEBUG] CCA_LANG=uz CCA_SUBJECT=jahon tarixi CCA_GRADE=8
    const debugEnv = line.match(/CCA_LANG=(\w+)\s+CCA_SUBJECT=(.+?)\s+CCA_GRADE=(\d+)/);
    if (debugEnv) {
      curLang = debugEnv[1];
      curSubject = debugEnv[2].trim();
      curGrade = parseInt(debugEnv[3]);
      if (state.currentLesson) state.currentLesson.lang = curLang;
    }

    // Legacy v5 banner: ═══ LESSON 1/2 : G7/uz/jahon tarixi/ch19 ═══
    const lessonMatch = line.match(/LESSON (\d+)\/(\d+) : G(\d+)\/(\w+)\/(.+?)\/ch(\d+)/);
    if (lessonMatch) {
      state.currentLesson = {
        idx: parseInt(lessonMatch[1]),
        total: parseInt(lessonMatch[2]),
        grade: parseInt(lessonMatch[3]),
        lang: lessonMatch[4],
        subject: lessonMatch[5],
        chapter: parseInt(lessonMatch[6]),
      };
      state.stages = { FETCH: 'pending', REFINE: 'pending', PROMPTS: 'pending', IMAGES: 'pending', UPLOAD: 'pending' };
      state.stageDurations = {};
    }
    // Stage start: ─── STAGE 1/5 FETCH ───
    const stageStart = line.match(/STAGE \d\/5 (FETCH|REFINE|PROMPTS|IMAGES|UPLOAD)/);
    if (stageStart) state.stages[stageStart[1]] = 'running';

    // Stage done: [1/5 FETCH] ✓ done in 4.9s
    const stageDone = line.match(/\[\d\/5 (FETCH|REFINE|PROMPTS|IMAGES|UPLOAD)\] ✓ done in ([\d.]+)s/);
    if (stageDone) {
      state.stages[stageDone[1]] = 'done';
      state.stageDurations[stageDone[1]] = parseFloat(stageDone[2]);
    }
    // Stage fail
    if (/✗ STAGE FAILED/.test(line) || /STAGE FAILED/.test(line)) {
      Object.keys(state.stages).forEach(s => { if (state.stages[s] === 'running') state.stages[s] = 'failed'; });
    }

    // ORCH heartbeat
    const orchMatch = line.match(/\[ORCH\] saved=(\d+)\/(\d+)\s+pending=(\d+)\s+submit=(\w+)\s+save=(\w+)\s+stall=(\d+)s/);
    if (orchMatch) {
      state.lastOrch = {
        saved: parseInt(orchMatch[1]),
        total: parseInt(orchMatch[2]),
        pending: parseInt(orchMatch[3]),
        submit: orchMatch[4],
        save: orchMatch[5],
        stall: parseInt(orchMatch[6]),
      };
    }
    if (/RESCUE|rescue_zombie/i.test(line)) state.rescueCount++;
    if (/1095|content.{0,5}filter|content.{0,5}policy/i.test(line)) state.error1095 = true;

    // Pipeline final
    if (/PIPELINE DONE/.test(line)) state.finalStatus = 'done';
    if (/Pipeline halted/.test(line) || /ABORTING batch/.test(line)) state.finalStatus = 'failed';
    if (/BATCH SUMMARY/.test(line)) state.finalStatus = state.finalStatus || 'done';

    // BATCH parsed list: "1. G7/uz/jahon tarixi/ch19  (line 7)"
    const batchLessonMatch = line.match(/^\s+(\d+)\. G(\d+)\/(\w+)\/(.+?)\/ch(\d+)\s+\(line/);
    if (batchLessonMatch) {
      state.lessonsList.push({
        idx: parseInt(batchLessonMatch[1]),
        grade: parseInt(batchLessonMatch[2]),
        lang: batchLessonMatch[3],
        subject: batchLessonMatch[4],
        chapter: parseInt(batchLessonMatch[5]),
      });
    }
  }
  return state;
}

// ─── all-lessons history (filesystem-driven, across all runs) ───────────────
function enumerateAllLessons() {
  // Walk chapters/g{N}-{lang}/{subj-slug}/*.meta.json — one entry per chapter ever fetched.
  // For each, derive completion state by checking refined/, prompts/, images/, zips/.
  const out = [];
  const chaptersRoot = path.join(REPO, 'chapters');
  if (!fileExists(chaptersRoot)) return out;

  let gradeDirs = [];
  try { gradeDirs = fs.readdirSync(chaptersRoot); } catch { return out; }

  for (const gradeDir of gradeDirs) {
    // gradeDir like "g7-uz"
    const m = gradeDir.match(/^g(\d+)-(uz|ru)$/);
    if (!m) continue;
    const grade = parseInt(m[1], 10);
    const lang  = m[2];
    const gradePath = path.join(chaptersRoot, gradeDir);

    let subjDirs = [];
    try { subjDirs = fs.readdirSync(gradePath); } catch { continue; }

    for (const subjSlug of subjDirs) {
      const subjPath = path.join(gradePath, subjSlug);
      let metaFiles = [];
      try {
        metaFiles = fs.readdirSync(subjPath).filter(f => f.endsWith('.meta.json'));
      } catch { continue; }

      for (const metaFile of metaFiles) {
        const base = metaFile.replace(/\.meta\.json$/, '');
        const chMatch = base.match(/^ch(\d+)-/);
        if (!chMatch) continue;
        const chapter = parseInt(chMatch[1], 10);
        const meta = safeJSON(path.join(subjPath, metaFile), {});
        const title = meta.chapter_title || base;
        const subject = meta.subject || subjSlug.replace(/-/g, ' ');

        // Stage 2: refined MD
        const refinedMd = path.join(REPO, 'refined', gradeDir, subjSlug, `${base}.md`);
        const refineDone = fileExists(refinedMd);

        // Stage 3: prompts JSON (count entries)
        const promptsJson = path.join(REPO, 'prompts', gradeDir, subjSlug, `${base}.json`);
        const promptsArr = safeJSON(promptsJson, null);
        const promptsCount = Array.isArray(promptsArr) ? promptsArr.length : 0;

        // Stage 4: images on disk
        const imagesDir = path.join(REPO, 'images', gradeDir, subjSlug, base);
        const imagesCount = countFiles(imagesDir, '.png');

        // Stage 5: upload marker
        const markerPath = path.join(REPO, 'zips', gradeDir, subjSlug, `${base}.uploaded.json`);
        const marker = fileExists(markerPath) ? safeJSON(markerPath, null) : null;
        const zipPath = path.join(REPO, 'zips', gradeDir, subjSlug, `${base}.zip`);
        const zipExists = fileExists(zipPath);

        // Per-stage status
        const stages = {
          FETCH:   true,                                          // always true (we found the meta)
          REFINE:  refineDone,
          PROMPTS: promptsCount > 0,
          IMAGES:  promptsCount > 0 && imagesCount >= promptsCount,
          UPLOAD:  marker !== null,
        };
        const stageDone = Object.values(stages).filter(Boolean).length;
        const completionPct = Math.round((stageDone / 5) * 100);

        // Status label
        let status;
        if (stageDone === 5)                      status = 'complete';
        else if (imagesCount > 0 && imagesCount < (promptsCount || 80)) status = 'partial-images';
        else if (stageDone === 4 && !stages.UPLOAD) status = 'awaiting-upload';
        else if (stageDone >= 1)                  status = 'in-progress';
        else                                      status = 'fetched-only';

        // mtime — pick the most recent of marker, last image, prompts, refined, meta
        let lastMtime = 0;
        for (const p of [markerPath, zipPath, promptsJson, refinedMd, path.join(subjPath, metaFile)]) {
          try { const m = fs.statSync(p).mtimeMs; if (m > lastMtime) lastMtime = m; } catch {}
        }
        if (imagesCount > 0) {
          try { const m = fs.statSync(imagesDir).mtimeMs; if (m > lastMtime) lastMtime = m; } catch {}
        }

        out.push({
          grade, lang, subject, chapter, base, title,
          stages,
          counts: {
            promptsCount,
            imagesCount,
            imagesTotal: promptsCount || 80,
            zipExists,
          },
          completionPct,
          status,
          lastMtime,
          notion: marker ? {
            block_id:        marker.notion_block_id,
            page_id:         marker.notion_page_id,
            page_title:      marker.notion_page_title,
            uploaded_at:     marker.uploaded_at,
            zip_size_bytes:  marker.zip_size_bytes,
            refined_md_included: marker.refined_md_included || false,
          } : null,
        });
      }
    }
  }
  // Sort: complete first by upload time desc, then in-progress, then others
  out.sort((a, b) => {
    if (a.status === 'complete' && b.status !== 'complete') return -1;
    if (b.status === 'complete' && a.status !== 'complete') return 1;
    return b.lastMtime - a.lastMtime;
  });
  return out;
}

// ─── 1095-risk classifier ───────────────────────────────────────────────────
function classifyRisk(subject, chapter, title) {
  const blob = `${subject} ${title || ''}`.toLowerCase();
  const hits = DANGER_KEYWORDS.filter(k => blob.includes(k));
  if (hits.length >= 2) return { level: 'high', hits };
  if (hits.length === 1) return { level: 'medium', hits };
  return { level: 'low', hits: [] };
}

// ─── status snapshot ────────────────────────────────────────────────────────
function snapshot() {
  const out = {
    timestamp: Date.now(),
    log: { exists: false, mtimeMs: 0, name: null, recentLines: [] },
    state: null,
    diskCounts: null,
  };
  const latest = findLatestLog();
  if (latest) {
    out.log.exists = true;
    out.log.mtimeMs = latest.mtime;
    out.log.name = latest.name;
    const lines = fs.readFileSync(latest.path, 'utf-8').split(/\r?\n/);
    out.log.recentLines = lines.slice(-30).filter(x => x.length > 0);
    out.state = parseLog(lines);
  }

  // Disk-based image count for current lesson
  if (out.state && out.state.currentLesson) {
    const { grade, lang, subject, chapter } = out.state.currentLesson;
    const subjectSlug = slugify(subject);
    const promptsDir = path.join(REPO, 'prompts', `g${grade}-${lang}`, subjectSlug);
    let promptsBase = null;
    try {
      const candidates = fs.readdirSync(promptsDir).filter(f => f.startsWith(`ch${String(chapter).padStart(2,'0')}-`) && f.endsWith('.json') && !f.endsWith('.meta.json'));
      if (candidates[0]) promptsBase = candidates[0].replace(/\.json$/, '');
    } catch {}
    if (promptsBase) {
      const promptsJson = path.join(promptsDir, `${promptsBase}.json`);
      const promptsArr = safeJSON(promptsJson, []);
      const imagesDir = path.join(REPO, 'images', `g${grade}-${lang}`, subjectSlug, promptsBase);
      const imageCount = countFiles(imagesDir, '.png');
      const zipPath = path.join(REPO, 'zips', `g${grade}-${lang}`, subjectSlug, `${promptsBase}.zip`);
      const uploadedMarker = path.join(REPO, 'zips', `g${grade}-${lang}`, subjectSlug, `${promptsBase}.uploaded.json`);
      out.diskCounts = {
        promptsCount: Array.isArray(promptsArr) ? promptsArr.length : 0,
        imageCount,
        zipExists: fileExists(zipPath),
        uploadedExists: fileExists(uploadedMarker),
        uploadedMarkerData: fileExists(uploadedMarker) ? safeJSON(uploadedMarker, null) : null,
        promptsTitles: Array.isArray(promptsArr) ? promptsArr.map(p => (p && (p.slug || p.title || p.subject)) || '').slice(0, 80) : [],
      };
      out.state.currentLesson.title = promptsBase;
    }
  }

  // .cca state files
  out.cca = {
    saved_indices: safeJSON(path.join(REPO, '.cca', 'saved_indices.json'), null),
    tab_map:       safeJSON(path.join(REPO, '.cca', 'tab_map.json'), null),
  };

  // Account rotation status — read accounts.json + .cca/active_accounts.json
  // and produce a per-provider summary the UI can render.
  const accountsJson    = safeJSON(path.join(REPO, 'accounts.json'), null);
  const activeAccounts  = safeJSON(path.join(REPO, '.cca', 'active_accounts.json'), {}) || {};
  out.accounts = { providers: {} };
  if (accountsJson) {
    for (const provider of ['chatgpt', 'gemini']) {
      const list = Array.isArray(accountsJson[provider]) ? accountsJson[provider] : [];
      const stateForProvider = activeAccounts[provider] || {};
      const idx = Number.isInteger(stateForProvider.index) ? stateForProvider.index : 0;
      const safeIdx = (idx >= 0 && idx < list.length) ? idx : 0;
      const acct = list[safeIdx] || {};
      out.accounts.providers[provider] = {
        total:        list.length,
        activeIndex:  safeIdx,
        activeLabel:  acct.label || stateForProvider.label || '—',
        activeEmail:  acct.email || '—',
        // 1-based "accounts used" — primary alone = 1, after one rotation = 2, etc.
        used:         Math.min(list.length, safeIdx + 1),
        remaining:    Math.max(0, list.length - safeIdx - 1),
        list:         list.map((a, i) => ({
          label:  a.label || ('acct-' + (i + 1)),
          email:  a.email || '—',
          active: i === safeIdx,
        })),
      };
    }
  }
  // Risk
  if (out.state && out.state.currentLesson) {
    out.risk = classifyRisk(out.state.currentLesson.subject, out.state.currentLesson.chapter, out.state.currentLesson.title);
  }

  // All-lessons history (filesystem-driven)
  out.allLessons = enumerateAllLessons();
  out.lessonStats = {
    total:           out.allLessons.length,
    complete:        out.allLessons.filter(l => l.status === 'complete').length,
    awaitingUpload:  out.allLessons.filter(l => l.status === 'awaiting-upload').length,
    partialImages:   out.allLessons.filter(l => l.status === 'partial-images').length,
    inProgress:      out.allLessons.filter(l => l.status === 'in-progress').length,
    fetchedOnly:     out.allLessons.filter(l => l.status === 'fetched-only').length,
    totalImagesGen:  out.allLessons.reduce((s, l) => s + l.counts.imagesCount, 0),
    totalUploaded:   out.allLessons.filter(l => l.notion).length,
  };
  return out;
}

// ─── HTML page ───────────────────────────────────────────────────────────────
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>CCA v5 — Live Pipeline</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-0: #0a0e1a; --bg-1: #131829; --bg-2: #1a2138; --line: #2a3450;
  --txt: #e8edf7; --dim: #8a96b3; --ok: #4ade80; --warn: #fbbf24;
  --err: #ef4444; --info: #60a5fa; --accent: #c084fc; --pulse: #34d399;
}
html, body { background: var(--bg-0); color: var(--txt); font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace; min-height: 100vh; }
body { background: radial-gradient(circle at 10% 0%, #16203a 0%, #0a0e1a 60%) fixed; }
.wrap { max-width: 1400px; margin: 0 auto; padding: 24px; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding: 18px 22px; background: linear-gradient(90deg, var(--bg-1), var(--bg-2)); border-radius: 14px; border: 1px solid var(--line); }
.header h1 { font-size: 20px; letter-spacing: 1.5px; font-weight: 600; background: linear-gradient(90deg, #c084fc, #60a5fa); -webkit-background-clip: text; background-clip: text; color: transparent; }
.header .heartbeat { display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 12px var(--pulse); animation: pulse 1.5s ease-in-out infinite; }
.dot.cold { background: var(--dim); box-shadow: none; animation: none; }
.dot.err { background: var(--err); box-shadow: 0 0 12px var(--err); }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }
.lesson-banner { padding: 22px 26px; background: linear-gradient(135deg, #1f2742 0%, #1a2138 100%); border-radius: 14px; border: 1px solid var(--line); margin-bottom: 22px; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; position: relative; overflow: hidden; }
.lesson-banner::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: linear-gradient(180deg, var(--accent), var(--info)); }
.lesson-banner h2 { font-size: 24px; margin-bottom: 6px; }
.lesson-banner .meta { color: var(--dim); font-size: 13px; }
.risk-badge { padding: 6px 14px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
.risk-low { background: rgba(74, 222, 128, 0.1); color: var(--ok); border: 1px solid rgba(74, 222, 128, 0.3); }
.risk-medium { background: rgba(251, 191, 36, 0.1); color: var(--warn); border: 1px solid rgba(251, 191, 36, 0.3); }
.risk-high { background: rgba(239, 68, 68, 0.1); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.3); }
.grid { display: grid; gap: 18px; }
.grid-stages { grid-template-columns: repeat(5, 1fr); margin-bottom: 22px; }
.stage-card { padding: 16px; background: var(--bg-1); border: 1px solid var(--line); border-radius: 12px; position: relative; overflow: hidden; transition: all 0.3s ease; }
.stage-card.running { border-color: var(--info); box-shadow: 0 0 24px rgba(96, 165, 250, 0.15); animation: glow 2s ease-in-out infinite; }
.stage-card.done { border-color: rgba(74, 222, 128, 0.3); }
.stage-card.failed { border-color: var(--err); }
@keyframes glow { 0%, 100% { box-shadow: 0 0 24px rgba(96, 165, 250, 0.15); } 50% { box-shadow: 0 0 36px rgba(96, 165, 250, 0.3); } }
.stage-num { font-size: 11px; color: var(--dim); letter-spacing: 1px; }
.stage-name { font-size: 16px; font-weight: 600; margin: 4px 0; }
.stage-status { font-size: 12px; }
.stage-status.pending { color: var(--dim); }
.stage-status.running { color: var(--info); }
.stage-status.done { color: var(--ok); }
.stage-status.failed { color: var(--err); }
.stage-card .duration { font-size: 11px; color: var(--dim); margin-top: 6px; }
.stage-card.running::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--info), transparent); animation: shimmer 1.5s linear infinite; background-size: 200% 100%; }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.cards-2 { grid-template-columns: 1fr 1fr; }
.cards-3 { grid-template-columns: 2fr 1fr 1fr; }
.card { background: var(--bg-1); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
.card h3 { font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); margin-bottom: 14px; font-weight: 500; }
.image-grid { display: grid; grid-template-columns: repeat(20, 1fr); gap: 4px; margin-top: 10px; }
.img-cell { aspect-ratio: 1; background: var(--bg-2); border-radius: 3px; transition: all 0.4s ease; position: relative; }
.img-cell.saved { background: linear-gradient(135deg, #34d399, #10b981); box-shadow: 0 0 8px rgba(52, 211, 153, 0.4); }
.img-cell.pending { background: linear-gradient(135deg, #60a5fa, #3b82f6); animation: tabPulse 1.5s ease-in-out infinite; }
@keyframes tabPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.progress-num { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.progress-num .big { font-size: 36px; font-weight: 700; background: linear-gradient(90deg, var(--ok), var(--info)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.progress-num .small { color: var(--dim); font-size: 14px; }
.progress-bar { height: 8px; background: var(--bg-2); border-radius: 4px; overflow: hidden; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, var(--info), var(--ok)); border-radius: 4px; transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1); position: relative; }
.progress-bar .fill::after { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent); animation: shimmer 2s linear infinite; background-size: 200% 100%; }
.metric-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.metric-row:last-child { border: 0; }
.metric-row .label { color: var(--dim); }
.metric-row .val { color: var(--txt); font-weight: 600; }
.metric-row .val.ok { color: var(--ok); }
.metric-row .val.warn { color: var(--warn); }
.metric-row .val.err { color: var(--err); }
.log-tail { max-height: 320px; overflow-y: auto; font-size: 11px; line-height: 1.7; padding-right: 6px; }
.log-tail::-webkit-scrollbar { width: 6px; }
.log-tail::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.log-line { padding: 1px 0; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-line.orch { color: var(--info); }
.log-line.sav { color: var(--ok); }
.log-line.sub { color: var(--accent); }
.log-line.err { color: var(--err); }
.log-line.batch { color: var(--warn); font-weight: 600; }
.warn-banner { padding: 14px 18px; background: linear-gradient(90deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.05)); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 12px; margin-bottom: 22px; display: none; align-items: center; gap: 12px; }
.warn-banner.show { display: flex; }
.warn-banner.warn { background: linear-gradient(90deg, rgba(251, 191, 36, 0.15), rgba(251, 191, 36, 0.05)); border-color: rgba(251, 191, 36, 0.4); }
.warn-icon { font-size: 24px; }
.lesson-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.lesson-pill { padding: 6px 12px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px; font-size: 11px; color: var(--dim); display: inline-flex; align-items: center; gap: 6px; }
.lesson-pill.active { border-color: var(--info); color: var(--info); background: rgba(96,165,250,0.08); }
.lesson-pill.done { border-color: rgba(74, 222, 128, 0.3); color: var(--ok); }
.lesson-pill.queued { opacity: 0.5; }
.upload-cta { margin-top: 12px; padding: 10px 14px; background: linear-gradient(90deg, rgba(192, 132, 252, 0.1), rgba(192, 132, 252, 0.05)); border: 1px solid rgba(192, 132, 252, 0.3); border-radius: 8px; font-size: 12px; }
.upload-cta a { color: var(--accent); text-decoration: none; border-bottom: 1px dashed var(--accent); }
.gauge { display: flex; align-items: center; gap: 12px; }
.gauge-circle { width: 56px; height: 56px; border-radius: 50%; background: conic-gradient(var(--info) 0deg, var(--bg-2) 0deg); display: flex; align-items: center; justify-content: center; transition: background 0.5s ease; }
.gauge-circle .inner { width: 44px; height: 44px; border-radius: 50%; background: var(--bg-1); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.empty { color: var(--dim); font-style: italic; text-align: center; padding: 20px; }

/* ─── lesson history & breakdown ─── */
.history-section { margin-top: 22px; }
.history-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 18px; }
.history-stat { padding: 14px; background: var(--bg-1); border: 1px solid var(--line); border-radius: 10px; text-align: center; transition: transform 0.2s ease; }
.history-stat:hover { transform: translateY(-2px); border-color: var(--info); }
.history-stat .num { font-size: 28px; font-weight: 700; line-height: 1; }
.history-stat .lbl { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--dim); margin-top: 6px; }
.history-stat.ok    .num { color: var(--ok); }
.history-stat.warn  .num { color: var(--warn); }
.history-stat.err   .num { color: var(--err); }
.history-stat.info  .num { color: var(--info); }
.history-stat.accent .num { color: var(--accent); }

.history-toolbar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-btn { padding: 6px 12px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 999px; font: inherit; font-size: 11px; color: var(--dim); cursor: pointer; letter-spacing: 0.5px; text-transform: uppercase; transition: all 0.2s ease; }
.filter-btn:hover { color: var(--txt); border-color: var(--info); }
.filter-btn.active { background: rgba(96, 165, 250, 0.12); border-color: var(--info); color: var(--info); }

.lesson-card-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 14px; padding: 14px 16px; background: var(--bg-1); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; align-items: center; transition: all 0.25s ease; }
.lesson-card-row:hover { border-color: var(--info); transform: translateX(2px); }
.lesson-card-row.complete { border-left: 3px solid var(--ok); }
.lesson-card-row.partial-images, .lesson-card-row.awaiting-upload { border-left: 3px solid var(--warn); }
.lesson-card-row.in-progress { border-left: 3px solid var(--info); }
.lesson-card-row.fetched-only { border-left: 3px solid var(--dim); }

.lc-meta .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.lc-meta .sub { font-size: 11px; color: var(--dim); }
.lc-meta .sub b { color: var(--txt); font-weight: 600; }

.stage-chips { display: flex; gap: 4px; }
.sc { width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; background: var(--bg-2); color: var(--dim); border: 1px solid var(--line); transition: all 0.3s ease; }
.sc.done { background: linear-gradient(135deg, #34d399, #10b981); color: white; border-color: transparent; box-shadow: 0 0 8px rgba(52, 211, 153, 0.3); }
.sc.partial { background: linear-gradient(135deg, #fbbf24, #f59e0b); color: white; border-color: transparent; }

.lc-images { font-size: 12px; color: var(--dim); min-width: 90px; text-align: right; }
.lc-images b { color: var(--txt); font-size: 14px; font-weight: 700; }
.lc-images .mini-bar { width: 90px; height: 4px; background: var(--bg-2); border-radius: 2px; overflow: hidden; margin-top: 4px; }
.lc-images .mini-bar .mini-fill { height: 100%; background: linear-gradient(90deg, var(--info), var(--ok)); transition: width 0.5s ease; }

.lc-status { padding: 5px 11px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; white-space: nowrap; }
.lc-status.complete         { background: rgba(74, 222, 128, 0.12); color: var(--ok); border: 1px solid rgba(74, 222, 128, 0.3); }
.lc-status.partial-images   { background: rgba(251, 191, 36, 0.12); color: var(--warn); border: 1px solid rgba(251, 191, 36, 0.3); }
.lc-status.awaiting-upload  { background: rgba(192, 132, 252, 0.12); color: var(--accent); border: 1px solid rgba(192, 132, 252, 0.3); }
.lc-status.in-progress      { background: rgba(96, 165, 250, 0.12); color: var(--info); border: 1px solid rgba(96, 165, 250, 0.3); }
.lc-status.fetched-only     { background: var(--bg-2); color: var(--dim); border: 1px solid var(--line); }

.lc-notion { display: inline-block; margin-top: 4px; padding: 3px 8px; background: rgba(192, 132, 252, 0.08); color: var(--accent); border: 1px solid rgba(192, 132, 252, 0.25); border-radius: 6px; font-size: 10px; text-decoration: none; }
.lc-notion:hover { background: rgba(192, 132, 252, 0.18); }

@media (max-width: 1100px) {
  .grid-stages { grid-template-columns: repeat(2, 1fr); }
  .cards-3, .cards-2 { grid-template-columns: 1fr; }
  .image-grid { grid-template-columns: repeat(10, 1fr); }
  .history-stats { grid-template-columns: repeat(3, 1fr); }
  .lesson-card-row { grid-template-columns: 1fr; gap: 8px; }
  .lc-images { text-align: left; }
}
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>◆ CCA v5 PIPELINE — LIVE BOARD</h1>
    <div class="heartbeat">
      <span class="dot" id="heartbeat-dot"></span>
      <span id="heartbeat-text">connecting...</span>
    </div>
  </div>

  <div class="warn-banner" id="warn-banner">
    <span class="warn-icon" id="warn-icon">⚠</span>
    <div id="warn-text"></div>
  </div>

  <div id="lesson-banner" class="lesson-banner" style="display:none;">
    <div>
      <h2 id="lesson-title">—</h2>
      <div class="meta" id="lesson-meta">—</div>
      <div class="lesson-list" id="lesson-list"></div>
    </div>
    <div class="risk-badge" id="risk-badge">—</div>
  </div>

  <div class="grid grid-stages" id="stages-grid"></div>

  <!-- ─── Account rotation panel ─── -->
  <div class="card" id="accounts-card" style="margin-bottom: 22px;">
    <h3 style="display:flex; align-items:center; gap:14px;">
      ◆ Account rotation
      <span style="font-weight:400; color:var(--dim); font-size:11px;">
        (active account + how many have been used so far)
      </span>
    </h3>
    <div id="accounts-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 18px;">
      <div class="empty">waiting for accounts.json...</div>
    </div>
  </div>

  <div class="grid cards-3">
    <div class="card">
      <h3>◆ Image generation — saved on disk</h3>
      <div class="progress-num">
        <span class="big" id="img-saved">0</span>
        <span class="small">/ <span id="img-total">80</span></span>
      </div>
      <div class="progress-bar"><div class="fill" id="img-fill" style="width:0%"></div></div>
      <div class="image-grid" id="image-grid"></div>
      <div class="upload-cta" id="upload-cta" style="display:none;">
        <strong>✓ Uploaded to Notion</strong> — block <span id="upload-blockid">—</span> · <span id="upload-size">—</span>
      </div>
    </div>

    <div class="card">
      <h3>◆ Orchestrator</h3>
      <div class="metric-row"><span class="label">submit</span><span class="val" id="m-submit">—</span></div>
      <div class="metric-row"><span class="label">save</span><span class="val" id="m-save">—</span></div>
      <div class="metric-row"><span class="label">pending tabs</span><span class="val" id="m-pending">—</span></div>
      <div class="metric-row"><span class="label">stall</span><span class="val" id="m-stall">—</span></div>
      <div class="metric-row"><span class="label">rescues</span><span class="val" id="m-rescues">0</span></div>
      <div class="metric-row"><span class="label">1095 detected</span><span class="val" id="m-1095">no</span></div>
    </div>

    <div class="card">
      <h3>◆ Stage timing</h3>
      <div id="timings"></div>
    </div>
  </div>

  <div class="grid cards-2" style="margin-top:22px;">
    <div class="card">
      <h3>◆ Recent log</h3>
      <div class="log-tail" id="log-tail"><div class="empty">waiting for log...</div></div>
    </div>
    <div class="card">
      <h3>◆ Pipeline diagnostics</h3>
      <div class="metric-row"><span class="label">log file</span><span class="val" id="d-log">—</span></div>
      <div class="metric-row"><span class="label">log mtime</span><span class="val" id="d-mtime">—</span></div>
      <div class="metric-row"><span class="label">.cca/saved_indices</span><span class="val" id="d-saved-state">—</span></div>
      <div class="metric-row"><span class="label">.cca/tab_map size</span><span class="val" id="d-tabmap">—</span></div>
      <div class="metric-row"><span class="label">prompts.json count</span><span class="val" id="d-prompts">—</span></div>
      <div class="metric-row"><span class="label">images dir count</span><span class="val" id="d-images">—</span></div>
      <div class="metric-row"><span class="label">zip exists</span><span class="val" id="d-zip">—</span></div>
    </div>
  </div>

  <!-- ─── Lesson history & breakdown ─── -->
  <div class="card history-section">
    <h3 style="display:flex;align-items:center;gap:12px;">
      ◆ Generated lessons — full breakdown
      <span style="font-weight:400;color:var(--dim);font-size:11px;">(filesystem-driven · across all runs)</span>
    </h3>
    <div class="history-stats" id="history-stats"></div>
    <div class="history-toolbar" id="history-filters">
      <button class="filter-btn active" data-filter="all">all</button>
      <button class="filter-btn" data-filter="complete">✓ complete</button>
      <button class="filter-btn" data-filter="awaiting-upload">awaiting upload</button>
      <button class="filter-btn" data-filter="partial-images">partial images</button>
      <button class="filter-btn" data-filter="in-progress">in-progress</button>
      <button class="filter-btn" data-filter="fetched-only">fetched-only</button>
    </div>
    <div id="lessons-history-list">
      <div class="empty">no lessons generated yet</div>
    </div>
  </div>
</div>

<script>
const STAGES = [['1/5','FETCH'],['2/5','REFINE'],['3/5','PROMPTS'],['4/5','IMAGES'],['5/5','UPLOAD']];

function el(t,c,h){const x=document.createElement(t);if(c)x.className=c;if(h!==undefined)x.innerHTML=h;return x;}

function renderStages(state) {
  const g = document.getElementById('stages-grid');
  g.innerHTML = '';
  for (const [num, name] of STAGES) {
    const status = state.stages[name] || 'pending';
    const dur = state.stageDurations[name];
    const card = el('div', 'stage-card ' + status);
    card.innerHTML = '<div class="stage-num">STAGE ' + num + '</div>' +
      '<div class="stage-name">' + name + '</div>' +
      '<div class="stage-status ' + status + '">' + status.toUpperCase() + '</div>' +
      (dur ? '<div class="duration">⏱ ' + dur.toFixed(1) + 's</div>' : '');
    g.appendChild(card);
  }
}

function renderAccounts(accounts) {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!accounts || !accounts.providers || Object.keys(accounts.providers).length === 0) {
    grid.appendChild(el('div', 'empty', 'no accounts.json yet'));
    return;
  }
  for (const [provider, info] of Object.entries(accounts.providers)) {
    const card = el('div');
    card.style.cssText = 'background: var(--bg-1); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;';
    const head = el('div');
    head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px;';
    head.innerHTML =
      '<div style="font-weight:700; letter-spacing:0.5px; text-transform:uppercase; font-size:12px; color:var(--accent);">' + provider + '</div>' +
      '<div style="font-size:11px; color:var(--dim);">' +
        '<span style="color:var(--ok); font-weight:700;">' + info.used + '</span>' +
        ' of ' + info.total + ' used · ' +
        info.remaining + ' remaining' +
      '</div>';
    card.appendChild(head);
    // Active row
    const active = el('div');
    active.style.cssText = 'background: rgba(74,222,128,0.10); border:1px solid rgba(74,222,128,0.32); border-radius:7px; padding:8px 11px; margin-bottom:8px; font-size:13px;';
    active.innerHTML =
      '<div style="font-size:10px; color:var(--ok); font-weight:700; letter-spacing:0.4px; margin-bottom:3px;">⏵ CURRENTLY ACTIVE — index ' + info.activeIndex + '</div>' +
      '<div><strong>' + info.activeLabel + '</strong> · <span style="color:var(--dim);">' + info.activeEmail + '</span></div>';
    card.appendChild(active);
    // Full list with active highlighted
    const list = el('div');
    list.style.cssText = 'font-size:11.5px; color:var(--dim); display:flex; flex-direction:column; gap:3px;';
    info.list.forEach((a, i) => {
      const row = el('div');
      const isActive = a.active;
      const isPast   = i < info.activeIndex;
      row.style.cssText = 'display:flex; gap:10px; padding:3px 8px; border-radius:5px;' +
        (isActive ? 'background:rgba(74,222,128,0.06); color:var(--txt);' :
         isPast   ? 'color:var(--dim); text-decoration:line-through;' :
                    'color:var(--dim);');
      row.innerHTML =
        '<span style="width:18px;">' + (isActive ? '▶' : (isPast ? '✓' : '·')) + '</span>' +
        '<span style="width:90px;">[' + a.label + ']</span>' +
        '<span>' + a.email + '</span>';
      list.appendChild(row);
    });
    card.appendChild(list);
    grid.appendChild(card);
  }
}

function renderImageGrid(saved, pending, total) {
  const grid = document.getElementById('image-grid');
  grid.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const cls = i < saved ? 'saved' : (i < saved + pending ? 'pending' : '');
    grid.appendChild(el('div', 'img-cell ' + cls));
  }
}

function colorClass(name) {
  if (/SAV-ERR|SUB-ERR|FAIL|✗|Error|Traceback/.test(name)) return 'err';
  if (/\[ORCH\]/.test(name)) return 'orch';
  if (/\[SAV\]/.test(name)) return 'sav';
  if (/\[SUB\]/.test(name)) return 'sub';
  if (/\[BATCH\]/.test(name)) return 'batch';
  return '';
}

function fmt(s) { return s.length > 200 ? s.slice(0, 200) + '…' : s; }

async function tick() {
  let s;
  try { s = await fetch('/status').then(r => r.json()); }
  catch (e) {
    document.getElementById('heartbeat-dot').classList.add('err');
    document.getElementById('heartbeat-text').textContent = 'server unreachable';
    return;
  }
  document.getElementById('heartbeat-dot').classList.remove('err','cold');
  document.getElementById('heartbeat-text').textContent = 'live · ' + new Date(s.timestamp).toLocaleTimeString();

  if (!s.state) {
    document.getElementById('lesson-banner').style.display = 'none';
    return;
  }

  // lesson banner
  if (s.state.currentLesson) {
    const cl = s.state.currentLesson;
    document.getElementById('lesson-banner').style.display = 'grid';
    document.getElementById('lesson-title').textContent = (cl.title || 'ch' + cl.chapter).replace(/-/g, ' ');
    document.getElementById('lesson-meta').textContent = 'G' + cl.grade + ' · ' + cl.lang + ' · ' + cl.subject + ' · ch' + cl.chapter + '  ·  Lesson ' + cl.idx + '/' + cl.total;
    const rb = document.getElementById('risk-badge');
    if (s.risk) {
      rb.className = 'risk-badge risk-' + s.risk.level;
      rb.textContent = '1095 RISK · ' + s.risk.level + (s.risk.hits.length ? ' (' + s.risk.hits.join(', ') + ')' : '');
    }
    // lesson list
    const lst = document.getElementById('lesson-list');
    lst.innerHTML = '';
    s.state.lessonsList.forEach(l => {
      let cls = 'lesson-pill queued';
      if (l.idx === cl.idx) cls = 'lesson-pill active';
      else if (l.idx < cl.idx) cls = 'lesson-pill done';
      lst.appendChild(el('span', cls, '#' + l.idx + ' · G' + l.grade + ' ' + l.subject + ' ch' + l.chapter));
    });
  }

  renderStages(s.state);

  // Account rotation panel
  renderAccounts(s.accounts);

  // Image grid
  const total = (s.diskCounts && s.diskCounts.promptsCount) || 80;
  const saved = (s.diskCounts && s.diskCounts.imageCount) || 0;
  const pending = (s.state.lastOrch && s.state.lastOrch.pending) || 0;
  document.getElementById('img-saved').textContent = saved;
  document.getElementById('img-total').textContent = total;
  document.getElementById('img-fill').style.width = (total ? (saved / total * 100) : 0) + '%';
  renderImageGrid(saved, pending, total);

  // Upload CTA
  if (s.diskCounts && s.diskCounts.uploadedExists) {
    document.getElementById('upload-cta').style.display = 'block';
    const m = s.diskCounts.uploadedMarkerData || {};
    document.getElementById('upload-blockid').textContent = (m.notion_block_id || '—').slice(0, 13);
    const sz = m.zip_size_bytes ? (m.zip_size_bytes / 1024 / 1024).toFixed(1) + ' MB' : '—';
    document.getElementById('upload-size').textContent = sz;
  }

  // Orchestrator metrics
  const o = s.state.lastOrch;
  document.getElementById('m-submit').textContent = o ? o.submit : '—';
  document.getElementById('m-submit').className = 'val ' + (o && o.submit === 'alive' ? 'ok' : 'warn');
  document.getElementById('m-save').textContent = o ? o.save : '—';
  document.getElementById('m-save').className = 'val ' + (o && o.save === 'alive' ? 'ok' : 'warn');
  document.getElementById('m-pending').textContent = o ? o.pending : '—';
  document.getElementById('m-stall').textContent = o ? (o.stall + 's') : '—';
  document.getElementById('m-stall').className = 'val ' + (o && o.stall < 60 ? 'ok' : (o && o.stall < 150 ? 'warn' : 'err'));
  document.getElementById('m-rescues').textContent = s.state.rescueCount;
  document.getElementById('m-1095').textContent = s.state.error1095 ? 'YES — DEADLOCK RISK' : 'no';
  document.getElementById('m-1095').className = 'val ' + (s.state.error1095 ? 'err' : 'ok');

  // Stage timings
  const t = document.getElementById('timings');
  t.innerHTML = '';
  for (const [num, name] of STAGES) {
    const dur = s.state.stageDurations[name];
    const row = el('div', 'metric-row');
    row.innerHTML = '<span class="label">' + name + '</span><span class="val">' + (dur ? dur.toFixed(1) + 's' : '—') + '</span>';
    t.appendChild(row);
  }

  // Log tail
  const lt = document.getElementById('log-tail');
  lt.innerHTML = '';
  s.log.recentLines.slice(-25).forEach(line => {
    lt.appendChild(el('div', 'log-line ' + colorClass(line), fmt(line)));
  });
  lt.scrollTop = lt.scrollHeight;

  // Diagnostics
  document.getElementById('d-log').textContent = s.log.name || '—';
  document.getElementById('d-mtime').textContent = s.log.mtimeMs ? new Date(s.log.mtimeMs).toLocaleTimeString() : '—';
  const si = s.cca && s.cca.saved_indices;
  document.getElementById('d-saved-state').textContent = si ? (Array.isArray(si) ? si.length : Object.keys(si).length) + ' indices' : '—';
  const tm = s.cca && s.cca.tab_map;
  document.getElementById('d-tabmap').textContent = tm ? Object.keys(tm).length + ' tabs' : '—';
  document.getElementById('d-prompts').textContent = (s.diskCounts && s.diskCounts.promptsCount) || '—';
  document.getElementById('d-images').textContent = (s.diskCounts && s.diskCounts.imageCount) || '0';
  document.getElementById('d-zip').textContent = (s.diskCounts && s.diskCounts.zipExists) ? 'yes' : 'no';

  // Warning banner
  const wb = document.getElementById('warn-banner');
  if (s.state.error1095) {
    wb.classList.add('show');
    wb.classList.remove('warn');
    document.getElementById('warn-icon').textContent = '🛑';
    document.getElementById('warn-text').innerHTML = '<strong>Gemini error 1095 detected in log</strong> — content policy filter rejecting prompts. Image stage may deadlock at pending=10. Check Gemini tabs in Chrome :9223.';
  } else if (o && o.stall >= 150) {
    wb.classList.add('show', 'warn');
    document.getElementById('warn-icon').textContent = '⚠';
    document.getElementById('warn-text').innerHTML = '<strong>Saver stalled ' + o.stall + 's</strong> — orchestrator may attempt rescue at 180s. Watch tab count.';
  } else {
    wb.classList.remove('show');
  }

  // Lesson history breakdown
  renderLessonHistory(s.allLessons || [], s.lessonStats || {});
}

// ─── lesson history renderer ─────────────────────────────────────────────
let activeFilter = 'all';
function renderLessonHistory(lessons, stats) {
  // top stat tiles
  const statsEl = document.getElementById('history-stats');
  const tiles = [
    { lbl: 'TOTAL',          num: stats.total          || 0, cls: 'info'   },
    { lbl: 'COMPLETE',       num: stats.complete       || 0, cls: 'ok'     },
    { lbl: 'AWAITING UPLOAD',num: stats.awaitingUpload || 0, cls: 'accent' },
    { lbl: 'PARTIAL IMAGES', num: stats.partialImages  || 0, cls: 'warn'   },
    { lbl: 'IMAGES GENERATED', num: stats.totalImagesGen || 0, cls: 'ok'   },
    { lbl: 'UPLOADED TO NOTION', num: stats.totalUploaded || 0, cls: 'accent' },
  ];
  statsEl.innerHTML = '';
  tiles.forEach(t => {
    const tile = el('div', 'history-stat ' + t.cls);
    tile.innerHTML = '<div class="num">' + t.num + '</div><div class="lbl">' + t.lbl + '</div>';
    statsEl.appendChild(tile);
  });

  // filter buttons (wire up once)
  document.querySelectorAll('.filter-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderLessonRows(lessons);
    });
  });

  renderLessonRows(lessons);
}

function renderLessonRows(lessons) {
  const list = document.getElementById('lessons-history-list');
  const filtered = activeFilter === 'all' ? lessons : lessons.filter(l => l.status === activeFilter);
  if (!filtered.length) {
    list.innerHTML = '<div class="empty">no lessons match this filter</div>';
    return;
  }
  list.innerHTML = '';
  const STAGE_LETTERS = [['FETCH','F'],['REFINE','R'],['PROMPTS','P'],['IMAGES','I'],['UPLOAD','U']];
  filtered.forEach(l => {
    const row = el('div', 'lesson-card-row ' + l.status);

    // meta column
    const meta = el('div', 'lc-meta');
    const cleanTitle = (l.title || '').replace(/^\d+-mavzu[:\.]?\s*/, '');
    meta.innerHTML = '<div class="title">' + cleanTitle + '</div>' +
      '<div class="sub">G<b>' + l.grade + '</b> · ' + l.lang + ' · <b>' + l.subject + '</b> · ch<b>' + l.chapter + '</b></div>' +
      (l.notion ? '<a class="lc-notion" target="_blank" href="https://www.notion.so/' + l.notion.page_id.replace(/-/g,'') + '">↗ open in Notion · block ' + l.notion.block_id.slice(0,8) + (l.notion.refined_md_included ? ' · refined ✓' : '') + '</a>' : '');

    // stage chips
    const chips = el('div', 'stage-chips');
    STAGE_LETTERS.forEach(([name, letter]) => {
      let cls = 'sc';
      if (l.stages[name]) cls += ' done';
      else if (name === 'IMAGES' && l.counts.imagesCount > 0) cls += ' partial';
      const chip = el('div', cls);
      chip.textContent = letter;
      chip.title = name + (l.stages[name] ? ' ✓' : '');
      chips.appendChild(chip);
    });

    // images progress
    const imgs = el('div', 'lc-images');
    const ic = l.counts.imagesCount, it = l.counts.imagesTotal;
    const pct = it ? Math.round(ic / it * 100) : 0;
    imgs.innerHTML = '<b>' + ic + '</b> / ' + it + ' images' +
      '<div class="mini-bar"><div class="mini-fill" style="width:' + pct + '%"></div></div>' +
      (l.notion ? '<div style="font-size:10px;color:var(--dim);margin-top:4px;">' + (l.notion.zip_size_bytes/1024/1024).toFixed(1) + ' MB</div>' : '');

    // status badge
    const badge = el('div', 'lc-status ' + l.status);
    const statusText = {
      'complete':         '✓ complete',
      'awaiting-upload':  'awaiting upload',
      'partial-images':   'partial images',
      'in-progress':      'in progress',
      'fetched-only':     'fetched only',
    }[l.status] || l.status;
    badge.textContent = statusText;

    row.appendChild(meta);
    row.appendChild(chips);
    row.appendChild(imgs);
    row.appendChild(badge);
    list.appendChild(row);
  });
}

setInterval(tick, 2000);
tick();
</script></body></html>`;

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url === '/status') {
    try {
      const s = snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(s));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CCA v5 LIVE BOARD');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  open  →  http://localhost:' + PORT);
  console.log('  Ctrl+C to stop.');
  console.log('═══════════════════════════════════════════════════════════════');
});
