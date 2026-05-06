// Build a visual HTML report from per-chapter pipeline logs.
//
// Reads:    reports/ch{NN}.log  — copy each chapter's pipeline stdout here
// Writes:   reports/index.html
//
// Parses each log to extract:
//   • Per-stage duration (FETCH, REFINE, PROMPTS, IMAGES, ANIMATE)
//   • Per-image save time (image stage)
//   • Per-video render+save time (animate stage)
//   • Rate-limit hits, rescue events
//   • Final saved counts
//
// Usage:
//   node scripts/build_report.cjs
//   open reports/index.html in any browser

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(REPO, 'reports');

function parseLog(text) {
  const out = {
    stages: {},          // FETCH/REFINE/PROMPTS/IMAGES/ANIMATE → seconds
    imageSaves: [],      // per-image durations (sec)
    videoSaves: [],      // per-video durations (sec)
    rescuesImage: 0,
    rescuesAnimate: 0,
    rateLimitHits: 0,
    saverRestarts: 0,
    finalImagesSaved: 0,
    finalVideosSaved: 0,
    submitErrors: 0,
    totalSeconds: 0,
    pipelineDone: false,
    pipelineSummary: null,
  };

  // Per-stage durations from "[1/5 FETCH] ✓ done in 6.5s"
  for (const m of text.matchAll(/\[(\d+)\/5 (FETCH|REFINE|PROMPTS|IMAGES|ANIMATE)\] ✓ done in ([\d.]+)s/g)) {
    out.stages[m[2]] = parseFloat(m[3]);
  }

  // Per-image save lines: "[save] 037 desert-rest-stop  → 456x249 725 KB"
  // (We can't get duration from these directly — image stage doesn't log per-image time.)
  // Instead use submission-to-save delta if available, or just count.
  for (const _ of text.matchAll(/\[save\] (\d{3}) [\w-]+/g)) out.imageSaves.push(0);

  // Per-video save lines: "[anim] 010 ✓ saved 3.11 MB  71.0s  → 010-...mp4  (saved: 10/80)"
  for (const m of text.matchAll(/\[anim\] (\d{3}) ✓ saved [\d.]+ MB\s+([\d.]+)s/g)) {
    out.videoSaves.push({ idx: parseInt(m[1], 10), seconds: parseFloat(m[2]) });
  }

  // Rate-limit + rescue counters
  out.rateLimitHits   = (text.match(/⚠ rate-limit:.*new failed tile/g) || []).length;
  out.rescuesImage    = (text.match(/=== RESCUE TRIGGERED ===/g) || []).length;
  out.rescuesAnimate  = (text.match(/\[runner\] launching animator \(attempt #(\d+)/g) || []).length;
  out.saverRestarts   = (text.match(/\[ORCH\] saver STALLED \d+s with \d+ pending — restarting/g) || []).length;
  out.submitErrors    = (text.match(/\[anim\] submit failed for \d+/g) || []).length;

  // Final saved counts
  const imgDoneMatch = text.match(/=== DONE ===\s+(\d+)\/\d+ saved.*disk-verified/);
  if (imgDoneMatch) out.finalImagesSaved = parseInt(imgDoneMatch[1], 10);
  const animDoneMatch = text.match(/saved: (\d+)\/\d+\)$/m) || text.match(/total (\d+)\/\d+ videos saved/);
  if (animDoneMatch) out.finalVideosSaved = parseInt(animDoneMatch[1], 10);

  // Pipeline final summary
  const pipelineDoneMatch = text.match(/✓ PIPELINE DONE\s+—\s+([\d.]+)\s+min/);
  if (pipelineDoneMatch) {
    out.pipelineDone = true;
    out.totalSeconds = parseFloat(pipelineDoneMatch[1]) * 60;
  }

  // Sum stages if no PIPELINE DONE line yet
  if (out.totalSeconds === 0) {
    out.totalSeconds = Object.values(out.stages).reduce((a, b) => a + b, 0);
  }

  return out;
}

function fmtSec(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(0);
  return `${m}m ${r}s`;
}

function loadAllChapters() {
  const chapters = [];
  if (!fs.existsSync(REPORTS_DIR)) return chapters;
  const files = fs.readdirSync(REPORTS_DIR).filter(f => /^ch\d+\.log$/.test(f)).sort();
  for (const file of files) {
    const ch = file.match(/^ch(\d+)\.log$/)[1];
    const text = fs.readFileSync(path.join(REPORTS_DIR, file), 'utf-8');
    chapters.push({ ch, file, parsed: parseLog(text) });
  }
  return chapters;
}

function buildHtml(chapters) {
  const totalImagesSaved = chapters.reduce((s, c) => s + c.parsed.finalImagesSaved, 0);
  const totalVideosSaved = chapters.reduce((s, c) => s + c.parsed.finalVideosSaved, 0);
  const totalSeconds = chapters.reduce((s, c) => s + c.parsed.totalSeconds, 0);
  const totalRescues = chapters.reduce((s, c) => s + c.parsed.rescuesImage + c.parsed.rescuesAnimate, 0);
  const totalRateLimits = chapters.reduce((s, c) => s + c.parsed.rateLimitHits, 0);
  const allVideoTimes = chapters.flatMap(c => c.parsed.videoSaves.map(v => v.seconds));
  const avgVideoTime = allVideoTimes.length ? allVideoTimes.reduce((a, b) => a + b, 0) / allVideoTimes.length : 0;
  const minVideoTime = allVideoTimes.length ? Math.min(...allVideoTimes) : 0;
  const maxVideoTime = allVideoTimes.length ? Math.max(...allVideoTimes) : 0;
  const stageColors = {
    FETCH:    '#7dd3fc',
    REFINE:   '#a78bfa',
    PROMPTS:  '#fbbf24',
    IMAGES:   '#34d399',
    ANIMATE:  '#fb7185',
  };
  const maxStageTotal = Math.max(1, ...chapters.map(c => c.parsed.totalSeconds));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Creative Automation — Pipeline Report</title>
<style>
  :root {
    --bg: #0b1020; --panel: #131a2e; --panel-2: #1a2240; --text: #e5e7eb;
    --muted: #94a3b8; --accent: #38bdf8; --good: #34d399; --warn: #fbbf24;
    --bad: #fb7185; --grid: #1f2937;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.5px; }
  .subtitle { color: var(--muted); margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: var(--panel); border-radius: 10px; padding: 18px; border: 1px solid var(--grid); }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card .value { font-size: 26px; font-weight: 600; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--grid); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: var(--panel); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--grid); }
  th { background: var(--panel-2); color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { display: flex; height: 24px; border-radius: 6px; overflow: hidden; background: var(--panel-2); margin: 6px 0; }
  .bar > div { height: 100%; transition: width .3s; min-width: 0; position: relative; }
  .bar > div:hover { filter: brightness(1.2); }
  .bar > div span { position: absolute; left: 4px; top: 50%; transform: translateY(-50%); font-size: 10px; color: rgba(0,0,0,0.7); font-weight: 600; white-space: nowrap; overflow: hidden; }
  .legend { display: flex; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; }
  .video-bar { background: var(--panel-2); border-radius: 6px; padding: 12px; }
  .video-bar svg { width: 100%; height: 60px; display: block; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill.ok { background: rgba(52, 211, 153, 0.2); color: var(--good); }
  .pill.warn { background: rgba(251, 191, 36, 0.2); color: var(--warn); }
  .pill.bad { background: rgba(251, 113, 133, 0.2); color: var(--bad); }
  .footer { color: var(--muted); font-size: 11px; margin-top: 40px; text-align: center; }
</style>
</head>
<body>

<h1>Creative Automation — Pipeline Report</h1>
<div class="subtitle">${chapters.length} chapters processed · generated ${new Date().toISOString().substr(0, 19).replace('T', ' ')}</div>

<div class="grid">
  <div class="card">
    <div class="label">Chapters</div>
    <div class="value">${chapters.length}</div>
    <div class="sub">${chapters.filter(c => c.parsed.pipelineDone).length} fully complete</div>
  </div>
  <div class="card">
    <div class="label">Total time</div>
    <div class="value">${fmtSec(totalSeconds)}</div>
    <div class="sub">across all stages, all chapters</div>
  </div>
  <div class="card">
    <div class="label">Images saved</div>
    <div class="value">${totalImagesSaved}</div>
    <div class="sub">of ${chapters.length * 80} expected</div>
  </div>
  <div class="card">
    <div class="label">Videos saved</div>
    <div class="value">${totalVideosSaved}</div>
    <div class="sub">of ${chapters.length * 80} expected</div>
  </div>
  <div class="card">
    <div class="label">Avg video render</div>
    <div class="value">${avgVideoTime.toFixed(1)}s</div>
    <div class="sub">range ${minVideoTime.toFixed(1)}s – ${maxVideoTime.toFixed(1)}s</div>
  </div>
  <div class="card">
    <div class="label">Auto-recoveries</div>
    <div class="value">${totalRescues}</div>
    <div class="sub">${totalRateLimits} rate-limit hits handled</div>
  </div>
</div>

<h2>Per-chapter timeline</h2>
<div class="legend">
  ${Object.entries(stageColors).map(([s, c]) =>
    `<div class="legend-item"><div class="legend-swatch" style="background:${c}"></div>${s}</div>`).join('')}
</div>
${chapters.map(c => {
  const stages = c.parsed.stages;
  const total = c.parsed.totalSeconds;
  return `
  <div style="margin-bottom: 12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <strong>Chapter ${c.ch}</strong>
      <span style="color:var(--muted);font-size:12px;">${fmtSec(total)} · imgs ${c.parsed.finalImagesSaved}/80 · vids ${c.parsed.finalVideosSaved}/80
      ${c.parsed.pipelineDone ? '<span class="pill ok">DONE</span>' : '<span class="pill warn">PARTIAL</span>'}</span>
    </div>
    <div class="bar">
      ${Object.entries(stageColors).map(([s, color]) => {
        const sec = stages[s] || 0;
        const pct = total > 0 ? (sec / total * 100) : 0;
        if (pct < 0.1) return '';
        return `<div style="width:${pct}%;background:${color}" title="${s}: ${fmtSec(sec)}"><span>${pct >= 8 ? `${s} ${fmtSec(sec)}` : ''}</span></div>`;
      }).join('')}
    </div>
  </div>`;
}).join('')}

<h2>Stage breakdown</h2>
<table>
  <thead>
    <tr>
      <th>Chapter</th>
      <th class="num">Fetch</th>
      <th class="num">Refine</th>
      <th class="num">Prompts</th>
      <th class="num">Images</th>
      <th class="num">Animate</th>
      <th class="num">Total</th>
      <th class="num">Imgs</th>
      <th class="num">Vids</th>
      <th class="num">Recov.</th>
    </tr>
  </thead>
  <tbody>
    ${chapters.map(c => {
      const s = c.parsed.stages;
      const recov = c.parsed.rescuesImage + c.parsed.rescuesAnimate + c.parsed.saverRestarts;
      const recovClass = recov === 0 ? 'ok' : recov <= 3 ? 'warn' : 'bad';
      return `
      <tr>
        <td><strong>${c.ch}</strong></td>
        <td class="num">${s.FETCH ? fmtSec(s.FETCH) : '—'}</td>
        <td class="num">${s.REFINE ? fmtSec(s.REFINE) : '—'}</td>
        <td class="num">${s.PROMPTS ? fmtSec(s.PROMPTS) : '—'}</td>
        <td class="num">${s.IMAGES ? fmtSec(s.IMAGES) : '—'}</td>
        <td class="num">${s.ANIMATE ? fmtSec(s.ANIMATE) : '—'}</td>
        <td class="num"><strong>${fmtSec(c.parsed.totalSeconds)}</strong></td>
        <td class="num">${c.parsed.finalImagesSaved}/80</td>
        <td class="num">${c.parsed.finalVideosSaved}/80</td>
        <td class="num"><span class="pill ${recovClass}">${recov}</span></td>
      </tr>`;
    }).join('')}
  </tbody>
</table>

<h2>Per-video animation times</h2>
${chapters.map(c => {
  if (c.parsed.videoSaves.length === 0) return '';
  const max = Math.max(...c.parsed.videoSaves.map(v => v.seconds), 1);
  const w = Math.max(800, c.parsed.videoSaves.length * 10);
  const barW = w / Math.max(c.parsed.videoSaves.length, 1) - 1;
  const avg = c.parsed.videoSaves.reduce((a, b) => a + b.seconds, 0) / c.parsed.videoSaves.length;
  return `
  <div style="margin-bottom: 18px;">
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <strong>Chapter ${c.ch}</strong>
      <span style="color:var(--muted);font-size:12px;">avg ${avg.toFixed(1)}s · ${c.parsed.videoSaves.length} videos · max ${max.toFixed(1)}s</span>
    </div>
    <div class="video-bar">
      <svg viewBox="0 0 ${w} 60" preserveAspectRatio="none">
        ${c.parsed.videoSaves.map((v, i) => {
          const h = (v.seconds / max) * 56;
          const color = v.seconds > 90 ? '#fb7185' : v.seconds > 60 ? '#fbbf24' : '#34d399';
          return `<rect x="${i * (w / c.parsed.videoSaves.length)}" y="${60 - h}" width="${barW}" height="${h}" fill="${color}"><title>idx ${v.idx}: ${v.seconds.toFixed(1)}s</title></rect>`;
        }).join('')}
      </svg>
    </div>
  </div>`;
}).join('')}

<div class="footer">
  Built by build_report.cjs · v2 fixes: zombie-rescue + atomic retry + adaptive backoff
</div>

</body>
</html>
`;
}

(function main() {
  const chapters = loadAllChapters();
  if (chapters.length === 0) {
    console.error(`No chXX.log files in ${REPORTS_DIR}. Snapshot pipeline logs there first.`);
    process.exit(1);
  }
  console.log(`Loaded ${chapters.length} chapter logs:`);
  for (const c of chapters) {
    const p = c.parsed;
    console.log(`  ch${c.ch}: total=${fmtSec(p.totalSeconds)}  images=${p.finalImagesSaved}/80  videos=${p.finalVideosSaved}/80  recoveries=${p.rescuesImage + p.rescuesAnimate + p.saverRestarts}`);
  }
  const html = buildHtml(chapters);
  const outPath = path.join(REPORTS_DIR, 'index.html');
  fs.writeFileSync(outPath, html);
  console.log(`\nReport written → ${outPath}`);
  console.log(`Open in browser to view.`);
})();
