from __future__ import annotations

import logging
import re
import time
from urllib.parse import urljoin

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

TUSAS_BASE = "https://kariyer.tusas.com"
TUSAS_LIST_URL = "https://kariyer.tusas.com/acik-pozisyonlarimiz"


class TusasAdapter(BaseAdapter):
    """
    TUSAŞ - Türk Havacılık ve Uzay Sanayii (kariyer.tusas.com) için izole custom adapter.
    Açık pozisyonlar sayfasındaki tüm /ilan-detay/ ilanlarını ve detay bilgilerini çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        session = cf_requests.Session(impersonate="chrome124")
        headers = {"Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8"}

        resp = session.get(TUSAS_LIST_URL, headers=headers, timeout=20, allow_redirects=True)
        resp.raise_for_status()
        tree = LexborHTMLParser(resp.text)

        detail_urls: list[str] = []
        seen_urls: set[str] = set()
        for a in tree.css("a"):
            href = (a.attributes.get("href") or "").strip()
            if "/ilan-detay/" not in href:
                continue
            full_url = urljoin(TUSAS_BASE, href).split("?")[0]
            if full_url not in seen_urls:
                seen_urls.add(full_url)
                detail_urls.append(full_url)

        jobs: list[JobPayload] = []
        for url in detail_urls:
            slug = url.rstrip("/").split("/")[-1]
            if not slug:
                continue

            try:
                time.sleep(0.2)
                dr = session.get(url, headers=headers, timeout=20, allow_redirects=True)
                if dr.status_code != 200 or not dr.text:
                    continue
                dtree = LexborHTMLParser(dr.text)

                h1 = dtree.css_first("h1")
                title = re.sub(r"\s+", " ", h1.text(strip=True)) if h1 else ""
                if not title:
                    continue

                header_text = ""
                if h1 and h1.parent and h1.parent.parent:
                    header_text = re.sub(
                        r"\s+", " ", h1.parent.parent.text(separator=" | ", strip=True)
                    )

                city = normalize_city(header_text) or normalize_city(title)
                emp_type = detect_employment_type(title, header_text)
                work_mode = detect_work_mode(header_text, title)

                # Sayfa gövdesindeki açıklama bloklarını topla
                body_parts: list[str] = []
                for container in dtree.css("main section, article, .prose, [class*='prose']"):
                    cleaned = strip_html(container.html)
                    if cleaned and len(cleaned) > 100 and cleaned not in body_parts:
                        body_parts.append(cleaned)
                description = "\n\n".join(body_parts[:3]) or None

                jobs.append(
                    JobPayload(
                        company_name=source.name,
                        company_logo_url=source.logo_url,
                        source_platform="direct",
                        external_id=f"tusas:{slug}",
                        dedupe_hash=compute_dedupe_hash(source.name, title, city),
                        title=title,
                        description=description,
                        apply_url=url,
                        location=city,
                        city=city,
                        work_mode=work_mode,
                        employment_type=emp_type,
                        category=detect_category(title, header_text),
                        department=None,
                        posted_at=None,
                    )
                )
            except Exception as exc:
                logger.debug("[tusas] Detay okunamadı (%s): %s", url, exc)

        return jobs
