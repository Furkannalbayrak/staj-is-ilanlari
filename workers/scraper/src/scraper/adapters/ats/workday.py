from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

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

logger = logging.getLogger(__name__)


class WorkdayAdapter(BaseAdapter):
    """
    Ortak Workday CXS JSON API Adapter'ı.
    Örn: https://{host}/wday/cxs/{tenant}/{board}/jobs
    Yeni bir Workday şirketi eklemek için registry.yaml'a host, tenant ve board eklenir.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        host = source.config["host"]
        tenant = source.config["tenant"]
        board = source.config["board"]
        turkey_only = bool(source.config.get("turkey_only", True))
        search_terms: list[str] = source.config.get("search_terms") or (
            ["Türkiye", "Turkey", "Istanbul"] if turkey_only else [""]
        )
        max_per_term = int(source.config.get("max_per_term", 60))

        base_cxs = f"https://{host}/wday/cxs/{tenant}/{board}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

        seen_paths: dict[str, dict[str, Any]] = {}
        with httpx.Client(timeout=25.0, follow_redirects=True, headers=headers) as client:
            for term in search_terms:
                offset = 0
                limit = 20
                while offset < max_per_term:
                    resp = None
                    for attempt in range(3):
                        resp = client.post(
                            f"{base_cxs}/jobs",
                            json={
                                "appliedFacets": {},
                                "limit": limit,
                                "offset": offset,
                                "searchText": term,
                            },
                        )
                        if resp.status_code != 429:
                            break
                        time.sleep(2.0 * (attempt + 1))
                    if resp is None or resp.status_code != 200:
                        break
                    data = resp.json()
                    postings = data.get("jobPostings") or []
                    if not postings:
                        break

                    for p in postings:
                        ext_path = (p.get("externalPath") or "").strip()
                        if not ext_path or ext_path in seen_paths:
                            continue
                        loc_text = p.get("locationsText") or ""
                        if turkey_only and not is_turkey_location(loc_text):
                            continue
                        seen_paths[ext_path] = p

                    total = int(data.get("total") or 0)
                    offset += len(postings)
                    if offset >= total or len(postings) < limit:
                        break

            jobs: list[JobPayload] = []
            for ext_path, summary in seen_paths.items():
                title = (summary.get("title") or "").strip()
                loc_text = (summary.get("locationsText") or "").strip()
                if not title:
                    continue

                apply_url = f"https://{host}/{board}{ext_path}"
                external_id = (
                    (summary.get("bulletFields") or [None])[0]
                    or ext_path.rstrip("/").split("/")[-1]
                )
                description = None
                time_type = None
                remote_type = None
                posted_at = None

                try:
                    time.sleep(0.25)
                    det_resp = None
                    for attempt in range(3):
                        det_resp = client.get(f"{base_cxs}{ext_path}")
                        if det_resp.status_code != 429:
                            break
                        time.sleep(2.0 * (attempt + 1))
                    if det_resp is not None and det_resp.status_code == 200:
                        info = (det_resp.json() or {}).get("jobPostingInfo") or {}
                        external_id = str(info.get("jobReqId") or info.get("id") or external_id)
                        apply_url = info.get("externalUrl") or apply_url
                        loc_text = info.get("location") or loc_text
                        time_type = info.get("timeType")
                        remote_type = info.get("remoteType")
                        description = strip_html(info.get("jobDescription"))

                        raw_date = info.get("startDate")
                        if isinstance(raw_date, str) and len(raw_date) >= 10:
                            try:
                                posted_at = datetime.strptime(
                                    raw_date[:10], "%Y-%m-%d"
                                ).replace(tzinfo=timezone.utc)
                            except ValueError:
                                posted_at = None
                except Exception as exc:
                    logger.debug("[workday] Detay okunamadı (%s): %s", ext_path, exc)

                if turkey_only and loc_text and not is_turkey_location(loc_text):
                    continue

                city = normalize_city(loc_text)
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
                        location=city or loc_text or None,
                        city=city,
                        work_mode=detect_work_mode(remote_type, loc_text, title),
                        employment_type=detect_employment_type(title, time_type),
                        category=detect_category(title),
                        department=None,
                        posted_at=posted_at,
                    )
                )

        return jobs
