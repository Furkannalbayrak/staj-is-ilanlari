from __future__ import annotations

import json
import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig, WorkMode
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://www.eleman.net"
TRT = timezone(timedelta(hours=3))


def _parse_jobposting_jsonld(html: str) -> dict[str, Any] | None:
    tree = LexborHTMLParser(html)
    for sc in tree.css('script[type="application/ld+json"]'):
        raw = sc.text(strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict) and item.get("@type") == "JobPosting":
                return item
    return None


def _parse_date_tr(raw_date: str | None) -> datetime | None:
    if not raw_date or not isinstance(raw_date, str):
        return None
    val = raw_date.strip()
    try:
        if "T" in val:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=TRT).astimezone(timezone.utc)
        if len(val) >= 19:
            return datetime.strptime(val[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=TRT).astimezone(timezone.utc)
        if len(val) >= 10:
            return datetime.strptime(val[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return None


def _extract_city(job_location: Any) -> tuple[str | None, str | None]:
    cities: list[str] = []
    seen: set[str] = set()
    locs = job_location if isinstance(job_location, list) else ([job_location] if isinstance(job_location, dict) else [])
    for loc in locs:
        if not isinstance(loc, dict):
            continue
        addrs = loc.get("address")
        addr_list = addrs if isinstance(addrs, list) else ([addrs] if isinstance(addrs, dict) else [])
        for addr in addr_list:
            if not isinstance(addr, dict):
                continue
            cand = addr.get("addressRegion") or addr.get("addressLocality")
            if isinstance(cand, str) and cand.strip():
                c = normalize_city(cand)
                if c and c not in seen:
                    seen.add(c)
                    cities.append(c)
    if not cities:
        return None, None
    if len(cities) == 1:
        return cities[0], cities[0]
    if len(cities) > 10:
        return "Türkiye Geneli", "Türkiye Geneli"
    return cities[0], ", ".join(cities)


class ElemanNetAdapter(BaseAdapter):
    """
    Eleman.net için izole portal adapter'ı.
    Yeni ilanları listeleme sayfalarından toplayıp sadece DB'de olmayan ilanların
    detay sayfasındaki Schema.org JobPosting JSON-LD verisini çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        list_urls: list[str] = source.config.get("list_urls") or [
            "https://www.eleman.net/is-ilanlari",
        ]
        max_new_details = int(source.config.get("max_new_details", 45))
        existing = existing_external_ids or set()

        session = cf_requests.Session(impersonate="chrome124")
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
        }

        jobs: list[JobPayload] = []
        seen_ids: set[str] = set()
        fetched_details = 0

        for list_url in list_urls:
            resp = session.get(list_url, headers=headers, timeout=20, allow_redirects=True)
            if resp.status_code != 200 or not resp.text:
                continue

            tree = LexborHTMLParser(resp.text)
            urls: list[str] = []
            for a in tree.css("a[href]"):
                href = (a.attributes.get("href") or "").strip()
                if "/is-ilani/" not in href:
                    continue
                full = urljoin(BASE_URL, href).split("?")[0]
                if full not in urls:
                    urls.append(full)

            consecutive_existing = 0
            for detail_url in urls:
                m = re.search(r"-i(\d+)$", detail_url.rstrip("/"))
                raw_id = m.group(1) if m else detail_url.rstrip("/").split("/")[-1]
                ext_id = f"en-{raw_id}"
                if ext_id in seen_ids:
                    continue
                seen_ids.add(ext_id)

                if ext_id in existing:
                    consecutive_existing += 1
                    if consecutive_existing >= 15:
                        logger.info("[elemannet] Mevcut ilanlara ulaşıldı, artımlı tarama durduruldu.")
                        break
                    continue
                consecutive_existing = 0

                if fetched_details >= max_new_details:
                    break

                try:
                    time.sleep(random.uniform(0.2, 0.45))
                    dr = session.get(detail_url, headers=headers, timeout=15, allow_redirects=True)
                    fetched_details += 1
                    if dr.status_code != 200 or not dr.text:
                        continue

                    jp = _parse_jobposting_jsonld(dr.text)
                    if not jp:
                        continue

                    title = (jp.get("title") or "").strip()
                    org = jp.get("hiringOrganization") or {}
                    company_name = (org.get("name") or "").strip() if isinstance(org, dict) else ""
                    if not title or not company_name:
                        continue

                    logo = org.get("logo") if isinstance(org, dict) else None
                    company_logo_url = (
                        logo.strip()
                        if isinstance(logo, str) and logo.strip().startswith("http")
                        else None
                    )

                    city, location_str = _extract_city(jp.get("jobLocation"))
                    emp_raw = jp.get("employmentType")
                    emp_str = " ".join(emp_raw) if isinstance(emp_raw, list) else str(emp_raw or "")
                    emp_type = detect_employment_type(title, emp_str)

                    loc_type = str(jp.get("jobLocationType") or "").upper()
                    work_mode: WorkMode = (
                        "remote"
                        if "TELECOMMUTE" in loc_type
                        else detect_work_mode(title, emp_str)
                    )

                    posted_at = _parse_date_tr(jp.get("datePosted"))
                    description = strip_html(jp.get("description"))
                    occ = jp.get("occupationalCategory")
                    dept = str(occ).strip() if isinstance(occ, str) and occ.strip() else None

                    jobs.append(
                        JobPayload(
                            company_name=company_name,
                            company_logo_url=company_logo_url,
                            source_platform="elemannet",
                            external_id=ext_id,
                            dedupe_hash=compute_dedupe_hash(company_name, title, city),
                            title=title,
                            description=description,
                            apply_url=detail_url,
                            location=location_str,
                            city=city,
                            work_mode=work_mode,
                            employment_type=emp_type,
                            category=detect_category(title, dept),
                            department=dept,
                            posted_at=posted_at,
                        )
                    )
                except Exception as exc:
                    logger.debug("[elemannet] Detay okunamadı (%s): %s", detail_url, exc)

        return jobs
