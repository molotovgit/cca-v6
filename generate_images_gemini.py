"""Step 4 — generate images via Gemini using the PROVEN flow from the previous
session's working ai_studio + gemini_app scripts.

For each prompt (sequential, single-tab):
  1. Click 'New chat' button
  2. Type prompt fast (15-30ms/char), no embedded newlines
  3. Click 'Send message' button (proven aria-label)
  4. Wait for the 'Stop' button to appear-then-disappear (generation done)
  5. Find the new <img> on canvas, download (handles blob:/data:/http URLs)

Assumes the user is already signed in to gemini.google.com via the keepalive's
profile (cookies persisted). Auto-login via Google SSO is unreliable; one-time
manual sign-in is the proven path.

Usage:
    python generate_images_gemini.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1 --limit 1
"""

from __future__ import annotations

import argparse
import json
import os
import random
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

from tools.browser import gemini as gem

CDP_PORT = int(os.environ.get("GEMINI_CDP_PORT", "9223"))
MAX_WAIT_PER_IMAGE_SECONDS = 300
INTER_GEN_DELAY_MIN = 2.5
INTER_GEN_DELAY_MAX = 5.0


def slugify(text: str, max_len: int = 60) -> str:
    text = text.lower().strip()
    repl = {"ʼ": "", "'": "", "`": ""}
    for src, dst in repl.items():
        text = text.replace(src, dst)
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text).strip("-")
    return text[:max_len].rstrip("-") or "untitled"


def resolve_prompts_file(grade: int, lang: str, subject: str, chapter: int) -> Path:
    subject_slug = slugify(subject)
    folder = REPO / "prompts" / f"g{grade}-{lang}" / subject_slug
    matches = sorted(folder.glob(f"ch{chapter:02d}-*.json"))
    if not matches:
        raise SystemExit(f"No prompts file at {folder}\\ch{chapter:02d}-*.json")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path)
    parser.add_argument("--grade", type=int)
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject")
    parser.add_argument("--chapter", type=int)
    parser.add_argument("--limit", type=int, default=0, help="0 = all")
    parser.add_argument("--start", type=int, default=1)
    args = parser.parse_args()

    if args.input:
        input_path = args.input.resolve()
    elif args.grade and args.subject and args.chapter:
        input_path = resolve_prompts_file(args.grade, args.lang, args.subject, args.chapter)
    else:
        parser.error("either --input <path> or (--grade, --subject, --chapter) is required")

    prompts = json.loads(input_path.read_text(encoding="utf-8"))
    print(f"[gen] loaded {len(prompts)} prompts from {input_path.name}")

    prompts = [p for p in prompts if p["idx"] >= args.start]
    if args.limit > 0:
        prompts = prompts[: args.limit]
    print(f"[gen] will generate {len(prompts)} image(s)")

    base = input_path.stem
    parts = input_path.resolve().parts
    try:
        idx = parts.index("prompts")
    except ValueError:
        raise SystemExit(f"input path missing 'prompts/' segment: {input_path}")
    new_parts = list(parts)
    new_parts[idx] = "images"
    out_dir = Path(*new_parts).parent / base
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[gen] output dir: {out_dir}")

    print(f"[gen] connecting to Gemini keep-alive on :{CDP_PORT}")
    try:
        browser = gem.attach_to_keepalive(CDP_PORT)
    except Exception as e:
        raise SystemExit(
            f"[gen] cannot connect to Gemini keep-alive: {e}\n"
            f"        Start it: python gemini_keepalive.py"
        )

    gem.close_intercept_tabs(CDP_PORT)

    # Find a signed-in Gemini tab (across persistent + incognito contexts)
    print(f"[gen] searching all contexts for a signed-in Gemini tab...")
    print(f"[gen] contexts: {len(browser.contexts)}")
    for i, c in enumerate(browser.contexts):
        urls = [p.url for p in c.pages]
        print(f"  ctx {i}: {len(c.pages)} page(s) — {urls}")

    try:
        context, page = gem.find_signed_in_gemini(browser)
    except RuntimeError as e:
        raise SystemExit(f"[gen] {e}")
    page.bring_to_front()
    print(f"[gen] working tab: {page.url[:120]}")

    # Verify prompt input is actually present (proves signed-in state)
    if not gem._bbox_of_first_visible(page, '[contenteditable="true"]'):
        raise SystemExit(
            "[gen] No contenteditable prompt input — sign in manually first.\n"
            "      In the keepalive's Chromium, sign in to gemini.google.com.\n"
            "      Once 'Ask Gemini' input is visible, re-run."
        )
    print(f"[gen] signed in — prompt input present")

    # ── Sequential generation loop ──
    successes, failures = 0, 0
    for entry in prompts:
        idx = entry["idx"]
        slug = entry["slug"]
        prompt_text = entry["image_prompt"]

        out_file = out_dir / f"{idx:03d}-{slug}.png"
        if out_file.exists() and out_file.stat().st_size > 1024:
            print(f"[gen] {idx:03d} skip (already exists)")
            continue

        print(f"\n[gen] {idx:03d}/{len(prompts)} — {slug}")
        try:
            # New chat for fresh context
            gem.click_new_chat(page)

            # Snapshot baseline images BEFORE submission
            baseline = gem.capture_baseline_image_srcs(page)
            print(f"[gen]   baseline: {len(baseline)} images on page")

            # Submit prompt (clicks input, types fast, clicks Send)
            t0 = time.time()
            gem.submit_prompt(page, prompt_text)
            print(f"[gen]   submitted, waiting for generation to finish...")

            # Wait for Stop button to appear-then-disappear
            done = gem.wait_for_generation_done(page, max_s=MAX_WAIT_PER_IMAGE_SECONDS)
            dt = time.time() - t0
            print(f"[gen]   generation phase done in {dt:.1f}s (saw_stop={done})")

            # Find the new image
            found = gem.find_new_image(page, baseline)
            if not found:
                print(f"[gen]   FAIL: no new image after generation")
                failures += 1
            else:
                print(f"[gen]   found image: {found['w']}x{found['h']}, src starts {found['src'][:60]!r}")
                ok = gem.download_image(page, found["src"], out_file)
                if ok:
                    print(f"[gen]   OK: {out_file.name} ({out_file.stat().st_size:,} bytes)")
                    successes += 1
                else:
                    print(f"[gen]   FAIL: download")
                    failures += 1
        except Exception as e:
            print(f"[gen]   ERROR: {e}")
            failures += 1

        # Pacing — courteous between calls
        wait = random.uniform(INTER_GEN_DELAY_MIN, INTER_GEN_DELAY_MAX)
        print(f"[gen]   sleeping {wait:.1f}s")
        time.sleep(wait)

    print(f"\n[gen] DONE — {successes} succeeded, {failures} failed")
    print(f"[gen] images saved to: {out_dir}")


if __name__ == "__main__":
    main()
