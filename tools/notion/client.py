"""
Notion API client wrapper with rate limiting and pagination.
Lifted from Notion---Video-Lesson repo.
Read-only methods kept; deletion / write helpers preserved but not used here.
"""

import os
import time
import logging
from typing import Optional
from notion_client import Client
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("notion.client")


class NotionClientWrapper:
    """Thin wrapper around the official Notion SDK with rate limiting + pagination."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("NOTION_API_KEY")
        if not self.api_key or self.api_key.startswith("your_"):
            raise ValueError(
                "NOTION_API_KEY not set. Add it to .env or pass it directly."
            )
        self.api_key = self.api_key.strip().strip('"').strip("'")
        if not self.api_key.startswith(("ntn_", "secret_")):
            raise ValueError(
                f"NOTION_API_KEY looks invalid (should start with 'ntn_' or 'secret_'). "
                f"Got: '{self.api_key[:10]}...'"
            )
        self.client = Client(auth=self.api_key)
        self._request_count = 0
        self._last_request_time = 0.0
        # Notion rate limit: ~3 requests/sec
        self._min_interval = 0.35

    def _rate_limit(self):
        now = time.time()
        elapsed = now - self._last_request_time
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request_time = time.time()
        self._request_count += 1

    def get_page(self, page_id: str) -> dict:
        self._rate_limit()
        logger.debug(f"get_page: {page_id}")
        return self.client.pages.retrieve(page_id=page_id)

    def get_block_children(self, block_id: str) -> list[dict]:
        all_results = []
        cursor = None
        while True:
            self._rate_limit()
            kwargs = {"block_id": block_id}
            if cursor:
                kwargs["start_cursor"] = cursor
            response = self.client.blocks.children.list(**kwargs)
            all_results.extend(response["results"])
            if not response.get("has_more"):
                break
            cursor = response.get("next_cursor")
        logger.debug(f"get_block_children: {block_id} -> {len(all_results)} blocks")
        return all_results

    def search(self, query: str, filter_type: Optional[str] = None) -> list[dict]:
        self._rate_limit()
        kwargs = {"query": query}
        if filter_type:
            kwargs["filter"] = {"value": filter_type, "property": "object"}
        response = self.client.search(**kwargs)
        logger.debug(f"search: '{query}' -> {len(response['results'])} results")
        return response["results"]

    def get_block(self, block_id: str) -> dict:
        self._rate_limit()
        return self.client.blocks.retrieve(block_id=block_id)

    def get_page_title(self, page: dict) -> str:
        for prop in page.get("properties", {}).values():
            if prop.get("type") == "title":
                parts = prop.get("title", [])
                return "".join(t.get("plain_text", "") for t in parts)
        return ""

    def get_child_pages(self, parent_id: str) -> list[dict]:
        children = self.get_block_children(parent_id)
        pages = []
        for block in children:
            if block["type"] == "child_page":
                pages.append({
                    "id": block["id"],
                    "title": block.get("child_page", {}).get("title", ""),
                    "type": "child_page",
                })
        return pages

    def get_text_blocks(self, page_id: str) -> list[dict]:
        children = self.get_block_children(page_id)
        text_types = {
            "paragraph", "heading_1", "heading_2", "heading_3",
            "bulleted_list_item", "numbered_list_item",
            "quote", "callout", "toggle", "to_do",
        }
        return [b for b in children if b.get("type") in text_types]

    @property
    def stats(self) -> dict:
        return {"total_requests": self._request_count}
