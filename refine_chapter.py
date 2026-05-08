"""Step 2 — refine a fetched chapter via ChatGPT using refine_prompt.txt.

Reads:
    - refine_prompt.txt at repo root (the formula)
    - --input <chapter.md> (output of fetch_chapter.py)
        OR --grade --lang --subject --chapter (resolves to the matching .md)

Writes:
    <input-base>.refined.md alongside the source

Requires:
    chrome_keepalive.py running in another shell, with chatgpt.com logged in.

Usage:
    python refine_chapter.py --input chapters/g7-uz/jahon-tarixi/ch01-...md
    python refine_chapter.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1
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
FORMULA_PATH = REPO / "refine_prompt.txt"


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


def resolve_chapter_file(grade: int, lang: str, subject: str, chapter: int) -> Path:
    """Find the fetched chapter MD by (grade, lang, subject, chapter)."""
    subject_slug = slugify(subject)
    folder = REPO / "chapters" / f"g{grade}-{lang}" / subject_slug
    matches = sorted(folder.glob(f"ch{chapter:02d}-*.md"))
    matches = [m for m in matches if not m.name.endswith(".refined.md")]
    if not matches:
        raise SystemExit(f"No fetched chapter found at {folder}\\ch{chapter:02d}-*.md — run fetch_chapter.py first")
    if len(matches) > 1:
        print(f"[warn] multiple matches for ch{chapter:02d}; using {matches[0].name}")
    return matches[0]


def stage_path(chapter_input_path: Path, stage: str) -> Path:
    """Map chapters/g7-uz/.../ch01-X.md  →  {stage}/g7-uz/.../ch01-X.md

    Uses the relative position of the 'chapters' directory anchor so the
    same subject-folder substructure is mirrored under refined/ or prompts/.
    """
    parts = chapter_input_path.resolve().parts
    try:
        idx = parts.index("chapters")
    except ValueError:
        raise SystemExit(
            f"input path does not contain a 'chapters/' segment: {chapter_input_path}\n"
            f"Expected layout: chapters/g{{N}}-{{lang}}/{{subject}}/ch{{NN}}-X.md"
        )
    new_parts = list(parts)
    new_parts[idx] = stage
    return Path(*new_parts)


def main() -> None:
    parser = argparse.ArgumentParser(description="Refine a chapter via ChatGPT.")
    parser.add_argument("--input", type=Path, help="Direct path to the chapter MD")
    parser.add_argument("--grade", type=int, help="Grade (alternative to --input)")
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject", help="Subject (alternative to --input)")
    parser.add_argument("--chapter", type=int, help="Chapter number (alternative to --input)")
    parser.add_argument("--max-seconds", type=int, default=360,
                        help="Max wait for ChatGPT response (default: 360s)")
    args = parser.parse_args()

    if args.input:
        input_path = args.input.resolve()
    elif args.grade and args.subject and args.chapter:
        input_path = resolve_chapter_file(args.grade, args.lang, args.subject, args.chapter)
    else:
        parser.error("either --input <path> or (--grade, --subject, --chapter) is required")

    if not input_path.exists():
        raise SystemExit(f"input not found: {input_path}")
    if not FORMULA_PATH.exists():
        raise SystemExit(f"formula not found: {FORMULA_PATH}")

    source = input_path.read_text(encoding="utf-8")
    formula = FORMULA_PATH.read_text(encoding="utf-8")

    print(f"[refine] input: {input_path.name} ({len(source):,} chars)")
    print(f"[refine] formula: {FORMULA_PATH.name} ({len(formula):,} chars)")
    print(f"[refine] connecting to keep-alive on :{CDP_PORT}")

    try:
        browser, context = cg.attach_to_keepalive(CDP_PORT)
    except Exception as e:
        raise SystemExit(
            f"[refine] cannot connect to keep-alive Chromium on :{CDP_PORT}\n"
            f"        ({e})\n"
            f"        Start it first in another shell:\n"
            f"            python chrome_keepalive.py"
        )

    page = cg.get_or_open_chatgpt_page(context)
    print(f"[refine] on-page: {page.url}")

    # Always ensure account-logged-in (skip if profile already authenticated).
    email = os.environ.get("CHATGPT_EMAIL", "")
    password = os.environ.get("CHATGPT_PASSWORD", "")
    if not email or not password:
        raise SystemExit(
            "[refine] CHATGPT_EMAIL / CHATGPT_PASSWORD not set in .env"
        )
    try:
        cg.ensure_logged_in(page, email, password)
    except Exception as e:
        raise SystemExit(
            f"[refine] auto-login failed: {e}\n"
            f"        Log in manually in the keep-alive window, then re-run."
        )

    print("[refine] opening fresh conversation")
    REFINE_MIN_CHARS = 5000
    REFINE_MAX_CHARS = 9000
    REFINE_TARGET    = 7500   # used in retry instructions
    MAX_REFINE_ATTEMPTS = 3

    base_prompt = formula.strip() + "\n\n---\n\n" + source.strip()
    response = None
    rlen = 0
    last_kind = None

    for attempt in range(1, MAX_REFINE_ATTEMPTS + 1):
        cg.new_conversation(page)

        if attempt == 1:
            prompt = base_prompt
            print(f"[refine] attempt {attempt}/{MAX_REFINE_ATTEMPTS}: sending {len(prompt):,} chars to ChatGPT...")
        else:
            # Retry preamble: tell ChatGPT specifically how the previous
            # attempt was wrong and what to target. ChatGPT routinely
            # overshoots ~9000-9500 even with the "max 9000" rule in the
            # formula; explicit "your last try was X chars, target N" works.
            if last_kind == "too_long":
                preamble = (
                    f"PREVIOUS ATTEMPT FAILED — your last response was {rlen:,} characters, "
                    f"but the HARD MAXIMUM is {REFINE_MAX_CHARS:,}. Output a TRIMMED version of "
                    f"~{REFINE_TARGET:,} characters. Keep the structure, opening, all 5 👉 markers, "
                    f"conclusion, all 5 questions. Cut redundant adjectives, transitions, and any "
                    f"repeated explanations. Do NOT acknowledge this — output only the trimmed chapter."
                )
            else:  # too_short
                preamble = (
                    f"PREVIOUS ATTEMPT FAILED — your last response was {rlen:,} characters, "
                    f"but the HARD MINIMUM is {REFINE_MIN_CHARS:,}. Output an EXPANDED version of "
                    f"~{REFINE_TARGET:,} characters with more historical detail and more dramatic "
                    f"narrative. Keep the structure, opening, all 5 👉 markers, conclusion, all 5 "
                    f"questions. Do NOT acknowledge this — output only the expanded chapter."
                )
            prompt = preamble + "\n\n---\n\n" + base_prompt
            print(f"[refine] attempt {attempt}/{MAX_REFINE_ATTEMPTS}: retry with {('trim' if last_kind=='too_long' else 'expand')} instruction ({len(prompt):,} chars)")

        t0 = time.time()
        response = cg.send_and_collect(page, prompt, max_ms=args.max_seconds * 1000)
        dt = time.time() - t0
        rlen = len(response)
        print(f"[refine]   response received ({rlen:,} chars in {dt:.1f}s)")

        if REFINE_MIN_CHARS <= rlen <= REFINE_MAX_CHARS:
            print(f"[refine]   ✓ in range; accepting (attempt {attempt})")
            break
        last_kind = "too_long" if rlen > REFINE_MAX_CHARS else "too_short"
        if attempt < MAX_REFINE_ATTEMPTS:
            head = response[:120].replace("\n", " | ")
            print(f"[refine]   ✗ out of range ({last_kind}); first 120c: {head}")
            print(f"[refine]   retrying...")

    # After all attempts, if still out of range, fail without writing.
    if not (REFINE_MIN_CHARS <= rlen <= REFINE_MAX_CHARS):
        kind = "too short — likely a meta-acknowledgement" if rlen < REFINE_MIN_CHARS else "too long — exceeds the 9k cap"
        head = response[:200].replace("\n", " | ")
        raise SystemExit(
            f"[refine] OUT-OF-BOUNDS after {MAX_REFINE_ATTEMPTS} attempts: {rlen:,} chars "
            f"(allowed: {REFINE_MIN_CHARS:,}-{REFINE_MAX_CHARS:,}) — {kind}\n"
            f"        first 200 chars: {head}\n"
            f"        not writing to disk; next run will re-attempt REFINE."
        )

    out_path = stage_path(input_path, "refined")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(response, encoding="utf-8")

    meta_path = out_path.with_suffix(".meta.json")
    meta_path.write_text(
        json.dumps(
            {
                "source_chapter": str(input_path.relative_to(REPO)).replace("\\", "/"),
                "formula": FORMULA_PATH.name,
                "input_chars": len(source),
                "output_chars": len(response),
                "elapsed_seconds": round(dt, 1),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(f"[refine] wrote {out_path}")
    print(f"[refine] wrote {meta_path}")


if __name__ == "__main__":
    main()
