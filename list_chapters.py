"""List all chapters under a (grade, lang, subject)."""
import argparse
import sys
from pathlib import Path
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()
sys.path.insert(0, str(Path(__file__).resolve().parent))

from tools.notion import NotionNavigator, NotionExtractor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--grade", required=True, type=int)
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject", required=True)
    parser.add_argument("--with-status", action="store_true",
                        help="Also fetch each chapter's subpages to show text presence")
    args = parser.parse_args()

    nav = NotionNavigator()
    subj = nav.find_subject(args.grade, args.lang, args.subject)
    if not subj:
        print(f"Subject {args.subject!r} not found")
        sys.exit(1)
    print(f"Subject: '{subj['title']}'  id={subj['id']}\n")

    chapters = nav.list_chapters(subj["id"])
    print(f"{len(chapters)} chapters:\n")

    if args.with_status:
        ext = NotionExtractor(client=nav.client, navigator=nav)
        for c in chapters:
            status = ext.check_chapter_status(args.grade, args.lang, args.subject, c["chapter_number"])
            t = status or {}
            flags = []
            if t.get("has_text_refined"): flags.append("REFINED")
            if t.get("has_text_original"): flags.append("RAW")
            if t.get("has_images"): flags.append("IMG")
            if t.get("has_video"): flags.append("VID")
            tag = "[" + ",".join(flags) + "]" if flags else ""
            num = str(c['chapter_number']) if c['chapter_number'] is not None else '—'
            print(f"  parsed_num={num:>3}  idx={c['index']:>3}  {tag:<28} '{c['title']}'")
    else:
        for c in chapters:
            num = str(c['chapter_number']) if c['chapter_number'] is not None else '—'
            print(f"  parsed_num={num:>3}  idx={c['index']:>3}  '{c['title']}'")


if __name__ == "__main__":
    main()
