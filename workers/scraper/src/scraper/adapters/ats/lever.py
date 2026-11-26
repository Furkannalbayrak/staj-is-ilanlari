from __future__ import annotations

from datetime import datetime, timezone

import httpx

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    is_turkey_location,
    normalize_city,
    strip_html,
)


class LeverAdapter(BaseAdapter):
    """
    Ortak Lever ATS Adapter'ı.
    Yeni bir Lever şirketi eklemek için sadece registry.yaml'a board_token eklemek yeterlidir.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        board_token = source.config["board_token"]
        turkey_only = bool(source.config.get("turkey_only", True))
        url = f"https://api.lever.co/v0/postings/{board_token}?mode=json"

        resp = httpx.get(url, timeout=25.0, follow_redirects=True)
        resp.raise_for_status()
        postings = resp.json()

        jobs: list[JobPayload] = []
        for item in postings:
            categories = item.get("categories") or {}
            location = categories.get("location") or item.get("country") or ""
            workplace = item.get("workplaceType") or ""

            if turkey_only and not is_turkey_location(location):
                continue

            title = (item.get("text") or "").strip()
            apply_url = item.get("hostedUrl") or item.get("applyUrl")
            external_id = str(item.get("id") or "")
            if not title or not apply_url or not external_id:
                continue

            city = normalize_city(location)
            department = categories.get("department") or categories.get("team")
            commitment = categories.get("commitment")

            desc_parts = [item.get("descriptionPlain") or strip_html(item.get("description"))]
            for lst in item.get("lists") or []:
                header = lst.get("text")
                body = strip_html(lst.get("content"))
                if header and body:
                    desc_parts.append(f"{header}\n{body}")
            description = "\n\n".join(p for p in desc_parts if p) or None

            posted_at = None
            created_ms = item.get("createdAt")
            if isinstance(created_ms, (int, float)):
                posted_at = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc)

            jobs.append(
                JobPayload(
                    company_name=source.name,
                    source_platform="direct",
                    external_id=f"{source.slug}:{external_id}",
                    dedupe_hash=compute_dedupe_hash(source.name, title, city),
                    title=title,
                    description=description,
                    apply_url=apply_url,
                    location=location or None,
                    city=city,
                    work_mode=detect_work_mode(workplace, location, title),
                    employment_type=detect_employment_type(title, commitment),
                    category=detect_category(title, department),
                    department=department,
                    posted_at=posted_at,
                )
            )

        return jobs
