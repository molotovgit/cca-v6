// Check which images from prompts.json have been saved to the images folder.
// Prints a summary + list of missing entries; optionally writes a JSON of
// missing prompts that can be passed back to the generator for re-runs.
//
// Usage:
//   node scripts/check_images.cjs <prompts.json>
//   node scripts/check_images.cjs <prompts.json> --write-missing
//       (also writes <prompts>.missing.json next to the input — a JSON array
//        of just the missing entries, ready to feed to the generator)

'use strict';
const path = require('path');
const fs   = require('fs');

const MIN_VALID_BYTES = 5 * 1024;  // anything <5KB is probably a stub / failed gen

function deriveOutputDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'images';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

(async () => {
  const promptsPath = process.argv[2];
  const writeMissing = process.argv.includes('--write-missing');
  if (!promptsPath) {
    console.error('Usage: node check_images.cjs <prompts.json> [--write-missing]');
    process.exit(1);
  }
  if (!fs.existsSync(promptsPath)) {
    console.error(`prompts file not found: ${promptsPath}`);
    process.exit(1);
  }

  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const outDir = deriveOutputDir(promptsPath);

  console.log(`[check] prompts:  ${path.basename(promptsPath)}  (${prompts.length} entries)`);
  console.log(`[check] images:   ${outDir}`);
  console.log('');

  const present = [];
  const missing = [];
  const small = [];   // exists but too small (likely failed)

  for (const entry of prompts) {
    const expected = `${String(entry.idx).padStart(3, '0')}-${entry.slug}.png`;
    const fullPath = path.join(outDir, expected);
    if (!fs.existsSync(fullPath)) {
      missing.push({ idx: entry.idx, slug: entry.slug, expected });
      continue;
    }
    const size = fs.statSync(fullPath).size;
    if (size < MIN_VALID_BYTES) {
      small.push({ idx: entry.idx, slug: entry.slug, expected, size });
      continue;
    }
    present.push({ idx: entry.idx, slug: entry.slug, expected, size });
  }

  // Also list "extra" files in the dir that don't match any expected name
  const expectedSet = new Set(prompts.map(e => `${String(e.idx).padStart(3, '0')}-${e.slug}.png`));
  let actualFiles = [];
  if (fs.existsSync(outDir)) {
    actualFiles = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.png'));
  }
  const extras = actualFiles.filter(f => !expectedSet.has(f));

  // ── Summary ──
  console.log(`────── SUMMARY ──────`);
  console.log(`  ✓ present:  ${present.length} / ${prompts.length}  (${(present.length / prompts.length * 100).toFixed(1)}%)`);
  console.log(`  ✗ missing:  ${missing.length}`);
  console.log(`  ⚠ small (likely bad): ${small.length}`);
  console.log(`  ? extras (unexpected files): ${extras.length}`);

  if (missing.length > 0) {
    console.log(`\n────── MISSING ──────`);
    for (const m of missing) {
      console.log(`  [${String(m.idx).padStart(3, '0')}] ${m.slug}`);
    }
  }

  if (small.length > 0) {
    console.log(`\n────── TOO SMALL (re-gen recommended) ──────`);
    for (const s of small) {
      console.log(`  [${String(s.idx).padStart(3, '0')}] ${s.slug}  (${(s.size / 1024).toFixed(1)} KB)`);
    }
  }

  if (extras.length > 0) {
    console.log(`\n────── UNEXPECTED FILES ──────`);
    for (const x of extras) console.log(`  ${x}`);
  }

  // ── Optionally write missing-list JSON ──
  if (writeMissing && (missing.length > 0 || small.length > 0)) {
    // Build a prompt array for the missing/small entries by idx lookup
    const needIdxs = new Set([...missing.map(m => m.idx), ...small.map(s => s.idx)]);
    const needPrompts = prompts.filter(p => needIdxs.has(p.idx));
    const outPath = promptsPath.replace(/\.json$/i, '.missing.json');
    fs.writeFileSync(outPath, JSON.stringify(needPrompts, null, 2));
    console.log(`\n[check] wrote ${needPrompts.length} entries to: ${outPath}`);
    console.log(`[check] re-run with:`);
    console.log(`        node scripts\\generate_images_gemini_parallel.cjs "${outPath}"`);
  }

  // Exit code: 0 if all present, 1 if any missing/small (useful for scripting)
  process.exit(missing.length + small.length > 0 ? 1 : 0);
})();
