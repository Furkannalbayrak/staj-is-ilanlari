from __future__ import annotations

import json
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

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

BASE_URL = "https://www.techcareer.net"


def _extract_next_data(html: str) -> dict[str, Any] | None:
    tree = LexborHTMLParser(html)
    sc = tree.css_first("script#__NEXT_DATA__")
    if not sc:
        return None
    try:
        return json.loads(sc.text())
    except json.JSONDecodeError:
        return None


def _clean_logo(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return None
    u = url.strip()
    if "cdn1.kariyer.net/" in u:
        u = u.replace("http://cdn1.kariyer.net/", "https://img-kariyer.mncdn.com/").replace(
            "https://cdn1.kariyer.net/", "https://img-kariyer.mncdn.com/"
        )
    if u.startswith("http://"):
        u = "https://" + u[len("http://") :]
    return u if u.startswith("https://") else None


class TechcareerAdapter(BaseAdapter):
    """
    Techcareer.net (/jobs) için izole portal adapter'ı.
    __NEXT_DATA__ JSON verisinden tüm aktif teknoloji ilanlarını, gerçek şirket
    logolarını, çalışma modellerini (İş Yerinde/Hibrit/Uzaktan) ve detay
    açıklamalarını çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        max_pages = int(source.config.get("max_pages", 15))
        fetch_details = bool(source.config.get("fetch_details", True))
        existing = existing_external_ids or set()

        session = cf_requests.Session(impersonate="chrome124")
        headers = {"Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8"}

        jobs: list[JobPayload] = []
        seen_ids: set[str] = set()
        page_count = 1

        for page in range(1, max_pages + 1):
            if page > 1:
                time.sleep(random.uniform(0.4, 0.8))

            url = f"{BASE_URL}/jobs" if page == 1 else f"{BASE_URL}/jobs?page={page}"
            resp = session.get(url, headers=headers, timeout=20, allow_redirects=True)
            if resp.status_code != 200 or not resp.text:
                break

            nd = _extract_next_data(resp.text)
            if not nd:
                break

            pp = (nd.get("props") or {}).get("pageProps") or {}
            job_list = pp.get("initialJobList") or {}
            items: list[dict[str, Any]] = job_list.get("jobListItems") or []
            pagination = job_list.get("pagination") or {}
            if page == 1 and pagination.get("pageCount"):
                page_count = min(max_pages, int(pagination["pageCount"]))

            if not items:
                break

            for item in items:
                raw_id = str(item.get("id") or "").strip()
                slug = (item.get("slug") or "").strip()
                title = (item.get("title") or "").strip()
                if not raw_id or not slug or not title:
                    continue

                ext_id = f"tc-{raw_id}"
                if ext_id in seen_ids:
                    continue
                seen_ids.add(ext_id)

                owner = item.get("owner") or {}
                company_name = (owner.get("name") or item.get("companyName") or "").strip()
                if not company_name:
                    company_name = "Gizli Şirket"
                company_logo_url = _clean_logo(owner.get("logo"))

                loc_raw = (item.get("location") or "").strip()
                city = (
                    "Türkiye Geneli"
                    if item.get("isAllLocationsSelected")
                    else normalize_city(loc_raw)
                )
                work_places = " ".join(str(w) for w in (item.get("workPlaces") or []))
                work_mode = detect_work_mode(work_places, loc_raw, title)
                emp_type = detect_employment_type(title)
                posted_at = None
                description = None

                apply_url = f"{BASE_URL}/jobs/detail/{slug}"

                # Detay sayfasından sadece yeni ilanlar için gerçek startDate, typeOfWorks ve açıklamayı çek
                if fetch_details and ext_id not in existing:
                    try:
                        time.sleep(random.uniform(0.15, 0.3))
                        det_resp = session.get(apply_url, headers=headers, timeout=15)
                        if det_resp.status_code == 200 and det_resp.text:
                            det_nd = _extract_next_data(det_resp.text)
                            det_pp = ((det_nd or {}).get("props") or {}).get("pageProps") or {}
                            det_obj = (
                                det_pp.get("jobDetail")
                                or det_pp.get("initialJobDetail")
                                or {}
                            )
                            head = det_obj.get("head") or {}
                            content = det_obj.get("content") or {}

                            type_of_works = " ".join(
                                str(w) for w in (head.get("typeOfWorks") or [])
                            )
                            if type_of_works:
                                emp_type = detect_employment_type(title, type_of_works)
                            if head.get("workPlaces") and work_mode == "unknown":
                                work_mode = detect_work_mode(
                                    " ".join(str(w) for w in head["workPlaces"]), title
                                )

                            raw_start = head.get("startDate")
                            if isinstance(raw_start, str) and len(raw_start) >= 10:
                                try:
                                    posted_at = datetime.strptime(
                                        raw_start[:10], "%Y-%m-%d"
                                    ).replace(tzinfo=timezone.utc)
                                except ValueError:
                                    posted_at = None

                            desc_clean = strip_html(content.get("description"))
                            skills = [
                                str(sk).strip()
                                for sk in (content.get("skills") or [])
                                if str(sk).strip()
                            ]
                            parts = []
                            if skills:
                                parts.append(f"**Yetkinlikler:** {', '.join(skills)}")
                            if desc_clean:
                                parts.append(desc_clean)
                            description = "\n\n".join(parts) or None
                    except Exception as exc:
                        logger.debug("[techcareer] Detay okunamadı (%s): %s", slug, exc)

                jobs.append(
                    JobPayload(
                        company_name=company_name,
                        company_logo_url=company_logo_url,
                        source_platform="techcareer",
                        external_id=ext_id,
                        dedupe_hash=compute_dedupe_hash(company_name, title, city),
                        title=title,
                        description=description,
                        apply_url=apply_url,
                        location=city or loc_raw or None,
                        city=city,
                        work_mode=work_mode,
                        employment_type=emp_type,
                        category=detect_category(title, item.get("jobTitle"), item.get("jobTitleEn")),
                        department=None,
                        posted_at=posted_at,
                    )
                )

            logger.info("[techcareer] Sayfa %d/%d tamamlandı (toplam: %d)", page, page_count, len(jobs))
            if page >= page_count:
                break

        return jobs
