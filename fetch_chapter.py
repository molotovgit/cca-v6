"""Step 1 — fetch a single textbook chapter from Notion.

Uses the NVL Notion read layer (tools/notion/) with the official
NOTION_API_KEY (loaded from .env). Output is written to
chapters/g{N}-{lang}/{subject-slug}/ch{NN}-{chapter-slug}.md
plus a .meta.json sibling.

Usage:
    python fetch_chapter.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1
    python fetch_chapter.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1 -v
"""

import argparse
import json
import logging
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

# Force UTF-8 console output on Windows so Uzbek diacritics render correctly
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools.notion import NotionExtractor


def clean_chapter_title(title: str) -> str:
    """Strip the leading chapter-number prefix from a Notion title.

    The chapter number is already encoded in the ch{NN}- filename prefix,
    so leaving it inside the title slug too produces noisy basenames like
    'ch01-1-mavzu-german-...' — strip the prefix here so we get
    'ch01-german-...' instead.

    Handles all the Notion title shapes seen in the workspace:
        '1-mavzu. German qabilalari'  -> 'German qabilalari'
        '2-3-mavzu: Franklar davlati' -> 'Franklar davlati'
        'Mavzu 7. Title'              -> 'Title'
        '5-§. Tarixda yil hisobi'     -> 'Tarixda yil hisobi'
        '§5. Title'                   -> 'Title'
        'Глава 7. Title'              -> 'Title'
    """
    t = title.strip()
    patterns = [
        r"^\d+\s*-\s*\d+\s*-\s*mavzu\s*[.:]?\s*",  # '2-3-mavzu:'
        r"^\d+\s*-\s*mavzu\s*[.:]?\s*",            # '1-mavzu:' or '1-mavzu.'
        r"^[Mm]avzu\s*\d+\s*[.:]?\s*",             # 'Mavzu 7.'
        r"^\d+\s*-\s*§\s*[.:]?\s*",                # '5-§.'
        r"^§\s*\d+\s*[.:]?\s*",                    # '§5.'
        r"^[Гг]лава\s*\d+\s*[.:]?\s*",             # 'Глава 7.'
        r"^[Бб]об\s*\d+\s*[.:]?\s*",               # 'Боб 7.'
        r"^[Тт]ема\s*\d+\s*[.:]?\s*",              # 'Тема 7.'
        r"^[Уу]рок\s*\d+\s*[.:]?\s*",              # 'Урок 7.'
        r"^\d+\s*[.:)]\s+",                        # '5. ' or '5: ' or '5) '
    ]
    for p in patterns:
        new_t = re.sub(p, "", t, count=1)
        if new_t != t:
            t = new_t
            break
    return t.strip()


def slugify(text: str, max_len: int = 60) -> str:
    """Lowercase, strip diacritics-ish, collapse spaces to dashes."""
    text = text.lower().strip()
    # Replace common Uzbek/Cyrillic letters with ASCII-ish equivalents
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


def main():
    parser = argparse.ArgumentParser(description="Fetch a textbook chapter from Notion.")
    parser.add_argument("--grade", required=True, type=int, help="Grade 5-11")
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject", required=True, help="Subject name (fuzzy matched)")
    parser.add_argument("--chapter", required=True, type=int, help="Chapter number")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    extractor = NotionExtractor()
    print(f"[fetch] G{args.grade}/{args.lang}/{args.subject!r}/Ch.{args.chapter}")

    result = extractor.extract_chapter(args.grade, args.lang, args.subject, args.chapter)
    if not result:
        print("[fetch] NOT FOUND")
        sys.exit(1)

    text = result.get("refined_text") or result.get("raw_text") or ""
    source_kind = "refined_text" if result.get("refined_text") else (
        "raw_text" if result.get("raw_text") else "none"
    )

    if not text.strip():
        print(f"[fetch] WARNING: chapter found ('{result['chapter_title']}') but no text content.")
        print(f"[fetch] subpages present: {[sp['title'] for sp in result['subpages']]}")
        sys.exit(2)

    subject_slug = slugify(args.subject)
    chapter_slug = slugify(clean_chapter_title(result["chapter_title"]))
    out_dir = Path("chapters") / f"g{args.grade}-{args.lang}" / subject_slug
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"ch{args.chapter:02d}-{chapter_slug}.md"
    meta_path = out_path.with_suffix(".meta.json")

    out_path.write_text(text, encoding="utf-8")
    meta_path.write_text(
        json.dumps(
            {
                "chapter_id": result["chapter_id"],
                "chapter_title": result["chapter_title"],
                "grade": result["grade"],
                "language": result["language"],
                "subject": result["subject"],
                "chapter_number": result["chapter_number"],
                "char_count": len(text),
                "source": source_kind,
                "subpages": [
                    {"title": sp["title"], "type_hint": sp["type_hint"]}
                    for sp in result["subpages"]
                ],
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print(f"[fetch] OK: '{result['chapter_title']}'")
    print(f"[fetch]   source={source_kind}  chars={len(text):,}")
    print(f"[fetch]   wrote {out_path}")
    print(f"[fetch]   wrote {meta_path}")


if __name__ == "__main__":
    main()
