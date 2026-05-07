"""Step 3 — generate 80 image prompts via ChatGPT in 4 batches of 20.

Uses 80_prompt_formula.txt + the refined chapter MD. The formula already
specifies "Output in groups of 20", so we send the formula + refined text
on batch 1, then send continuation prompts ("Continue with prompts 21-40")
for batches 2-4. Each batch is requested as a strict JSON array so we can
parse it cleanly into the final prompts.json.

Each ChatGPT raw response is saved alongside the parsed JSON for
traceability:

    chapters/{g}-{lang}/{subject}/
      ch{NN}-...prompts.raw.md       (all 4 ChatGPT answers concatenated)
      ch{NN}-...prompts.json         (parsed [{idx, slug, image_prompt, motion_script}])
      ch{NN}-...prompts.meta.json    (run metadata)

Usage:
    python generate_prompts.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1
    python generate_prompts.py --input chapters/.../ch01-...refined.md
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()

REPO = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO))

from tools.browser import chatgpt as cg

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
FORMULA_PATH = REPO / "80_prompt_formula.txt"
TOTAL_PROMPTS = 80
BATCH_SIZE = 20
NUM_BATCHES = TOTAL_PROMPTS // BATCH_SIZE  # 4

# Default motion script when the scene has no meaningful motion in the source.
DEFAULT_MOTION_SCRIPT = "drone shot animated slowly"

# Structured-output instruction appended to the formula on batch 1.
STRUCTURED_OUTPUT_INSTRUCTION = """OUTPUT FORMAT (strict — machine-parsable):
Return ONLY a JSON array, no markdown fences, no commentary before or after.
Each entry MUST have these four fields:
  - idx: integer for this scene
  - slug: short kebab-case identifier (3-6 words summarizing the scene)
  - image_prompt: the full prompt ending with the locked style line
  - motion_script: a short Veo motion description if the source text shows meaningful
                   motion in this scene, otherwise null

Example of a single entry:
{"idx": 1, "slug": "germanic-tribes-misty-forest", "image_prompt": "Ancient northern Europe wide forest landscape... clean cinematic historical illustration, slightly simplified, semi-realistic, smooth shading, sharp edges, no brush texture, no paint effect, full-frame, no text, no borders", "motion_script": "drone shot slowly panning across the misty forest"}

