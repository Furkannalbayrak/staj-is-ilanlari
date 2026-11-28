from __future__ import annotations

import logging
import time
from typing import Any

from curl_cffi import requests as cf_requests

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

BAYKAR_API_URL = "https://kariyer.baykartech.com/tr/basvuru/serializerProgram/?page=1"
BAYKAR_DETAIL_BASE = "https://kariyer.baykartech.com/tr/acik-pozisyonlar/detay"


class BaykarAdapter(BaseAdapter):
    """
    Baykar Teknoloji (kariyer.baykartech.com) için izole custom adapter.
    Resmi DRF JSON API'sinden (/tr/basvuru/serializerProgram/) tüm aktif açık
    pozisyonları ve staj programlarını sayfa sayfa çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        max_pages = int(source.config.get("max_pages", 40))
        session = cf_requests.Session(impersonate="chrome124")
        headers = {
            "Accept": "application/json",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
        }

        jobs: list[JobPayload] = []
        seen_ids: set[str] = set()
        next_url: str | None = BAYKAR_API_URL
        page_num = 0

        while next_url and page_num < max_pages:
            page_num += 1
            if page_num > 1:
                time.sleep(0.15)
            resp = session.get(next_url, headers=headers, timeout=20, allow_redirects=True)
            if resp.status_code != 200:
                logger.warning("[baykar] Sayfa %d HTTP %d döndü.", page_num, resp.status_code)
                break

            data: dict[str, Any] = resp.json()
            results = data.get("results") or []
            if not results:
                break

            for item in results:
                if item.get("stop_application") is True or item.get("active") is False:
                    continue

                raw_id = str(item.get("id") or "").strip()
                title = (item.get("text") or "").strip()
                slug = (item.get("new_slug") or item.get("slug") or "").strip()
                if not raw_id or not title or not slug:
                    continue

                ext_id = f"baykar:{raw_id}"
                if ext_id in seen_ids:
                    continue
                seen_ids.add(ext_id)

                cat_obj = item.get("category") or {}
                department = (
                    (cat_obj.get("text") or "").strip() if isinstance(cat_obj, dict) else None
                ) or None

                keywords = [
                    str(k).strip()
                    for k in (item.get("keywords_list") or [])
                    if str(k).strip()
                ]
                phases = strip_html(item.get("phases_text")) if item.get("phases_text") else None

                desc_parts: list[str] = []
                if department:
                    desc_parts.append(f"**Departman / Birim:** {department}")
                if keywords:
                    desc_parts.append(f"**Anahtar Yetkinlikler:** {', '.join(keywords)}")
                if phases:
                    desc_parts.append(f"### Başvuru Süreci\n{phases}")
                description = "\n\n".join(desc_parts) or None

                city = normalize_city(title)
                apply_url = f"{BAYKAR_DETAIL_BASE}/{slug}"

                jobs.append(
                    JobPayload(
                        company_name=source.name,
                        company_logo_url=source.logo_url,
                        source_platform="direct",
                        external_id=ext_id,
                        dedupe_hash=compute_dedupe_hash(source.name, title, city),
                        title=title,
                        description=description,
                        apply_url=apply_url,
                        location=city,
                        city=city,
                        work_mode="unknown",
                        employment_type=detect_employment_type(title, department),
                        category=detect_category(title, department, " ".join(keywords)),
                        department=department,
                        posted_at=None,
                    )
                )

            next_url = data.get("next")

        return jobs
