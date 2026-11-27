from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig, WorkMode
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

_WORKABLE_WORKPLACE: dict[str, WorkMode] = {
    "remote": "remote",
    "hybrid": "hybrid",
    "on_site": "onsite",
    "onsite": "onsite",
}


class WorkableAdapter(BaseAdapter):
    """
    Ortak Workable ATS Adapter'ı.
    Herkese açık Workable API'sinden (apply.workable.com/api/v3/accounts/{slug}/jobs)
    ilanları, gerçek çalışma modelini ve detay açıklamasını çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        account_slug = source.config["account_slug"]
        turkey_only = bool(source.config.get("turkey_only", True))
        fetch_details = bool(source.config.get("fetch_details", True))

        list_url = f"https://apply.workable.com/api/v3/accounts/{account_slug}/jobs"
        jobs: list[JobPayload] = []

        with httpx.Client(timeout=25.0, follow_redirects=True) as client:
            resp = client.post(
                list_url,
                json={"query": "", "location": [], "department": [], "worktype": [], "remote": []},
            )
            resp.raise_for_status()
            results: list[dict[str, Any]] = resp.json().get("results") or []

            for item in results:
                shortcode = str(item.get("shortcode") or "").strip()
                title = (item.get("title") or "").strip()
                if not shortcode or not title:
                    continue

                loc_obj = item.get("location") or {}
                country_code = str(loc_obj.get("countryCode") or "").upper()
                loc_str = " ".join(
                    p for p in (loc_obj.get("city"), loc_obj.get("region"), loc_obj.get("country")) if p
                )

                if turkey_only and country_code != "TR" and not is_turkey_location(loc_str):
                    continue

                city = normalize_city(loc_obj.get("city")) or normalize_city(loc_str)
                wp_raw = str(item.get("workplace") or "").lower()
                work_mode: WorkMode = _WORKABLE_WORKPLACE.get(wp_raw, "unknown")
                if work_mode == "unknown":
                    if item.get("remote") is True:
                        work_mode = "remote"
                    else:
                        work_mode = detect_work_mode(loc_str, title)

                emp_type = detect_employment_type(title, item.get("type"))
                departments = item.get("department") or []
                department = departments[0] if isinstance(departments, list) and departments else None

                posted_at = None
                raw_pub = item.get("published")
                if isinstance(raw_pub, str) and len(raw_pub) >= 10:
                    try:
                        posted_at = datetime.strptime(raw_pub[:10], "%Y-%m-%d").replace(
                            tzinfo=timezone.utc
                        )
                    except ValueError:
                        posted_at = None

                apply_url = f"https://apply.workable.com/{account_slug}/j/{shortcode}/"
                description = None

                if fetch_details:
                    try:
                        time.sleep(0.12)
                        det_resp = client.get(
                            f"https://apply.workable.com/api/v2/accounts/{account_slug}/jobs/{shortcode}"
                        )
                        if det_resp.status_code == 200:
                            det = det_resp.json()
                            parts = []
                            for key, heading in (
                                ("description", None),
                                ("requirements", "Gereksinimler"),
                                ("benefits", "Yan Haklar"),
                            ):
                                body = strip_html(det.get(key))
                                if body:
                                    parts.append(f"### {heading}\n{body}" if heading else body)
                            description = "\n\n".join(parts) or None
                    except Exception as exc:
                        logger.debug("[workable] Detay okunamadı (%s): %s", shortcode, exc)

                jobs.append(
                    JobPayload(
                        company_name=source.name,
                        company_logo_url=source.logo_url,
                        source_platform="direct",
                        external_id=f"{source.slug}:{shortcode}",
                        dedupe_hash=compute_dedupe_hash(source.name, title, city),
                        title=title,
                        description=description,
                        apply_url=apply_url,
                        location=city or loc_str or None,
                        city=city,
                        work_mode=work_mode,
                        employment_type=emp_type,
                        category=detect_category(title, department),
                        department=department,
                        posted_at=posted_at,
                    )
                )

        return jobs
