"""
Notion workspace navigator.
Handles the hierarchy: Grade -> Language -> Subject -> Chapter
with fuzzy subject matching and chapter number detection.
Lifted from Notion---Video-Lesson repo.
"""

import re
import logging
from typing import Optional
from .client import NotionClientWrapper
from .config import LANGUAGE_PAGES, SUBJECT_ALIASES, SKIP_SUBJECTS, HISTORY_SPLIT_GRADE

logger = logging.getLogger("notion.navigator")


class NotionNavigator:
    def __init__(self, client: Optional[NotionClientWrapper] = None):
        self.client = client or NotionClientWrapper()
        self._subject_cache: dict[str, list[dict]] = {}
        self._chapter_cache: dict[str, list[dict]] = {}

    def get_language_page_id(self, grade: int, language: str) -> Optional[str]:
        lang_pages = LANGUAGE_PAGES.get(grade, {})
        page_id = lang_pages.get(language)
        if not page_id:
            logger.warning(f"No page ID for grade {grade}/{language}")
        return page_id

    def list_subjects(self, grade: int, language: str) -> list[dict]:
        cache_key = f"{grade}_{language}"
        if cache_key in self._subject_cache:
            return self._subject_cache[cache_key]

        lang_page_id = self.get_language_page_id(grade, language)
        if not lang_page_id:
            return []

        child_pages = self.client.get_child_pages(lang_page_id)

        subjects = []
        for page in child_pages:
            title = page["title"].strip()
            skipped = any(s in title.lower() for s in SKIP_SUBJECTS)
            subjects.append({
                "id": page["id"],
                "title": title,
                "skipped": skipped,
            })

        self._subject_cache[cache_key] = subjects
        logger.info(f"Grade {grade}/{language}: {len(subjects)} subjects found")
        return subjects

    def find_subject(self, grade: int, language: str, target_subject: str) -> Optional[dict]:
        subjects = self.list_subjects(grade, language)
        for subj in subjects:
            if subj["skipped"]:
                continue
            if self._subject_matches(subj["title"], target_subject, grade=grade):
                logger.info(f"Found subject '{target_subject}' -> '{subj['title']}' ({subj['id']})")
                return subj
        logger.warning(f"Subject '{target_subject}' not found under grade {grade}/{language}")
        return None

    _PART_PATTERNS = [
        r"\d+\s*-?\s*qism",
        r"qism\s*\d+",
        r"[IVX]+\s*-?\s*qism",
        r"\d+\s*-?\s*kitob",
        r"kitob\s*\d+",
        r"часть\s*\d+",
        r"\d+\s*-?я?\s*часть",
        r"часть\s*[IVX]+",
        r"книга\s*\d+",
        r"part\s*\d+",
        r"\d+\s*-?\s*part",
        r"book\s*\d+",
    ]

    def _is_part_page(self, title: str) -> bool:
        t = title.strip()
        return any(re.search(p, t, re.IGNORECASE) for p in self._PART_PATTERNS)

    def get_subject_parts(self, subject_page_id: str) -> list[dict]:
        child_pages = self.client.get_child_pages(subject_page_id)
        return [
            {"id": p["id"], "title": p["title"]}
            for p in child_pages
            if self._is_part_page(p["title"])
        ]

    def list_chapters(self, subject_page_id: str) -> list[dict]:
        if subject_page_id in self._chapter_cache:
            return self._chapter_cache[subject_page_id]

        child_pages = self.client.get_child_pages(subject_page_id)
        part_pages = [p for p in child_pages if self._is_part_page(p["title"])]

        if part_pages:
            logger.info(
                f"Subject {subject_page_id}: multi-part ({len(part_pages)} parts: "
                + ", ".join(p["title"] for p in part_pages) + ")"
            )
            chapters = []
            idx = 0
            for part in part_pages:
                part_children = self.client.get_child_pages(part["id"])
                for page in part_children:
                    idx += 1
                    title = page["title"].strip()
                    title = re.sub(r"[\.\s…]{3,}\d{1,3}\s*$", "", title).strip()
                    title = re.sub(r"\.{2,}\s*$", "", title).strip()
                    ch_num = self._parse_chapter_number(title)
                    chapters.append({
                        "id": page["id"],
                        "title": title,
                        "index": idx,
                        "chapter_number": ch_num,
                        "part_id": part["id"],
                        "part_title": part["title"],
                    })
        else:
            chapters = []
            idx = 0
            for page in child_pages:
                idx += 1
                title = page["title"].strip()
                title = re.sub(r"[\.\s…]{3,}\d{1,3}\s*$", "", title).strip()
                title = re.sub(r"\.{2,}\s*$", "", title).strip()
                ch_num = self._parse_chapter_number(title)
                chapters.append({
                    "id": page["id"],
                    "title": title,
                    "index": idx,
                    "chapter_number": ch_num,
                })

        self._chapter_cache[subject_page_id] = chapters
        logger.info(f"Subject {subject_page_id}: {len(chapters)} chapters total")
        return chapters

    def find_chapter(self, grade: int, language: str, subject: str, chapter_number: int) -> Optional[dict]:
        subject_info = self.find_subject(grade, language, subject)
        if not subject_info:
            return None

        chapters = self.list_chapters(subject_info["id"])

        # Prefer parsed-number match (skips intro/Kirish pages with no number)
        for ch in chapters:
            if ch["chapter_number"] is not None and ch["chapter_number"] == chapter_number:
                logger.info(
                    f"Found: G{grade}/{language}/{subject}/Ch.{chapter_number} "
                    f"-> '{ch['title']}' ({ch['id']})"
                )
                return ch

        # Fallback: index into PARSED-only chapters (skip unnumbered intro pages)
        parsed = [c for c in chapters if c["chapter_number"] is not None]
        if 1 <= chapter_number <= len(parsed):
            ch = parsed[chapter_number - 1]
            logger.info(
                f"Found by parsed-index: G{grade}/{language}/{subject}/Ch.{chapter_number} "
                f"-> '{ch['title']}' ({ch['id']})"
            )
            return ch

        logger.warning(
            f"Chapter {chapter_number} not found in {subject} "
            f"(grade {grade}/{language}, {len(chapters)} chapters total)"
        )
        return None

    def get_chapter_subpages(self, chapter_page_id: str) -> list[dict]:
        child_pages = self.client.get_child_pages(chapter_page_id)
        subpages = []
        for page in child_pages:
            title = page["title"]
            type_hint = self._classify_subpage(title)
            subpages.append({
                "id": page["id"],
                "title": title,
                "type_hint": type_hint,
            })
        return subpages

    def _subject_matches(self, notion_title: str, target: str, grade: int = 0) -> bool:
        nt = notion_title.lower().strip()
        tt = target.lower().strip()

        if nt == tt:
            return True

        part_pattern = r'\d+\s*-?\s*(?:qism|part|часть|kitob|book)'
        if re.search(part_pattern, nt, re.IGNORECASE) or re.search(part_pattern, tt, re.IGNORECASE):
            return False

        excluded_keys = set()
        if grade >= HISTORY_SPLIT_GRADE:
            excluded_keys.add("tarix")

        for canonical, variations in SUBJECT_ALIASES.items():
            if canonical in excluded_keys:
                continue
            target_in_group = tt == canonical or tt in variations
            notion_in_group = nt == canonical or nt in variations
            if target_in_group and notion_in_group:
                return True

        return False

    def _parse_chapter_number(self, title: str) -> Optional[int]:
        title = title.strip()
        title = re.sub(r"[\.\s]{3,}\d{1,3}\s*$", "", title).strip()
        title = re.sub(r"\.{2,}\d*\s*$", "", title).strip()

        patterns = [
            r"(\d+)\s*-\s*§",
            r"§\s*(\d+)",
            r"^(\d+)\s*-\s*mavzu",     # '1-mavzu', '2-3-mavzu' (first num), '4 - mavzu'
            r"^(\d+)\s*-\s*тема",      # '1-тема'
            r"[Mm]avzu\s*(\d+)",
            r"[Бб]об\s*(\d+)",
            r"[Гг]лава\s*(\d+)",
            r"[Тт]ема\s*(\d+)",
            r"[Уу]рок\s*(\d+)",
            r"^(\d+)\s*[-\.]\s+\S",
        ]
        for pattern in patterns:
            match = re.search(pattern, title)
            if match:
                return int(match.group(1))
        return None

    def _classify_subpage(self, title: str) -> str:
        t = title.lower().strip()
        t = re.sub(r"\s*\(\d+\)\s*$", "", t)
        if "text original" in t:
            return "text_original"
        if "text refined" in t:
            return "text_refined"
        if "prompt" in t:
            return "prompt"
        if "images" in t or "image" in t:
            return "images"
        if "final video" in t:
            return "final_video"
        if "video" in t:
            return "video"
        if "audio" in t:
            return "audio"
        if "lesson files" in t or "ppt" in t or "pdf" in t:
            return "lesson_files"
        if "quizlet" in t:
            return "quizlet"
        if "homework" in t:
            return "homework"
        if "lesson plan" in t:
            return "lesson_plan"
        if "get ready" in t or "teacher" in t:
            return "teacher_prep"
        if "prezi" in t:
            return "prezi"
        return "unknown"

    def clear_cache(self):
        self._subject_cache.clear()
        self._chapter_cache.clear()
