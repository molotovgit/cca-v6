"""Notion file upload + block-attach helpers.

Notion's File Upload API has two modes:
  - single_part: max 20 MiB per upload — too small for our zips
  - multi_part:  parts must be 5-20 MiB each (last can be smaller); up to 5 GiB

Validated empirically against API version 2025-09-03 with a 200 MB zip
(see test_upload.py): single-part rejected with 400 "File too large";
multi-part with 15 MB chunks completed cleanly at ~14 MB/s.

Public API:
    find_images_subpage(navigator, chapter_id, *, strict=True) -> dict | None
    upload_file_multipart(api_key, file_path, ...) -> str  # file_upload_id
    attach_file_block(api_key, page_id, file_upload_id, filename) -> str  # block_id
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Optional

import httpx


NOTION_API     = "https://api.notion.com/v1"
NOTION_VERSION = "2025-09-03"

# Multi-part upload constraints (Notion-side):
MIN_PART_BYTES = 5  * 1024 * 1024   # 5 MiB
MAX_PART_BYTES = 20 * 1024 * 1024   # 20 MiB
DEFAULT_CHUNK_MB = 15               # safely inside [5, 20] range


def _headers(api_key: str, *, json_body: bool = False) -> dict:
    h = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": NOTION_VERSION,
    }
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def find_images_subpage(navigator, chapter_id: str, *, strict: bool = True) -> Optional[dict]:
    """Locate the chapter's 'Images' subpage among its child pages.

    With strict=True (default): prefer an exact match — title is exactly
    'Images' or 'Images N' (case-insensitive, trailing whitespace stripped).
    Fall back to the navigator's substring classification only if no exact
    match exists.

    Returns the matching subpage dict {id, title, type_hint} or None.
    """
    subpages = navigator.get_chapter_subpages(chapter_id)
    image_pages = [sp for sp in subpages if sp.get("type_hint") == "images"]
    if not image_pages:
        return None

    if strict:
        exact = [
            sp for sp in image_pages
            if re.match(r"^images(\s+\d+)?$", sp["title"].strip().lower())
        ]
        if exact:
            if len(exact) > 1:
                titles = [sp["title"] for sp in exact]
                print(f"[notion] WARN: multiple exact-match Images pages: {titles}; picking first")
            return exact[0]

        # No exact match — fall through to substring (loose) match.
        if len(image_pages) > 1:
            titles = [sp["title"] for sp in image_pages]
            print(f"[notion] WARN: no exact 'Images' match; multiple substring matches: {titles}; picking first")

    return image_pages[0]


def upload_file_multipart(
    api_key: str,
    file_path,
    *,
    content_type: str = "application/zip",
    chunk_mb: int = DEFAULT_CHUNK_MB,
    max_retries_per_part: int = 3,
) -> str:
    """Upload a file via Notion's multi-part File Upload API.

    Returns the file_upload_id once the upload is completed (status='uploaded').
    Raises RuntimeError on any terminal failure.

    Per-part retry with exponential backoff (1s, 2s, 4s, ...) handles
    transient network failures without aborting the whole upload.
    """
    file_path   = Path(file_path)
    chunk_bytes = chunk_mb * 1024 * 1024
    file_size   = file_path.stat().st_size

    if not (MIN_PART_BYTES <= chunk_bytes <= MAX_PART_BYTES):
        raise RuntimeError(
            f"chunk_mb={chunk_mb} out of Notion's allowed range [5, 20] MiB."
        )

    n_parts = (file_size + chunk_bytes - 1) // chunk_bytes
    if n_parts == 1 and file_size < MIN_PART_BYTES:
        raise RuntimeError(
            f"File too small for multi-part upload: {file_size:,} bytes "
            f"< Notion's {MIN_PART_BYTES:,} byte minimum part size. "
            f"(For files < 5 MB use single_part mode — not implemented here.)"
        )

    print(f"[notion] multi-part upload: {file_size:,} bytes -> {n_parts} parts of <= {chunk_mb} MB")

    # 1. Create file_upload object
    r = httpx.post(
        f"{NOTION_API}/file_uploads",
        headers=_headers(api_key, json_body=True),
        json={
            "filename":        file_path.name,
            "content_type":    content_type,
            "mode":            "multi_part",
            "number_of_parts": n_parts,
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(
            f"Notion file_uploads create failed: {r.status_code} {r.text[:400]}"
        )
    obj        = r.json()
    upload_id  = obj["id"]
    upload_url = obj.get("upload_url") or f"{NOTION_API}/file_uploads/{upload_id}/send"

    # 2. Send each part with retry
    sent = 0
    with open(file_path, "rb") as fh:
        for part in range(1, n_parts + 1):
            data = fh.read(chunk_bytes)
            attempt = 0
            while True:
                attempt += 1
                t0 = time.time()
                try:
                    r = httpx.post(
                        upload_url,
                        headers=_headers(api_key),  # no Content-Type — httpx adds multipart boundary
                        files={"file": (file_path.name, data, content_type)},
                        data={"part_number": str(part)},
                        timeout=600,
                    )
                    status = r.status_code
                    body   = r.text[:300]
                except httpx.RequestError as e:
                    status = None
                    body   = f"network: {e}"
                dt = time.time() - t0

                if status == 200:
                    sent += len(data)
                    pct = sent / file_size * 100
                    print(f"[notion] part {part}/{n_parts} ({len(data)/1024/1024:.1f} MB) ok in {dt:.1f}s [{pct:.0f}%]")
                    break

                if attempt >= max_retries_per_part:
                    raise RuntimeError(
                        f"Notion part {part}/{n_parts} failed after {attempt} attempts. "
                        f"Last status={status} body={body}"
                    )
                backoff = 2 ** (attempt - 1)
                print(f"[notion] part {part}/{n_parts} failed (status={status}); retry {attempt}/{max_retries_per_part} in {backoff}s. body={body}")
                time.sleep(backoff)

    # 3. Complete
    r = httpx.post(
        f"{NOTION_API}/file_uploads/{upload_id}/complete",
        headers=_headers(api_key, json_body=True),
        json={},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(
            f"Notion file_uploads complete failed: {r.status_code} {r.text[:400]}"
        )
    obj = r.json()
    if obj.get("status") != "uploaded":
        raise RuntimeError(
            f"Notion completion returned unexpected status='{obj.get('status')}'; expected 'uploaded'. body={r.text[:400]}"
        )
    print(f"[notion] complete ok — status=uploaded id={upload_id}")
    return upload_id


def attach_file_block(api_key: str, page_id: str, file_upload_id: str, filename: str) -> str:
    """Append a file block (referencing the upload) to the page body.

    Returns the new block_id.
    Raises RuntimeError on failure, with a specific 403 message pointing at
    the most likely permission-config error.
    """
    body = {
        "children": [{
            "type": "file",
            "file": {
                "type":         "file_upload",
                "file_upload":  {"id": file_upload_id},
                "name":         filename,
            },
        }]
    }
    r = httpx.patch(
        f"{NOTION_API}/blocks/{page_id}/children",
        headers=_headers(api_key, json_body=True),
        json=body,
        timeout=30,
    )
    if r.status_code == 403:
        raise RuntimeError(
            f"Notion 403 on block attach to page {page_id}.\n"
            f"        Most likely cause: the integration lacks 'Insert content' capability,\n"
            f"        OR the integration is not connected to the Images page (Notion access\n"
            f"        from the chapter does not always inherit). Fix in Notion:\n"
            f"          1. Settings & members -> My connections -> <integration> -> capabilities\n"
            f"             -> enable 'Insert content'\n"
            f"          2. On the chapter page in Notion: ... -> Add connections -> select your integration\n"
            f"        Body: {r.text[:300]}"
        )
    if r.status_code != 200:
        raise RuntimeError(
            f"Notion block attach failed: {r.status_code} {r.text[:400]}"
        )
    blocks = r.json().get("results", [])
    if not blocks:
        raise RuntimeError(f"Notion block attach returned empty results: {r.text[:400]}")
    return blocks[0]["id"]