For this first batch, return prompts 1 through 20.
"""


def slugify(text: str, max_len: int = 60) -> str:
    text = text.lower().strip()
    repl = {
        "ʼ": "", "'": "", "`": "",
        "ў": "o", "қ": "q", "ғ": "g", "ҳ": "h", "ё": "yo", "ю": "yu", "я": "ya",
        "ш": "sh", "ч": "ch", "ц": "ts", "ж": "j", "й": "y",
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "з": "z",
        "и": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
        "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "x",
        "ъ": "", "ы": "i", "ь": "", "э": "e",
    }
    for src, dst in repl.items():
        text = text.replace(src, dst)
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text).strip("-")
    return text[:max_len].rstrip("-") or "untitled"


def resolve_refined_file(grade: int, lang: str, subject: str, chapter: int) -> Path:
    """Find the refined chapter MD by (grade, lang, subject, chapter).

    Lives in refined/g{N}-{lang}/{subject-slug}/ch{NN}-X.md
    (mirrored from chapters/, same basename).
    """
    subject_slug = slugify(subject)
    folder = REPO / "refined" / f"g{grade}-{lang}" / subject_slug
    matches = sorted(folder.glob(f"ch{chapter:02d}-*.md"))
    matches = [m for m in matches if not m.name.endswith(".meta.json")]
    if not matches:
        raise SystemExit(f"No refined chapter found at {folder}\\ch{chapter:02d}-*.md — run refine_chapter.py first")
    if len(matches) > 1:
        print(f"[warn] multiple matches; using {matches[0].name}")
    return matches[0]


def stage_path(refined_input_path: Path, stage: str) -> Path:
    """Map refined/g7-uz/.../ch01-X.md  →  {stage}/g7-uz/.../ch01-X.<ext>

    Mirrors the subject-folder substructure under the new top-level stage.
    """
    parts = refined_input_path.resolve().parts
    try:
        idx = parts.index("refined")
    except ValueError:
        raise SystemExit(
            f"input path does not contain a 'refined/' segment: {refined_input_path}\n"
            f"Expected layout: refined/g{{N}}-{{lang}}/{{subject}}/ch{{NN}}-X.md"
        )
    new_parts = list(parts)
    new_parts[idx] = stage
    return Path(*new_parts)


def extract_json_array(text: str) -> list:
    """Try several strategies to pull a JSON array out of a ChatGPT response."""
    # Strategy 1: direct parse
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
    except Exception:
        pass

    # Strategy 2: ```json fenced block
    m = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass

    # Strategy 3: first [ ... last ] in the text
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        candidate = text[start:end + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass

    raise ValueError(
        f"Could not extract JSON array from response. First 500 chars:\n{text[:500]}"
    )


def normalize_entry(raw: dict, expected_idx: int) -> dict:
    """Normalize a single prompt entry, filling defaults and renumbering."""
    image_prompt = (raw.get("image_prompt") or raw.get("prompt") or "").strip()
    if not image_prompt:
        raise ValueError(f"Entry {expected_idx} missing image_prompt: {raw}")

    slug = (raw.get("slug") or "").strip()
    if not slug:
        # Generate from first few meaningful words of the prompt
        words = re.findall(r"[A-Za-z]+", image_prompt)[:5]
        slug = slugify(" ".join(words)) or f"scene-{expected_idx:03d}"

    motion = raw.get("motion_script")
    if isinstance(motion, str):
        motion = motion.strip()
        if not motion or motion.lower() in ("null", "none", "n/a"):
            motion = None

    return {
        "idx": expected_idx,
        "slug": slug,
        "image_prompt": image_prompt,
        "motion_script": motion,  # None or string
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate 80 image prompts via ChatGPT in batches of 20.")
    parser.add_argument("--input", type=Path, help="Direct path to the .refined.md")
    parser.add_argument("--grade", type=int)
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject")
    parser.add_argument("--chapter", type=int)
    parser.add_argument("--max-seconds-per-batch", type=int, default=300,
                        help="Max wait per ChatGPT batch response (default: 300s)")
    args = parser.parse_args()

    if args.input:
        input_path = args.input.resolve()
    elif args.grade and args.subject and args.chapter:
        input_path = resolve_refined_file(args.grade, args.lang, args.subject, args.chapter)
    else:
        parser.error("either --input <path> or (--grade, --subject, --chapter) is required")

    if not input_path.exists():
        raise SystemExit(f"input not found: {input_path}")
    if not FORMULA_PATH.exists():
        raise SystemExit(f"formula not found: {FORMULA_PATH}")

    refined = input_path.read_text(encoding="utf-8")
    formula = FORMULA_PATH.read_text(encoding="utf-8")

    print(f"[prompts] input: {input_path.name} ({len(refined):,} chars)")
    print(f"[prompts] formula: {FORMULA_PATH.name} ({len(formula):,} chars)")
    print(f"[prompts] target: {TOTAL_PROMPTS} prompts in {NUM_BATCHES} batches of {BATCH_SIZE}")
    print(f"[prompts] connecting to keep-alive on :{CDP_PORT}")

    try:
        browser, context = cg.attach_to_keepalive(CDP_PORT)
    except Exception as e:
        raise SystemExit(
            f"[prompts] cannot connect to keep-alive on :{CDP_PORT} ({e}).\n"
            f"        Start it: python chrome_keepalive.py"
        )

    page = cg.get_or_open_chatgpt_page(context)
    print(f"[prompts] on-page: {page.url}")

    email = os.environ.get("CHATGPT_EMAIL", "")
    password = os.environ.get("CHATGPT_PASSWORD", "")
    if email and password:
        try:
            cg.ensure_logged_in(page, email, password)
        except Exception as e:
            raise SystemExit(f"[prompts] auto-login failed: {e}")

    raw_batches = []
    parsed_entries = []

    # Each batch opens its OWN conversation. The previous design sent batch 1
    # with full context and batches 2-4 as "continue" follow-ups in the same
    # conversation. This consistently failed at batch 4/4 with a 300s timeout
    # ("no new assistant message; assistant count unchanged") because ChatGPT
    # silently throttles after ~3 long-output turns in a single conversation.
    # Independent conversations are slower (each one re-sends the formula +
    # refined chapter, ~10k input chars × 4) but every batch is the FIRST
    # message in a fresh conversation, so the throttle never triggers.
    for batch_idx in range(NUM_BATCHES):
        start = batch_idx * BATCH_SIZE + 1
        end = start + BATCH_SIZE - 1

        # Approximate which quarter of the chronological story this batch
        # should cover, so ChatGPT (which has no memory of the other batches)
        # focuses on the right segment of the chapter narrative.
        seg_pct_lo = batch_idx * (100 // NUM_BATCHES)
        seg_pct_hi = (batch_idx + 1) * (100 // NUM_BATCHES)
        batch_instruction = (
            "OUTPUT FORMAT (strict — machine-parsable):\n"
            f"Return ONLY a JSON array of {BATCH_SIZE} entries, no markdown fences, no commentary before or after.\n"
            "Each entry MUST have these four fields:\n"
            "  - idx: integer for this scene\n"
            "  - slug: short kebab-case identifier (3-6 words summarizing the scene)\n"
            "  - image_prompt: the full prompt ending with the locked style line\n"
            "  - motion_script: a short Veo motion description if the source text shows meaningful motion in this scene, otherwise null\n\n"
            "Example of a single entry:\n"
            '{"idx": 1, "slug": "germanic-tribes-misty-forest", "image_prompt": "Ancient northern Europe wide forest landscape... clean cinematic historical illustration, slightly simplified, semi-realistic, smooth shading, sharp edges, no brush texture, no paint effect, full-frame, no text, no borders", "motion_script": "drone shot slowly panning across the misty forest"}\n\n'
            f"For THIS batch, return prompts {start} through {end} only — index the entries {start}, {start+1}, ..., {end}.\n"
            f"The 80-scene story is CHRONOLOGICAL across the chapter; this batch covers approximately the {seg_pct_lo}%-{seg_pct_hi}% segment of the chapter narrative. Stay within that segment of the story."
        )

        print(f"\n[prompts] batch {batch_idx + 1}/{NUM_BATCHES} ({start}-{end}) — opening fresh conversation")
        cg.new_conversation(page)

        prompt = (
            formula.strip()
            + "\n\n---\n\n"
            + batch_instruction
            + "\n\n---\n\nSOURCE TEXT (refined chapter):\n\n"
            + refined.strip()
        )
        print(f"[prompts]   sending {len(prompt):,} chars")

        t0 = time.time()
        response = cg.send_and_collect(page, prompt, max_ms=args.max_seconds_per_batch * 1000)
        dt = time.time() - t0
        print(f"[prompts]   response received: {len(response):,} chars in {dt:.1f}s")

        raw_batches.append(response)

        try:
            entries_raw = extract_json_array(response)
        except ValueError as e:
            raise SystemExit(f"[prompts] batch {batch_idx + 1} parse failed: {e}")

        if len(entries_raw) != BATCH_SIZE:
            print(f"[prompts]   WARNING: expected {BATCH_SIZE} entries, got {len(entries_raw)}")

        for i, raw in enumerate(entries_raw):
            try:
                normalized = normalize_entry(raw, expected_idx=start + i)
                parsed_entries.append(normalized)
            except ValueError as e:
                print(f"[prompts]   skip malformed entry: {e}")

    if len(parsed_entries) != TOTAL_PROMPTS:
        print(f"[prompts] WARNING: expected {TOTAL_PROMPTS} prompts, got {len(parsed_entries)}")

    # Re-index 1..N to be safe.
    for i, entry in enumerate(parsed_entries):
        entry["idx"] = i + 1

    # ── Save outputs to prompts/ folder, mirroring refined/ subject substructure ──
    out_md_path = stage_path(input_path, "prompts")  # ch01-X.md in prompts/...
    out_md_path.parent.mkdir(parents=True, exist_ok=True)
    base = out_md_path.with_suffix("")  # strip .md → ch01-X

    raw_path = base.with_suffix(".raw.md")
    json_path = base.with_suffix(".json")
    meta_path = base.with_suffix(".meta.json")

    # Raw: all batches concatenated with section headers
    raw_doc = []
    for i, batch in enumerate(raw_batches):
        s, e = i * BATCH_SIZE + 1, (i + 1) * BATCH_SIZE
        raw_doc.append(f"## Batch {i + 1} — prompts {s}-{e}\n\n{batch.strip()}\n")
    raw_path.write_text("\n".join(raw_doc), encoding="utf-8")

    json_path.write_text(
        json.dumps(parsed_entries, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    motion_count = sum(1 for e in parsed_entries if e["motion_script"])
    meta_path.write_text(
        json.dumps(
            {
                "input": input_path.name,
                "formula": FORMULA_PATH.name,
                "total_prompts": len(parsed_entries),
                "batches": NUM_BATCHES,
                "batch_size": BATCH_SIZE,
                "motion_scripts_populated": motion_count,
                "motion_scripts_default_fallback": len(parsed_entries) - motion_count,
                "default_motion_script": DEFAULT_MOTION_SCRIPT,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(f"\n[prompts] DONE: {len(parsed_entries)} prompts ({motion_count} with motion script, {len(parsed_entries) - motion_count} default)")
    print(f"[prompts] wrote {raw_path}")
    print(f"[prompts] wrote {json_path}")
    print(f"[prompts] wrote {meta_path}")


if __name__ == "__main__":
    main()
