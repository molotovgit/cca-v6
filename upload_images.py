"""Step 5 — zip the chapter's images + refined text and upload to its Notion 'Images' subpage.

Reads:
  - chapters/g{N}-{lang}/{subj}/ch{NN}-X.meta.json  (chapter_id from stage 1 FETCH)
  - refined/g{N}-{lang}/{subj}/ch{NN}-X.md          (output of stage 2 REFINE — bundled inside the zip)
  - images/g{N}-{lang}/{subj}/ch{NN}-X/*.png        (output of stage 4 IMAGES)

Writes:
  - zips/g{N}-{lang}/{subj}/ch{NN}-X.zip            (the uploaded artifact)
  - zips/g{N}-{lang}/{subj}/ch{NN}-X.uploaded.json  (idempotency marker)

Skip conditions (in order):
  1. CCA_SKIP_UPLOAD=1 in environment
  2. Marker file exists AND its zip_sha256 matches the local zip's sha256
     -> already uploaded for this exact zip; nothing to do.

If the local zip exists but the marker is missing OR sha mismatches, the
stage re-uploads (appending a new file block on the Notion page; the user
manages duplicates manually).

Usage:
    python upload_images.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 11
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path

from dotenv import load_dotenv

# Force UTF-8 console output on Windows (matches fetch_chapter.py convention).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parent
load_dotenv(REPO / ".env")
sys.path.insert(0, str(REPO))

from tools.notion import NotionNavigator
from tools.notion.uploader import (
    find_images_subpage,
    upload_file_multipart,
    attach_file_block,
)


# ── helpers ─────────────────────────────────────────────────────────────────
def slugify(text: str, max_len: int = 60) -> str:
    """Mirror of the slugify used by fetch/refine/prompts so paths line up."""
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


def find_chapter_meta(grade: int, lang: str, subject: str, chapter: int) -> Path:
    subj_slug = slugify(subject)
    folder = REPO / "chapters" / f"g{grade}-{lang}" / subj_slug
    matches = sorted(folder.glob(f"ch{chapter:02d}-*.meta.json"))
    if not matches:
        raise SystemExit(
            f"[upload] meta.json not found at {folder}/ch{chapter:02d}-*.meta.json — "
            f"run FETCH stage first."
        )
    return matches[0]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def create_zip(images_dir: Path, out_zip: Path, refined_md: Path) -> int:
    """Zip every PNG in images_dir + the refined chapter MD into out_zip.
    PNGs use STORED (no compression — already compressed). The MD uses DEFLATE
    since plain text compresses well and is tiny anyway.
    Order: refined MD first, then PNGs sorted alphanumerically — deterministic
    so re-creating the same input produces the same sha256."""
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    pngs = sorted(images_dir.glob("*.png"))
    if not pngs:
        raise SystemExit(f"[upload] no PNGs in {images_dir} — run IMAGES stage first.")
    if not refined_md.exists():
        raise SystemExit(
            f"[upload] refined chapter missing: {refined_md}\n"
            f"        Run REFINE stage first (delete refined/.../{refined_md.name} "
            f"to force regeneration if needed)."
        )

    print(f"[zip] writing 1 MD + {len(pngs)} PNGs -> {out_zip.name}")
    t0 = time.time()
    tmp = out_zip.with_suffix(".zip.tmp")
    try:
        # ZIP_STORED at the archive level; per-entry compression set explicitly below.
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
            # Refined chapter MD first (DEFLATE — text compresses well).
            zf.write(refined_md, arcname=refined_md.name, compress_type=zipfile.ZIP_DEFLATED)
            # Then every PNG (STORED — already compressed, no gain from DEFLATE).
            for png in pngs:
                zf.write(png, arcname=png.name, compress_type=zipfile.ZIP_STORED)
        tmp.replace(out_zip)  # atomic rename
    except Exception:
        if tmp.exists():
            try: tmp.unlink()
            except Exception: pass
        raise
    size = out_zip.stat().st_size
    print(f"[zip] done — {size:,} bytes ({size/1024/1024:.1f} MB) in {time.time()-t0:.1f}s")
    return size


def write_marker(marker_path: Path, data: dict) -> None:
    """Atomic JSON write."""
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = marker_path.with_suffix(marker_path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(marker_path)


# ── main ───────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stage 5 — zip images and upload to chapter's Notion Images subpage."
    )
    parser.add_argument("--grade",   required=True, type=int, help="Grade 5-11")
    parser.add_argument("--lang",    default="uz",  choices=["uz", "ru"])
    parser.add_argument("--subject", required=True, help="Subject name (fuzzy-matched)")
    parser.add_argument("--chapter", required=True, type=int, help="Chapter number")
    args = parser.parse_args()

    if os.environ.get("CCA_SKIP_UPLOAD") == "1":
        print("[upload] CCA_SKIP_UPLOAD=1 — skipping stage")
        return

    api_key = (os.environ.get("NOTION_API_KEY") or "").strip().strip('"').strip("'")
    if not api_key or api_key.startswith(("secret_x", "your_")):
        raise SystemExit("[upload] NOTION_API_KEY missing or placeholder in .env")

    # 1. Locate FETCH meta + IMAGES dir
    meta_path = find_chapter_meta(args.grade, args.lang, args.subject, args.chapter)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    chapter_id    = meta.get("chapter_id")
    chapter_title = meta.get("chapter_title", "")
    if not chapter_id:
        raise SystemExit(f"[upload] meta.json missing chapter_id: {meta_path}")
    base = meta_path.name[: -len(".meta.json")]  # ch11-mogullar-davlati
    print(f"[upload] chapter: '{chapter_title}'  id={chapter_id}  base={base}")

    subj_slug  = slugify(args.subject)
    images_dir = REPO / "images" / f"g{args.grade}-{args.lang}" / subj_slug / base
    if not images_dir.exists():
        raise SystemExit(f"[upload] images dir missing: {images_dir} — run IMAGES first.")

    refined_md = REPO / "refined" / f"g{args.grade}-{args.lang}" / subj_slug / f"{base}.md"
    if not refined_md.exists():
        raise SystemExit(f"[upload] refined chapter missing: {refined_md} — run REFINE first.")

    out_zip    = REPO / "zips"   / f"g{args.grade}-{args.lang}" / subj_slug / f"{base}.zip"
    out_marker = out_zip.with_suffix(".uploaded.json")

    # 2. Idempotency: skip if marker matches current zip
    if out_marker.exists() and out_zip.exists():
        try:
            marker = json.loads(out_marker.read_text(encoding="utf-8"))
            if marker.get("zip_sha256") == sha256_file(out_zip):
                print(f"[upload] skip — marker matches zip sha256 (block_id={marker.get('notion_block_id')})")
                return
            print(f"[upload] marker sha mismatch — re-uploading")
        except Exception as e:
            print(f"[upload] marker unreadable ({e}) — re-uploading")

    # 3. Create zip if missing OR if existing zip predates the refined-MD bundling
    #    (older zips were images-only — detect by checking namelist for the MD).
    needs_rebuild = False
    if out_zip.exists():
        try:
            with zipfile.ZipFile(out_zip, "r") as zf:
                if refined_md.name not in zf.namelist():
                    print(f"[zip] existing zip is images-only (legacy) — regenerating to include refined MD")
                    needs_rebuild = True
        except zipfile.BadZipFile:
            print(f"[zip] existing zip is corrupt — regenerating")
            needs_rebuild = True
    if needs_rebuild and out_zip.exists():
        out_zip.unlink()

    if not out_zip.exists():
        create_zip(images_dir, out_zip, refined_md)
    else:
        size = out_zip.stat().st_size
        print(f"[zip] reusing existing {out_zip.name} ({size:,} bytes, {size/1024/1024:.1f} MB)")

    zip_sha = sha256_file(out_zip)
    print(f"[zip] sha256={zip_sha[:16]}...")

    # 4. Find the Notion 'Images' subpage on the chapter
    nav = NotionNavigator()
    images_page = find_images_subpage(nav, chapter_id, strict=True)
    if not images_page:
        chapter_url = f"https://www.notion.so/{chapter_id.replace('-', '')}"
        raise SystemExit(
            f"[upload] no 'Images' subpage on chapter page.\n"
            f"        Chapter: {chapter_url}\n"
            f"        Fix: in Notion, create a child page on that chapter titled 'Images'\n"
            f"             (or 'Images 1', etc.) — or set CCA_SKIP_UPLOAD=1 to skip this stage."
        )
    print(f"[upload] target page: '{images_page['title']}' id={images_page['id']}")

    # 5. Upload (multi-part)
    file_upload_id = upload_file_multipart(api_key, out_zip)

    # 6. Attach file block to the Images page
    block_id = attach_file_block(api_key, images_page["id"], file_upload_id, out_zip.name)
    print(f"[upload] attached block_id={block_id}")

    # 7. Write idempotency marker
    marker_data = {
        "notion_block_id":     block_id,
        "notion_page_id":      images_page["id"],
        "notion_page_title":   images_page["title"],
        "file_upload_id":      file_upload_id,
        "zip_sha256":          zip_sha,
        "zip_size_bytes":      out_zip.stat().st_size,
        "refined_md_included": True,
        "refined_md_name":     refined_md.name,
        "uploaded_at":         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_marker(out_marker, marker_data)
    print(f"[upload] wrote marker {out_marker.name}")

    page_url = f"https://www.notion.so/{images_page['id'].replace('-', '')}"
    print(f"\n[upload] DONE — verify in Notion: {page_url}")


if __name__ == "__main__":
    main()
