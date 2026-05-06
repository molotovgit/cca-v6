"""
Notion content extractor.
Reads text content from Notion pages and their sub-pages.
Lifted from Notion---Video-Lesson repo.
"""

import logging
import httpx
from typing import Optional
from .client import NotionClientWrapper
from .navigator import NotionNavigator

logger = logging.getLogger("notion.extractor")


class NotionExtractor:
    def __init__(
        self,
        client: Optional[NotionClientWrapper] = None,
        navigator: Optional[NotionNavigator] = None,
    ):
        self.client = client or NotionClientWrapper()
        self.navigator = navigator or NotionNavigator(self.client)

    def download_text_attachment(self, page_id: str) -> str:
        blocks = self.client.get_block_children(page_id)
        texts = []
        for block in blocks:
            if block.get("type") != "file":
                continue
            file_data = block.get("file", {})
            file_name = file_data.get("name", "")
            if "file" in file_data:
                url = file_data["file"].get("url")
            elif "external" in file_data:
                url = file_data["external"].get("url")
            else:
                continue
            if not url or not file_name.lower().endswith(".txt"):
                continue
            try:
                logger.debug(f"Downloading .txt attachment: {file_name} from {page_id}")
                resp = httpx.get(url, timeout=30.0, follow_redirects=True)
                resp.raise_for_status()
                content = resp.text
                if content.strip():
                    texts.append(content)
            except Exception as e:
                logger.warning(f"Failed to download {file_name} from {page_id}: {e}")
        return "\n\n".join(texts)

    def extract_chapter(
        self, grade: int, language: str, subject: str, chapter_number: int
    ) -> Optional[dict]:
        chapter_info = self.navigator.find_chapter(
            grade, language, subject, chapter_number
        )
        if not chapter_info:
            return None

        chapter_id = chapter_info["id"]
        chapter_title = chapter_info["title"]

        logger.info(f"Extracting: G{grade}/{language}/{subject}/Ch.{chapter_number} - {chapter_title}")

        subpages = self.navigator.get_chapter_subpages(chapter_id)
        subpage_types = {sp["type_hint"] for sp in subpages}

        raw_text = ""
        for sp in subpages:
            if sp["type_hint"] == "text_original":
                attachment_text = self.download_text_attachment(sp["id"])
                if attachment_text.strip():
                    raw_text = attachment_text
                else:
                    raw_text = self.extract_page_text(sp["id"])
                break

        refined_text = ""
        for sp in subpages:
            if sp["type_hint"] == "text_refined":
                attachment_text = self.download_text_attachment(sp["id"])
                if attachment_text.strip():
                    refined_text = attachment_text
                else:
                    refined_text = self.extract_page_text(sp["id"])
                break

        return {
            "chapter_id": chapter_id,
            "chapter_title": chapter_title,
            "grade": grade,
            "subject": subject,
            "language": language,
            "chapter_number": chapter_number,
            "raw_text": raw_text,
            "refined_text": refined_text,
            "has_text_original": "text_original" in subpage_types and bool(raw_text.strip()),
            "has_text_refined": "text_refined" in subpage_types and bool(refined_text.strip()),
            "has_images": "images" in subpage_types,
            "has_video": "video" in subpage_types,
            "has_final_video": "final_video" in subpage_types,
            "subpages": subpages,
        }

    def extract_page_text(self, page_id: str) -> str:
        blocks = self.client.get_block_children(page_id)
        parts = []
        for block in blocks:
            text = self._extract_block(block)
            if text:
                parts.append(text)
        return "\n\n".join(parts)

    def _extract_block(self, block: dict, depth: int = 0) -> Optional[str]:
        block_type = block.get("type", "")
        text = self._get_rich_text(block, block_type)

        if block_type == "heading_1":
            text = f"# {text}" if text else None
        elif block_type == "heading_2":
            text = f"## {text}" if text else None
        elif block_type == "heading_3":
            text = f"### {text}" if text else None
        elif block_type == "bulleted_list_item":
            indent = "  " * depth
            text = f"{indent}- {text}" if text else None
        elif block_type == "numbered_list_item":
            indent = "  " * depth
            text = f"{indent}1. {text}" if text else None
        elif block_type == "to_do":
            checked = block.get("to_do", {}).get("checked", False)
            marker = "[x]" if checked else "[ ]"
            text = f"- {marker} {text}" if text else None
        elif block_type == "quote":
            text = f"> {text}" if text else None
        elif block_type == "callout":
            icon = block.get("callout", {}).get("icon", {})
            emoji = icon.get("emoji", "") if icon else ""
            text = f"> {emoji} {text}" if text else None
        elif block_type == "code":
            lang = block.get("code", {}).get("language", "")
            text = f"```{lang}\n{text}\n```" if text else None
        elif block_type == "divider":
            text = "---"
        elif block_type == "toggle":
            pass
        elif block_type == "paragraph":
            pass
        elif block_type == "child_page":
            return None
        elif block_type in ("image", "file", "pdf", "video", "embed", "bookmark"):
            url = self._get_media_url(block)
            if url:
                text = f"[{block_type}: {url}]"
            else:
                text = f"[{block_type}]"
        elif block_type == "table":
            return self._extract_table(block)
        else:
            if not text:
                return None

        if block.get("has_children") and block_type != "child_page":
            try:
                children = self.client.get_block_children(block["id"])
                child_texts = []
                for child in children:
                    ct = self._extract_block(child, depth + 1)
                    if ct:
                        child_texts.append(ct)
                if child_texts:
                    child_content = "\n".join(child_texts)
                    if text:
                        text = f"{text}\n{child_content}"
                    else:
                        text = child_content
            except Exception as e:
                logger.warning(f"Failed to get children of {block['id']}: {e}")

        return text

    def _get_rich_text(self, block: dict, block_type: str) -> str:
        type_data = block.get(block_type, {})
        rich_texts = type_data.get("rich_text", [])
        parts = []
        for rt in rich_texts:
            text = rt.get("plain_text", "")
            annotations = rt.get("annotations", {})
            if annotations.get("bold"):
                text = f"**{text}**"
            if annotations.get("italic"):
                text = f"*{text}*"
            if annotations.get("strikethrough"):
                text = f"~~{text}~~"
            if annotations.get("code"):
                text = f"`{text}`"
            parts.append(text)
        return "".join(parts)

    def _get_media_url(self, block: dict) -> Optional[str]:
        block_type = block.get("type", "")
        type_data = block.get(block_type, {})
        if "file" in type_data:
            return type_data["file"].get("url")
        if "external" in type_data:
            return type_data["external"].get("url")
        if "url" in type_data:
            return type_data["url"]
        return None

    def _extract_table(self, block: dict) -> Optional[str]:
        if not block.get("has_children"):
            return None
        try:
            rows = self.client.get_block_children(block["id"])
            if not rows:
                return None
            md_rows = []
            for i, row in enumerate(rows):
                cells = row.get("table_row", {}).get("cells", [])
                cell_texts = []
                for cell in cells:
                    cell_text = "".join(rt.get("plain_text", "") for rt in cell)
                    cell_texts.append(cell_text)
                md_rows.append("| " + " | ".join(cell_texts) + " |")
                if i == 0:
                    md_rows.append("| " + " | ".join("---" for _ in cell_texts) + " |")
            return "\n".join(md_rows)
        except Exception as e:
            logger.warning(f"Failed to extract table {block['id']}: {e}")
            return None
