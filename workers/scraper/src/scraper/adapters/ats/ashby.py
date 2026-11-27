from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from scraper.adapters.base import BaseAdapter
from scraper.models import EmploymentType, JobPayload, SourceConfig, WorkMode
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    is_turkey_location,
    normalize_city,
    strip_html,
)

_ASHBY_EMP_MAP: dict[str, EmploymentType] = {
    "fulltime": "full_time",
    "parttime": "part_time",
    "intern": "internship",
    "internship": "internship",
    "contract": "contract",
    "temporary": "contract",
}

_ASHBY_WORKPLACE_MAP: dict[str, WorkMode] = {
    "remote": "remote",
    "hybrid": "hybrid",
    "onsite": "onsite",
}


class AshbyAdapter(BaseAdapter):
    """
    Ortak Ashby HQ ATS Adapter'ı.
    Herkese açık resmi JSON API'den (api.ashbyhq.com) tüm ilanları,
    gerçek çalışma modelini, istihdam türünü ve tam açıklamasını çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        board_token = source.config["board_token"]
        turkey_only = bool(source.config.get("turkey_only", True))
        url = f"https://api.ashbyhq.com/posting-api/job-board/{board_token}"

        resp = httpx.get(url, timeout=25.0, follow_redirects=True)
        resp.raise_for_status()
        data = resp.json()

        jobs: list[JobPayload] = []
        for item in data.get("jobs") or []:
            if item.get("isListed") is False:
                continue

            loc_primary = (item.get("location") or "").strip()
            sec_locs = [
                (s.get("location") or "").strip()
                for s in (item.get("secondaryLocations") or [])
                if isinstance(s, dict) and s.get("location")
            ]
            all_locs_str = " ".join([loc_primary] + sec_locs)

            if turkey_only and not is_turkey_location(all_locs_str):
                continue

            title = (item.get("title") or "").strip()
            external_id = str(item.get("id") or "").strip()
            apply_url = (item.get("jobUrl") or item.get("applyUrl") or "").strip()
            if not title or not external_id or not apply_url:
                continue

            # Türkiye şehrini öncelikle seç
            city = normalize_city(loc_primary)
            if not city:
                for sl in sec_locs:
                    c = normalize_city(sl)
                    if c:
                        city = c
                        break

            raw_wp = str(item.get("workplaceType") or "").lower().replace("-", "").replace("_", "")
            work_mode: WorkMode = _ASHBY_WORKPLACE_MAP.get(raw_wp, "unknown")
            if work_mode == "unknown":
                if item.get("isRemote") is True:
                    work_mode = "remote"
                else:
                    work_mode = detect_work_mode(all_locs_str, title)

            raw_emp = str(item.get("employmentType") or "").lower().replace("-", "").replace("_", "")
            emp_type = detect_employment_type(title)
            if emp_type == "unknown":
                emp_type = _ASHBY_EMP_MAP.get(raw_emp, "unknown")

            department = (item.get("department") or item.get("team") or "").strip() or None
            description = (
                strip_html(item.get("descriptionHtml"))
                or (item.get("descriptionPlain") or "").strip()
                or None
            )

            posted_at = None
            raw_date = item.get("publishedAt")
            if isinstance(raw_date, str) and raw_date:
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
                    location=city or loc_primary or None,
                    city=city,
                    work_mode=work_mode,
                    employment_type=emp_type,
                    category=detect_category(title, department),
                    department=department,
                    posted_at=posted_at,
                )
            )

        return jobs
