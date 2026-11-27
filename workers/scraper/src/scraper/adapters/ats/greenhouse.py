from __future__ import annotations

import html as html_lib
from datetime import datetime

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


class GreenhouseAdapter(BaseAdapter):
    """
    Ortak Greenhouse ATS Adapter'ı.
    Yeni bir Greenhouse şirketi eklemek için sadece registry.yaml'a board_token eklenir.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        board_token = source.config["board_token"]
        turkey_only = bool(source.config.get("turkey_only", True))
        url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true"

        resp = httpx.get(url, timeout=25.0, follow_redirects=True)
        resp.raise_for_status()
        data = resp.json()

        jobs: list[JobPayload] = []
        for item in data.get("jobs") or []:
            location = (item.get("location") or {}).get("name") or ""
            if turkey_only and not is_turkey_location(location):
                continue

            title = (item.get("title") or "").strip()
            apply_url = item.get("absolute_url")
            external_id = str(item.get("id") or "")
            if not title or not apply_url or not external_id:
                continue

            city = normalize_city(location)
            departments = item.get("departments") or []
            department = departments[0].get("name") if departments else None
            raw_content = item.get("content")
            description = strip_html(html_lib.unescape(raw_content)) if raw_content else None

            posted_at = None
            raw_date = item.get("updated_at") or item.get("first_published")
            if raw_date:
                try:
                    posted_at = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                except ValueError:
                    posted_at = None

            jobs.append(
                JobPayload(
                    company_name=source.name,
                    company_logo_url=source.logo_url,
                    source_platform="direct",
                    external_id=f"{source.slug}:{external_id}",
                    dedupe_hash=compute_dedupe_hash(source.name, title, city),
                    title=title,
                    description=description,
                    apply_url=apply_url,
                    location=location or None,
                    city=city,
                    work_mode=detect_work_mode(location, title),
                    employment_type=detect_employment_type(title, department),
                    category=detect_category(title, department),
                    department=department,
                    posted_at=posted_at,
                )
            )

        return jobs
