from __future__ import annotations

import logging
import time
from datetime import datetime
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

BASE_API = "https://api.smartrecruiters.com/v1/companies"


def _parse_work_mode(loc_obj: dict[str, Any], title: str) -> WorkMode:
    if loc_obj.get("hybrid") is True:
        return "hybrid"
    if loc_obj.get("remote") is True:
        return "remote"
    if loc_obj.get("remote") is False and loc_obj.get("hybrid") is False:
        return "onsite"
    return detect_work_mode(loc_obj.get("fullLocation"), title)


def _build_description(detail: dict[str, Any]) -> str | None:
    sections = (detail.get("jobAd") or {}).get("sections") or {}
    order = ("jobDescription", "qualifications", "additionalInformation", "companyDescription")
    parts: list[str] = []
    for key in order:
        sec = sections.get(key)
        if not isinstance(sec, dict):
            continue
        body = strip_html(sec.get("text"))
        if not body:
            continue
        sec_title = (sec.get("title") or "").strip()
        if sec_title:
            parts.append(f"### {sec_title}\n{body}")
        else:
            parts.append(body)
    return "\n\n".join(parts) or None


class SmartRecruitersAdapter(BaseAdapter):
    """
    Ortak SmartRecruiters ATS Adapter'ı.
    Herkese açık resmi JSON API'den (api.smartrecruiters.com) şirket ilanlarını,
    gerçek remote/hybrid bilgisini, yayın tarihini ve tam açıklamasını çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        company_identifier = source.config["company_identifier"]
        turkey_only = bool(source.config.get("turkey_only", True))
        fetch_details = bool(source.config.get("fetch_details", True))
        existing = existing_external_ids or set()
        limit = 100
        offset = 0

        raw_items: list[dict[str, Any]] = []
        with httpx.Client(timeout=25.0, follow_redirects=True) as client:
            while True:
                params: dict[str, Any] = {"limit": limit, "offset": offset}
                if turkey_only:
                    params["country"] = "tr"

                resp = client.get(f"{BASE_API}/{company_identifier}/postings", params=params)
                resp.raise_for_status()
                data = resp.json()
                batch = data.get("content") or []
                if not batch:
                    break
                raw_items.extend(batch)
                total = int(data.get("totalFound") or 0)
                offset += len(batch)
                if offset >= total or len(batch) < limit:
                    break

            jobs: list[JobPayload] = []
            for item in raw_items:
                ext_id = str(item.get("id") or "").strip()
                title = (item.get("name") or "").strip()
                if not ext_id or not title:
                    continue

                loc_obj = item.get("location") or {}
                country_code = str(loc_obj.get("country") or "").lower()
                raw_city = (loc_obj.get("city") or "").strip()
                full_loc = (loc_obj.get("fullLocation") or raw_city).strip()

                if turkey_only and country_code != "tr" and not is_turkey_location(full_loc):
                    continue

                city = normalize_city(raw_city) or normalize_city(full_loc)
                work_mode = _parse_work_mode(loc_obj, title)

                emp_label = (item.get("typeOfEmployment") or {}).get("label") or ""
                exp_label = (item.get("experienceLevel") or {}).get("label") or ""
                dept_label = (item.get("department") or {}).get("label") or None

                emp_type = detect_employment_type(title, exp_label, emp_label)

                posted_at = None
                raw_date = item.get("releasedDate")
                if isinstance(raw_date, str) and raw_date:
                    try:
                        posted_at = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                    except ValueError:
                        posted_at = None

                full_ext_id = f"{source.slug}:{ext_id}"
                apply_url = f"https://jobs.smartrecruiters.com/{company_identifier}/{ext_id}"
                description = None

                if fetch_details and item.get("ref") and full_ext_id not in existing:
                    try:
                        time.sleep(0.12)
                        det_resp = client.get(item["ref"])
                        if det_resp.status_code == 200:
                            detail = det_resp.json()
                            apply_url = (
                                detail.get("postingUrl")
                                or detail.get("applyUrl")
                                or apply_url
                            )
                            if not dept_label:
                                dept_label = (detail.get("function") or {}).get("label") or None
                            description = _build_description(detail)
                    except Exception as exc:
                        logger.debug("[smartrecruiters] Detay okunamadı (%s): %s", ext_id, exc)

                jobs.append(
                    JobPayload(
                        company_name=source.name,
                        company_logo_url=source.logo_url,
                        source_platform="direct",
                        external_id=full_ext_id,
                        dedupe_hash=compute_dedupe_hash(source.name, title, city),
                        title=title,
                        description=description,
                        apply_url=apply_url,
                        location=city or full_loc or None,
                        city=city,
                        work_mode=work_mode,
                        employment_type=emp_type,
                        category=detect_category(title, dept_label),
                        department=dept_label,
                        posted_at=posted_at,
                    )
                )

        return jobs
